// Gives Maps its own copies of the Commons photos it shows, so the site no longer needs to forward
// requests to Wikimedia (security re-check M1, 6 Nov 2026).
//
// Runs in the weekly workflow right after build-data.mjs, before the commit:
//   1. finds every photo address in data/sweden/ ("src": "/photo/…" or "/thumb/…"),
//   2. downloads each one once from Wikimedia (a 640 px thumbnail when Wikimedia has one),
//   3. shrinks it to at most 640 px wide as a JPEG without any metadata (no camera or GPS details),
//   4. uploads it to the Cloudflare R2 bucket as <name>.jpg and points the data at /photos/<name>.jpg
//      (vercel.json passes /photos/ on to the bucket, so phones still only talk to maps.ellenial.app),
//   5. removes copies from the bucket that no place has used for 4 weeks.
// data/photos.json lists every copy in the bucket with its size and the last day a place used it.
// The photos used to live in data/photos/ and rode along in every Vercel deployment until they
// filled the free 10 GB Deployment Storage (moved to R2 on 23 Nov 2026).
// Names come from the source address, so a photo is downloaded once and reused every week.
// A photo that can't be fetched keeps its old address this week and is tried again next week.
//
//   node scripts/fetch-photos.mjs            (needs sharp and @aws-sdk/client-s3: npm i --no-save …,
//                                             and R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
//   node scripts/fetch-photos.mjs --dry-run  (lists what it would fetch, changes nothing)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const DATA = 'data/sweden'
const MANIFEST = 'data/photos.json'
const BUCKET = 'ellenial-maps-photos'
const KEEP_UNUSED_DAYS = 28 // a copy no place uses is removed only after this long (live pages may still show it)
const WIDTH = 640
const MAX_BYTES = 40 * 1024 * 1024 // never pull anything bigger than this
const BUDGET_MS = 45 * 60 * 1000 // whatever isn't done in time is done next week
const PAUSE_MS = 150 // be gentle with Wikimedia
const USER_AGENT = 'ellenial-maps-data/2.0 (https://maps.ellenial.app)'
const HOSTS = { '/photo/': 'https://upload.wikimedia.org/', '/thumb/': 'https://thumb.wikimedia.org/' }
const dryRun = process.argv.includes('--dry-run')

// Full Wikimedia addresses (from cache entries older than the host mapping) count too: they're
// turned into the /photo/ or /thumb/ form first (9 Nov fix; ~9,200 photos had slipped past).
const shortForm = (s) => (typeof s === 'string' ? s.split('?')[0].replace('https://upload.wikimedia.org/', '/photo/').replace('https://thumb.wikimedia.org/', '/thumb/') : s)
const isRemote = (s) => typeof s === 'string' && (s.startsWith('/photo/') || s.startsWith('/thumb/'))
const nameFor = (src) => createHash('sha1').update(src.split('?')[0]).digest('hex').slice(0, 20) + '.jpg'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function jsonFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...jsonFiles(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

function normalise(node) {
  if (Array.isArray(node)) for (const v of node) normalise(v)
  else if (node && typeof node === 'object') {
    if (typeof node.src === 'string' && node.src.startsWith('https://') && /wikimedia\.org\//.test(node.src)) node.src = shortForm(node.src)
    for (const v of Object.values(node)) normalise(v)
  }
}

// Every object with a photo address, wherever it sits in a file.
function photoRecords(node, found) {
  if (Array.isArray(node)) for (const v of node) photoRecords(v, found)
  else if (node && typeof node === 'object') {
    if (isRemote(node.src) || (typeof node.src === 'string' && node.src.startsWith('/photos/'))) found.push(node)
    for (const v of Object.values(node)) photoRecords(v, found)
  }
  return found
}

// Wikimedia addresses to try, smallest first: a ready-made 640 px thumbnail, then the file itself.
function candidates(src) {
  const path = src.split('?')[0]
  const prefix = path.startsWith('/photo/') ? '/photo/' : '/thumb/'
  const rest = path.slice(prefix.length)
  const urls = []
  const m = /^wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/.exec(rest)
  if (prefix === '/photo/' && m) {
    urls.push(`https://thumb.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/${WIDTH}px-${m[3]}`)
    urls.push(`https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/${WIDTH}px-${m[3]}`)
  }
  urls.push(HOSTS[prefix] + rest)
  return urls
}

async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) })
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (attempt + 1)); continue }
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (!type.startsWith('image/')) return null
    const size = Number(res.headers.get('content-length') || 0)
    if (size > MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > MAX_BYTES ? null : buf
  }
  return null
}

async function main() {
  const started = Date.now()
  const files = jsonFiles(DATA)
  const docs = files.map((f) => ({ f, d: JSON.parse(readFileSync(f, 'utf8')) }))
  for (const { d } of docs) normalise(d)
  const all = docs.flatMap(({ f, d }) => photoRecords(d, []).map((r) => ({ f, r })))
  const remote = [...new Set(all.filter((x) => isRemote(x.r.src)).map((x) => x.r.src.split('?')[0]))]
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
  const have = new Set(Object.keys(manifest))
  const inGallery = new Set(all.filter((x) => x.f.includes('/gallery/')).map((x) => x.r.src.split('?')[0]))
  // Order: place photos before gallery photos, Gothenburg's square (230_23) outwards, so if time
  // runs out the cards people see most are done first.
  const fileOf = new Map(all.map((x) => [x.r.src.split('?')[0], x.f]))
  const away = (s) => { const m = /(\d+)_(\d+)\.json$/.exec(fileOf.get(s) || ''); return m ? Math.hypot(m[1] - 230, m[2] - 23) : 999 }
  const todo = remote.filter((s) => !have.has(nameFor(s))).sort((a, b) => (inGallery.has(a) - inGallery.has(b)) || (away(a) - away(b)))
  console.log(`photos: ${remote.length} remote addresses, ${remote.length - todo.length} already copied, ${todo.length} to fetch`)
  if (dryRun) { for (const s of todo.slice(0, 20)) console.log('  would fetch', candidates(s)[0]); return }

  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!process.env[k]) throw new Error(`${k} is missing (a GitHub secret)`)
  }
  const sharp = (await import('sharp')).default
  const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  const r2 = new S3Client({
    region: 'auto',
    // The secret may hold just the account ID or the whole endpoint address; keep only the ID.
    endpoint: `https://${process.env.R2_ACCOUNT_ID.replace(/^https:\/\//, '').split('.')[0]}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  const today = new Date().toISOString().slice(0, 10)
  let fetched = 0, failed = 0
  for (const src of todo) {
    if (Date.now() - started > BUDGET_MS) { console.log('photos: out of time, the rest waits for next week'); break }
    let buf = null
    for (const url of candidates(src)) {
      try { buf = await download(url) } catch { buf = null }
      await sleep(PAUSE_MS)
      if (buf) break
    }
    if (!buf) { failed++; continue }
    try {
      const out = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: WIDTH, withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      // Only a photo that is safely in the bucket gets listed (and so used by the data).
      await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: nameFor(src), Body: out.data,
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }))
      manifest[nameFor(src)] = { w: out.info.width, h: out.info.height, u: today }
      have.add(nameFor(src))
      fetched++
    } catch (e) {
      console.warn(`photos: couldn't shrink or upload ${src}: ${e.message}`)
      failed++
    }
  }

  // Point the data at the copies (and remember which copies are in use).
  const used = new Set()
  const changed = new Set()
  for (const { f, r } of all) {
    if (isRemote(r.src)) {
      const name = nameFor(r.src)
      if (!have.has(name)) continue
      r.src = '/photos/' + name
      // The copy's real size (the rebuilt data carries Wikimedia's)
      const s = manifest[name]
      if (s) { r.w = s.w; r.h = s.h }
      changed.add(f)
    }
    if (r.src.startsWith('/photos/')) used.add(r.src.slice('/photos/'.length))
  }
  for (const { f, d } of docs) if (changed.has(f)) writeFileSync(f, JSON.stringify(d))

  for (const n of used) if (manifest[n]) manifest[n].u = today
  let removed = 0
  const cutoff = new Date(Date.now() - KEEP_UNUSED_DAYS * 86400000).toISOString().slice(0, 10)
  for (const [n, m] of Object.entries(manifest)) {
    if (used.has(n) || m.u >= cutoff) continue
    try { await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: n })); delete manifest[n]; removed++ } catch {}
  }
  writeFileSync(MANIFEST, JSON.stringify(Object.fromEntries(Object.entries(manifest).sort())))
  console.log(`photos: ${fetched} fetched, ${failed} failed (kept their old address), ${removed} copies unused for ${KEEP_UNUSED_DAYS} days removed, ${used.size} in use`)
}

main().catch((e) => { console.error(e); process.exit(1) })
