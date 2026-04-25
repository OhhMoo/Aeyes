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

No frames are persisted to disk. Two distinct in-memory caches:

1. **Working buffer** (`ClipBuffer`). Fixed-size rolling window (max 11
   frames at 1 fps). Pruned to the single most recent frame after every
   `/investigate` and `/analyze-change`. Trigger-moment data URLs are
   released as soon as the request finishes. Worst-case footprint: ~100 KB.
2. **Recent captures sub-window**. A separate, time-bounded record of every
   frame the model actually saw, with timestamp + source label. Entries
   auto-evict after `CAPTURE_TTL_MS` (default 1 min) — both proactively as
   new captures arrive and via a periodic sweep every 10 s, so old entries
   vanish even if nothing else is happening. Worst-case at peak (auto-capture
   firing on every change for 1 min): ~12 frames × 50 KB ≈ 600 KB.

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
| `JWT_SECRET` | Sign auth tokens with a real secret. **Required when `AEYES_ENV=prod`** — the dev default is `aeyes-dev-secret-change-in-prod`. |
| `AEYES_ENV` | `dev` (default) or `prod`. In `prod`, the server refuses to start unless `JWT_SECRET` is set to a non-default value. |
| `AEYES_DB_PATH` | Override the SQLite path. Defaults to `aeyes.db` next to `database.py`. Used by the Docker image to point at a mounted volume. |
| `AEYES_SKIP_SECRET_CHECK` | Set to `1` to bypass the JWT-secret check (test fixtures only — never in production). |
| `GOOGLE_MAPS_API_KEY` | Reverse-geocode lat/lon into addresses for saved locations. |

When SeeingEye is wired back into `/investigate` and `/analyze-change`, you'll
also need an `OPENAI_API_KEY` for the hosted Translator and *optionally* a
vLLM server backing the Reasoner — see "vLLM" and "Fully-hosted fallback"
below.

### Start the server

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

### Running tests

```bash
pip install -r requirements-dev.txt
pytest                                     # 41 tests, ~12 s
pytest --cov=server --cov=auth --cov=database --cov-report=term
```

CI runs the same suite on every push and PR via `.github/workflows/test.yml`.

### LAN demo on a phone (HTTPS via mkcert)

Camera, mic, geolocation, and `SpeechRecognition` only work in a "secure
context" on phones. `localhost` is exempt; LAN IPs over plain HTTP are not.
The included launcher generates a per-LAN-IP cert via `mkcert` and starts
uvicorn with TLS.

**One-time setup on the laptop:**

```bash
choco install mkcert    # or: scoop install mkcert  (macOS: brew install mkcert)
mkcert -install         # installs a local root CA into the OS trust store
```

**One-time setup on each phone** — install the mkcert root CA so the phone
trusts certs you sign locally:

```bash
mkcert -CAROOT          # prints the dir holding rootCA.pem
```

- **iOS:** AirDrop `rootCA.pem` to the phone → tap to install profile →
  Settings → General → VPN & Device Management → install. Then Settings →
  General → About → Certificate Trust Settings → toggle on the "mkcert"
  root. (Apple buries this on purpose; it's a one-time pain.)
- **Android (Chrome):** copy `rootCA.pem` to the phone → Settings → Security
  → Encryption & credentials → Install a certificate → CA certificate →
  pick the file. Some Android versions only honor user-installed roots
  inside Chrome, not all apps — Chrome is what we need.

**Each demo:**

```bash
python scripts/dev_https.py
```

The script prints both the localhost URL and the LAN URL. Open the LAN URL
on the phone (must be on the same wifi). On first load the phone prompts
for camera + mic + location — accept all three. iOS users: Share → Add to
Home Screen, then launch from the icon for fullscreen.

**When wifi changes:** the LAN IP changes too, so the cert no longer
matches. Re-run with `--regen`:

```bash
python scripts/dev_https.py --regen
```

The cached IP lives in `certs/.issued-for`; the script auto-regenerates
when it sees a mismatch, so `--regen` is mostly only needed if the cert
gets out of sync with what mkcert thinks.

### Docker

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
```

The image runs in `AEYES_ENV=prod` mode and refuses to start without a real
`JWT_SECRET`. SQLite is stored in a named volume (`aeyes-data:/app/data`) so
data survives `down`/`up`. A commented-out `caddy` service stub in
`docker-compose.yml` is the recommended TLS termination path for any public
deploy.

### Accessibility

The target user is blind/low-vision, so accessibility is treated as a hard
requirement, not a nice-to-have. What's covered:
- Skip link first in tab order.
- ARIA tabs pattern with arrow-key roving tabindex on Camera/Map and
  Login/Register tabs.
- `aria-pressed` on every toggle button (auto-capture, voice, safe mode).
- `role="status"` + `aria-live` on the response and voice-response panels.
- Focus moves into overlays on open and back to the trigger on close
  (auth → username field, dropdown → first menuitem, profile → back button).
- Escape closes the user dropdown and returns focus to the menu button.
- `prefers-reduced-motion` short-circuits splash, panel-swap, and pulse
  animations.
- High-contrast focus ring on tabs whose `.active` background is the accent.
- Decorative `alt=""` on history thumbnails (the response text alongside is
  the semantic content) to avoid SR repetition.

Test with NVDA + Firefox on Windows for primary coverage; spot-check
VoiceOver on iOS Safari for the mobile install path.

Open <http://localhost:8000> in **Chrome** (camera + microphone permissions;
`SpeechRecognition` is Chromium-only). On first visit you'll be asked to
register; on subsequent visits with a stored token, auto-capture starts
automatically. The auto-capture loop is the default running state — use
**"Stop auto-capture"** to silence it. The manual buttons override on top:
**"Describe surroundings"** for a fresh on-demand description, **"What
changed?"** for an explicit diff, **"Hold to speak"** to ask the model a
question by voice. The **"Recent captures"** panel on the right shows
thumbnails of every frame the model actually saw, auto-evicting after 1 min.

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
- `changeThreshold` (frontend, `app.js`, default 8 via `CHANGE_THRESHOLD_DEFAULT`):
  mean absolute brightness diff (0–255 scale) between consecutive 16×16 frame
  thumbnails required for the auto-capture loop to narrate. Below this, the
  tick stays silent and no request is sent. **The Calibration panel in the UI
  exposes this as a live slider** with a "Last diff" readout (green = above
  threshold, would have fired; gray = below, gated to silence). Static scenes
  typically diff at 1–3; an object moving usually diffs 10+. Tune in the room
  you'll demo in.
- `CAPTURE_TTL_MS` (frontend, `app.js`): how long thumbnails live in the
  "Recent captures" sub-window before being auto-evicted. Default 1 min.
- `CAPTURE_PRUNE_INTERVAL_MS` (frontend, `app.js`): how often the eviction
  sweep runs even when no new captures arrive. Default 10 s.
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

### Fresh database

`init_db` (in `database.py`) creates the schema on startup if missing, so
deleting the file resets all accounts and history:

```bash
rm aeyes.db && uvicorn server:app --reload
```

`aeyes.db` is `.gitignore`d, so a fresh clone starts empty. The legacy
dev-account DB is still in git history from prior commits; if those
accounts are sensitive, scrub with `git filter-repo --invert-paths --path
aeyes.db` (force-push, coordinate with collaborators).

## Cleanup follow-ups

- **JWT secret rotation.** Tokens issued under the dev default
  (`aeyes-dev-secret-change-in-prod`) remain valid against the new secret
  only if the secret is unchanged. Rotate before the first prod deploy and
  expect existing sessions to be invalidated.
- **`aeyes.db` history.** The file is no longer tracked, but historical
  commits still contain it. See `git filter-repo` note above.
