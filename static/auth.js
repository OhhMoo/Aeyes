// Auth state, login/register UI, profile panel, history.
// Loaded as a regular script before app.js so window.getAuthHeaders
// and window.refreshHistory are available to the app module.

const TOKEN_KEY   = "aeyes_token";
const USER_KEY    = "aeyes_user";
const DISPLAY_KEY = "aeyes_display";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getToken()      { return localStorage.getItem(TOKEN_KEY); }
function getDisplayName(){ return localStorage.getItem(DISPLAY_KEY) || localStorage.getItem(USER_KEY) || "?"; }

window.getAuthHeaders = function () {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

function setSession(token, username, displayName) {
  localStorage.setItem(TOKEN_KEY,   token);
  localStorage.setItem(USER_KEY,    username);
  localStorage.setItem(DISPLAY_KEY, displayName || username);
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(DISPLAY_KEY);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const authOverlay        = document.getElementById("auth-overlay");
const authForm           = document.getElementById("auth-form");
const authUsername       = document.getElementById("auth-username");
const authPassword       = document.getElementById("auth-password");
const authSubmitBtn      = document.getElementById("auth-submit");
const authErrorEl        = document.getElementById("auth-error");
const authTabs           = document.querySelectorAll(".auth-tab");

const appView            = document.getElementById("app-view");
const rightApp           = document.getElementById("right-app");
const rightProfile       = document.getElementById("right-profile");

const userMenuWrap       = document.getElementById("user-menu-wrap");
const userMenuBtn        = document.getElementById("user-menu-btn");
const userDropdown       = document.getElementById("user-dropdown");
const cornerAvatar       = document.getElementById("corner-avatar");
const cornerUserName     = document.getElementById("corner-user-name");
const profileBtn         = document.getElementById("profile-btn");
const logoutBtn          = document.getElementById("logout-btn");
const backBtn            = document.getElementById("back-btn");

const profileAvatar      = document.getElementById("profile-avatar");
const profileDisplayName = document.getElementById("profile-display-name-text");
const profileUsername    = document.getElementById("profile-username-text");
const profileStats       = document.getElementById("profile-stats-text");

const displayNameForm    = document.getElementById("display-name-form");
const editDisplayName    = document.getElementById("edit-display-name");
const displayNameMsg     = document.getElementById("display-name-msg");

const passwordForm       = document.getElementById("password-form");
const currentPasswordEl  = document.getElementById("current-password");
const newPasswordEl      = document.getElementById("new-password");
const passwordMsg        = document.getElementById("password-msg");

const historyListEl      = document.getElementById("history-list");

let currentTab = "login";

// ── Auth tabs ─────────────────────────────────────────────────────────────────
authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    currentTab = tab.dataset.tab;
    authTabs.forEach((t) => t.classList.toggle("active", t === tab));
    authSubmitBtn.textContent = currentTab === "login" ? "Login" : "Register";
    authErrorEl.hidden = true;
  });
});

// ── Corner dropdown ───────────────────────────────────────────────────────────
userMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  userDropdown.classList.toggle("open");
});
document.addEventListener("click", () => userDropdown.classList.remove("open"));

// ── Panel swap helpers ────────────────────────────────────────────────────────
async function fadeOutPanel(el) {
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  await sleep(200);
  el.style.display = "none";
}

async function fadeInPanel(el) {
  el.style.display = "flex";
  el.style.opacity = "0";
  await sleep(16); // one frame so display change paints first
  el.style.opacity = "1";
  el.style.pointerEvents = "auto";
}

// ── View transitions ──────────────────────────────────────────────────────────
function showApp(displayName) {
  const name = displayName || getDisplayName();
  authOverlay.hidden  = true;
  appView.hidden      = false;
  userMenuWrap.hidden = false;
  cornerAvatar.textContent   = name[0].toUpperCase();
  cornerUserName.textContent = name;
  // ensure app panel is visible, profile panel hidden
  rightApp.style.display      = "flex";
  rightApp.style.opacity      = "1";
  rightApp.style.pointerEvents = "auto";
  rightProfile.style.display  = "none";
}

function showAuth() {
  authOverlay.hidden  = false;
  appView.hidden      = true;
  userMenuWrap.hidden = true;
}

async function showProfile() {
  userDropdown.classList.remove("open");
  await fadeOutPanel(rightApp);
  await Promise.all([fetchAndRenderProfile(), loadLocations(), refreshHistory()]);
  // get coords so "Save here" button can be enabled
  pendingCoords = null;
  saveLocationBtn.disabled = true;
  _getCoords().then((c) => {
    pendingCoords = c;
    saveLocationBtn.disabled = !c;
  });
  await fadeInPanel(rightProfile);
}

async function showAppView() {
  await fadeOutPanel(rightProfile);
  await fadeInPanel(rightApp);
}

// ── Auth form ─────────────────────────────────────────────────────────────────
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) return;

  authSubmitBtn.disabled = true;
  authErrorEl.hidden = true;

  try {
    const resp = await fetch(`/auth/${currentTab}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      authErrorEl.textContent = data.detail || "Something went wrong.";
      authErrorEl.hidden = false;
    } else {
      setSession(data.token, data.username, data.display_name);
      showApp(data.display_name);
    }
  } catch {
    authErrorEl.textContent = "Network error.";
    authErrorEl.hidden = false;
  } finally {
    authSubmitBtn.disabled = false;
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
profileBtn.addEventListener("click", () => showProfile());
backBtn.addEventListener("click",    () => showAppView());
logoutBtn.addEventListener("click",  () => { clearSession(); showAuth(); });

// ── Profile data ──────────────────────────────────────────────────────────────
async function fetchAndRenderProfile() {
  try {
    const resp = await fetch("/profile", { headers: window.getAuthHeaders() });
    if (!resp.ok) return;
    const p = await resp.json();
    const initial = (p.display_name || "?")[0].toUpperCase();
    profileAvatar.textContent      = initial;
    profileDisplayName.textContent = p.display_name;
    profileUsername.textContent    = `@${p.username}`;
    profileStats.textContent       = `Member since ${p.member_since} · ${p.history_count} event${p.history_count !== 1 ? "s" : ""}`;
    editDisplayName.value          = p.display_name;
  } catch { /* non-critical */ }
}

// ── Saved locations ───────────────────────────────────────────────────────────
const saveLocationForm    = document.getElementById("save-location-form");
const locationNameInput   = document.getElementById("location-name-input");
const saveLocationBtn     = document.getElementById("save-location-btn");
const locationMsg         = document.getElementById("location-msg");
const locationsListEl     = document.getElementById("locations-list");
const locationFilterEl    = document.getElementById("history-location-filter");

let pendingCoords = null; // set when profile opens

async function _getCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      ()  => resolve(null),
      { timeout: 4000, maximumAge: 30_000 },
    );
  });
}

function populateLocationFilter(locations) {
  while (locationFilterEl.options.length > 1) locationFilterEl.remove(1);
  locations.forEach((loc) => {
    const opt = document.createElement("option");
    opt.value = loc.id;
    opt.textContent = loc.name;
    locationFilterEl.appendChild(opt);
  });
}

function renderLocations(locations) {
  if (!locations.length) {
    locationsListEl.innerHTML = '<p class="muted history-empty" style="margin:4px 0">No saved locations yet.</p>';
    return;
  }
  locationsListEl.innerHTML = locations.map((loc) => `
    <li class="location-item" data-id="${loc.id}">
      <div class="location-text">
        <span class="location-name">${loc.name}</span>
        ${loc.address ? `<span class="location-address">${loc.address}</span>` : ""}
      </div>
      <button class="location-delete" data-id="${loc.id}" aria-label="Delete ${loc.name}">✕</button>
    </li>`).join("");
}

async function loadLocations() {
  try {
    const resp = await fetch("/locations", { headers: window.getAuthHeaders() });
    if (!resp.ok) return;
    const locs = await resp.json();
    renderLocations(locs);
    populateLocationFilter(locs);
  } catch { /* non-critical */ }
}

saveLocationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = locationNameInput.value.trim();
  if (!name || !pendingCoords) return;
  hideMsg(locationMsg);
  saveLocationBtn.disabled = true;
  try {
    const resp = await fetch("/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders() },
      body: JSON.stringify({ name, ...pendingCoords }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showMsg(locationMsg, data.detail || "Error saving location.", "error");
    } else {
      showMsg(locationMsg, `"${name}" saved!`, "success");
      locationNameInput.value = "";
      await loadLocations();
      window.refreshMap?.();
    }
  } catch {
    showMsg(locationMsg, "Network error.", "error");
  } finally {
    saveLocationBtn.disabled = !pendingCoords;
  }
});

locationsListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".location-delete");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    await fetch(`/locations/${id}`, {
      method: "DELETE",
      headers: window.getAuthHeaders(),
    });
    await loadLocations();
    window.refreshMap?.();
  } catch { /* non-critical */ }
});

locationFilterEl.addEventListener("change", async () => {
  const locationId = locationFilterEl.value || null;
  const url = locationId ? `/history?location_id=${locationId}` : "/history";
  try {
    const resp = await fetch(url, { headers: window.getAuthHeaders() });
    if (resp.ok) renderHistory(await resp.json());
  } catch { /* non-critical */ }
});

// ── Edit display name ─────────────────────────────────────────────────────────
displayNameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const display_name = editDisplayName.value.trim();
  if (!display_name) return;
  hideMsg(displayNameMsg);
  try {
    const resp = await fetch("/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders() },
      body: JSON.stringify({ display_name }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showMsg(displayNameMsg, data.detail || "Error saving.", "error");
    } else {
      showMsg(displayNameMsg, "Saved!", "success");
      const initial = display_name[0].toUpperCase();
      profileAvatar.textContent      = initial;
      profileDisplayName.textContent = display_name;
      cornerAvatar.textContent       = initial;
      cornerUserName.textContent     = display_name;
      localStorage.setItem(DISPLAY_KEY, display_name);
    }
  } catch {
    showMsg(displayNameMsg, "Network error.", "error");
  }
});

// ── Change password ───────────────────────────────────────────────────────────
passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const current_password = currentPasswordEl.value;
  const new_password     = newPasswordEl.value;
  if (!current_password || !new_password) return;
  hideMsg(passwordMsg);
  try {
    const resp = await fetch("/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders() },
      body: JSON.stringify({ current_password, new_password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showMsg(passwordMsg, data.detail || "Error updating password.", "error");
    } else {
      showMsg(passwordMsg, "Password updated.", "success");
      passwordForm.reset();
    }
  } catch {
    showMsg(passwordMsg, "Network error.", "error");
  }
});

// ── History ───────────────────────────────────────────────────────────────────
function timeAgo(isoStr) {
  const s = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderHistory(entries) {
  if (!entries.length) {
    historyListEl.innerHTML = '<p class="muted history-empty">No history yet.</p>';
    return;
  }
  historyListEl.innerHTML = [...entries].reverse().map((h) => {
    const label =
      h.type === "chat"   ? "Voice chat"   :
      h.type === "change" ? "Scene change" :
      `Heard: ${h.event || h.input_text}`;
    const locChip = h.location_name
      ? `<span class="location-chip">${h.location_name}</span>` : "";
    const inputLine = h.type === "chat" && h.input_text
      ? `<p class="history-input">You: ${h.input_text}</p>` : "";
    return `<div class="history-entry">
      <div class="history-meta">
        <span class="history-label">${label}${locChip}</span>
        <span class="history-time">${timeAgo(h.created_at)}</span>
      </div>
      ${inputLine}
      <p class="history-response">${h.response}</p>
    </div>`;
  }).join("");
}

async function refreshHistory() {
  if (!getToken()) return;
  try {
    const locationId = locationFilterEl?.value || null;
    const url = locationId ? `/history?location_id=${locationId}` : "/history";
    const resp = await fetch(url, { headers: window.getAuthHeaders() });
    if (!resp.ok) return;
    renderHistory(await resp.json());
  } catch { /* non-critical */ }
}
window.refreshHistory = refreshHistory;

// ── Helpers ───────────────────────────────────────────────────────────────────
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `form-msg ${type}`;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 4000);
}
function hideMsg(el) { el.hidden = true; }

// ── Boot ──────────────────────────────────────────────────────────────────────
if (getToken() && localStorage.getItem(USER_KEY)) {
  showApp(getDisplayName());
} else {
  showAuth();
}
