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
  el.style.pointerEvents = "";
  await sleep(16); // one frame so display change paints first
  el.style.opacity = "1";
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
  rightApp.style.pointerEvents = "";
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
  await fetchAndRenderProfile();
  await refreshHistory();
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
    const inputLine = h.type === "chat" && h.input_text
      ? `<p class="history-input">You: ${h.input_text}</p>` : "";
    return `<div class="history-entry">
      <div class="history-meta">
        <span class="history-label">${label}</span>
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
    const resp = await fetch("/history", { headers: window.getAuthHeaders() });
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
