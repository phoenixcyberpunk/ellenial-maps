// Builds the data every phone reads: data/sweden/index.json plus one small file per map square
// (data/sweden/<square>.json), so a phone only downloads the squares it is looking at.
//
// Runs weekly on GitHub's servers (see .github/workflows/weekly-data.yml), so phones never
// talk to OpenStreetMap or Wikimedia themselves. Before this script runs, the workflow
// downloads Sweden's OpenStreetMap file from Geofabrik, keeps only the tags we use with osmium,
// and exports them as GeoJSON (one feature per line). This script:
//   1. reads those features line by line (places, toilets, water taps, benches, shelters, dog runs),
//   2. works out each place's setting, size and what's close by,
//   3. finds an openly licensed photo on Wikimedia Commons, with its credit (cached between weeks),
//   4. adds Gothenburg's dog rules (inside Gothenburg only; elsewhere the national rule),
//   5. writes the squares, but only if the result looks sane (so a bad week never empties the map).
//
// Weekly:       node scripts/build-data.mjs --input work/area.geojsonseq
// Offline test: node scripts/build-data.mjs --input tests/fixture.geojsonseq --test --no-photos
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import '../site/cells.js' // sets globalThis.EllenialCells (same file the app loads)
const { CELL, cellOf } = globalThis.EllenialCells

const AREA = { name: 'Sverige', south: 55.0, west: 10.5, north: 69.2, east: 24.3 }
// Gothenburg's hand-written dog rules only apply inside this box.
const LOCAL_DOG_AREA = { name: 'Göteborg', south: 57.55, west: 11.70, north: 57.86, east: 12.20 }
const OUT_DIR = 'data/sweden'
const PHOTO_CACHE = 'data/photo-cache.json'
const USER_AGENT = 'ellenial-maps-data/2.0 (https://maps.ellenial.app; https://github.com/phoenixcyberpunk/ellenial-maps)'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const WIKIDATA = 'https://www.wikidata.org/w/api.php'

const BIG_HA = 10 // places this big or bigger are "big, open"; smaller ones are "small, cosy"
const NATURE_PARK_HA = 30 // a park this big feels like nature rather than a city park
const NEAR_M = 200 // how far around a place a toilet, water tap or shelter still counts as "nearby"

const args = process.argv.slice(2)
const input = args.includes('--input') ? args[args.indexOf('--input') + 1] : null
const test = args.includes('--test')
const withPhotos = !args.includes('--no-photos')
// A deliberate change of rules (like dropping plain hills) is allowed to shrink the data once.
const allowDrop = args.includes('--allow-drop')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// What happened, written to data/report.json so problems are visible in the repo.
const trail = []
const report = { generated: new Date().toISOString(), source: 'Geofabrik Sweden extract (OpenStreetMap)', features: 0, landmarks: {}, trail }
const writeReport = () => { if (!test) writeFileSync('data/report.json', JSON.stringify(report, null, 1)) }

// Well-known places that must be on the map. If more than two are missing, the week is broken.
// Gothenburg's, plus a few across Sweden so a week that loses a region is caught too.
const LANDMARKS = ['Slottsskogen', 'Delsjö', 'botaniska trädgård', 'Keillers park', 'Kungsparken', 'Trädgårdsföreningen', 'Ramberget', 'Stora Amundö', 'Hagaparken', 'Pildammsparken', 'Kungsträdgården', 'Stadsparken']

// ---------- fetching (photos only) ----------

async function getJson(url, tries = 3) {
  let lastError
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`)
      return await res.json()
    } catch (e) {
      lastError = e
      if (i < tries - 1) await sleep(5000 * (i + 1))
    }
  }
  throw lastError
}

// ---------- reading osmium's GeoJSON ----------

// osmium export -f geojsonseq writes one feature per line, each starting with a record
// separator (0x1E). Properties hold the tags plus "@type" and "@id" (from -a type,id).
// Read line by line: all of Sweden is far too big to hold as one string.
async function* readFeatures(path) {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const raw of lines) {
    const line = raw.replace(/^\x1e/, '').trim()
    if (!line) continue
    const f = JSON.parse(line)
    const props = f.properties || {}
    const tags = {}
    for (const [k, v] of Object.entries(props)) if (!k.startsWith('@')) tags[k] = String(v)
    yield { type: props['@type'] || 'way', id: props['@id'] ?? 0, tags, geometry: f.geometry }
  }
}

// ---------- geometry ----------

const R = 6371008.8
const toXY = (lat, lon, lat0) => [((lon * Math.PI) / 180) * R * Math.cos((lat0 * Math.PI) / 180), ((lat * Math.PI) / 180) * R]

function ringArea(points, lat0) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = toXY(points[i].lat, points[i].lon, lat0)
    const [x2, y2] = toXY(points[(i + 1) % points.length].lat, points[(i + 1) % points.length].lon, lat0)
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

const ll = (c) => ({ lat: c[1], lon: c[0] })
// A loop, not Math.min(...points): big reserves have more points than a function call can take.
function boxOf(pts) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity
  for (const p of pts) { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon }
  return [s, w, n, e]
}

// Position, area and outline of a GeoJSON geometry from osmium.
function shape(g) {
  if (!g) return null
  if (g.type === 'Point') { const p = ll(g.coordinates); return { ...p, m2: null, box: [p.lat, p.lon, p.lat, p.lon] } }
  if (g.type === 'LineString') return lineShape(g.coordinates.map(ll))
  if (g.type === 'MultiLineString') return lineShape(g.coordinates.flat().map(ll))
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null
  if (!polys || !polys.length) return null
  const outers = polys.map((poly) => poly[0].map(ll))
  const box = boxOf(outers.flat())
  const lat0 = (box[0] + box[2]) / 2
  const m2 = polys.reduce((sum, poly) => sum + ringArea(poly[0].map(ll), lat0) - poly.slice(1).reduce((h, r) => h + ringArea(r.map(ll), lat0), 0), 0)
  // Marker: the biggest outer ring's vertex average, or its first point if that falls outside.
  const biggest = outers.reduce((x, y) => (ringArea(y, lat0) > ringArea(x, lat0) ? y : x))
  let lat = biggest.reduce((sum, p) => sum + p.lat, 0) / biggest.length
  let lon = biggest.reduce((sum, p) => sum + p.lon, 0) / biggest.length
  if (!inside({ lat, lon }, biggest)) [lat, lon] = [biggest[0].lat, biggest[0].lon]
  // Only whether it has an outline is kept; holding every outline for Sweden would fill the memory.
  return { lat, lon, m2: Math.max(m2, 0), box, ring: true }
}

function lineShape(points) {
  const box = boxOf(points)
  return { lat: (box[0] + box[2]) / 2, lon: (box[1] + box[3]) / 2, m2: null, box }
}

function inside(p, ring) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) hit = !hit
  }
  return hit
}

function metres(a, b) {
  const lat0 = (a.lat + b.lat) / 2
  const [x1, y1] = toXY(a.lat, a.lon, lat0)
  const [x2, y2] = toXY(b.lat, b.lon, lat0)
  return Math.hypot(x2 - x1, y2 - y1)
}

// Is point p within d metres of the place (inside it, or within d of its box)?
function near(p, place, d) {
  const dLat = d / 111320
  const dLon = d / (111320 * Math.cos((place.lat * Math.PI) / 180))
  const [s, w, n, e] = place.box
  if (p.lat < s - dLat || p.lat > n + dLat || p.lon < w - dLon || p.lon > e + dLon) return false
  if (place.ring && p.lat >= s && p.lat <= n && p.lon >= w && p.lon <= e) return true
  return place.ring ? true : metres(p, place) <= d
}

// A grid of ~1 km buckets, so "is there a toilet near this place?" only looks at points close by.
const GRID = 0.01
function grid(points) {
  const g = new Map()
  for (const p of points) {
    const k = `${Math.floor(p.lat / GRID)}:${Math.floor(p.lon / GRID)}`
    if (!g.has(k)) g.set(k, [])
    g.get(k).push(p)
  }
  return g
}
function anyNear(g, place, d) {
  const dLat = d / 111320
  const dLon = d / (111320 * Math.cos((place.lat * Math.PI) / 180))
  const [s, w, n, e] = place.box
  for (let i = Math.floor((s - dLat) / GRID); i <= Math.floor((n + dLat) / GRID); i++) {
    for (let j = Math.floor((w - dLon) / GRID); j <= Math.floor((e + dLon) / GRID); j++) {
      const bucket = g.get(`${i}:${j}`)
      if (bucket && bucket.some((x) => near(x, place, d))) return true
    }
  }
  return false
}
const inBox = (p, a) => p.lat >= a.south && p.lat <= a.north && p.lon >= a.west && p.lon <= a.east

// ---------- classifying ----------

const isPrivate = (t) => /^(private|no|customers|permit)$/.test(t.access || '')

function kindOf(t) {
  // A named hill or mountain top is only "A view" when it's also tagged as a viewpoint. Otherwise all of
  // Sweden's summits and forest hills would crowd out real lookouts (15,857 of 29,022 places, 1 Nov).
  if ((t.natural === 'peak' || t.natural === 'hill') && t.tourism !== 'viewpoint') return null
  if (t.landuse === 'recreation_ground') return 'park'
  if (t.amenity === 'library') return 'library'
  if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return 'square'
  if (t.tourism === 'viewpoint') return 'viewpoint'
  if (t.leisure === 'bathing_place' || t.leisure === 'swimming_area' || t.natural === 'beach') return 'swim'
  if (t.leisure === 'garden') return 'garden'
  if (t.leisure === 'nature_reserve' || t.boundary === 'protected_area') return 'reserve'
  if (t.leisure === 'park') return 'park'
  return null
}

// Names that are just a type ("Bibliotek", "Park") or a placeholder are mapping slips, not places.
const GENERIC = /^(bibliotek|library|park|parken|lekplats|torg|torget|plats|garden|trädgård|naturspot \d+|utsikt|viewpoint)$/i

function keep(t, kind) {
  if (isPrivate(t)) return false
  if (GENERIC.test(t.name.trim())) return false
  if (kind === 'square' && /kryss|korsning|rondell|cirkulation|punkten$/i.test(t.name)) return false
  if (t.highway === 'pedestrian' && !(t.area === 'yes' && /torg/i.test(t.name))) return false
  if (kind === 'garden' && /residential|private|community|allotment/.test(t['garden:type'] || '')) return false
  if (kind === 'reserve') {
    // Only real protected nature, not e.g. water-protection zones.
    const cls = t.protect_class || ''
    const title = (t.protection_title || '').toLowerCase()
    if (t.leisure !== 'nature_reserve' && !/^[1-6]$|^1[ab]$/.test(cls) && !/naturreservat|nature reserve|natura 2000|naturvårdsområde/.test(title)) return false
  }
  return true
}

function settingOf(kind, ha) {
  switch (kind) {
    case 'library': return 'libraries'
    case 'square': return 'squares'
    case 'viewpoint': return 'view'
    case 'swim': return 'water'
    case 'garden': return 'gardens'
    case 'reserve': return 'nature'
    case 'park': return ha != null && ha >= NATURE_PARK_HA ? 'nature' : 'urban'
  }
}

const website = (t) => {
  const w = t.website || t['contact:website'] || t.url
  if (!w) return null
  return /^https?:\/\//i.test(w) ? w : `https://${w}`
}

// ---------- photos (Wikimedia Commons) ----------

const plain = (html) => (html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim()
const OPEN_LICENCE = /^(cc|public domain|pd|cc0|gfdl|attribution|free art)/i

async function commonsApi(params) {
  const url = `${COMMONS}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`
  await sleep(150)
  return getJson(url)
}

// What Wikidata and Commons answered in earlier weeks, so each week only asks about new places
// (and refreshes answers older than two months). Kept in the repo as data/photo-cache.json.
const FRESH_MS = 60 * 864e5
function loadCache() {
  try { return JSON.parse(readFileSync(PHOTO_CACHE, 'utf8')) } catch { return { wd: {}, cat: {}, files: {} } }
}
const fresh = (entry) => entry && Date.now() - Date.parse(entry.t) < FRESH_MS

async function addPhotos(places) {
  const cache = loadCache()
  const stamp = new Date().toISOString().slice(0, 10)
  let asked = 0

  // Wikidata gives a photo (P18) and a Commons category (P373) for well-known places.
  const qids = [...new Set(places.map((p) => p.tags.wikidata).filter((q) => /^Q\d+$/.test(q || '')))]
  const askQ = qids.filter((q) => !fresh(cache.wd[q]))
  for (let i = 0; i < askQ.length; i += 50) {
    const batch = askQ.slice(i, i + 50)
    try {
      const url = `${WIKIDATA}?${new URLSearchParams({ action: 'wbgetentities', ids: batch.join('|'), props: 'claims', format: 'json' })}`
      await sleep(150)
      const res = await getJson(url)
      asked++
      for (const q of batch) {
        const ent = res.entities?.[q]
        const claim = (prop) => ent?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value
        cache.wd[q] = { image: claim('P18') || null, category: claim('P373') || null, t: stamp }
      }
    } catch (e) {
      console.warn(`Wikidata batch ${i}: ${e.message}`)
    }
  }

  for (const p of places) {
    const t = p.tags
    const wd = cache.wd[t.wikidata]
    const tag = (t.wikimedia_commons || '').trim()
    const fromImage = /commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/.exec(t.image || '')
    p.file = /^File:/i.test(tag) ? tag : fromImage ? decodeURIComponent(fromImage[1]).replace(/_/g, ' ') : wd?.image ? `File:${wd.image}` : null
    p.category = /^Category:/i.test(tag) ? tag : wd?.category ? `Category:${wd.category}` : null
  }

  // A place with only a category gets the first photo in it.
  for (const p of places.filter((x) => !x.file && x.category)) {
    if (!fresh(cache.cat[p.category])) {
      try {
        const res = await commonsApi({ action: 'query', list: 'categorymembers', cmtitle: p.category, cmtype: 'file', cmlimit: '5' })
        asked++
        const first = (res.query?.categorymembers || []).find((m) => /\.(jpe?g|png|webp)$/i.test(m.title))
        cache.cat[p.category] = { file: first ? first.title : null, t: stamp }
      } catch (e) {
        console.warn(`Category ${p.category}: ${e.message}`)
      }
    }
    if (cache.cat[p.category]?.file) p.file = cache.cat[p.category].file
  }

  const files = [...new Set(places.map((p) => p.file).filter(Boolean))]
  const askF = files.filter((f) => !fresh(cache.files[f]))
  for (let i = 0; i < askF.length; i += 40) {
    const batch = askF.slice(i, i + 40)
    try {
      const res = await commonsApi({
        action: 'query', prop: 'imageinfo', titles: batch.join('|'),
        iiprop: 'url|extmetadata|size', iiurlwidth: '500', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
      })
      asked++
      const norm = Object.fromEntries((res.query?.normalized || []).map((n) => [n.to, n.from]))
      const found = {}
      for (const page of res.query?.pages || []) {
        const ii = page.imageinfo?.[0]
        if (!ii?.thumburl) continue
        const meta = ii.extmetadata || {}
        const licence = plain(meta.LicenseShortName?.value)
        if (!OPEN_LICENCE.test(licence)) continue
        const record = {
          src: ii.thumburl.replace('https://upload.wikimedia.org/', '/photo/'),
          w: ii.thumbwidth, h: ii.thumbheight,
          by: plain(meta.Artist?.value).slice(0, 120) || 'Unknown photographer',
          licence, licenceUrl: meta.LicenseUrl?.value || null,
          page: ii.descriptionurl,
        }
        found[page.title] = record
        if (norm[page.title]) found[norm[page.title]] = record
      }
      // Files with no usable photo are remembered too, so they aren't asked about every week.
      for (const f of batch) cache.files[f] = { photo: found[f] || found[f.replace(/_/g, ' ')] || null, t: stamp }
    } catch (e) {
      console.warn(`Photo batch ${i}: ${e.message}`)
    }
  }
  for (const p of places) p.photo = p.file ? cache.files[p.file]?.photo || cache.files[p.file.replace(/_/g, ' ')]?.photo || null : null
  trail.push(`photos: ${asked} requests to Wikimedia (${askQ.length} new Wikidata items, ${askF.length} new files)`)
  writeFileSync(PHOTO_CACHE, JSON.stringify(cache))
}

// ---------- dog rules ----------

function dogRulesFor(name, rules) {
  const n = name.toLowerCase()
  return rules.local.find((r) => r.match.some((m) => n.includes(m.toLowerCase()))) || null
}

// ---------- main ----------

async function main() {
  if (!input || !existsSync(input)) throw new Error(`No input file (--input). Got: ${input}`)
  const started = Date.now()
  const dogRules = JSON.parse(readFileSync('data/dog-rules-goteborg.json', 'utf8'))

  // One pass through the file: facilities become points, places keep only what we need.
  const closed = (t) => /^(private|no|customers)$/.test(t.access || '')
  const toilets = [], water = [], shelters = [], benches = [], dogParks = []
  let places = []
  let count = 0
  for await (const e of readFeatures(input)) {
    count++
    const t = e.tags
    const isFacility = t.amenity === 'toilets' || t.amenity === 'drinking_water' || t.amenity === 'shelter' || t.amenity === 'bench' || t.leisure === 'dog_park'
    if (isFacility && !closed(t)) {
      const sh = shape(e.geometry)
      if (sh) {
        const p = { lat: sh.lat, lon: sh.lon }
        if (t.amenity === 'toilets') toilets.push({ ...p, fee: t.fee === 'yes' })
        else if (t.amenity === 'drinking_water') water.push(p)
        // Bus-stop and animal shelters aren't somewhere to sit out the rain at a park.
        else if (t.amenity === 'shelter') { if (!/^(public_transport|field_shelter)$/.test(t.shelter_type || '')) shelters.push(p) }
        else if (t.amenity === 'bench') benches.push(p)
        else dogParks.push({ ...p, name: t.name || null, fenced: t.barrier === 'fence' || t.fenced === 'yes', osm: `${e.type}/${e.id}` })
      }
    }
    const kind = kindOf(t)
    if (!kind || !t.name || !keep(t, kind)) continue
    const sh = shape(e.geometry)
    if (!sh) continue
    const ha = sh.m2 != null ? sh.m2 / 10000 : null
    // A point-only park (no outline mapped) is still a park; give it no size.
    places.push({ e: { type: e.type, id: e.id }, tags: t, kind, ...sh, ha })
  }
  report.features = count
  trail.push(`read ${count} features from ${input}`)

  // The same spot is often mapped twice (a beach and its bathing place, a park and its reserve).
  // Keep one per name within 400 m: the one with an area, then the larger.
  places.sort((a, b) => (b.ha ?? -1) - (a.ha ?? -1))
  const byName = new Map()
  const kept = []
  for (const p of places) {
    const key = p.tags.name.toLowerCase()
    const same = byName.get(key) || []
    const twin = same.find((k) => metres(k, p) < 400)
    if (twin) {
      for (const k of ['wikidata', 'wikimedia_commons', 'image', 'website']) if (!twin.tags[k] && p.tags[k]) twin.tags[k] = p.tags[k]
      continue
    }
    same.push(p)
    byName.set(key, same)
    kept.push(p)
  }
  places = kept
  trail.push(`${places.length} places after merging twins`)

  if (withPhotos && !test) await addPhotos(places)

  const gT = grid(toilets), gW = grid(water), gS = grid(shelters), gB = grid(benches)
  const round = (x) => Math.round(x * 1e5) / 1e5
  const out = places.map((p) => {
    const t = p.tags
    const dog = inBox(p, LOCAL_DOG_AREA) ? dogRulesFor(t.name, dogRules) : null
    const nearby = {
      toilet: anyNear(gT, p, NEAR_M),
      water: anyNear(gW, p, NEAR_M),
      shelter: anyNear(gS, p, NEAR_M / 2) || t.leisure === 'library' || t.amenity === 'library',
      benches: anyNear(gB, p, 30),
    }
    const commonsCategory = p.category ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.category.replace(/ /g, '_'))}` : null
    return {
      id: `${p.e.type[0]}${p.e.id}`,
      name: t.name,
      kind: p.kind,
      setting: settingOf(p.kind, p.ha),
      // A library's outline is its building, so its size says nothing about the space to relax in.
      size: p.ha == null || p.kind === 'library' ? null : p.ha >= BIG_HA ? 'big' : 'small',
      ha: p.ha == null || p.kind === 'library' ? null : Math.round(p.ha * 10) / 10,
      lat: round(p.lat), lon: round(p.lon),
      fee: t.fee === 'yes',
      website: website(t),
      nearby,
      photo: p.photo || null,
      morePhotos: commonsCategory,
      osm: `${p.e.type}/${p.e.id}`,
      dogRule: dog ? dog.id : null,
    }
  })

  // Split everything into squares. A place, toilet or dog run belongs to the square its marker is in.
  const cells = new Map()
  const cell = (lat, lon) => {
    const k = cellOf(lat, lon)
    if (!cells.has(k)) cells.set(k, { places: [], toilets: [], water: [], dogParks: [] })
    return cells.get(k)
  }
  for (const p of out) cell(p.lat, p.lon).places.push(p)
  for (const x of toilets) cell(x.lat, x.lon).toilets.push([round(x.lat), round(x.lon), x.fee ? 1 : 0])
  for (const x of water) cell(x.lat, x.lon).water.push([round(x.lat), round(x.lon)])
  for (const x of dogParks) cell(x.lat, x.lon).dogParks.push({ ...x, lat: round(x.lat), lon: round(x.lon) })

  const counts = {
    places: out.length,
    bySetting: out.reduce((m, p) => ((m[p.setting] = (m[p.setting] || 0) + 1), m), {}),
    withPhoto: out.filter((p) => p.photo).length,
    // Places still without a photo after Commons (OSM tags) and Wikidata (P18 / P373); they show the placeholder.
    withoutPhoto: out.filter((p) => !p.photo).length,
    withoutPhotoBySetting: out.filter((p) => !p.photo).reduce((m, p) => ({ ...m, [p.setting]: (m[p.setting] || 0) + 1 }), {}),
    toilets: toilets.length, water: water.length, dogParks: dogParks.length, squares: cells.size,
  }
  const generated = new Date().toISOString()
  const index = {
    generated,
    area: AREA,
    cell: CELL,
    localDogArea: LOCAL_DOG_AREA,
    counts,
    // How many places each square holds, so the app knows which squares exist.
    cells: Object.fromEntries([...cells].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.places.length])),
    dogRules,
  }

  for (const l of LANDMARKS) report.landmarks[l] = out.some((p) => p.name.toLowerCase().includes(l.toLowerCase()))
  report.counts = counts
  report.seconds = Math.round((Date.now() - started) / 1000)
  const missing = Object.entries(report.landmarks).filter(([, ok]) => !ok).map(([l]) => l)
  writeReport()
  if (!test && missing.length > 3) {
    console.error(`Landmarks missing: ${missing.join(', ')}. Not replacing the data.`)
    process.exit(1)
  }

  // Sanity check: never replace good data with a broken week.
  const dir = test ? 'data/sample' : OUT_DIR
  if (!test && existsSync(`${dir}/index.json`)) {
    const old = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'))
    if (!allowDrop && old.counts?.places > 500 && out.length < old.counts.places * 0.8) {
      console.error(`Only ${out.length} places this week (was ${old.counts.places}). Keeping last week's data.`)
      process.exit(1)
    }
  }
  if (out.length < (test ? 1 : 1000)) {
    console.error(`Only ${out.length} places found. Not writing.`)
    process.exit(1)
  }

  const unmatched = dogRules.local.filter((r) => !out.some((p) => p.dogRule === r.id)).map((r) => r.id)
  if (unmatched.length) console.warn(`Dog rules with no matching place on the map: ${unmatched.join(', ')}`)

  // Write into a fresh folder, then swap it in, so squares that emptied out don't linger.
  const tmp = `${dir}.new`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  for (const [k, v] of cells) {
    v.places.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
    writeFileSync(`${tmp}/${k}.json`, JSON.stringify(v))
  }
  writeFileSync(`${tmp}/index.json`, JSON.stringify(index))
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmp, dir)
  console.log(JSON.stringify({ ...counts, seconds: report.seconds }, null, 1))
}

main().catch((e) => {
  trail.push(`stopped: ${String(e.message || e).slice(0, 300)}`)
  report.failed = true
  writeReport()
  console.error(e)
  process.exit(1)
})
