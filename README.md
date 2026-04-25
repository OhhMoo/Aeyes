# Aeyes — Auto-Capture Visual Narration

A hackathon-style web demo that helps blind users understand what's in front
of the camera. The browser captures a still every 5 seconds (or on demand),
sends it to the underlying
[SeeingEye](../README.md#about-seeingeye-the-underlying-framework) multi-agent
pipeline for description, and reads the answer aloud. Two complementary
on-demand modes: **"What just changed?"** compares two frames sampled ~10 s
apart, and **"Hold to speak"** lets the user ask follow-up questions by voice.
Logged-in users get persistent per-account history that's fed back to the
model as memory.

## Why no audio detection?

An earlier version listened for environmental sounds (glass breaking, alarms,
crashes) with on-device YAMNet and triggered investigations on those events.
That premise was wrong: blind users *aren't deaf*. They already hear the glass
break — what they need is for the model to tell them what they *can't* hear.
The audio-detection layer was removed; the value lives in the visual
description and in voice-driven Q&A, not in echoing what the user already
perceived.

> **Backend status — stub mode.** `server.py` returns canned strings from a
> `STUB_RESPONSES` map, plus a stub `/chat` reply. The SeeingEye Translator →
> Reasoner pipeline and OpenAI vision calls described below are the *target*
> architecture and are marked with `# TODO` in `server.py`. The browser
> (camera, ClipBuffer, auto-capture loop, voice chat, auth, profile, history)
> is fully functional against the stub. ElevenLabs TTS for `/chat` is real
> when `ELEVENLABS_API_KEY` is set; otherwise the browser falls back to
> `speechSynthesis`.

## Architecture

```
Browser                                       Server (FastAPI)
─────────                                     ─────────────────
auth.js   ──login/register──→  /auth/login, /auth/register  ──→  SQLite (users)
                ↓                                                      │
            JWT in localStorage                                        │
                                                                       │
camera → ClipBuffer  ─10 s rolling window of JPEGs                     │
              │       (sampled at 1 fps, sample()-on-demand)           │
              ▼                                                        │
   5 s timer → 16×16 perceptual hash → diff vs last narration          │
                  │                                                    │
                  ├─ below CHANGE_THRESHOLD → stay silent               │
                  │                                                    │
                  └─ above → /analyze-change {prev, current}     ─→  stub diff
                              (first tick: /investigate _describe)─→  stub describe
   "What changed?" → /analyze-change {frame0, frame1}        ─────→  stub diff
   "Hold to speak" → /chat {text}                            ─────→  stub + ElevenLabs MP3
              │                                                        │
              │   each successful request appends to                   ▼
              │   ─────────────────────────────────────────→  SQLite (history)
              ▼
   speechSynthesis.speak(text)   OR   audio.play(audio_b64)
              │
              └── after each request: clip cache pruned to most recent frame only
              └── on success: window.refreshHistory() repopulates the panel
```

### Clip → frame sampling

The model takes images, not video, so the browser maintains a small rolling
window of recent frames and picks representative ones per request.
`static/clip_buffer.js` exposes a `ClipBuffer` class that owns the window and
the sampling policy:

| Strategy | Returns | Used by |
|---|---|---|
| `latest` | newest frame | (available; any future "describe what's now" path) |
| `edges` | `[oldest, newest]` | `/analyze-change` |
| `uniform` | N evenly spaced frames across the window | reserved for future multi-image investigate |

Adding a new strategy (e.g. perceptual-hash dedup, motion keyframes) is a local
edit to `ClipBuffer.sample()` — no orchestration changes needed.

### Cache hygiene

No frames are persisted to disk. The `ClipBuffer` is a fixed-size in-memory
window (max 11 frames at 1 fps). After each `/investigate` or `/analyze-change`
call returns, the buffer is collapsed to the single most recent frame and the
trigger-moment data URL is released. The captured-still preview that flashes
in the camera area is auto-hidden after 8 s. Worst-case in-memory footprint is
one to two ~50 KB JPEG strings at any moment.

History is persisted server-side in `aeyes.db` only for authenticated users
(via `auth.optional_user`). Unauthenticated requests still work; they just
aren't recorded.

## Running it

### Prerequisites

```bash
pip install -r requirements.txt
```

Required for first run: nothing. The SQLite DB and tables are created
automatically on startup (`database.init_db` runs in the FastAPI lifespan
hook).

Optional environment variables:

| Var | Effect when set |
|---|---|
| `ELEVENLABS_API_KEY` | `/chat` returns a real MP3 voice reply (Rachel by default) instead of relying on browser TTS. |
| `ELEVENLABS_VOICE_ID` | Override the ElevenLabs voice ID (default: `21m00Tcm4TlvDq8ikWAM`, Rachel). |
| `JWT_SECRET` | Sign auth tokens with a real secret. **Set this for any non-local deployment** — the dev default is `aeyes-dev-secret-change-in-prod`. |

When SeeingEye is wired back into `/investigate` and `/analyze-change`, you'll
also need an `OPENAI_API_KEY` for the hosted Translator and *optionally* a
vLLM server backing the Reasoner — see "vLLM" and "Fully-hosted fallback"
below.

### Start the server

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Open <http://localhost:8000> in **Chrome** (camera + microphone permissions;
`SpeechRecognition` is Chromium-only). On first visit you'll be asked to
register. Then click **"Start auto-capture"** to begin the 5-second narration
loop, **"Describe surroundings"** / **"What changed?"** for one-shot requests,
or **"Hold to speak"** to ask the model a question by voice.

`GET /health` returns `{"ok": true, "mode": "stub", "elevenlabs": <bool>}`.

### vLLM (target — self-hosted Reasoner, ~16 GB VRAM)

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen3-8B \
  --port 8001 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

### Fully-hosted fallback (target — no GPU)

Open `src/multi-agent/config/config.toml`, find the `[llm.reasoning_api]`
block, and swap it to OpenAI just like the translator:

```toml
[llm.reasoning_api]
model = "gpt-4o-mini"
api_type = "openai"
base_url = "https://api.openai.com/v1"
api_key = ""           # patched at runtime from OPENAI_API_KEY
max_tokens = 1024
temperature = 0.2
```

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/auth/register` | none | Create a user, return a JWT. |
| POST | `/auth/login` | none | Verify credentials, return a JWT. |
| GET | `/profile` | required | Return user profile + history count. |
| PATCH | `/profile` | required | Update display name and/or password. |
| GET | `/history` | required | List the user's last N events. |
| POST | `/investigate` | optional | Single-frame description (currently stub). Saves history when authenticated. |
| POST | `/analyze-change` | optional | Two-frame diff (currently stub). Saves history when authenticated. |
| POST | `/chat` | optional | Voice question → text reply + optional ElevenLabs MP3. Saves history when authenticated. |
| GET | `/health` | none | Liveness + mode. |

## Demo plan (stage-day)

1. Open the page → register a demo account in <10 s.
2. Click **"Start auto-capture"**. Stand in front of three pre-staged scenes
   for ~5 s each. The page speaks a description as soon as each one comes
   into frame.
3. Show **"What just changed?"** by quietly removing or adding an object
   during the demo, then pressing the button.
4. Hold **"Hold to speak"** and ask "what colour is the lamp on the desk?" —
   showcases voice Q&A with optional ElevenLabs voice if the key is set.
5. Open the corner avatar → **Profile** to show display-name + password
   editing and history count. Click into **History** to show that prior
   observations are remembered across sessions and (eventually) injected as
   context when the real model lands.
6. Privacy story: no frames leave the browser except for the single in-flight
   request, and the in-memory cache is pruned after each call. Only the
   text response is persisted.

## Knobs to tune

- `AUTO_CAPTURE_MS` (frontend, `app.js`): interval between automatic
  capture ticks. Default 5 s. Raise for less aggressive polling.
- `CHANGE_THRESHOLD` (frontend, `app.js`): mean absolute brightness diff
  (0–255 scale) between consecutive 16×16 frame thumbnails required for the
  auto-capture loop to narrate. Below this, the tick stays silent and no
  request is sent. Default 8. Lower for chattier narration, higher for
  terser. Static scenes typically diff at 1–3; an object moving usually
  diffs 10+.
- `CLIP_WINDOW_MS` / `CLIP_FPS` (frontend, `app.js`): rolling-window length
  and sampling rate handed to `ClipBuffer`. Default 10 s @ 1 fps.
- `STUB_RESPONSES` (backend, `server.py`, **stub mode**): canned reply per
  event. Will be replaced by `EVENT_PROMPTS` (per-event investigative
  prompts) when SeeingEye is reconnected — that prompt map is the hackathon
  "secret sauce".
- `_build_context(...)` (backend, `server.py`): formats recent history into
  a prompt prefix that will be injected into the real model once integrated,
  giving it memory of past observations.
- `_EXPIRY_HOURS` (backend, `auth.py`): JWT lifetime, default 24 h.
- Reasoner `max_steps` (in `src/multi-agent/config/config.toml` under
  `[flow]`, **target architecture**): drop from 3 → 1 to cut latency at the
  cost of reasoning depth.

## File map

| Path | Purpose |
|---|---|
| `server.py` | FastAPI app — auth, history, profile, investigate, analyze-change, chat, health. Stub responses for the model paths; `# TODO` markers point to where SeeingEye will plug back in. |
| `auth.py` | bcrypt password hashing + PyJWT token issuance/verification. `require_user` and `optional_user` dependencies. |
| `database.py` | aiosqlite wrappers for users (id, username, password_hash, display_name) and history (type, event, input, response, timestamp). Auto-creates schema on startup. |
| `aeyes.db` | SQLite store. *Note: tracked in git from prior commit; not ideal — see "Cleanup follow-ups".* |
| `requirements.txt` | fastapi, uvicorn, httpx (ElevenLabs), aiosqlite, bcrypt, PyJWT. |
| `static/index.html` | Auth overlay, two-column layout (camera left, app/profile right), corner user menu. |
| `static/app.js` | Camera init, ClipBuffer wiring, 5 s auto-capture loop, manual buttons, voice chat (`SpeechRecognition` → `/chat` → ElevenLabs audio), TTS, fetch + Bearer auth + cache pruning. |
| `static/auth.js` | Auth flows (login/register/logout), profile panel (display name, password change), history panel (server-driven via `/history`). Exposes `window.getAuthHeaders` and `window.refreshHistory`. |
| `static/clip_buffer.js` | `ClipBuffer` class — rolling 10 s frame window with named sampling strategies (`latest` / `edges` / `uniform`). The seam between "video coming in" and "images going to the model". |
| `static/style.css` | Dark theme, two-column layout, panels, animations. |
| `src/multi-agent/config/config.toml` *(target architecture, not yet active)* | `[llm.translator_api]` repointed at OpenAI; `[llm.reasoning_api]` left on local vLLM (`:8001`). |

## Limits / honest caveats

- Chrome recommended. `SpeechRecognition` (used for voice chat) is
  Chromium-only; the rest works in any modern browser.
- Auto-capture narration is gated by a client-side perceptual hash
  (`CHANGE_THRESHOLD`). Static scenes are silent — including in stub mode,
  where the canned reply only fires when the scene actually changes. The
  first tick of every auto-capture run still fires a baseline `/investigate`
  so the user gets an initial description; subsequent ticks route through
  `/analyze-change` for a "what changed" framing.
- Auth lives entirely in `localStorage` on the client; logging out clears
  it. The JWT `_SECRET` defaults to a dev value — set `JWT_SECRET` for any
  shared deployment.
- ElevenLabs is optional. Without the key, `/chat.audio_b64` is `null` and
  the browser falls back to `speechSynthesis`.
- `/analyze-change` is designed to bypass the agent loop and call the hosted
  VLM directly with both frames — the agent loop is overkill (and too slow)
  for a frame diff. (Currently stubbed.)

## Cleanup follow-ups

- **`aeyes.db` is in git history.** Friend's commit checked in the SQLite
  file with whatever dev accounts existed at the time. The included
  `.gitignore` rules (`*.db-journal`, `*.db-wal`, `*.db-shm`) prevent the
  WAL/SHM journals from sneaking in, but the main `.db` is grandfathered in.
  Consider `git rm --cached aeyes.db` once dev accounts no longer need to be
  shared, and adding `aeyes.db` to `.gitignore`.
- **Set `JWT_SECRET`** (and rotate any token issued under the dev default)
  before exposing the demo on any reachable network.
