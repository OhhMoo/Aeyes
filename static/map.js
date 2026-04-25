// Left-column map tab — Leaflet.js + OpenStreetMap (CartoDB Dark Matter tiles).
// Tab switching, lazy map init, current position marker, saved location pins.

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const tabCamera     = document.getElementById("tab-camera");
  const tabMap        = document.getElementById("tab-map");
  const cameraSection = document.getElementById("camera-section");
  const mapSection    = document.getElementById("map-section");

  let leafletMap     = null;
  let positionMarker = null;
  const savedMarkers = [];
  const captureMarkers = [];  // untagged history rows (per-capture dots)

  // Per-location history cache: { id: { ts, rows } }. 30 s TTL avoids
  // hammering /history when a user opens, closes, and reopens the same popup.
  const HISTORY_CACHE_TTL_MS = 30_000;
  const popupHistoryCache = new Map();

  function _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function _relTime(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  async function fetchPopupHistory(locId) {
    const cached = popupHistoryCache.get(locId);
    if (cached && Date.now() - cached.ts < HISTORY_CACHE_TTL_MS) return cached.rows;
    try {
      const headers = window.getAuthHeaders?.() || {};
      const resp = await fetch(`/history?location_id=${locId}&limit=5`, { headers });
      if (!resp.ok) return [];
      const rows = await resp.json();
      popupHistoryCache.set(locId, { ts: Date.now(), rows });
      return rows;
    } catch { return []; }
  }

  function renderPopupHistory(rows) {
    if (!rows.length) return '<p style="margin:6px 0 0;color:#8b95a5;font-size:12px">No captures here yet.</p>';
    const items = rows.slice(-5).reverse().map((h) => {
      const snippet = (h.response || "").slice(0, 80).replace(/\.+$/, "");
      return `<li style="margin:6px 0 0;font-size:12px;color:#f1f3f5;line-height:1.4">
        <span style="color:#8b95a5">${_relTime(h.created_at)}</span>
        — ${_esc(snippet)}…
      </li>`;
    }).join("");
    return `<ul style="list-style:none;padding:0;margin:6px 0 0">${items}</ul>`;
  }

  // ── Custom marker icons ───────────────────────────────────────────────────

  // Inject ping keyframes once into the document head.
  (function injectPingStyles() {
    if (document.getElementById("map-ping-style")) return;
    const s = document.createElement("style");
    s.id = "map-ping-style";
    s.textContent = `
      @keyframes map-ping {
        0%   { transform: translate(-50%,-50%) scale(1);   opacity: 0.7; }
        100% { transform: translate(-50%,-50%) scale(3.5); opacity: 0;   }
      }
      .map-ping-ring {
        position: absolute; width: 16px; height: 16px; border-radius: 50%;
        background: #7cf2c2;
        top: 50%; left: 50%;
        transform: translate(-50%,-50%);
        animation: map-ping 1.8s ease-out infinite;
      }
      .map-ping-dot {
        position: absolute; width: 16px; height: 16px; border-radius: 50%;
        background: #7cf2c2;
        border: 2.5px solid rgba(255,255,255,0.85);
        box-shadow: 0 0 6px #7cf2c255;
        top: 50%; left: 50%;
        transform: translate(-50%,-50%);
      }
    `;
    document.head.appendChild(s);
  })();

  const iconCurrent = L.divIcon({
    className: "",
    html: `<div style="position:relative;width:48px;height:48px;">
             <div class="map-ping-ring"></div>
             <div class="map-ping-dot"></div>
           </div>`,
    iconSize:    [48, 48],
    iconAnchor:  [24, 24],
    popupAnchor: [0, -24],
  });

  function makePinIcon(color, w = 28, h = 40) {
    return L.divIcon({
      className: "",
      html: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 28 40">
        <path d="M14 0C8.5 0 4 4.7 4 10.5c0 8.2 10 29.5 10 29.5s10-21.3 10-29.5C24 4.7 19.5 0 14 0z"
              fill="${color}" stroke="rgba(0,0,0,0.25)" stroke-width="1.5"/>
        <circle cx="14" cy="10.5" r="4.5" fill="white" opacity="0.9"/>
      </svg>`,
      iconSize:    [w, h],
      iconAnchor:  [w / 2, h],
      popupAnchor: [0, -h],
    });
  }

  const iconSaved = makePinIcon("#f2c97c", 28, 40); // amber — named locations

  // Tiny dot for individual capture rows that aren't tied to a saved location.
  // Less prominent than the amber pins so the user's eye still goes to named places.
  const iconCapture = L.divIcon({
    className: "",
    html: `<div style="width:10px;height:10px;border-radius:50%;
                       background:#7cf2c2;opacity:0.55;
                       border:1.5px solid rgba(255,255,255,0.6);
                       box-shadow:0 0 4px rgba(0,0,0,0.4)"></div>`,
    iconSize:    [10, 10],
    iconAnchor:  [5, 5],
    popupAnchor: [0, -6],
  });

  // ── Map initialisation ────────────────────────────────────────────────────

  function initMap() {
    if (leafletMap) return;
    leafletMap = L.map("map", { zoomControl: true });
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
          ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(leafletMap);
  }

  // ── Refresh markers ───────────────────────────────────────────────────────

  async function refreshMap() {
    initMap();
    // Leaflet needs the container to be visible before rendering tiles correctly
    leafletMap.invalidateSize();

    // current position
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          if (positionMarker) positionMarker.remove();
          positionMarker = L.marker([lat, lng], { icon: iconCurrent })
            .addTo(leafletMap)
            .bindPopup("You are here");
          // only pan to current position if no saved markers are present
          if (savedMarkers.length === 0) {
            leafletMap.setView([lat, lng], 15);
          }
        },
        () => { /* location denied — map still shows saved pins */ },
        { timeout: 5000, maximumAge: 30_000 }
      );
    }

    // saved locations + per-capture dots
    savedMarkers.forEach((m) => m.remove());
    savedMarkers.length = 0;
    captureMarkers.forEach((m) => m.remove());
    captureMarkers.length = 0;

    const headers = window.getAuthHeaders?.() || {};
    if (!headers.Authorization) return;

    let locs = [];
    let history = [];
    try {
      const [locResp, hisResp] = await Promise.all([
        fetch("/locations", { headers }),
        fetch("/history?limit=50", { headers }),
      ]);
      if (locResp.ok) locs = await locResp.json();
      if (hisResp.ok) history = await hisResp.json();
    } catch { /* non-critical */ }

    const bounds = [];

    // Per-capture dots — only for rows with lat/lon AND not already tied to a
    // saved location (those are represented by the amber pin instead).
    history.forEach((h) => {
      if (typeof h.lat !== "number" || typeof h.lon !== "number") return;
      if (h.location_id) return;
      const when = _relTime(h.created_at);
      const snippet = (h.response || "").slice(0, 100).replace(/\.+$/, "");
      const popup = `<span style="color:#8b95a5;font-size:11px">${when}</span>
                     <p style="margin:4px 0 0;font-size:12px;color:#f1f3f5;line-height:1.4">${_esc(snippet)}…</p>`;
      const m = L.marker([h.lat, h.lon], { icon: iconCapture, interactive: true })
        .addTo(leafletMap)
        .bindPopup(popup, { maxWidth: 240, minWidth: 180 });
      captureMarkers.push(m);
      bounds.push([h.lat, h.lon]);
    });

    if (locs.length === 0 && captureMarkers.length === 0) return;

    locs.forEach((loc) => {
      const head = `<strong style="color:#f1f3f5">${_esc(loc.name)}</strong>`
        + (loc.address ? `<br><span style="color:#8b95a5;font-size:12px">${_esc(loc.address)}</span>` : "");
      const skeleton = `${head}
        <div data-popup-history>
          <p style="margin:6px 0 0;color:#8b95a5;font-size:12px">Loading recent captures…</p>
        </div>
        <button data-popup-filter="${loc.id}" style="margin-top:10px;padding:6px 10px;
          background:#7cf2c2;color:#04140d;border:none;border-radius:6px;
          font-size:12px;font-weight:600;cursor:pointer;width:100%">
          Show history at this location
        </button>`;
      const m = L.marker([loc.lat, loc.lon], { icon: iconSaved })
        .addTo(leafletMap)
        .bindPopup(skeleton, { maxWidth: 280, minWidth: 220 });
      m.on("popupopen", async (e) => {
        const root = e.popup.getElement();
        if (!root) return;
        const slot = root.querySelector("[data-popup-history]");
        if (slot) {
          const rows = await fetchPopupHistory(loc.id);
          slot.innerHTML = renderPopupHistory(rows);
        }
        const btn = root.querySelector(`[data-popup-filter="${loc.id}"]`);
        if (btn) {
          btn.addEventListener("click", async () => {
            m.closePopup();
            // Switch to camera tab so the right-column history is visible.
            if (mapSection && !mapSection.hidden) tabCamera.click();
            // Defer until the cross-fade is done to make sure auth.js
            // hasn't been racing with us on the same select element.
            setTimeout(() => window.filterHistoryByLocation?.(loc.id), 250);
          }, { once: true });
        }
      });
      savedMarkers.push(m);
      bounds.push([loc.lat, loc.lon]);
    });

    // fit view to show all pins (plus current position if available)
    if (positionMarker) {
      const c = positionMarker.getLatLng();
      bounds.push([c.lat, c.lng]);
    }
    if (bounds.length === 1) {
      leafletMap.setView(bounds[0], 15);
    } else if (bounds.length > 1) {
      leafletMap.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  let tabBusy = false;

  async function crossFade(hide, show, afterShow) {
    hide.style.transition = "opacity 180ms ease";
    hide.style.opacity = "0";
    await sleep(180);
    hide.hidden = true;
    hide.style.transition = "";
    hide.style.opacity = "";

    if (afterShow) afterShow();

    show.hidden = false;
    show.style.opacity = "0";
    show.style.transition = "opacity 220ms ease";
    await sleep(16);
    show.style.opacity = "1";
    await sleep(220);
    show.style.transition = "";
    show.style.opacity = "";
  }

  function setActiveTab(active, inactive) {
    active.classList.add("active");
    active.setAttribute("aria-selected", "true");
    active.setAttribute("tabindex", "0");
    inactive.classList.remove("active");
    inactive.setAttribute("aria-selected", "false");
    inactive.setAttribute("tabindex", "-1");
  }

  tabCamera.addEventListener("click", async () => {
    if (tabBusy || !cameraSection.hidden) return;
    tabBusy = true;
    setActiveTab(tabCamera, tabMap);
    await crossFade(mapSection, cameraSection);
    tabBusy = false;
  });

  tabMap.addEventListener("click", async () => {
    if (tabBusy || cameraSection.hidden) return;
    tabBusy = true;
    setActiveTab(tabMap, tabCamera);
    await crossFade(cameraSection, mapSection, refreshMap);
    tabBusy = false;
  });

  // Arrow-key roving-tabindex per WAI-ARIA tabs pattern.
  [tabCamera, tabMap].forEach((tab) => {
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const next = tab === tabCamera ? tabMap : tabCamera;
      next.focus();
      next.click();
    });
  });

  // Switch to the map tab and pulse a marker at (lat, lon). Used by app.js
  // when /chat returns a `referenced_location` — the answer to "where did I
  // see X" should *show* the place, not just say it.
  async function flashLocation(lat, lon, name) {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    // Switch tabs
    setActiveTab(tabMap, tabCamera);
    cameraSection.hidden = true;
    mapSection.hidden    = false;
    await refreshMap();
    if (!leafletMap) return;

    const popup = name
      ? `<strong style="color:#f1f3f5">${name}</strong>`
      : '<strong style="color:#f1f3f5">Here</strong>';
    const marker = L.marker([lat, lon], { icon: makePinIcon("#f27c7c") })
      .addTo(leafletMap)
      .bindPopup(popup)
      .openPopup();
    leafletMap.setView([lat, lon], 16);

    // Pulse + auto-remove after 12 s so flashes don't accumulate.
    const el = marker.getElement();
    if (el) el.style.animation = "pulse 1.2s ease-in-out infinite";
    setTimeout(() => marker.remove(), 12_000);
  }

  // expose so auth.js can refresh map pins after a location is saved/deleted
  window.refreshMap   = refreshMap;
  window.flashLocation = flashLocation;
})();
