// Display-only mirror of the server-side EVENT_PROMPTS map. The server is the
// source of truth for actual prompts sent to the model — this is just for the
// "what just happened" chip shown in the UI.
window.EVENT_LABELS = {
  "Glass": "Breaking glass",
  "Shatter": "Breaking glass",
  "Rain": "Heavy rain",
  "Water tap, faucet": "Running water",
  "Water": "Water sounds",
  "Smoke detector, smoke alarm": "Smoke alarm",
  "Fire alarm": "Fire alarm",
  "Smash, crash": "Crash / fall",
  "Thump, thud": "Thud / fall",
};

// YAMNet class names we treat as triggers. Anything else from YAMNet is ignored.
window.YAMNET_TRIGGER_CLASSES = new Set(Object.keys(window.EVENT_LABELS));
