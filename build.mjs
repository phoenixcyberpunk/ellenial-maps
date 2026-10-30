// Builds the site into dist/:
// - site/ (the page, styles, scripts),
// - MapLibre's CSP-safe build and the self-hosted fonts, copied from npm so no visitor loads
//   anything from a CDN or Google,
// - data/gothenburg.json (written weekly by scripts/build-data.mjs) as /data/places.json.
//   Before the first weekly run it falls back to data/sample.json so the page still builds.
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'

const FONTS = [
  ['fraunces', [500]],
  ['dm-sans', [400, 500, 600]],
]

rmSync('dist', { recursive: true, force: true })
cpSync('site', 'dist', { recursive: true })

mkdirSync('dist/vendor', { recursive: true })
for (const f of ['maplibre-gl-csp.js', 'maplibre-gl-csp-worker.js', 'maplibre-gl.css', 'LICENSE.txt']) {
  copyFileSync(`node_modules/maplibre-gl/dist/${f}`, `dist/vendor/${f === 'LICENSE.txt' ? 'maplibre-LICENSE.txt' : f}`)
}

mkdirSync('dist/fonts', { recursive: true })
for (const [family, weights] of FONTS) {
  for (const w of weights) {
    const file = `${family}-latin-${w}-normal.woff2`
    copyFileSync(`node_modules/@fontsource/${family}/files/${file}`, `dist/fonts/${file}`)
  }
}

mkdirSync('dist/data', { recursive: true })
const data = existsSync('data/gothenburg.json') ? 'data/gothenburg.json' : 'data/sample.json'
copyFileSync(data, 'dist/data/places.json')
console.log(`Built dist/ with ${data}`)
