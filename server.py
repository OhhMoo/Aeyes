"""
Aeyes demo backend — stub mode (SeeingEye not yet wired in).

Endpoints:
  POST /auth/register       — create account
  POST /auth/login          — get JWT token
  GET  /profile             — fetch current user profile + history count
  PATCH /profile            — update display name and/or password
  GET  /history             — fetch user's event history (requires auth)
  GET  /locations           — list saved named locations (requires auth)
  POST /locations           — save a new named location (requires auth)
  DELETE /locations/{id}    — remove a saved location (requires auth)
  PATCH /locations/{id}     — rename a saved location (requires auth)
  POST /investigate         — single-frame scene description (optional auth → history saved)
  POST /analyze-change      — two-frame scene-diff narration   (optional auth → history saved)
  POST /chat                — voice chat + ElevenLabs TTS       (optional auth → history saved)
  GET  /health              — readiness probe

Env vars:
  ELEVENLABS_API_KEY        — required for /chat audio output
  ELEVENLABS_VOICE_ID       — optional, defaults to Rachel (21m00Tcm4TlvDq8ikWAM)
  GOOGLE_MAPS_API_KEY       — optional, enables reverse geocoding for saved locations
  JWT_SECRET                — JWT signing secret (set a strong value in production)
"""
from __future__ import annotations

import base64
import math
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import auth
import database

DEMO_DIR = Path(__file__).resolve().parent
STATIC_DIR = DEMO_DIR / "static"

_ELEVENLABS_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
_ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
_GMAPS_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()

_MATCH_RADIUS_METERS = 100


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await database.init_db()
    yield


app = FastAPI(title="Aeyes Demo (stub)", lifespan=lifespan)


# ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async def _elevenlabs_tts(text: str) -> Optional[str]:
    """Call ElevenLabs and return base64-encoded MP3, or None if key not set."""
    if not _ELEVENLABS_KEY:
        return None
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{_ELEVENLABS_VOICE}",
            headers={"xi-api-key": _ELEVENLABS_KEY, "Content-Type": "application/json"},
            json={
                "text": text,
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            timeout=30.0,
        )
    if r.status_code != 200:
        return None
    return base64.b64encode(r.content).decode()


# ── Geolocation helpers ───────────────────────────────────────────────────────

def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def _reverse_geocode(lat: float, lon: float) -> Optional[str]:
    """Return a human-readable address from Google Maps, or None on any failure."""
    if not _GMAPS_KEY:
        return None
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"latlng": f"{lat},{lon}", "key": _GMAPS_KEY,
                        "result_type": "street_address|premise"},
                timeout=5.0,
            )
        data = r.json()
        results = data.get("results", [])
        return results[0]["formatted_address"] if results else None
    except Exception:
        return None


async def _resolve_location(
    user_id: Optional[int],
    lat: Optional[float],
    lon: Optional[float],
) -> tuple[Optional[int], Optional[str]]:
    """Match lat/lon against user's saved locations. Returns (id, name) or (None, None)."""
    if not user_id or lat is None or lon is None:
        return None, None
    saved = await database.get_locations(user_id)
    for loc in saved:
        if _haversine_m(lat, lon, loc["lat"], loc["lon"]) <= _MATCH_RADIUS_METERS:
            return loc["id"], loc["name"]
    return None, None


# ── History context builder ───────────────────────────────────────────────────

def _build_context(history: list[dict]) -> str:
    """
    Format recent history into a prompt context string, grouped by location so
    the model can naturally answer location-scoped queries like "what's the
    state of my kitchen?". When the real model is integrated, inject this
    before the user's query so it has memory of past observations *and where
    they happened*. The model's output is always a visual description (audio-
    event triggering was removed), so "Saw" is the correct verb regardless of
    the original event field.
    """
    if not history:
        return ""

    grouped: dict[Optional[str], list[dict]] = {}
    for h in history[-12:]:
        grouped.setdefault(h.get("location_name"), []).append(h)

    lines = ["Recent observations (for context):"]
    # Render groups with named locations first, then untagged rows.
    keys = sorted(grouped.keys(), key=lambda k: (k is None, k or ""))
    for loc in keys:
        lines.append(f"  At {loc}:" if loc else "  Untagged location:")
        for h in grouped[loc]:
            ts = h["created_at"][:16].replace("T", " ")
            snippet = h["response"][:100].rstrip(".")
            if h["type"] == "chat":
                lines.append(f'    [{ts}] User asked: "{h["input_text"]}" → "{snippet}…"')
            elif h["type"] == "investigate":
                lines.append(f'    [{ts}] Saw: "{snippet}…"')
            elif h["type"] == "change":
                lines.append(f'    [{ts}] Scene changed: "{snippet}…"')
    return "\n".join(lines)


# ── Spatial-query stubs ───────────────────────────────────────────────────────
# In stub mode we do tiny pattern-matching so the demo can actually answer
# "where did I last see X" / "what's at the kitchen" without an LLM. The real
# model takes over once SeeingEye is wired in; these routes are best-effort
# fallbacks that produce something useful in the meantime.

# Matches: "where did I see/leave/put X", "where is X", "where are X",
# "where can I find X", "where's X". Captures whatever follows.
_WHERE_RE = re.compile(
    r"\bwhere(?:'s|\s+is|\s+are|\s+can\s+i\s+find|\s+did\s+i\s+(?:see|last\s+see|put|leave|find))\s+"
    r"(?:my\s+|the\s+|a\s+|an\s+|some\s+)?(.+?)\??\s*$",
    re.IGNORECASE,
)


def _match_object_query(text: str) -> Optional[str]:
    """If `text` looks like a 'where did I see X' question, return X. Else None."""
    m = _WHERE_RE.search(text.strip())
    if not m:
        return None
    obj = m.group(1).strip().lower().rstrip("?.,!")
    return obj or None


def _find_object_in_history(history: list[dict], object_name: str) -> Optional[dict]:
    """Most recent history row whose response mentions `object_name`. Else None."""
    needle = object_name.lower()
    for h in reversed(history):
        if needle in (h.get("response") or "").lower():
            return h
    return None


def _match_location_query(text: str, locations: list[dict]) -> Optional[dict]:
    """If text mentions a saved location name, return that location dict."""
    txt = text.lower()
    # Prefer the longest matching name so "main kitchen" beats "kitchen".
    best = None
    for loc in locations:
        name = loc["name"].lower()
        if name and name in txt and (best is None or len(name) > len(best["name"])):
            best = loc
    return best


def _summarize_at_location(history: list[dict], loc: dict) -> str:
    rows = [h for h in history if h.get("location_id") == loc["id"]]
    if not rows:
        return f"No observations recorded at {loc['name']} yet."
    last = rows[-1]
    snippet = (last.get("response") or "")[:120].rstrip(".")
    n = len(rows)
    return (
        f"At {loc['name']}, {n} observation{'s' if n != 1 else ''} on file. "
        f'Most recent: "{snippet}…"'
    )


def _relative_time(iso: str) -> str:
    try:
        when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except Exception:
        return iso[:16].replace("T", " ")
    delta = datetime.now(timezone.utc) - when
    s = int(delta.total_seconds())
    if s < 60:    return f"{s}s ago"
    if s < 3600:  return f"{s // 60}m ago"
    if s < 86400: return f"{s // 3600}h ago"
    return f"{s // 86400}d ago"


# ── Auth endpoints ────────────────────────────────────────────────────────────

class AuthReq(BaseModel):
    username: str
    password: str


class AuthResp(BaseModel):
    token: str
    username: str
    display_name: str


@app.post("/auth/register", response_model=AuthResp)
async def register(req: AuthReq) -> AuthResp:
    if len(req.username) < 2 or len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Username ≥2 chars, password ≥4 chars.")
    if await database.get_user(req.username):
        raise HTTPException(status_code=409, detail="Username already taken.")
    hashed = auth.hash_password(req.password)
    user_id = await database.create_user(req.username, hashed)
    return AuthResp(
        token=auth.create_token(user_id, req.username),
        username=req.username,
        display_name=req.username,
    )


@app.post("/auth/login", response_model=AuthResp)
async def login(req: AuthReq) -> AuthResp:
    user = await database.get_user(req.username)
    if not user or not auth.verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    return AuthResp(
        token=auth.create_token(user["id"], req.username),
        username=user["username"],
        display_name=user.get("display_name") or user["username"],
    )


# ── History endpoint ──────────────────────────────────────────────────────────

@app.get("/history")
async def get_history(
    limit: int = 20,
    location_id: Optional[int] = None,
    current_user: dict = Depends(auth.require_user),
) -> list[dict]:
    return await database.get_history(current_user["id"], limit=limit, location_id=location_id)


# ── Profile endpoints ─────────────────────────────────────────────────────────

class ProfileResp(BaseModel):
    username: str
    display_name: str
    member_since: str
    history_count: int


class UpdateProfileReq(BaseModel):
    display_name: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None


@app.get("/profile", response_model=ProfileResp)
async def get_profile(current_user: dict = Depends(auth.require_user)) -> ProfileResp:
    user = await database.get_user_by_id(current_user["id"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    count = await database.count_history(current_user["id"])
    return ProfileResp(
        username=user["username"],
        display_name=user.get("display_name") or user["username"],
        member_since=user["created_at"][:10],
        history_count=count,
    )


@app.patch("/profile")
async def update_profile(
    req: UpdateProfileReq,
    current_user: dict = Depends(auth.require_user),
) -> dict:
    if req.display_name is not None:
        name = req.display_name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Display name cannot be empty.")
        await database.update_display_name(current_user["id"], name)
    if req.new_password:
        if not req.current_password:
            raise HTTPException(status_code=400, detail="Current password required.")
        user = await database.get_user_by_id(current_user["id"])
        if not user or not auth.verify_password(req.current_password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect.")
        if len(req.new_password) < 4:
            raise HTTPException(status_code=400, detail="New password must be ≥4 chars.")
        await database.update_password(current_user["id"], auth.hash_password(req.new_password))
    return {"ok": True}


# ── Location endpoints ────────────────────────────────────────────────────────

class CreateLocationReq(BaseModel):
    name: str
    lat: float
    lon: float


class UpdateLocationReq(BaseModel):
    name: str


@app.get("/locations")
async def list_locations(current_user: dict = Depends(auth.require_user)) -> list[dict]:
    return await database.get_locations(current_user["id"])


@app.post("/locations", status_code=201)
async def create_location(
    req: CreateLocationReq,
    current_user: dict = Depends(auth.require_user),
) -> dict:
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Location name cannot be empty.")
    if not (-90 <= req.lat <= 90) or not (-180 <= req.lon <= 180):
        raise HTTPException(status_code=400, detail="Invalid coordinates.")
    address = await _reverse_geocode(req.lat, req.lon)
    loc_id = await database.add_location(current_user["id"], name, req.lat, req.lon, address)
    locs = await database.get_locations(current_user["id"])
    return next((l for l in locs if l["id"] == loc_id), {"id": loc_id, "name": name})


@app.patch("/locations/{location_id}")
async def rename_location(
    location_id: int,
    req: UpdateLocationReq,
    current_user: dict = Depends(auth.require_user),
) -> dict:
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Location name cannot be empty.")
    await database.update_location_name(location_id, current_user["id"], name)
    return {"ok": True}


@app.delete("/locations/{location_id}")
async def remove_location(
    location_id: int,
    current_user: dict = Depends(auth.require_user),
) -> dict:
    await database.delete_location(location_id, current_user["id"])
    return {"ok": True}


# ── Investigation endpoints ───────────────────────────────────────────────────

# Canned replies keyed by event. Post-pivot the client only sends `_describe`
# to /investigate; /analyze-change has its own response. When SeeingEye is
# wired back in, this map is replaced by `EVENT_PROMPTS` — the per-event
# investigative prompts that go *into* the model rather than canned reply text.
STUB_RESPONSES: dict[str, str] = {
    "_describe": "Stub mode: SeeingEye model not yet connected. Cannot describe surroundings.",
    "_change": "Stub mode: SeeingEye model not yet connected. Cannot detect changes.",
}
DEFAULT_STUB = "Stub mode: SeeingEye model not yet connected."


class InvestigateReq(BaseModel):
    event: str
    image_b64: str
    lat: Optional[float] = None
    lon: Optional[float] = None


class InvestigateResp(BaseModel):
    event: str
    prompt: str
    response: str
    elapsed_seconds: float
    success: bool


# TODO: replace stub with real SeeingEye FlowExecutor once integrated
@app.post("/investigate", response_model=InvestigateResp)
async def investigate(
    req: InvestigateReq,
    current_user: Optional[dict] = Depends(auth.optional_user),
) -> InvestigateResp:
    start = time.time()
    history = await database.get_history(current_user["id"]) if current_user else []
    context = _build_context(history)  # inject into real model prompt when integrated

    response = STUB_RESPONSES.get(req.event, DEFAULT_STUB)

    if current_user:
        loc_id, loc_name = await _resolve_location(current_user["id"], req.lat, req.lon)
        await database.add_history(
            user_id=current_user["id"],
            type="investigate",
            response=response,
            input_text=req.event,
            event=req.event,
            lat=req.lat,
            lon=req.lon,
            location_id=loc_id,
            location_name=loc_name,
        )

    return InvestigateResp(
        event=req.event,
        prompt=context or "(no history)",
        response=response,
        elapsed_seconds=round(time.time() - start, 3),
        success=True,
    )


class ChangeReq(BaseModel):
    frame0_b64: str
    frame1_b64: str
    lat: Optional[float] = None
    lon: Optional[float] = None


class ChangeResp(BaseModel):
    response: str
    elapsed_seconds: float
    success: bool


# TODO: replace stub with real multi-image VLM call once integrated
@app.post("/analyze-change", response_model=ChangeResp)
async def analyze_change(
    req: ChangeReq,
    current_user: Optional[dict] = Depends(auth.optional_user),
) -> ChangeResp:
    start = time.time()
    history = await database.get_history(current_user["id"]) if current_user else []
    context = _build_context(history)  # inject into real model prompt when integrated

    response = STUB_RESPONSES["_change"]

    if current_user:
        loc_id, loc_name = await _resolve_location(current_user["id"], req.lat, req.lon)
        await database.add_history(
            user_id=current_user["id"],
            type="change",
            response=response,
            lat=req.lat,
            lon=req.lon,
            location_id=loc_id,
            location_name=loc_name,
        )

    return ChangeResp(
        response=response,
        elapsed_seconds=round(time.time() - start, 3),
        success=True,
    )


# ── Chat endpoint ─────────────────────────────────────────────────────────────

class ChatReq(BaseModel):
    text: str
    lat: Optional[float] = None
    lon: Optional[float] = None


class LocationRef(BaseModel):
    name: Optional[str] = None
    lat: float
    lon: float


class ChatResp(BaseModel):
    text: str
    response: str
    audio_b64: Optional[str]
    success: bool
    referenced_location: Optional[LocationRef] = None


# TODO: replace stub_response with real model call once SeeingEye is integrated;
#       pass `context` as system/prefix to give the model memory of past events.
@app.post("/chat", response_model=ChatResp)
async def chat(
    req: ChatReq,
    current_user: Optional[dict] = Depends(auth.optional_user),
) -> ChatResp:
    history = await database.get_history(current_user["id"]) if current_user else []
    locations = await database.get_locations(current_user["id"]) if current_user else []
    context = _build_context(history)  # inject into real model prompt when integrated

    referenced: Optional[LocationRef] = None
    stub_response: str

    # Feature 1: "where did I (last) see X?" — find an object across history
    # and surface where it was last observed, plus a map pin for the client
    # to highlight.
    obj = _match_object_query(req.text)
    if obj and history:
        match = _find_object_in_history(history, obj)
        if match:
            loc_str = f" at {match['location_name']}" if match.get("location_name") else ""
            when = _relative_time(match["created_at"])
            snippet = (match.get("response") or "")[:120].rstrip(".")
            stub_response = (
                f'You last saw something matching "{obj}"{loc_str} {when}: "{snippet}…" '
                "(Stub response — real model coming soon.)"
            )
            if match.get("lat") is not None and match.get("lon") is not None:
                referenced = LocationRef(
                    name=match.get("location_name"),
                    lat=match["lat"],
                    lon=match["lon"],
                )
        else:
            stub_response = (
                f'I don\'t have any past observations matching "{obj}". '
                "(Stub: real model coming soon.)"
            )
    else:
        # Feature 3: "what's at <location>?" / "state of <location>?" — match
        # against the user's saved locations and return a per-location summary.
        loc_match = _match_location_query(req.text, locations) if locations else None
        if loc_match:
            stub_response = _summarize_at_location(history, loc_match)
            referenced = LocationRef(
                name=loc_match["name"],
                lat=loc_match["lat"],
                lon=loc_match["lon"],
            )
        elif history:
            stub_response = (
                f'You asked: "{req.text}". '
                f"I have {len(history)} past observation{'s' if len(history) != 1 else ''} on file. "
                "The AI model is not yet connected — this is a stub response."
            )
        else:
            stub_response = (
                f'You asked: "{req.text}". '
                "No previous history yet. "
                "The AI model is not yet connected — this is a stub response."
            )

    audio_b64 = await _elevenlabs_tts(stub_response)

    if current_user:
        loc_id, loc_name = await _resolve_location(current_user["id"], req.lat, req.lon)
        await database.add_history(
            user_id=current_user["id"],
            type="chat",
            response=stub_response,
            input_text=req.text,
            lat=req.lat,
            lon=req.lon,
            location_id=loc_id,
            location_name=loc_name,
        )

    return ChatResp(
        text=req.text,
        response=stub_response,
        audio_b64=audio_b64,
        success=True,
        referenced_location=referenced,
    )


# ── Static + root ─────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "mode": "stub",
        "elevenlabs": bool(_ELEVENLABS_KEY),
        "geocoding": bool(_GMAPS_KEY),
    }
