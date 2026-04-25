// Aeyes demo — frontend orchestration.
//
// Pipelines:
//   (a) Auto-capture timer       -> /investigate (event=_describe), every AUTO_CAPTURE_MS
//   (b) Manual "describe"        -> /investigate (event=_describe)
//   (c) Manual "what changed"    -> /analyze-change (oldest+newest frame from rolling buffer)
//   (d) Hold-to-speak voice chat -> /chat (transcript + ElevenLabs audio reply)
//
// All capture paths funnel through `runInvestigation(event)` so status / TTS
// behave consistently. There is no audio classification: blind users already
// hear what's happening — the model's job is to describe what they cannot.
//
// History is server-driven when the user is logged in (auth.js owns the
// rendering via window.refreshHistory). When unauthenticated, requests still
// work; they just aren't persisted.
//
// No frames are persisted on disk. The ClipBuffer is a fixed-size rolling
// window in memory; on each request the buffer is collapsed to the latest
// frame (kept solely so /analyze-change has something to diff against), and
// the trigger-moment data URL is dropped as soon as the request finishes.

const AUTO_CAPTURE_MS = 5_000;
const CLIP_WINDOW_MS = 10_000;
const CLIP_FPS = 1;

// Perceptual-hash threshold for the auto-capture change gate. Scale is the
// mean absolute brightness difference per pixel between two 16×16 thumbnails
// (0–255). ~3 corresponds to "no perceptible change", ~10+ corresponds to
// "an object moved or appeared". Tune lower for chatty, higher for terse.
const CHANGE_THRESHOLD = 8;

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
const voiceBtn = $("voice-btn");
const voiceTranscriptEl = $("voice-transcript");
const voiceResponseEl = $("voice-response");

let busy = false;
let clipBuffer = null;
let autoCaptureTimer = null;
let lastNarrationHash = null; // 16×16 grayscale thumbnail of the last frame we spoke about
let firstAutoTick = true;     // first tick of an auto-capture run uses /investigate to seed the baseline

// Reusable 16×16 canvas for the perceptual hash — avoids allocating per tick.
const HASH_CANVAS = document.createElement("canvas");
HASH_CANVAS.width = 16;
HASH_CANVAS.height = 16;

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

// 16×16 grayscale thumbnail of the live camera frame. Returns a Uint8Array
// of 256 brightness values, or null if the camera isn't ready.
function frameHash() {
  if (cameraEl.readyState < 2) return null;
  const ctx = HASH_CANVAS.getContext("2d");
  ctx.drawImage(cameraEl, 0, 0, 16, 16);
  const data = ctx.getImageData(0, 0, 16, 16).data;
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    out[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  }
  return out;
}

// Mean absolute difference between two 256-byte hashes. Range 0–255.
function hashDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
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
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders?.() },
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
      speak(data.response);
      window.refreshHistory?.();
    }
  } catch (e) {
    setStatus("Network error.", "error");
    speak("Network error.");
    console.error(e);
  } finally {
    triggerFrame = null; // release the trigger frame's data URL
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
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders?.() },
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
      speak(data.response);
      window.refreshHistory?.();
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
//
// Each tick perceptually hashes the live frame and only narrates when the
// scene has changed enough vs. the last frame we spoke about. The first tick
// of a run always narrates (gives the user a baseline description). Subsequent
// ticks route through /analyze-change so the model describes *what changed*
// rather than re-describing the whole scene.
function autoCaptureTick() {
  if (busy) return;
  const h = frameHash();
  if (!h) return;

  if (firstAutoTick || lastNarrationHash === null) {
    firstAutoTick = false;
    lastNarrationHash = h;
    runInvestigation("_describe");
    return;
  }

  const diff = hashDiff(lastNarrationHash, h);
  if (diff < CHANGE_THRESHOLD) {
    // Scene hasn't changed enough to be worth narrating. Stay silent.
    return;
  }

  lastNarrationHash = h;
  // Prefer /analyze-change for a "what changed" framing. Fall back to
  // /investigate if the rolling buffer doesn't yet have two frames (rare —
  // happens only right after a prune).
  if (clipBuffer && clipBuffer.length() >= 2) {
    runChangeAnalysis();
  } else {
    runInvestigation("_describe");
  }
}

function startAutoCapture() {
  if (autoCaptureTimer !== null) return;
  firstAutoTick = true;
  lastNarrationHash = null;
  autoCaptureTimer = setInterval(autoCaptureTick, AUTO_CAPTURE_MS);
  setStatus("Auto-capturing.", "listening");
  autoBtn.textContent = "Stop auto-capture";
  autoBtn.dataset.state = "running";
  speak("Auto capture started.");
  // Fire one immediately so the user gets feedback in <5 s.
  autoCaptureTick();
}

function stopAutoCapture() {
  if (autoCaptureTimer === null) return;
  clearInterval(autoCaptureTimer);
  autoCaptureTimer = null;
  lastNarrationHash = null;
  firstAutoTick = true;
  setStatus("Ready.");
  autoBtn.textContent = "Start auto-capture";
  delete autoBtn.dataset.state;
  speak("Auto capture stopped.");
}

// ---------------- Voice chat ----------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let voiceBusy = false;

function initRecognition() {
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.continuous = false;
  r.interimResults = false;
  r.lang = "en-US";
  return r;
}

async function playAudioB64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  await audio.play();
  audio.onended = () => URL.revokeObjectURL(url);
}

async function runChat(text) {
  voiceBusy = true;
  voiceTranscriptEl.textContent = `You: ${text}`;
  voiceTranscriptEl.hidden = false;
  voiceResponseEl.textContent = "…";
  voiceResponseEl.hidden = false;

  try {
    const resp = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders?.() },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    voiceResponseEl.textContent = data.response;
    if (data.audio_b64) {
      await playAudioB64(data.audio_b64);
    } else {
      speak(data.response, { cancel: false });
    }
    window.refreshHistory?.();
  } catch (e) {
    voiceResponseEl.textContent = "Network error.";
    console.error(e);
  } finally {
    voiceBusy = false;
  }
}

voiceBtn.addEventListener("mousedown", () => {
  if (voiceBusy) return;
  if (!SpeechRecognition) {
    voiceTranscriptEl.textContent = "Speech recognition not supported in this browser. Use Chrome.";
    voiceTranscriptEl.hidden = false;
    return;
  }

  recognition = initRecognition();
  voiceBtn.classList.add("recording");
  voiceBtn.textContent = "Listening…";

  recognition.onresult = (ev) => {
    const text = ev.results[0][0].transcript.trim();
    if (text) runChat(text);
  };

  recognition.onerror = (ev) => {
    console.error("SpeechRecognition error", ev.error);
    voiceTranscriptEl.textContent = `Mic error: ${ev.error}`;
    voiceTranscriptEl.hidden = false;
  };

  recognition.onend = () => {
    voiceBtn.classList.remove("recording");
    voiceBtn.textContent = "Hold to speak";
  };

  recognition.start();
});

voiceBtn.addEventListener("mouseup", () => recognition?.stop());
voiceBtn.addEventListener("mouseleave", () => recognition?.stop());

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
