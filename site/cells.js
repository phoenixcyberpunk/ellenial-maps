// Map squares: the same small grid in the weekly data job and in the app. A square is
// 0.25° tall and 0.5° wide (roughly 28 x 30 km in southern Sweden); its key is
// "<row>_<column>", counted from the equator and Greenwich.
;(function (root) {
  const CELL = { lat: 0.25, lon: 0.5 }
  const cellOf = (lat, lon) => `${Math.floor(lat / CELL.lat)}_${Math.floor(lon / CELL.lon)}`
  // Every square that touches a box [south, west, north, east].
  function cellsIn(s, w, n, e) {
    const out = []
    for (let i = Math.floor(s / CELL.lat); i <= Math.floor(n / CELL.lat); i++)
      for (let j = Math.floor(w / CELL.lon); j <= Math.floor(e / CELL.lon); j++) out.push(`${i}_${j}`)
    return out
  }
  const api = { CELL, cellOf, cellsIn }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.EllenialCells = api
})(typeof window !== 'undefined' ? window : globalThis)
