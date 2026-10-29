// Builds data/gothenburg.json: the one file every phone reads.
//
// Runs weekly on GitHub's servers (see .github/workflows/weekly-data.yml), so phones never
// talk to OpenStreetMap or Wikimedia themselves. It:
//   1. asks OpenStreetMap (Overpass) for calm, free places and nearby facilities,
//   2. works out each place's setting, size and what's close by,
//   3. finds an openly licensed photo on Wikimedia Commons, with its credit,
//   4. adds Gothenburg's dog rules from data/dog-rules-goteborg.json,
//   5. writes the result, but only if it looks sane (so a bad week never empties the map).
//
// Offline test: node scripts/build-data.mjs --fixture tests/fixture-overpass.json --no-photos
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const AREA = { name: 'Göteborg', south: 57.55, west: 11.70, north: 57.86, east: 12.20 }
const OUT = 'data/gothenburg.json'
const USER_AGENT = 'ellenial-maps-data/1.0 (https://maps.ellenial.app; https://github.com/phoenixcyberpunk/ellenial-maps)'
// The main Overpass server first, then community mirrors. All are free and shared, so a busy
// one is normal: the job waits and retries rather than publishing half an answer.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const WIKIDATA = 'https://www.wikidata.org/w/api.php'

const BIG_HA = 10 // places this big or bigger are "big, open"; smaller ones are "small, cosy"
const NATURE_PARK_HA = 30 // a park this big feels like nature rather than a city park
const NEAR_M = 200 // how far around a place a toilet, water tap or shelter still counts as "nearby"

const args = process.argv.slice(2)
const fixture = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null
const withPhotos = !args.includes('--no-photos')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// What happened on the way, written to data/report.json so problems are visible in the repo.
const trail = []
const report = { generated: new Date().toISOString(), queries: {}, landmarks: {}, trail }
const writeReport = () => { if (!fixture) writeFileSync('data/report.json', JSON.stringify(report, null, 1)) }

// ---------- fetching ----------

async function getJson(url, init = {}, tries = 3, wait = (i) => 5000 * (i + 1)) {
  let lastError
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers } })
      if (res.status === 429 || res.status >= 500) throw new Error(`${res.status} from ${new URL(url).host}: ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`)
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
      return await res.json()
    } catch (e) {
      lastError = e
      if (i < tries - 1) await sleep(wait(i))
    }
  }
  throw lastError
}

async function overpass(query) {
  let lastError
  // Two full rounds over all servers; inside each, a busy server gets 3 tries 30 s and 60 s apart.
  for (const endpoint of [...OVERPASS, ...OVERPASS]) {
    try {
      const res = await getJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      }, 3, (i) => 30000 * (i + 1))
      // A "remark" means Overpass stopped early (out of time or memory): the answer is incomplete.
      if (res.remark) throw new Error(`incomplete answer: ${res.remark}`)
      trail.push(`ok ${new URL(endpoint).host}: ${res.elements.length} elements`)
      return res
    } catch (e) {
      lastError = e
      trail.push(`failed ${new URL(endpoint).host}: ${String(e.message).slice(0, 300)}`)
      console.warn(`Overpass ${endpoint} failed: ${e.message}`)
    }
  }
  throw lastError
}

const bbox = `${AREA.south},${AREA.west},${AREA.north},${AREA.east}`

// Several small queries instead of one big one: Overpass quietly cuts a heavy answer short,
// and the big park and reserve outlines are the heaviest part.
const q = (body, out = 'out tags geom;') => `[out:json][timeout:240][maxsize:1073741824][bbox:${bbox}];(${body});${out}`
const PLACE_QUERIES = {
  parks: q('wr["leisure"="park"]["name"];'),
  parkPoints: q('node["leisure"="park"]["name"];', 'out tags;'),
  reserves: q('wr["leisure"="nature_reserve"]["name"];wr["boundary"="protected_area"]["name"];'),
  gardens: q('nwr["leisure"="garden"]["name"];'),
  water: q('nwr["leisure"="bathing_place"]["name"];nwr["leisure"="swimming_area"]["name"];nwr["natural"="beach"]["name"];'),
  squares: q('nwr["place"="square"]["name"];nwr["highway"="pedestrian"]["area"="yes"]["name"~"torg|plats",i];'),
  points: q('nwr["tourism"="viewpoint"]["name"];nwr["amenity"="library"]["name"];', 'out tags center;'),
}

const FACILITIES_QUERY = `[out:json][timeout:180][bbox:${bbox}];
(
  nwr["amenity"="toilets"]["access"!~"private|no|customers"];
  nwr["amenity"="drinking_water"]["access"!~"private|no"];
  nwr["amenity"="shelter"]["access"!~"private|no"];
  node["amenity"="bench"];
  nwr["leisure"="dog_park"];
);
out tags center qt;`

// Well-known places that must be on the map. If several are missing, the week is broken.
const LANDMARKS = ['Slottsskogen', 'Delsjö', 'botaniska trädgård', 'Keillers park', 'Kungsparken', 'Trädgårdsföreningen', 'Ramberget', 'Stora Amundön']

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

// Joins a relation's outer (or inner) member ways into closed rings.
function rings(ways) {
  const open = ways.map((w) => [...w]).filter((w) => w.length > 1)
  const done = []
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon
  while (open.length) {
    let ring = open.shift()
    let grew = true
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false
      for (let i = 0; i < open.length; i++) {
        const w = open[i]
        const end = ring[ring.length - 1]
        if (same(end, w[0])) ring = ring.concat(w.slice(1))
        else if (same(end, w[w.length - 1])) ring = ring.concat([...w].reverse().slice(1))
        else continue
        open.splice(i, 1)
        grew = true
        break
      }
    }
    if (same(ring[0], ring[ring.length - 1]) && ring.length > 3) done.push(ring)
  }
  return done
}

function shape(el) {
  if (el.center && !el.geometry && !el.members) return { lat: el.center.lat, lon: el.center.lon, m2: null, box: [el.center.lat, el.center.lon, el.center.lat, el.center.lon] }
  if (el.type === 'node') return { lat: el.lat, lon: el.lon, m2: null, box: [el.lat, el.lon, el.lat, el.lon] }
  let outer = []
  let inner = []
  if (el.type === 'way' && el.geometry) {
    const g = el.geometry
    const closed = g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon
    outer = closed ? [g] : []
    if (!closed) return lineShape(g)
  } else if (el.type === 'relation' && el.members) {
    const geo = (role) => el.members.filter((m) => m.type === 'way' && m.geometry && (m.role || 'outer') === role).map((m) => m.geometry)
    outer = rings(geo('outer'))
    inner = rings(geo('inner'))
    if (!outer.length) {
      const all = el.members.flatMap((m) => m.geometry || (m.lat ? [m] : []))
      return all.length ? lineShape(all) : null
    }
  } else return null
  const pts = outer.flat()
  const box = [Math.min(...pts.map((p) => p.lat)), Math.min(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lon))]
  const lat0 = (box[0] + box[2]) / 2
  const m2 = outer.reduce((s, r) => s + ringArea(r, lat0), 0) - inner.reduce((s, r) => s + ringArea(r, lat0), 0)
  // Marker: the outer-ring vertex average, nudged to the bbox centre if that falls inside.
  const biggest = outer.reduce((a, b) => (ringArea(b, lat0) > ringArea(a, lat0) ? b : a))
  let lat = biggest.reduce((s, p) => s + p.lat, 0) / biggest.length
  let lon = biggest.reduce((s, p) => s + p.lon, 0) / biggest.length
  if (!inside({ lat, lon }, biggest)) [lat, lon] = [biggest[0].lat, biggest[0].lon]
  return { lat, lon, m2: Math.max(m2, 0), box, ring: biggest }
}

function lineShape(points) {
  const box = [Math.min(...points.map((p) => p.lat)), Math.min(...points.map((p) => p.lon)), Math.max(...points.map((p) => p.lat)), Math.max(...points.map((p) => p.lon))]
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
  if (t.amenity === 'library') return 'library'
  if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return 'square'
  if (t.tourism === 'viewpoint') return 'viewpoint'
  if (t.leisure === 'bathing_place' || t.leisure === 'swimming_area' || t.natural === 'beach') return 'swim'
  if (t.leisure === 'garden') return 'garden'
  if (t.leisure === 'nature_reserve' || t.boundary === 'protected_area') return 'reserve'
  if (t.leisure === 'park') return 'park'
  return null
}

function keep(t, kind) {
  if (isPrivate(t)) return false
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
  let placesRaw
  if (fixture) placesRaw = JSON.parse(readFileSync(fixture, 'utf8')).places
  else {
    placesRaw = { elements: [] }
    for (const [name, query] of Object.entries(PLACE_QUERIES)) {
      trail.push(`query ${name}`)
      const res = await overpass(query)
      report.queries[name] = res.elements.length
      placesRaw.elements.push(...res.elements)
      await sleep(2000)
    }
  }
  if (!fixture) trail.push("query facilities")
  const facilitiesRaw = fixture ? JSON.parse(readFileSync(fixture, 'utf8')).facilities : await overpass(FACILITIES_QUERY)
  const dogRules = JSON.parse(readFileSync('data/dog-rules-goteborg.json', 'utf8'))

  // Facilities
  const pt = (e) => (e.lat != null ? { lat: e.lat, lon: e.lon } : e.center ? { lat: e.center.lat, lon: e.center.lon } : null)
  const toilets = []
  const water = []
  const shelters = []
  const benches = []
  const dogParks = []
  for (const e of facilitiesRaw.elements) {
    const p = pt(e)
    if (!p) continue
    const t = e.tags || {}
    if (t.amenity === 'toilets') toilets.push({ ...p, fee: t.fee === 'yes' })
    else if (t.amenity === 'drinking_water') water.push(p)
    else if (t.amenity === 'shelter') shelters.push(p)
    else if (t.amenity === 'bench') benches.push(p)
    else if (t.leisure === 'dog_park') dogParks.push({ ...p, name: t.name || null, fenced: t.barrier === 'fence' || t.fenced === 'yes', osm: `${e.type}/${e.id}` })
  }

  // Places
  let places = []
  for (const e of placesRaw.elements) {
    const t = e.tags || {}
    const kind = kindOf(t)
    if (!kind || !t.name || !keep(t, kind)) continue
    const s = shape(e)
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

  if (withPhotos && !fixture) await addPhotos(places)

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
      size: p.ha == null ? null : p.ha >= BIG_HA ? 'big' : 'small',
      ha: p.ha == null ? null : Math.round(p.ha * 10) / 10,
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
  if (!fixture && missing.length > 2) {
    console.error(`Landmarks missing: ${missing.join(', ')}. Not replacing the data file.`)
    process.exit(1)
  }

  // Sanity check: never replace a good file with a broken week.
  if (!fixture && existsSync(OUT)) {
    const old = JSON.parse(readFileSync(OUT, 'utf8'))
    if (old.counts?.places > 50 && out.length < old.counts.places * 0.6) {
      console.error(`Only ${out.length} places this week (was ${old.counts.places}). Keeping last week's file.`)
      process.exit(1)
    }
  }
  if (out.length < (fixture ? 1 : 50)) {
    console.error(`Only ${out.length} places found. Not writing.`)
    process.exit(1)
  }

  const unmatched = dogRules.local.filter((r) => !out.some((p) => p.dogRule === r.id)).map((r) => r.id)
  if (unmatched.length) console.warn(`Dog rules with no matching place on the map: ${unmatched.join(', ')}`)

  writeFileSync(fixture ? 'data/sample.json' : OUT, JSON.stringify(data))
  console.log(JSON.stringify(data.counts, null, 1))
}

main().catch((e) => {
  trail.push(`stopped: ${String(e.message || e).slice(0, 300)}`)
  report.failed = true
  writeReport()
  console.error(e)
  process.exit(1)
})
