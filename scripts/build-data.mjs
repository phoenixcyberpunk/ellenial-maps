// Builds data/gothenburg.json: the one file every phone reads.
//
// Runs weekly on GitHub's servers (see .github/workflows/weekly-data.yml), so phones never
// talk to OpenStreetMap or Wikimedia themselves. Before this script runs, the workflow
// downloads Sweden's OpenStreetMap file from Geofabrik, cuts out the Gothenburg area and the
// tags we use with osmium, and exports them as GeoJSON (one feature per line). This script:
//   1. reads those features (places, toilets, water taps, benches, shelters, dog runs),
//   2. works out each place's setting, size and what's close by,
//   3. finds an openly licensed photo on Wikimedia Commons, with its credit,
//   4. adds Gothenburg's dog rules from data/dog-rules-goteborg.json,
//   5. writes the result, but only if it looks sane (so a bad week never empties the map).
//
// Weekly:       node scripts/build-data.mjs --input work/gothenburg.geojsonseq
// Offline test: node scripts/build-data.mjs --input tests/fixture.geojsonseq --test --no-photos
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Keep in sync with AREA_BBOX in .github/workflows/weekly-data.yml.
const AREA = { name: 'Göteborg', south: 57.55, west: 11.70, north: 57.86, east: 12.20 }
const OUT = 'data/gothenburg.json'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// What happened, written to data/report.json so problems are visible in the repo.
const trail = []
const report = { generated: new Date().toISOString(), source: 'Geofabrik Sweden extract (OpenStreetMap)', features: 0, landmarks: {}, trail }
const writeReport = () => { if (!test) writeFileSync('data/report.json', JSON.stringify(report, null, 1)) }

// Well-known places that must be on the map. If more than two are missing, the week is broken.
const LANDMARKS = ['Slottsskogen', 'Delsjö', 'botaniska trädgård', 'Keillers park', 'Kungsparken', 'Trädgårdsföreningen', 'Ramberget', 'Stora Amundö']

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
function readFeatures(path) {
  const out = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/^\x1e/, '').trim()
    if (!line) continue
    const f = JSON.parse(line)
    const props = f.properties || {}
    const tags = {}
    for (const [k, v] of Object.entries(props)) if (!k.startsWith('@')) tags[k] = String(v)
    out.push({ type: props['@type'] || 'way', id: props['@id'] ?? 0, tags, geometry: f.geometry })
  }
  return out
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
const boxOf = (pts) => [Math.min(...pts.map((p) => p.lat)), Math.min(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lon))]

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
  return { lat, lon, m2: Math.max(m2, 0), box, ring: biggest }
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

// ---------- classifying ----------

const isPrivate = (t) => /^(private|no|customers|permit)$/.test(t.access || '')

function kindOf(t) {
  if (t.natural === 'peak' || t.natural === 'hill') return 'viewpoint'
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

async function addPhotos(places) {
  // Wikidata gives a photo (P18) and a Commons category (P373) for well-known places.
  const qids = [...new Set(places.map((p) => p.tags.wikidata).filter((q) => /^Q\d+$/.test(q || '')))]
  const wd = {}
  for (let i = 0; i < qids.length; i += 50) {
    const url = `${WIKIDATA}?${new URLSearchParams({ action: 'wbgetentities', ids: qids.slice(i, i + 50).join('|'), props: 'claims', format: 'json' })}`
    await sleep(150)
    const res = await getJson(url)
    for (const [id, ent] of Object.entries(res.entities || {})) {
      const claim = (p) => ent.claims?.[p]?.[0]?.mainsnak?.datavalue?.value
      wd[id] = { image: claim('P18'), category: claim('P373') }
    }
  }

  for (const p of places) {
    const t = p.tags
    const tag = (t.wikimedia_commons || '').trim()
    const fromImage = /commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/.exec(t.image || '')
    p.file = /^File:/i.test(tag) ? tag : fromImage ? decodeURIComponent(fromImage[1]).replace(/_/g, ' ') : wd[t.wikidata]?.image ? `File:${wd[t.wikidata].image}` : null
    p.category = /^Category:/i.test(tag) ? tag : wd[t.wikidata]?.category ? `Category:${wd[t.wikidata].category}` : null
  }

  // A place with only a category gets the first photo in it.
  for (const p of places.filter((x) => !x.file && x.category)) {
    try {
      const res = await commonsApi({ action: 'query', list: 'categorymembers', cmtitle: p.category, cmtype: 'file', cmlimit: '5' })
      const first = (res.query?.categorymembers || []).find((m) => /\.(jpe?g|png|webp)$/i.test(m.title))
      if (first) p.file = first.title
    } catch (e) {
      console.warn(`Category ${p.category}: ${e.message}`)
    }
  }

  const files = [...new Set(places.map((p) => p.file).filter(Boolean))]
  const info = {}
  for (let i = 0; i < files.length; i += 40) {
    try {
      const res = await commonsApi({
        action: 'query', prop: 'imageinfo', titles: files.slice(i, i + 40).join('|'),
        iiprop: 'url|extmetadata|size', iiurlwidth: '500', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
      })
      const norm = Object.fromEntries((res.query?.normalized || []).map((n) => [n.to, n.from]))
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
        info[page.title] = record
        if (norm[page.title]) info[norm[page.title]] = record
      }
    } catch (e) {
      console.warn(`Photo batch ${i}: ${e.message}`)
    }
  }
  for (const p of places) p.photo = p.file ? info[p.file] || info[p.file.replace(/_/g, ' ')] || null : null
}

// ---------- dog rules ----------

function dogRulesFor(name, rules) {
  const n = name.toLowerCase()
  return rules.local.find((r) => r.match.some((m) => n.includes(m.toLowerCase()))) || null
}

// ---------- main ----------

async function main() {
  if (!input || !existsSync(input)) throw new Error(`No input file (--input). Got: ${input}`)
  const features = readFeatures(input)
  report.features = features.length
  trail.push(`read ${features.length} features from ${input}`)
  const dogRules = JSON.parse(readFileSync('data/dog-rules-goteborg.json', 'utf8'))

  // Facilities
  const pt = (e) => { const sh = shape(e.geometry); return sh ? { lat: sh.lat, lon: sh.lon } : null }
  const closed = (t) => /^(private|no|customers)$/.test(t.access || '')
  const toilets = []
  const water = []
  const shelters = []
  const benches = []
  const dogParks = []
  for (const e of features) {
    const t = e.tags
    if (!(t.amenity === 'toilets' || t.amenity === 'drinking_water' || t.amenity === 'shelter' || t.amenity === 'bench' || t.leisure === 'dog_park') || closed(t)) continue
    const p = pt(e)
    if (!p) continue
    if (t.amenity === 'toilets') toilets.push({ ...p, fee: t.fee === 'yes' })
    else if (t.amenity === 'drinking_water') water.push(p)
    else if (t.amenity === 'shelter') shelters.push(p)
    else if (t.amenity === 'bench') benches.push(p)
    else if (t.leisure === 'dog_park') dogParks.push({ ...p, name: t.name || null, fenced: t.barrier === 'fence' || t.fenced === 'yes', osm: `${e.type}/${e.id}` })
  }

  // Places
  let places = []
  for (const e of features) {
    const t = e.tags
    const kind = kindOf(t)
    if (!kind || !t.name || !keep(t, kind)) continue
    const s = shape(e.geometry)
    if (!s) continue
    const ha = s.m2 != null ? s.m2 / 10000 : null
    // A point-only park (no outline mapped) is still a park; give it no size.
    places.push({ e, tags: t, kind, ...s, ha })
  }

  // The same spot is often mapped twice (a beach and its bathing place, a park and its reserve).
  // Keep one per name within 400 m: the one with an area, then the larger.
  places.sort((a, b) => (b.ha ?? -1) - (a.ha ?? -1))
  const kept = []
  for (const p of places) {
    const twin = kept.find((k) => k.tags.name.toLowerCase() === p.tags.name.toLowerCase() && metres(k, p) < 400)
    if (twin) {
      for (const key of ['wikidata', 'wikimedia_commons', 'image', 'website']) if (!twin.tags[key] && p.tags[key]) twin.tags[key] = p.tags[key]
      continue
    }
    kept.push(p)
  }
  places = kept

  if (withPhotos && !test) await addPhotos(places)

  const round = (x) => Math.round(x * 1e5) / 1e5
  const out = places.map((p) => {
    const t = p.tags
    const dog = dogRulesFor(t.name, dogRules)
    const nearby = {
      toilet: toilets.some((x) => near(x, p, NEAR_M)),
      water: water.some((x) => near(x, p, NEAR_M)),
      shelter: shelters.some((x) => near(x, p, NEAR_M / 2)) || t.leisure === 'library' || t.amenity === 'library',
      benches: benches.some((x) => near(x, p, 30)),
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

  const data = {
    generated: new Date().toISOString(),
    area: AREA,
    counts: {
      places: out.length,
      bySetting: out.reduce((m, p) => ((m[p.setting] = (m[p.setting] || 0) + 1), m), {}),
      withPhoto: out.filter((p) => p.photo).length,
      toilets: toilets.length, water: water.length, dogParks: dogParks.length,
    },
    places: out.sort((a, b) => a.name.localeCompare(b.name, 'sv')),
    toilets: toilets.map((x) => [round(x.lat), round(x.lon), x.fee ? 1 : 0]),
    water: water.map((x) => [round(x.lat), round(x.lon)]),
    dogParks: dogParks.map((x) => ({ ...x, lat: round(x.lat), lon: round(x.lon) })),
    dogRules,
  }

  for (const l of LANDMARKS) report.landmarks[l] = out.some((p) => p.name.toLowerCase().includes(l.toLowerCase()))
  report.counts = data.counts
  const missing = Object.entries(report.landmarks).filter(([, ok]) => !ok).map(([l]) => l)
  writeReport()
  if (!test && missing.length > 2) {
    console.error(`Landmarks missing: ${missing.join(', ')}. Not replacing the data file.`)
    process.exit(1)
  }

  // Sanity check: never replace a good file with a broken week.
  if (!test && existsSync(OUT)) {
    const old = JSON.parse(readFileSync(OUT, 'utf8'))
    if (old.counts?.places > 50 && out.length < old.counts.places * 0.6) {
      console.error(`Only ${out.length} places this week (was ${old.counts.places}). Keeping last week's file.`)
      process.exit(1)
    }
  }
  if (out.length < (test ? 1 : 50)) {
    console.error(`Only ${out.length} places found. Not writing.`)
    process.exit(1)
  }

  const unmatched = dogRules.local.filter((r) => !out.some((p) => p.dogRule === r.id)).map((r) => r.id)
  if (unmatched.length) console.warn(`Dog rules with no matching place on the map: ${unmatched.join(', ')}`)

  writeFileSync(test ? 'data/sample.json' : OUT, JSON.stringify(data))
  console.log(JSON.stringify(data.counts, null, 1))
}

main().catch((e) => {
  trail.push(`stopped: ${String(e.message || e).slice(0, 300)}`)
  report.failed = true
  writeReport()
  console.error(e)
  process.exit(1)
})
