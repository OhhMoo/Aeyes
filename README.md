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

## Architecture

```
Browser:  mic → YAMNet (TF.js) → event label
          camera → JPEG snapshot
                       │
                       ▼
Server:   POST /investigate {event, image_b64}
              → SeeingEye FlowExecutor (Translator → Reasoner)
          POST /analyze-change {frame0, frame1}
              → multi-image VLM call
                       │
Browser:  speechSynthesis.speak(response)
```

## Running it

### Prerequisites

- The repo's `requirements.txt` already includes `fastapi` and `uvicorn`. Install with:
  ```bash
  pip install -r requirements.txt
  ```
- An `OPENAI_API_KEY` for the hosted Translator (gpt-4o, used in `/investigate` and `/analyze-change`).
- *Optional but the "real SeeingEye stack" path:* a vLLM server running `Qwen/Qwen3-8B`
  on `http://localhost:8001/v1` to back the Reasoner agent. See "vLLM" below. If you
  don't have a GPU, see "Fully-hosted fallback" below to skip vLLM.

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
export OPENAI_API_KEY=sk-...
cd demo
uvicorn server:app --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000> in **Chrome** (mic + camera permissions; YAMNet via
TF.js works best on Chromium). Grant permissions when prompted. The page boots
into camera-ready state with manual trigger buttons enabled. Click **"Enable
sound detection"** to also load YAMNet and start listening on the mic.

`GET /health` reports whether the API key is set and which models are configured.

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
- `EVENT_PROMPTS` (backend, `server.py`): the per-event investigative prompt. The
  hackathon "secret sauce" — hand-crafting these per class gives much better answers
  than a generic template.
- Reasoner `max_steps` (in `src/multi-agent/config/config.toml` under `[flow]`): drop
  from 3 → 1 to cut latency at the cost of reasoning depth.

## File map

| Path | Purpose |
|---|---|
| `demo/server.py` | FastAPI app — `/investigate`, `/analyze-change`, `/health`. Patches `OPENAI_API_KEY` into the SeeingEye config singleton at startup. |
| `demo/static/index.html` | Minimal page: status, manual triggers, camera preview. |
| `demo/static/app.js` | Camera capture, 10 s frame buffer, YAMNet inference loop, TTS, fetch wiring. |
| `demo/static/event_prompts.js` | UI label map for the "Heard: …" chip. |
| `demo/static/style.css` | Dark theme. |
| `src/multi-agent/config/config.toml` | `[llm.translator_api]` repointed at OpenAI; `[llm.reasoning_api]` left on local vLLM (`:8001`). |

## Limits / honest caveats

- Chrome only. Safari's `AudioContext` does not honor `{sampleRate: 16000}` reliably,
  which YAMNet needs.
- YAMNet is general-purpose; expect occasional misfires. The cool-down + confidence
  gate keeps it usable; tighten both for noisier rooms.
- Audio is the *trigger and context*, not a model input. SeeingEye is image-only.
  The detected event becomes a string baked into the prompt.
- `/analyze-change` bypasses the agent loop and calls the hosted VLM directly with
  both frames — the agent loop is overkill (and too slow) for a frame diff.
