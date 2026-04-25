# Aeyes — Audio-Triggered Visual Investigation

A hackathon-style web demo that helps blind users understand their environment.
The browser listens for environmental sounds (glass breaking, rain, alarms, crashes)
with on-device YAMNet, then captures a single camera frame and asks the underlying
[SeeingEye](../README.md#about-seeingeye-the-underlying-framework) multi-agent
pipeline a *targeted* question about it. The answer is read aloud.

A second mode compares two frames sampled ~10 seconds apart to describe what changed.

## How it differs from existing accessibility apps

Most camera-based assistive apps continuously narrate what's *in front of* the user.
This one stays quiet until the *environment* triggers it — the user doesn't have to
aim a camera, the sound itself prompts the investigation.

> **Backend status — stub mode.** `server.py` currently returns canned strings
> from a `STUB_RESPONSES` map. The SeeingEye Translator → Reasoner pipeline,
> OpenAI key handling, and vLLM Reasoner described below are the *target*
> architecture and are marked with `# TODO` in `server.py`. The browser side
> (camera, YAMNet, ClipBuffer, TTS) is fully functional against the stub.

## Architecture

```
Browser:  mic    → YAMNet (TF.js)   → event label
          camera → ClipBuffer       → 10 s rolling window of JPEG frames
                       │              (sampled at 1 fps, sample()-on-demand)
                       ▼
Server:   POST /investigate {event, image_b64}
              → SeeingEye FlowExecutor (Translator → Reasoner)
          POST /analyze-change {frame0, frame1}
              → multi-image VLM call
                       │
Browser:  speechSynthesis.speak(response)
```

### Clip → frame sampling

The model takes images, not video, so the browser maintains a rolling window of
recent frames and picks representative ones per trigger. `static/clip_buffer.js`
exposes a `ClipBuffer` class that owns the window and the sampling policy:

| Strategy | Returns | Used by |
|---|---|---|
| `latest` | newest frame | (available; current `/investigate` uses `captureNow()` for a fresh moment-of-trigger snap) |
| `edges` | `[oldest, newest]` | `/analyze-change` |
| `uniform` | N evenly spaced frames across the window | reserved for future multi-image investigate |

Adding a new strategy (e.g. perceptual-hash dedup, motion keyframes) is a local
edit to `ClipBuffer.sample()` — no orchestration changes needed.

## Running it

### Prerequisites

- Install the runtime deps:
  ```bash
  pip install -r requirements.txt
  ```
- **Stub mode (current default):** nothing else required. No API keys, no GPU.
- **For the target SeeingEye pipeline (not currently wired):** an `OPENAI_API_KEY`
  for the hosted Translator (gpt-4o), and *optionally* a vLLM server running
  `Qwen/Qwen3-8B` on `http://localhost:8001/v1` to back the Reasoner. See "vLLM"
  below; if you don't have a GPU, see "Fully-hosted fallback" to skip vLLM.

### vLLM (self-hosted Reasoner — needs ~16GB VRAM)

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen3-8B \
  --port 8001 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes
```

### Fully-hosted fallback (no GPU)

Open `src/multi-agent/config/config.toml`, find the `[llm.reasoning_api]` block, and
swap it to OpenAI just like the translator:

```toml
[llm.reasoning_api]
model = "gpt-4o-mini"
api_type = "openai"
base_url = "https://api.openai.com/v1"
api_key = ""           # patched at runtime from OPENAI_API_KEY
max_tokens = 1024
temperature = 0.2
```

No code change needed in `demo/server.py` — at startup it auto-patches the
`OPENAI_API_KEY` into every config block whose `base_url` points at
`api.openai.com`.

### Start the server

```bash
# Stub mode — no API key required.
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

# Once SeeingEye is wired back in, also:
# export OPENAI_API_KEY=sk-...
```

Open <http://localhost:8000> in **Chrome** (mic + camera permissions; YAMNet via
TF.js works best on Chromium). Grant permissions when prompted. The page boots
into camera-ready state with manual trigger buttons enabled. Click **"Enable
sound detection"** to also load YAMNet and start listening on the mic.

`GET /health` returns `{"ok": true, "mode": "stub"}` today. (When SeeingEye is
reconnected it will also report whether the API key is set and which models
are configured.)

## Demo plan (stage-day)

1. Stage four small scenes in front of the camera, each paired with a trigger sound:
   - **Glass:** a (pre-broken) drinking glass and shards on a tabletop.
   - **Rain:** an open window with the camera looking outside; play a rain loop.
   - **Smoke alarm:** a slice of toast smoking on a plate; play an alarm beep.
   - **Crash:** a fallen book and lamp on the floor.
2. Pre-record short trigger clips (1–3 s each) on a phone so the demo is deterministic
   on stage. YAMNet picks them up reliably at conversational volume.
3. For each: play the clip → the page speaks "Investigating…" → SeeingEye responds
   in 5–15 s with a targeted answer.
4. Show **"What just changed?"** by quietly removing or adding an object during the
   demo, then pressing the button.
5. Mention the privacy story: raw audio never leaves the browser; only the matched
   event label and a single still frame are sent to the server.

## Knobs to tune

- `COOLDOWN_MS` (frontend, `app.js`): minimum gap between auto-triggers. Default 15 s.
- `CONFIDENCE_THRESHOLD` (frontend): YAMNet confidence required to trigger. Default 0.6.
- `CLIP_WINDOW_MS` / `CLIP_FPS` (frontend, `app.js`): rolling-window length and
  sampling rate handed to `ClipBuffer`. Default 10 s @ 1 fps. Raise the fps for
  finer change detection at the cost of more memory and per-tick JPEG encodes.
- `STUB_RESPONSES` (backend, `server.py`, **stub mode**): canned reply per event.
  Will be replaced by `EVENT_PROMPTS` (per-event investigative prompts) when
  SeeingEye is reconnected — that prompt map is the hackathon "secret sauce".
- Reasoner `max_steps` (in `src/multi-agent/config/config.toml` under `[flow]`,
  **target architecture**): drop from 3 → 1 to cut latency at the cost of
  reasoning depth.

## File map

| Path | Purpose |
|---|---|
| `server.py` | FastAPI app — `/investigate`, `/analyze-change`, `/health`. Currently stub mode; `# TODO` markers point to where SeeingEye will plug back in. |
| `requirements.txt` | Stub-mode deps (FastAPI + uvicorn). The full SeeingEye pipeline will need additional packages and an external `src/multi-agent/` checkout. |
| `static/index.html` | Minimal page: status, manual triggers, camera preview. |
| `static/app.js` | Camera init, YAMNet inference loop, TTS, trigger orchestration, fetch wiring. |
| `static/clip_buffer.js` | `ClipBuffer` class — rolling 10 s frame window with named sampling strategies (`latest` / `edges` / `uniform`). The seam between "video coming in" and "images going to the model". |
| `static/event_prompts.js` | UI label map for the "Heard: …" chip. |
| `static/style.css` | Dark theme. |
| `src/multi-agent/config/config.toml` *(target architecture, not yet active)* | `[llm.translator_api]` repointed at OpenAI; `[llm.reasoning_api]` left on local vLLM (`:8001`). |

## Limits / honest caveats

- Chrome only. Safari's `AudioContext` does not honor `{sampleRate: 16000}` reliably,
  which YAMNet needs.
- YAMNet is general-purpose; expect occasional misfires. The cool-down + confidence
  gate keeps it usable; tighten both for noisier rooms.
- Audio is the *trigger and context*, not a model input. SeeingEye is image-only.
  The detected event becomes a string baked into the prompt.
- `/analyze-change` is designed to bypass the agent loop and call the hosted VLM
  directly with both frames — the agent loop is overkill (and too slow) for a
  frame diff. (Currently stubbed.)
