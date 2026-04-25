// Left-column map tab — Leaflet.js + OpenStreetMap (CartoDB Dark Matter tiles).
// Tab switching, lazy map init, current position marker, saved location pins.

(function () {
  const tabCamera    = document.getElementById("tab-camera");
  const tabMap       = document.getElementById("tab-map");
  const cameraSection = document.getElementById("camera-section");
  const mapSection   = document.getElementById("map-section");

  let leafletMap     = null;
  let positionMarker = null;
  const savedMarkers = [];

  // ── Custom marker icons ───────────────────────────────────────────────────

  function makeIcon(color, size = 12) {
    return L.divIcon({
      className: "",
      html: `<div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${color};border:2px solid rgba(255,255,255,0.5);
        box-shadow:0 0 6px ${color}55;
      "></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)],
    });
  }

  const iconCurrent = makeIcon("#7cf2c2", 14); // teal — current position
  const iconSaved   = makeIcon("#f2c97c", 11); // amber — named locations

  // ── Map initialisation ────────────────────────────────────────────────────

  function initMap() {
    if (leafletMap) return;
    leafletMap = L.map("map", { zoomControl: true });
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
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

  tabCamera.addEventListener("click", () => {
    tabCamera.classList.add("active");
    tabMap.classList.remove("active");
    cameraSection.hidden = false;
    mapSection.hidden    = true;
  });

  tabMap.addEventListener("click", () => {
    tabMap.classList.add("active");
    tabCamera.classList.remove("active");
    cameraSection.hidden = true;
    mapSection.hidden    = false;
    refreshMap();
  });

  // expose so auth.js can refresh map pins after a location is saved/deleted
  window.refreshMap = refreshMap;
})();
