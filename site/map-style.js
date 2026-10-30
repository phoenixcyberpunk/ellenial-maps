// A calm, low-contrast map style in Ellenial's colours, for OpenFreeMap's vector tiles
// (OpenMapTiles schema). Every request goes to this site's own /ofm/ address, which Vercel
// forwards, so OpenFreeMap never sees who is looking at the map.
window.mapStyle = function mapStyle(origin, dark) {
  const c = dark
    ? { bg: '#1C1826', water: '#26343B', park: '#25302A', wood: '#28332B', road: '#332D40', roadMajor: '#4A4259', building: '#26212F', label: '#C2BACF', halo: '#17141F' }
    : { bg: '#FAEEDD', water: '#CFE0EA', park: '#DCE7D2', wood: '#D3E1C8', road: '#FFFFFF', roadMajor: '#FFFBF5', building: '#EFE3D2', label: '#575166', halo: '#FEF2E2' }
  const font = ['Noto Sans Regular']
  return {
    version: 8,
    glyphs: `${origin}/ofm/fonts/{fontstack}/{range}.pbf`,
    sources: { omt: { type: 'vector', url: `${origin}/ofm/planet` } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': c.bg } },
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]], paint: { 'fill-color': c.wood } },
      { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'meadow', 'scrub']]], paint: { 'fill-color': c.park, 'fill-opacity': 0.7 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 16, 3] } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': c.building } },
      { id: 'paths', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13, filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]], paint: { 'line-color': c.road, 'line-width': 1, 'line-dasharray': [2, 1.5] } },
      { id: 'roads', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary', 'secondary']]], paint: { 'line-color': c.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 6] } },
      { id: 'roads-major', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk', 'motorway']]], paint: { 'line-color': c.roadMajor, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 16, 9] } },
      { id: 'water-names', type: 'symbol', source: 'omt', 'source-layer': 'water_name', layout: { 'text-field': ['coalesce', ['get', 'name:sv'], ['get', 'name']], 'text-font': font, 'text-size': 12 }, paint: { 'text-color': dark ? '#8FB0C0' : '#4F7488', 'text-halo-color': c.halo, 'text-halo-width': 1 } },
      { id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood', 'quarter', 'village']]], layout: { 'text-field': ['coalesce', ['get', 'name:sv'], ['get', 'name']], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11, 15, 14] }, paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.2 } },
    ],
  }
}
