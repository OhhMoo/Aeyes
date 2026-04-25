"""
Aeyes demo backend — stub mode (SeeingEye not yet wired in).

Endpoints:
  POST /auth/register     — create account
  POST /auth/login        — get JWT token
  GET  /history           — fetch user's event history (requires auth)
  POST /investigate       — audio-event investigation (optional auth → history saved)
  POST /analyze-change    — scene change detection  (optional auth → history saved)
  POST /chat              — voice chat + ElevenLabs TTS (optional auth → history saved)
  GET  /health            — readiness probe

Env vars:
  ELEVENLABS_API_KEY      — required for /chat audio output
  ELEVENLABS_VOICE_ID     — optional, defaults to Rachel (21m00Tcm4TlvDq8ikWAM)
  JWT_SECRET              — JWT signing secret (set a strong value in production)
"""
from __future__ import annotations

import base64
import os
import time
from contextlib import asynccontextmanager
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


# ── History context builder ───────────────────────────────────────────────────

def _build_context(history: list[dict]) -> str:
    """
    Format recent history into a prompt context string.
    When the real model is integrated, inject this string before the user's query
    so the model has memory of past observations.
    """
    if not history:
        return ""
    lines = ["Recent observations (for context):"]
    for h in history[-8:]:
        ts = h["created_at"][:16].replace("T", " ")
        snippet = h["response"][:100].rstrip(".")
        if h["type"] == "chat":
            lines.append(f'  [{ts}] User said: "{h["input_text"]}" → "{snippet}…"')
        elif h["type"] == "investigate":
            lines.append(f'  [{ts}] Heard {h["event"]} → "{snippet}…"')
        elif h["type"] == "change":
            lines.append(f'  [{ts}] Scene changed → "{snippet}…"')
    return "\n".join(lines)


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
    current_user: dict = Depends(auth.require_user),
) -> list[dict]:
    return await database.get_history(current_user["id"], limit=limit)


# ── Profile endpoints ────────────────────────────────────────────────────────

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


# ── Investigation endpoints ───────────────────────────────────────────────────

STUB_RESPONSES: dict[str, str] = {
    "Glass": "I heard breaking glass. The stub model is not yet connected — no visual analysis available.",
    "Shatter": "I heard breaking glass. The stub model is not yet connected — no visual analysis available.",
    "Rain": "I heard rain or water. The stub model is not yet connected — no visual analysis available.",
    "Water tap, faucet": "I heard running water. The stub model is not yet connected — no visual analysis available.",
    "Water": "I heard water sounds. The stub model is not yet connected — no visual analysis available.",
    "Smoke detector, smoke alarm": "I heard a smoke alarm. The stub model is not yet connected — no visual analysis available.",
    "Fire alarm": "I heard a fire alarm. The stub model is not yet connected — no visual analysis available.",
    "Smash, crash": "I heard a crash. The stub model is not yet connected — no visual analysis available.",
    "Thump, thud": "I heard a thud. The stub model is not yet connected — no visual analysis available.",
    "_describe": "Stub mode: SeeingEye model not yet connected. Cannot describe surroundings.",
    "_change": "Stub mode: SeeingEye model not yet connected. Cannot detect changes.",
}
DEFAULT_STUB = "Stub mode: SeeingEye model not yet connected."


class InvestigateReq(BaseModel):
    event: str
    image_b64: str


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
        await database.add_history(
            user_id=current_user["id"],
            type="investigate",
            response=response,
            input_text=req.event,
            event=req.event,
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


class ChangeResp(BaseModel):
    response: str
    elapsed_seconds: float
    success: bool


# TODO: replace stub with real multi-image VLM call once integrated
@app.post("/analyze-change", response_model=ChangeResp)
async def analyze_change(
    _req: ChangeReq,
    current_user: Optional[dict] = Depends(auth.optional_user),
) -> ChangeResp:
    start = time.time()
    history = await database.get_history(current_user["id"]) if current_user else []
    context = _build_context(history)  # inject into real model prompt when integrated

    response = STUB_RESPONSES["_change"]

    if current_user:
        await database.add_history(
            user_id=current_user["id"],
            type="change",
            response=response,
        )

    return ChangeResp(
        response=response,
        elapsed_seconds=round(time.time() - start, 3),
        success=True,
    )


# ── Chat endpoint ─────────────────────────────────────────────────────────────

class ChatReq(BaseModel):
    text: str


class ChatResp(BaseModel):
    text: str
    response: str
    audio_b64: Optional[str]
    success: bool


# TODO: replace stub_response with real model call once SeeingEye is integrated;
#       pass `context` as system/prefix to give the model memory of past events.
@app.post("/chat", response_model=ChatResp)
async def chat(
    req: ChatReq,
    current_user: Optional[dict] = Depends(auth.optional_user),
) -> ChatResp:
    history = await database.get_history(current_user["id"]) if current_user else []
    context = _build_context(history)  # inject into real model prompt when integrated

    if history:
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
        await database.add_history(
            user_id=current_user["id"],
            type="chat",
            response=stub_response,
            input_text=req.text,
        )

    return ChatResp(
        text=req.text,
        response=stub_response,
        audio_b64=audio_b64,
        success=True,
    )


# ── Static + root ─────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "mode": "stub", "elevenlabs": bool(_ELEVENLABS_KEY)}
