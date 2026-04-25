"""
Aeyes demo backend — stub mode (SeeingEye not yet wired in).

Endpoints:
  POST /investigate       — returns a stub response
  POST /analyze-change    — returns a stub response
  GET  /health            — readiness probe
"""
from __future__ import annotations

import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DEMO_DIR = Path(__file__).resolve().parent
STATIC_DIR = DEMO_DIR / "static"

app = FastAPI(title="Aeyes Demo (stub)")

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


# TODO: replace this stub with the real SeeingEye FlowExecutor once integrated
@app.post("/investigate", response_model=InvestigateResp)
async def investigate(req: InvestigateReq) -> InvestigateResp:
    start = time.time()
    response = STUB_RESPONSES.get(req.event, DEFAULT_STUB)
    return InvestigateResp(
        event=req.event,
        prompt="(stub)",
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


# TODO: replace this stub with the real multi-image VLM call once integrated
@app.post("/analyze-change", response_model=ChangeResp)
async def analyze_change(_req: ChangeReq) -> ChangeResp:
    start = time.time()
    return ChangeResp(
        response=STUB_RESPONSES["_change"],
        elapsed_seconds=round(time.time() - start, 3),
        success=True,
    )


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "mode": "stub"}
