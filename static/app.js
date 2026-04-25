// Aeyes demo — frontend orchestration.
//
// Pipelines:
//   (a) Audio event (YAMNet) -> /investigate
//   (b) Manual button        -> /investigate
//   (c) Manual "describe"    -> /investigate (event=_describe)
//   (d) Manual "what changed"-> /analyze-change (oldest+newest frame from rolling buffer)
//
// All triggers funnel through `runInvestigation(event)` so cooldown / status / TTS
// behave consistently.

const COOLDOWN_MS = 15_000;
const CONFIDENCE_THRESHOLD = 0.6;
const YAMNET_HUB_URL = "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1";
const YAMNET_LABELS_URL =
  "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv";
const FRAME_BUFFER_LEN = 11; // ~1 frame/sec, we want oldest = 10s ago
const FRAME_INTERVAL_MS = 1_000;

const $ = (id) => document.getElementById(id);
const statusEl = $("status-text");
const eventChipEl = $("event-chip");
const responseEl = $("response-text");
const enableMicBtn = $("enable-mic");
const describeBtn = $("describe-btn");
const changeBtn = $("change-btn");
const cameraEl = $("camera");
const captureCanvas = $("capture-canvas");
const lastFrameImg = $("last-frame");
const voiceBtn = $("voice-btn");
const voiceTranscriptEl = $("voice-transcript");
const voiceResponseEl = $("voice-response");

let lastTriggerAt = 0;
let busy = false;
let yamnetModel = null;
let yamnetLabels = null;
let audioCtx = null;
let micEnabled = false;
const frameBuffer = []; // {ts, dataUrl}

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

function showEvent(eventKey) {
  if (!eventKey || eventKey.startsWith("_")) {
    eventChipEl.hidden = true;
    return;
  }
  const label = window.EVENT_LABELS[eventKey] || eventKey;
  eventChipEl.textContent = `Heard: ${label}`;
  eventChipEl.hidden = false;
}

function showResponse(text) {
  responseEl.textContent = text;
  responseEl.hidden = !text;
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
  setInterval(snapshotIntoBuffer, FRAME_INTERVAL_MS);
}

function captureFrameDataUrl() {
  const ctx = captureCanvas.getContext("2d");
  ctx.drawImage(cameraEl, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL("image/jpeg", 0.85);
}

function snapshotIntoBuffer() {
  if (cameraEl.readyState < 2) return;
  const dataUrl = captureFrameDataUrl();
  frameBuffer.push({ ts: Date.now(), dataUrl });
  while (frameBuffer.length > FRAME_BUFFER_LEN) frameBuffer.shift();
}

function showLastFrame(dataUrl) {
  lastFrameImg.src = dataUrl;
  lastFrameImg.hidden = false;
  cameraEl.style.display = "none"; // swap preview for the captured still
  setTimeout(() => {
    cameraEl.style.display = "";
    lastFrameImg.hidden = true;
  }, 8000);
}

// ---------------- YAMNet ----------------
async function loadYamnet() {
  setStatus("Loading audio model…");
  const labelsResp = await fetch(YAMNET_LABELS_URL);
  if (!labelsResp.ok) throw new Error(`labels fetch ${labelsResp.status}`);
  const csv = await labelsResp.text();
  yamnetLabels = csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",").slice(2).join(",").replace(/^"|"$/g, ""))
    .filter((s) => s);

  yamnetModel = await tf.loadGraphModel(YAMNET_HUB_URL, { fromTFHub: true });
}

function predictTopClass(samples) {
  // samples: Float32Array, 16kHz mono. Returns {label, score} or null.
  return tf.tidy(() => {
    const input = tf.tensor1d(samples);
    const out = yamnetModel.execute(input);
    const scoresTensor = Array.isArray(out)
      ? out.find((t) => t.shape.length === 2 && t.shape[1] === 521)
      : out;
    if (!scoresTensor) return null;
    const scores = scoresTensor.mean(0); // average over frames
    const arr = scores.dataSync();
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > bestVal) {
        bestVal = arr[i];
        bestIdx = i;
      }
    }
    return { label: yamnetLabels[bestIdx], score: bestVal };
  });
}

// ---------------- Audio capture ----------------
async function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (audioCtx.sampleRate !== 16000) {
    console.warn(`AudioContext sampleRate is ${audioCtx.sampleRate}, expected 16000. YAMNet predictions may be unreliable.`);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: false },
    video: false,
  });
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination);

  const ringBuffer = new Float32Array(16000); // 1 second
  let writeIdx = 0;
  let lastInferAt = 0;

  processor.onaudioprocess = (ev) => {
    const data = ev.inputBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      ringBuffer[writeIdx] = data[i];
      writeIdx = (writeIdx + 1) % ringBuffer.length;
    }
    const now = performance.now();
    if (now - lastInferAt < 500) return;
    if (busy) return;
    if (!yamnetModel) return;
    lastInferAt = now;
    const samples = new Float32Array(ringBuffer.length);
    for (let i = 0; i < ringBuffer.length; i++) {
      samples[i] = ringBuffer[(writeIdx + i) % ringBuffer.length];
    }
    const top = predictTopClass(samples);
    if (!top) return;
    if (
      window.YAMNET_TRIGGER_CLASSES.has(top.label) &&
      top.score >= CONFIDENCE_THRESHOLD &&
      Date.now() - lastTriggerAt >= COOLDOWN_MS
    ) {
      runInvestigation(top.label);
    }
  };
}

// ---------------- Trigger handlers ----------------
async function runInvestigation(eventKey) {
  if (busy) return;
  if (Date.now() - lastTriggerAt < COOLDOWN_MS && !eventKey.startsWith("_")) return;
  if (cameraEl.readyState < 2) {
    setStatus("Camera not ready", "error");
    return;
  }
  busy = true;
  lastTriggerAt = Date.now();
  showEvent(eventKey);
  showResponse("");

  setStatus("Investigating…", "investigating");
  speak("Investigating.");
  const dataUrl = captureFrameDataUrl();
  showLastFrame(dataUrl);

  try {
    const resp = await fetch("/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders?.() },
      body: JSON.stringify({ event: eventKey, image_b64: dataUrl }),
    });
    const data = await resp.json();
    if (!data.success) {
      setStatus("Something went wrong.", "error");
      showResponse(data.response || "");
      speak("Something went wrong with the investigation.");
    } else {
      setStatus(micEnabled ? "Listening." : "Ready.", micEnabled ? "listening" : null);
      showResponse(data.response);
      speak(data.response);
      window.refreshHistory?.();
    }
  } catch (e) {
    setStatus("Network error.", "error");
    speak("Network error.");
    console.error(e);
  } finally {
    busy = false;
  }
}

async function runChangeAnalysis() {
  if (busy) return;
  if (frameBuffer.length < 2) {
    speak("Not enough video history yet. Wait a few more seconds.");
    return;
  }
  busy = true;
  setStatus("Comparing the last few seconds…", "investigating");
  speak("Comparing the scene.");
  showEvent("_change");
  showResponse("");

  const oldest = frameBuffer[0];
  const newest = frameBuffer[frameBuffer.length - 1];
  showLastFrame(newest.dataUrl);

  try {
    const resp = await fetch("/analyze-change", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders?.() },
      body: JSON.stringify({ frame0_b64: oldest.dataUrl, frame1_b64: newest.dataUrl }),
    });
    const data = await resp.json();
    if (!data.success) {
      setStatus("Something went wrong.", "error");
      showResponse(data.response || "");
      speak("Could not compare the scene.");
    } else {
      setStatus(micEnabled ? "Listening." : "Ready.", micEnabled ? "listening" : null);
      showResponse(data.response);
      speak(data.response);
      window.refreshHistory?.();
    }
  } catch (e) {
    setStatus("Network error.", "error");
    speak("Network error.");
    console.error(e);
  } finally {
    busy = false;
  }
}

// ---------------- Wiring ----------------
enableMicBtn.addEventListener("click", async () => {
  enableMicBtn.disabled = true;
  try {
    await loadYamnet();
    await initAudio();
    micEnabled = true;
    enableMicBtn.textContent = "Sound detection active";
    setStatus("Listening.", "listening");
    speak("Sound detection is active.");
  } catch (e) {
    console.error(e);
    setStatus("Could not start sound detection. Use manual triggers below.", "error");
    enableMicBtn.disabled = false;
    enableMicBtn.textContent = "Retry sound detection";
  }
});

describeBtn.addEventListener("click", () => runInvestigation("_describe"));
changeBtn.addEventListener("click", () => runChangeAnalysis());

document.querySelectorAll("button.manual").forEach((btn) => {
  btn.addEventListener("click", () => {
    const ev = btn.dataset.event;
    if (ev) {
      lastTriggerAt = 0; // manual buttons bypass cooldown
      runInvestigation(ev);
    }
  });
});

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

voiceBtn.addEventListener("mouseup", () => {
  recognition?.stop();
});

voiceBtn.addEventListener("mouseleave", () => {
  recognition?.stop();
});

// ---------------- Boot ----------------
(async () => {
  try {
    await initCamera();
    setStatus("Ready. Enable sound detection or use a manual trigger.");
    describeBtn.disabled = false;
    changeBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("Camera permission denied. Reload and grant camera access.", "error");
  }
})();
