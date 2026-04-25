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

    // saved locations
    savedMarkers.forEach((m) => m.remove());
    savedMarkers.length = 0;

    const headers = window.getAuthHeaders?.() || {};
    if (!headers.Authorization) return;

    try {
      const resp = await fetch("/locations", { headers });
      if (!resp.ok) return;
      const locs = await resp.json();

      if (locs.length === 0) return;

      const bounds = [];
      locs.forEach((loc) => {
        const popup = `<strong style="color:#f1f3f5">${loc.name}</strong>`
          + (loc.address ? `<br><span style="color:#8b95a5;font-size:12px">${loc.address}</span>` : "");
        const m = L.marker([loc.lat, loc.lon], { icon: iconSaved })
          .addTo(leafletMap)
          .bindPopup(popup);
        savedMarkers.push(m);
        bounds.push([loc.lat, loc.lon]);
      });

      // fit view to show all saved pins (plus current position if available)
      if (positionMarker) {
        const c = positionMarker.getLatLng();
        bounds.push([c.lat, c.lng]);
      }
      if (bounds.length === 1) {
        leafletMap.setView(bounds[0], 15);
      } else {
        leafletMap.fitBounds(bounds, { padding: [40, 40] });
      }
    } catch { /* non-critical */ }
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

  tabCamera.addEventListener("click", async () => {
    if (tabBusy || !cameraSection.hidden) return;
    tabBusy = true;
    tabCamera.classList.add("active");
    tabMap.classList.remove("active");
    await crossFade(mapSection, cameraSection);
    tabBusy = false;
  });

  tabMap.addEventListener("click", async () => {
    if (tabBusy || cameraSection.hidden) return;
    tabBusy = true;
    tabMap.classList.add("active");
    tabCamera.classList.remove("active");
    await crossFade(cameraSection, mapSection, refreshMap);
    tabBusy = false;
  });

  // Switch to the map tab and pulse a marker at (lat, lon). Used by app.js
  // when /chat returns a `referenced_location` — the answer to "where did I
  // see X" should *show* the place, not just say it.
  async function flashLocation(lat, lon, name) {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    // Switch tabs
    tabMap.classList.add("active");
    tabCamera.classList.remove("active");
    cameraSection.hidden = true;
    mapSection.hidden    = false;
    await refreshMap();
    if (!leafletMap) return;

    const popup = name
      ? `<strong style="color:#f1f3f5">${name}</strong>`
      : '<strong style="color:#f1f3f5">Here</strong>';
    const marker = L.marker([lat, lon], { icon: makeIcon("#f27c7c", 16) })
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
