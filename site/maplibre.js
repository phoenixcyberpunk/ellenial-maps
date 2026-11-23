// Loads the map engine, then the app (23 Nov 2026). MapLibre 6 is an ES module only, so it can't be a
// plain <script> any more; app.js waits for it here so it finds window.maplibregl as before.
// If the engine can't load, the app still starts and shows its lists without the map.
// build.mjs fills in the engine's address below (/vendor/maplibre-<version>).
import('__MAPLIBRE__/maplibre-gl.mjs')
  .then((m) => { window.maplibregl = m })
  .catch((e) => console.warn('maps: map engine did not load', e))
  .finally(() => {
    const s = document.createElement('script')
    s.src = '/app.js'
    document.body.append(s)
  })
