# Aeyes — Auto-Capture Visual Narration

A hackathon-style web demo that helps blind users understand what's in front of
the camera. The browser captures a still every 5 seconds, sends it to the
underlying [SeeingEye](../README.md#about-seeingeye-the-underlying-framework)
multi-agent pipeline for description, and reads the answer aloud. A second mode
compares two frames sampled ~10 seconds apart to describe what has changed.

## Why no audio detection?

An earlier version listened for environmental sounds (glass breaking, alarms,
crashes) with on-device YAMNet and triggered investigations on those events.
That premise was wrong: blind users *aren't deaf*. They already hear the glass
break — what they need is for the model to tell them what they *can't* hear.
The audio detection layer was removed; the value lives in the visual
description, not in echoing what the user already perceived.

> **Backend status — stub mode.** `server.py` currently returns canned strings
> from a `STUB_RESPONSES` map. The SeeingEye Translator → Reasoner pipeline,
> OpenAI key handling, and vLLM Reasoner described below are the *target*
> architecture and are marked with `# TODO` in `server.py`. The browser side
> (camera, ClipBuffer, auto-capture loop, TTS) is fully functional against the
> stub.

## Architecture

```
Browser:  camera → ClipBuffer       → 10 s rolling window of JPEG frames
                       │              (sampled at 1 fps, sample()-on-demand)
                       │
          5 s timer ───┘   triggers /investigate with event=_describe
                       │
                       ▼
Server:   POST /investigate {event, image_b64}
              → SeeingEye FlowExecutor (Translator → Reasoner)
          POST /analyze-change {frame0, frame1}
              → multi-image VLM call
                       │
Browser:  speechSynthesis.speak(response)
                       │
                       └── after each request: clip cache pruned
                                              to most recent frame only
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
in the camera area is auto-hidden after 8 s. Worst-case memory footprint is
one to two ~50 KB JPEG strings at any moment.

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

No code change needed in `server.py` — once SeeingEye is reconnected, startup
will auto-patch the `OPENAI_API_KEY` into every config block whose `base_url`
points at `api.openai.com`.

### Start the server

```bash
# Stub mode — no API key required.
uvicorn server:app --host 0.0.0.0 --port 8000 --reload

# Once SeeingEye is wired back in, also:
# export OPENAI_API_KEY=sk-...
```

Open <http://localhost:8000> in **Chrome** (camera permission required). Grant
camera access. Click **"Start auto-capture"** to begin the 5-second narration
loop, or use **"Describe my surroundings"** / **"What just changed?"** for
on-demand requests.

`GET /health` returns `{"ok": true, "mode": "stub"}` today. (When SeeingEye is
reconnected it will also report whether the API key is set and which models
are configured.)

## Demo plan (stage-day)

1. Open the page, grant camera permissions, click **"Start auto-capture"**.
2. Stand in front of three pre-staged scenes for ~5 s each. The page speaks a
   description as soon as each one comes into frame:
   - A messy desk with a (pre-broken) glass and shards.
   - A counter with a smoking slice of toast on a plate.
   - A floor with a fallen book and lamp.
3. Show **"What just changed?"** by quietly removing or adding an object during
   the demo, then pressing the button.
4. Mention the privacy story: no frames leave the browser except for the single
   in-flight request, and the cache is pruned after each call.

## Knobs to tune

- `AUTO_CAPTURE_MS` (frontend, `app.js`): interval between automatic captures.
  Default 5 s. Raise to reduce TTS spam in slow-changing scenes; lower for
  more responsive narration.
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
| `static/index.html` | Minimal page: status, controls, camera preview, history. |
| `static/app.js` | Camera init, ClipBuffer wiring, 5-second auto-capture loop, manual buttons, TTS, fetch + cache pruning. |
| `static/clip_buffer.js` | `ClipBuffer` class — rolling 10 s frame window with named sampling strategies (`latest` / `edges` / `uniform`). The seam between "video coming in" and "images going to the model". |
| `static/style.css` | Dark theme. |
| `src/multi-agent/config/config.toml` *(target architecture, not yet active)* | `[llm.translator_api]` repointed at OpenAI; `[llm.reasoning_api]` left on local vLLM (`:8001`). |

## Limits / honest caveats

- Chrome recommended. Other browsers may work, but `getUserMedia` + the
  `image/jpeg` canvas encoder are best-tested on Chromium.
- TTS spam in stub mode: the same canned string is spoken every 5 s. Raise
  `AUTO_CAPTURE_MS` or stop the loop while iterating.
- Auto-capture is unconditional — every tick fires a request, even if the
  scene is unchanged. A planned improvement is to gate the auto-capture on
  `/analyze-change` first and only narrate when something materially differs.
- `/analyze-change` is designed to bypass the agent loop and call the hosted
  VLM directly with both frames — the agent loop is overkill (and too slow)
  for a frame diff. (Currently stubbed.)
