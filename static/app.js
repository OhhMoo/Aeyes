// Aeyes demo — frontend orchestration.
//
// Pipelines:
//   (a) Auto-capture timer       -> /investigate (event=_describe), every AUTO_CAPTURE_MS
//   (b) Manual "describe"        -> /investigate (event=_describe)
//   (c) Manual "what changed"    -> /analyze-change (oldest+newest frame from rolling buffer)
//
// All capture paths funnel through `runInvestigation(event)` so status / TTS
// behave consistently. There is no audio detection: blind users already hear
// what's happening — the model's job is to describe what they cannot.
//
// No frames are persisted. The ClipBuffer is a fixed-size rolling window in
// memory; on each auto-capture the buffer is collapsed to the latest frame
// (kept solely so /analyze-change has something to diff against), and the
// trigger-moment data URL is dropped as soon as the request finishes.

const AUTO_CAPTURE_MS = 5_000;
const CLIP_WINDOW_MS = 10_000;
const CLIP_FPS = 1;

const $ = (id) => document.getElementById(id);
const statusEl = $("status-text");
const responseEl = $("response-text");
const latencyChipEl = $("latency-chip");
const autoBtn = $("auto-btn");
const describeBtn = $("describe-btn");
const changeBtn = $("change-btn");
const cameraEl = $("camera");
const captureCanvas = $("capture-canvas");
const lastFrameImg = $("last-frame");
const historySectionEl = $("history-section");
const historyListEl = $("history-list");

const HISTORY_MAX = 3;

let busy = false;
let clipBuffer = null;
let autoCaptureTimer = null;
const history = [];

// ---------------- TTS ----------------
function speak(text, opts = {}) {
  if (!("speechSynthesis" in window)) return;
  if (opts.cancel !== false) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = opts.rate ?? 1.05;
  u.pitch = opts.pitch ?? 1.0;
  speechSynthesis.speak(u);
}

function setStatus(text, state) {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

function showResponse(text) {
  responseEl.textContent = text;
  responseEl.hidden = !text;
}

function showLatency(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) {
    latencyChipEl.hidden = true;
    return;
  }
  latencyChipEl.textContent = `Responded in ${seconds.toFixed(2)}s`;
  latencyChipEl.hidden = false;
}

function eventLabelFor(eventKey) {
  if (eventKey === "_describe") return "Describe";
  if (eventKey === "_change") return "What changed";
  if (eventKey === "_auto") return "Auto-capture";
  return eventKey;
}

function pushHistory(eventKey, text, elapsed) {
  history.unshift({ ts: Date.now(), eventLabel: eventLabelFor(eventKey), text, elapsed });
  while (history.length > HISTORY_MAX) history.pop();
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historySectionEl.hidden = true;
    historyListEl.textContent = "";
    return;
  }
  historySectionEl.hidden = false;
  historyListEl.textContent = "";
  for (const item of history) {
    const li = document.createElement("li");
    li.textContent = item.text;
    const meta = document.createElement("span");
    meta.className = "h-meta";
    const t = new Date(item.ts).toLocaleTimeString();
    const elapsed = typeof item.elapsed === "number" ? `${item.elapsed.toFixed(2)}s` : "—";
    meta.textContent = `${item.eventLabel} · ${t} · ${elapsed}`;
    li.appendChild(meta);
    historyListEl.appendChild(li);
  }
}

// ---------------- Camera + frame buffer ----------------
async function initCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "environment" },
    audio: false,
  });
  cameraEl.srcObject = stream;
  await new Promise((r) => (cameraEl.onloadedmetadata = r));
  captureCanvas.width = cameraEl.videoWidth;
  captureCanvas.height = cameraEl.videoHeight;

  clipBuffer = new window.ClipBuffer({
    windowMs: CLIP_WINDOW_MS,
    fps: CLIP_FPS,
    captureFn: () => (cameraEl.readyState < 2 ? null : captureFrameDataUrl()),
  });
  clipBuffer.start();
}

function captureFrameDataUrl() {
  const ctx = captureCanvas.getContext("2d");
  ctx.drawImage(cameraEl, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL("image/jpeg", 0.85);
}

function showLastFrame(dataUrl) {
  lastFrameImg.src = dataUrl;
  lastFrameImg.hidden = false;
  cameraEl.style.display = "none";
  setTimeout(() => {
    cameraEl.style.display = "";
    lastFrameImg.hidden = true;
  }, 8000);
}

// Drop everything except the most recent frame, so the rolling window doesn't
// hold sent frames longer than necessary. /analyze-change still has the latest
// to diff against on its next call.
function pruneClipCache() {
  if (!clipBuffer) return;
  const last = clipBuffer.latest();
  clipBuffer.frames.length = 0;
  if (last) clipBuffer.frames.push(last);
}

// ---------------- Trigger handlers ----------------
async function runInvestigation(eventKey) {
  if (busy) return;
  if (cameraEl.readyState < 2) {
    setStatus("Camera not ready", "error");
    return;
  }
  busy = true;
  showResponse("");
  showLatency(null);

  setStatus("Investigating…", "investigating");
  let triggerFrame = clipBuffer.captureNow();
  if (!triggerFrame) {
    setStatus("Camera not ready", "error");
    busy = false;
    return;
  }
  showLastFrame(triggerFrame.dataUrl);

  const tStart = performance.now();
  try {
    const resp = await fetch("/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventKey, image_b64: triggerFrame.dataUrl }),
    });
    const data = await resp.json();
    const wallElapsed = (performance.now() - tStart) / 1000;
    const elapsed = typeof data.elapsed_seconds === "number" ? data.elapsed_seconds : wallElapsed;
    if (!data.success) {
      setStatus("Something went wrong.", "error");
      showResponse(data.response || "");
      speak("Something went wrong with the investigation.");
    } else {
      setStatus(autoCaptureTimer ? "Auto-capturing." : "Ready.", autoCaptureTimer ? "listening" : null);
      showResponse(data.response);
      showLatency(elapsed);
      pushHistory(eventKey, data.response, elapsed);
      speak(data.response);
    }
  } catch (e) {
    setStatus("Network error.", "error");
    speak("Network error.");
    console.error(e);
  } finally {
    triggerFrame = null; // release reference to the trigger frame's data URL
    pruneClipCache();
    busy = false;
  }
}

async function runChangeAnalysis() {
  if (busy) return;
  if (!clipBuffer || clipBuffer.length() < 2) {
    speak("Not enough video history yet. Wait a few more seconds.");
    return;
  }
  busy = true;
  setStatus("Comparing the last few seconds…", "investigating");
  speak("Comparing the scene.");
  showResponse("");
  showLatency(null);

  let [oldest, newest] = clipBuffer.sample("edges");
  showLastFrame(newest.dataUrl);

  const tStart = performance.now();
  try {
    const resp = await fetch("/analyze-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frame0_b64: oldest.dataUrl, frame1_b64: newest.dataUrl }),
    });
    const data = await resp.json();
    const wallElapsed = (performance.now() - tStart) / 1000;
    const elapsed = typeof data.elapsed_seconds === "number" ? data.elapsed_seconds : wallElapsed;
    if (!data.success) {
      setStatus("Something went wrong.", "error");
      showResponse(data.response || "");
      speak("Could not compare the scene.");
    } else {
      setStatus(autoCaptureTimer ? "Auto-capturing." : "Ready.", autoCaptureTimer ? "listening" : null);
      showResponse(data.response);
      showLatency(elapsed);
      pushHistory("_change", data.response, elapsed);
      speak(data.response);
    }
  } catch (e) {
    setStatus("Network error.", "error");
    speak("Network error.");
    console.error(e);
  } finally {
    oldest = null;
    newest = null;
    pruneClipCache();
    busy = false;
  }
}

// ---------------- Auto-capture loop ----------------
function startAutoCapture() {
  if (autoCaptureTimer !== null) return;
  autoCaptureTimer = setInterval(() => {
    if (busy) return; // skip ticks that overlap an in-flight request
    runInvestigation("_describe");
  }, AUTO_CAPTURE_MS);
  setStatus("Auto-capturing.", "listening");
  autoBtn.textContent = "Stop auto-capture";
  autoBtn.dataset.state = "running";
  speak("Auto capture started.");
  // Fire one immediately so the user gets feedback in <5 s.
  runInvestigation("_describe");
}

function stopAutoCapture() {
  if (autoCaptureTimer === null) return;
  clearInterval(autoCaptureTimer);
  autoCaptureTimer = null;
  setStatus("Ready.");
  autoBtn.textContent = "Start auto-capture";
  delete autoBtn.dataset.state;
  speak("Auto capture stopped.");
}

// ---------------- Wiring ----------------
autoBtn.addEventListener("click", () => {
  if (autoCaptureTimer === null) startAutoCapture();
  else stopAutoCapture();
});

describeBtn.addEventListener("click", () => runInvestigation("_describe"));
changeBtn.addEventListener("click", () => runChangeAnalysis());

// ---------------- Boot ----------------
(async () => {
  try {
    await initCamera();
    setStatus("Ready. Start auto-capture or use a manual button.");
    describeBtn.disabled = false;
    changeBtn.disabled = false;
    autoBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("Camera permission denied. Reload and grant camera access.", "error");
  }
})();
