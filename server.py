"""
Aeyes hackathon demo backend.

Endpoints:
  POST /investigate       — audio-event-triggered single-frame scene investigation
                            (runs the full SeeingEye Translator → Reasoner pipeline)
  POST /analyze-change    — compare two frames sampled 10s apart
                            (direct multi-image VLM call for speed)
  GET  /health            — readiness probe; reports whether OPENAI_API_KEY is set

The demo serves its frontend from ./static at the root path.
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

DEMO_DIR = Path(__file__).resolve().parent
SEEINGEYE_DIR = DEMO_DIR.parent / "src" / "multi-agent"
sys.path.insert(0, str(SEEINGEYE_DIR))

from app.config import config as seeingeye_config

_OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
if _OPENAI_KEY:
    for _name, _settings in seeingeye_config.llm.items():
        if _settings.api_type == "openai" and "api.openai.com" in _settings.base_url:
            _settings.api_key = _OPENAI_KEY
else:
    print("WARNING: OPENAI_API_KEY is not set; /investigate and /analyze-change will fail.", flush=True)

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.flow.flow_executor import FlowExecutor

app = FastAPI(title="Aeyes Demo")

EVENT_PROMPTS: dict[str, str] = {
    "Glass": "I just heard breaking glass. Look at this image and identify what broke and where in the scene. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Shatter": "I just heard breaking glass. Look at this image and identify what broke and where in the scene. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Rain": "I just heard heavy rain or running water. Look at this image and check whether any windows, taps, or doors are open. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Water tap, faucet": "I just heard running water. Look at this image and check whether any tap or faucet is open. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Water": "I just heard water sounds. Look at this image and check whether any windows, taps, or doors are open. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Smoke detector, smoke alarm": "I just heard a smoke alarm. Look at this image, look for any visible smoke, fire, or steam, and identify its source. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Fire alarm": "I just heard a fire alarm. Look at this image, look for any visible smoke, fire, or steam, and identify its source. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Smash, crash": "I just heard something fall or crash. Look at this image and tell me what appears to have fallen and where. Reply in 1-2 sentences spoken plainly to a blind user.",
    "Thump, thud": "I just heard a thud. Look at this image and tell me what appears to have fallen and where. Reply in 1-2 sentences spoken plainly to a blind user.",
    "_describe": "Briefly describe what is in front of the camera, focused on anything notable, hazardous, or out of place. Reply in 1-2 sentences spoken plainly to a blind user.",
    "_change": "Compare these two frames taken about 10 seconds apart. Describe what has changed in the scene. Reply in 1-2 sentences spoken plainly to a blind user.",
}
DEFAULT_PROMPT = (
    "I just heard a notable sound. Briefly describe what in this scene might be related. "
    "Reply in 1-2 sentences spoken plainly to a blind user."
)

_executor: Optional[FlowExecutor] = None
_executor_lock = asyncio.Lock()


async def _get_executor() -> FlowExecutor:
    global _executor
    async with _executor_lock:
        if _executor is None:
            _executor = FlowExecutor()
        return _executor


def _decode_to_temp_jpeg(b64: str) -> Path:
    payload = b64.split(",", 1)[1] if "," in b64 else b64
    data = base64.b64decode(payload)
    fd, path_str = tempfile.mkstemp(suffix=".jpg", prefix="aeyes_")
    os.close(fd)
    path = Path(path_str)
    path.write_bytes(data)
    return path


class InvestigateReq(BaseModel):
    event: str
    image_b64: str


class InvestigateResp(BaseModel):
    event: str
    prompt: str
    response: str
    elapsed_seconds: float
    success: bool


@app.post("/investigate", response_model=InvestigateResp)
async def investigate(req: InvestigateReq) -> InvestigateResp:
    prompt = EVENT_PROMPTS.get(req.event, DEFAULT_PROMPT)
    image_path = _decode_to_temp_jpeg(req.image_b64)
    try:
        executor = await _get_executor()
        result = await executor.execute_async(input_text=prompt, image_path=str(image_path))
    finally:
        try:
            image_path.unlink(missing_ok=True)
        except OSError:
            pass
    return InvestigateResp(
        event=req.event,
        prompt=prompt,
        response=str(result.get("response", "")),
        elapsed_seconds=float(result.get("execution_time_seconds", 0.0)),
        success=bool(result.get("success", False)),
    )


class ChangeReq(BaseModel):
    frame0_b64: str
    frame1_b64: str


class ChangeResp(BaseModel):
    response: str
    elapsed_seconds: float
    success: bool


@app.post("/analyze-change", response_model=ChangeResp)
async def analyze_change(req: ChangeReq) -> ChangeResp:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=_OPENAI_KEY, base_url="https://api.openai.com/v1")
    f0 = req.frame0_b64.split(",", 1)[-1]
    f1 = req.frame1_b64.split(",", 1)[-1]

    start = time.time()
    try:
        completion = await client.chat.completions.create(
            model="gpt-4o",
            max_tokens=200,
            temperature=0.2,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": EVENT_PROMPTS["_change"]},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{f0}"}},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{f1}"}},
                    ],
                }
            ],
        )
        text = completion.choices[0].message.content or ""
        return ChangeResp(response=text, elapsed_seconds=round(time.time() - start, 2), success=True)
    except Exception as e:
        return ChangeResp(response=f"Error: {e}", elapsed_seconds=round(time.time() - start, 2), success=False)


STATIC_DIR = DEMO_DIR / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "openai_key_set": bool(_OPENAI_KEY),
        "translator_model": seeingeye_config.llm.get("translator_api").model
        if "translator_api" in seeingeye_config.llm
        else None,
        "reasoning_model": seeingeye_config.llm.get("reasoning_api").model
        if "reasoning_api" in seeingeye_config.llm
        else None,
    }
