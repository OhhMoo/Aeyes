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
    authTabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    authSubmitBtn.textContent = currentTab === "login" ? "Login" : "Register";
    authErrorEl.hidden = true;
  });
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const others = [...authTabs].filter((t) => t !== tab);
    if (others[0]) { others[0].focus(); others[0].click(); }
  });
});

// ── Corner dropdown ───────────────────────────────────────────────────────────
function setDropdownOpen(open) {
  userDropdown.classList.toggle("open", open);
  userMenuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    // Focus first menuitem so keyboard users can navigate.
    userDropdown.querySelector("button")?.focus();
  }
}

userMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setDropdownOpen(!userDropdown.classList.contains("open"));
});
document.addEventListener("click", () => setDropdownOpen(false));
userDropdown.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setDropdownOpen(false);
    userMenuBtn.focus();
  }
});

// ── Splash dismiss ────────────────────────────────────────────────────────────
let splashGone = false;
function dismissSplash() {
  if (splashGone) return;
  splashGone = true;
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  // Double-rAF ensures the browser has painted opacity:1 before we animate to 0.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    splash.style.transition = "opacity 550ms ease, transform 550ms ease";
    splash.style.opacity    = "0";
    splash.style.transform  = "translateY(-36px)";
    setTimeout(() => { splash.style.display = "none"; }, 600);
  }));
}

// ── Panel swap helpers ────────────────────────────────────────────────────────
async function fadeOutPanel(el) {
  el.style.opacity = "0";
  el.style.transform = "translateX(-18px)";
  el.style.pointerEvents = "none";
  await sleep(240);
  el.style.display = "none";
  el.style.transform = "";
}

async function fadeInPanel(el) {
  el.style.display = "flex";
  el.style.opacity = "0";
  el.style.transform = "translateX(18px)";
  await sleep(16);
  el.style.opacity = "1";
  el.style.transform = "translateX(0)";
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
  refreshHistory();
  // Focus the primary action so keyboard users land on something useful.
  document.getElementById("auto-btn")?.focus();
}

function showAuth() {
  authOverlay.hidden  = false;
  appView.hidden      = true;
  userMenuWrap.hidden = true;
  // Focus the username field so keyboard/SR users can start typing immediately.
  authUsername?.focus();
}

async function showProfile() {
  setDropdownOpen(false);
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
  backBtn?.focus();
}

async function showAppView() {
  await fadeOutPanel(rightProfile);
  await fadeInPanel(rightApp);
  document.getElementById("auto-btn")?.focus();
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

function _esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function _labelFor(h) {
  if (h.type === "chat")        return "Voice chat";
  if (h.type === "change")      return "Scene change";
  if (h.type === "investigate") return "Saw";
  return _esc(h.event || h.type || "Event");
}

function renderHistory(entries) {
  if (!entries.length) {
    historyListEl.innerHTML = '<p class="muted history-empty">No history yet.</p>';
    return;
  }
  historyListEl.innerHTML = [...entries].reverse().map((h) => {
    const label   = _labelFor(h);
    const locChip = h.location_name
      ? `<span class="location-chip">${_esc(h.location_name)}</span>` : "";
    const inputLine = h.type === "chat" && h.input_text
      ? `<p class="history-input">You: ${_esc(h.input_text)}</p>` : "";
    // If we still have the captured frame in memory (within the 1 min TTL),
    // show it inline. Older entries gracefully fall back to text-only.
    const thumb = window.getCaptureNear?.(h.created_at);
    const thumbHtml = thumb
      ? `<img class="history-thumb" src="${thumb}" alt="" loading="lazy" />`
      : "";
    return `<div class="history-entry">
      <div class="history-row">
        ${thumbHtml}
        <div class="history-text">
          <div class="history-meta">
            <span class="history-label">${label}${locChip}</span>
            <span class="history-time">${timeAgo(h.created_at)}</span>
          </div>
          ${inputLine}
          <p class="history-response">${_esc(h.response)}</p>
        </div>
      </div>
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
    const entries = await resp.json();
    renderHistory(entries);
    maybeSuggestPlace(entries);
  } catch { /* non-critical */ }
}
window.refreshHistory = refreshHistory;

// Used by map.js's popup "Show history at this location" button so the
// coupling between the map and the history filter stays one-way.
window.filterHistoryByLocation = function (locationId) {
  if (!locationFilterEl) return;
  locationFilterEl.value = locationId == null ? "" : String(locationId);
  locationFilterEl.dispatchEvent(new Event("change"));
};

// ── Auto-cluster suggestion ──────────────────────────────────────────────────
//
// When ≥ CLUSTER_MIN_HITS recent history rows have geo coordinates, are not
// already tied to a saved location, and lie within CLUSTER_RADIUS_M of each
// other, prompt the user to name the place. Skips clusters the user has
// dismissed in this session.

const CLUSTER_RADIUS_M  = 50;
const CLUSTER_MIN_HITS  = 5;
const dismissedClusters = new Set(); // round(lat, 4) + "," + round(lon, 4)

const placeSuggestEl     = document.getElementById("place-suggest");
const placeSuggestCount  = document.getElementById("place-suggest-count");
const placeSuggestForm   = document.getElementById("place-suggest-form");
const placeSuggestName   = document.getElementById("place-suggest-name");
const placeSuggestSkip   = document.getElementById("place-suggest-dismiss");
let pendingClusterCenter = null; // {lat, lon} of the cluster currently shown

function _haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlam = toRad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlam / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _clusterKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function maybeSuggestPlace(entries) {
  if (!entries || entries.length < CLUSTER_MIN_HITS) {
    placeSuggestEl.hidden = true;
    return;
  }
  // Eligible: has lat/lon, not already tied to a saved location.
  const eligible = entries.filter((h) =>
    typeof h.lat === "number" && typeof h.lon === "number" && !h.location_id
  );
  if (eligible.length < CLUSTER_MIN_HITS) {
    placeSuggestEl.hidden = true;
    return;
  }
  // Find the densest cluster: for each row, count neighbors within radius.
  let best = null;
  let bestCount = 0;
  for (const r of eligible) {
    let count = 0;
    for (const s of eligible) {
      if (_haversineM(r.lat, r.lon, s.lat, s.lon) <= CLUSTER_RADIUS_M) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = r;
    }
  }
  if (!best || bestCount < CLUSTER_MIN_HITS) {
    placeSuggestEl.hidden = true;
    return;
  }
  const key = _clusterKey(best.lat, best.lon);
  if (dismissedClusters.has(key)) {
    placeSuggestEl.hidden = true;
    return;
  }
  pendingClusterCenter = { lat: best.lat, lon: best.lon };
  placeSuggestCount.textContent = `${bestCount} captures clustered within ~${CLUSTER_RADIUS_M} m.`;
  placeSuggestEl.hidden = false;
}

placeSuggestForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = placeSuggestName.value.trim();
  if (!name || !pendingClusterCenter) return;
  try {
    const resp = await fetch("/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...window.getAuthHeaders() },
      body: JSON.stringify({ name, ...pendingClusterCenter }),
    });
    if (!resp.ok) return;
    placeSuggestName.value = "";
    placeSuggestEl.hidden = true;
    pendingClusterCenter = null;
    await loadLocations();
    window.refreshMap?.();
    // Re-fetch history so the just-saved cluster's rows now show location_name
    // and stop triggering the suggestion banner.
    refreshHistory();
  } catch { /* non-critical */ }
});

placeSuggestSkip?.addEventListener("click", () => {
  if (pendingClusterCenter) {
    dismissedClusters.add(_clusterKey(pendingClusterCenter.lat, pendingClusterCenter.lon));
  }
  placeSuggestEl.hidden = true;
  pendingClusterCenter = null;
});

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
// Let the splash animate in for at least 600ms before it exits
setTimeout(dismissSplash, 600);
