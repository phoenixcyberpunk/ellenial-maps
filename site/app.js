// ellenial maps: one small script, no framework, no tracking.
// Views: home (#/), filters (#/filters), a place (#/place/<id>/<square>), dog (#/dog), about (#/about).
// Everything the app needs comes from this site: /data/places.json, /ofm/ (map), /photo/ (photos).
;(() => {
  'use strict'

  // ---------- small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel)
  // replaceChildren() would print arrays and nulls as text; flatten and drop empties first.
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false))

  // Builds elements without innerHTML, so text from the data can never run as code.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else if (k === 'style') el.setAttribute('style', v)
      else el.setAttribute(k, v === true ? '' : v)
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid))
    return el
  }
  const svg = (paths, size = 18) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24')
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2')
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true')
    for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p) }
    return s
  }
  const ICON = {
    back: ['M15 18l-6-6 6-6'], next: ['M9 18l6-6-6-6'], close: ['M6 6l12 12', 'M18 6L6 18'], out: ['M7 17L17 7', 'M8 7h9v9'],
    filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'], drop: ['M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z'],
    locate: ['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8'],
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem('ellenial-maps:' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set(k, v) { try { localStorage.setItem('ellenial-maps:' + k, JSON.stringify(v)) } catch { /* private mode: fine */ } },
  }

  let lang = store.get('lang', null) || ((navigator.languages || [navigator.language || 'en']).some((l) => /^sv\b/i.test(l)) ? 'sv' : 'en')
  const t = () => window.STRINGS[lang]

  const CENTRE = { lat: 57.7072, lon: 11.9668 } // Gustaf Adolfs torg

  // ---------- deep link from other Ellenial apps ----------
  // maps.ellenial.app/?at=LAT,LNG[&z=ZOOM][&name=Label] opens the map on that spot. If one of our
  // places is within MATCH_M metres it is selected (pin + card); otherwise a plain pin with the
  // label is shown. Read once on load, never saved or sent anywhere.
  const MATCH_M = 50
  const AT = (() => {
    try {
      const q = new URLSearchParams(location.search)
      const m = (q.get('at') || '').match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/)
      if (!m) return null
      const lat = +m[1], lon = +m[2]
      if (lat < 54 || lat > 70 || lon < 4 || lon > 32) return null // our data covers Sweden
      const z = Math.min(18, Math.max(5, Number(q.get('z')) || 16))
      const name = (q.get('name') || '').trim().slice(0, 80) || null
      return { lat, lon, z, name }
    } catch { return null }
  })()
  const SETTINGS = ['nature', 'water', 'urban', 'squares', 'gardens', 'view', 'libraries']

  const state = {
    data: null,
    filters: Object.assign({ settings: [], size: 'any', nearby: [] }, store.get('filters', {})),
    dog: store.get('dog', false) === true,
    me: null,
    // Layout A (Ellen, 5 Nov): on a phone it's the map or the list, never both. 'both' saved by
    // older versions means the map.
    view: store.get('view', 'map') === 'list' ? 'list' : 'map',
    follow: null, // the map's current view once the person has moved it: { s, w, n, e, lat, lon }
    sel: null,
    area: null, // a town or area picked in search: { name, lat, lon }
  }
  const saveFilters = () => store.set('filters', state.filters)

  // ---------- dates and distances ----------
  const pad = (n) => String(n).padStart(2, '0')
  const today = () => { const d = new Date(); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
  const inRange = (from, to, day = today()) => (from <= to ? day >= from && day <= to : day >= from || day <= to)
  const fmtDay = (md) => { const [m, d] = md.split('-').map(Number); return `${d} ${t().months[m - 1]}` }

  function metres(a, b) {
    const r = 6371008.8, rad = Math.PI / 180
    const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad)
    const y = (b.lat - a.lat) * rad
    return Math.hypot(x, y) * r
  }
  const from = () => state.area || state.me || AT || CENTRE

  // ---------- dog rules ----------
  function dogStatus(rule) {
    if (!rule) return null
    const s = t()
    switch (rule.kind) {
      case 'banned-between': return { allowed: !inRange(rule.from, rule.to), text: s.dogsBannedBetween(fmtDay(rule.from), fmtDay(rule.to)), months: monthsOff(rule.from, rule.to, true) }
      case 'allowed-between': return { allowed: inRange(rule.from, rule.to), text: s.dogsAllowedBetween(fmtDay(rule.from), fmtDay(rule.to)), months: monthsOff(rule.from, rule.to, false) }
      case 'always': return rule.rule === 'banned'
        ? { allowed: false, text: s.dogsBannedAlways, months: Array(12).fill(false) }
        : { allowed: true, text: s.dogsAlwaysLeash, months: Array(12).fill(true) }
    }
    return null
  }
  // Which months dogs are allowed (true) for the 12-month strip.
  function monthsOff(fromMd, toMd, rangeIsBan) {
    return Array.from({ length: 12 }, (_, i) => {
      const mid = `${pad(i + 1)}-15`
      const hit = inRange(fromMd, toMd, mid)
      return rangeIsBan ? !hit : hit
    })
  }
  const ruleFor = (p) => (p.dogRule && state.data ? state.data.dogRules.local.find((r) => r.id === p.dogRule) : null)

  // ---------- filtering ----------
  function matches(p) {
    const f = state.filters
    if (f.settings.length && !f.settings.includes(p.setting)) return false
    if (f.size !== 'any' && p.size !== f.size) return false
    for (const n of f.nearby) if (!p.nearby[n]) return false
    return true
  }
  // The list follows the map (Ellen, 5 Nov): once the map has been moved, only the places in
  // view are listed, closest to the middle of the map first. Before that, closest to the person.
  const visible = () => {
    const f = state.follow
    const o = f ? { lat: f.lat, lon: f.lon } : from()
    return state.data.places.filter(matches)
      .filter((p) => !f || (p.lat >= f.s && p.lat <= f.n && p.lon >= f.w && p.lon <= f.e))
      .map((p) => ({ p, d: metres(o, p) })).sort((a, b) => a.d - b.d)
  }
  const activeCount = () => (state.filters.size !== 'any' ? 1 : 0) + state.filters.nearby.length

  // ---------- shared bits ----------
  function dogSwitch(withHint) {
    const s = t()
    return h('button', {
      class: 'dog-switch' + (withHint ? ' dog-switch--row' : ''), 'aria-pressed': String(state.dog), type: 'button',
      onclick: () => { state.dog = !state.dog; store.set('dog', state.dog); render() },
    },
    art('paw', withHint ? 24 : 18),
    withHint ? h('span', { class: 'dog-switch__text' }, h('span', { class: 'dog-switch__label' }, s.dogSwitchLong), h('span', { class: 'dog-switch__hint' }, s.dogSwitchHint)) : s.dogSwitch,
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch__knob' })))
  }

  // Ellen's own hand-drawn icons (5 Nov), in site/art/ as <name>-light.png, used as drawn in both themes
  // (decided 5 Nov: on dark surfaces the outline melts away and the fills carry the shape, like Weather;
  // the -dark copies and paw-halo are unused).
  // (made by scripts/make-art.py). Anything not drawn yet keeps its Lucide icon from icons.js.
  const ART = new Set(['nature', 'water', 'urban', 'squares', 'gardens', 'view', 'libraries', 'toilet', 'tap', 'dogrun', 'town', 'shelter', 'paw'])
  const art = (name, size) => h('span', { class: `art art--${name}`, style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' })

  // The setting's icon: Ellen's drawing when there is one, else from icons.js (our own build file).
  function settingIcon(setting, size) {
    if (ART.has(setting)) return art(setting, size)
    const inner = (window.EM_ICONS || {})[setting]
    if (!inner) return null
    const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`, 'image/svg+xml')
    return document.importNode(doc.documentElement, true)
  }

  // Legend entry: the same disc and icon as the pin on the map.
  function legendDot(kind, icon) {
    const drawn = ART.has(icon)
    const dot = h('span', { class: 'dot dot--' + (drawn ? 'art' : kind), 'aria-hidden': 'true' })
    const svg = settingIcon(icon, drawn ? 14 : 11)
    if (svg) { if (!drawn) svg.setAttribute('stroke-width', '2.6'); dot.append(svg) }
    return dot
  }

  // No photo yet: the place's own outline from the map when it has one (decided 1 Nov), with the
  // pin's icon and a short word in the corner so it reads at a glance. Places that are only a point
  // on the map keep a calm block in the setting's colour with Ellen's drawn icon (the bracket words
  // from the first build were dropped 6 Nov, since the drawings now say it).
  const SVG_NS = 'http://www.w3.org/2000/svg'
  function placeholder(setting, cls, p) {
    const big = /pcard__img|hero__img/.test(cls || '')
    if (p && Array.isArray(p.outline) && p.outline.length >= 8) return outlineCard(p, cls, big)
    return h('div', { class: `placeholder placeholder--${setting} ${cls || ''}`, role: 'img', 'aria-label': t().noPhoto },
      settingIcon(setting, /hero__img/.test(cls || '') ? 56 : big ? 40 : 24))
  }

  function outlineCard(p, cls, big) {
    const [w, hh, ...xy] = p.outline
    const pad = 6
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${w + pad * 2} ${hh + pad * 2}`)
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', 'outline__shape')
    const poly = document.createElementNS(SVG_NS, 'polygon')
    const pts = []
    for (let i = 0; i + 1 < xy.length; i += 2) pts.push(xy[i] + ',' + xy[i + 1])
    poly.setAttribute('points', pts.join(' '))
    poly.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.append(poly)
    const s = t()
    const word = s.kindShort[p.kind] || s.settings[p.setting]
    const card = h('div', { class: `outline outline--${p.setting} ${big ? 'outline--big' : ''} ${cls || ''}`, role: 'img', 'aria-label': s.outlineOf(p.name) },
      svg,
      big ? h('span', { class: 'outline__label' }, settingIcon(p.setting, 16), word) : null)
    if (/pcard__img/.test(cls || '') && Array.isArray(p.obox)) cardMap(p, card)
    return card
  }

  // ---------- map pictures behind outline cards (5 Nov, an experiment on the preview) ----------
  // One hidden map "photographs" each card's place: the real map with the shape drawn on it.
  // Only cards on screen, only when the phone is idle, one at a time. A picture is drawn once and
  // kept on this phone (Cache Storage), so parks that never change are never redrawn; a new shape,
  // the other theme or a new map style gets a new picture. Until it's ready the plain outline shows.
  const SNAP_W = 168, SNAP_H = 112, SNAP_VERSION = 'v1'
  const snapUrls = new Map() // key -> object URL, for this visit
  const snapQueue = []
  let snapMap = null, snapBusy = false, snapCache = null
  const snapKey = (p) => `${SNAP_VERSION}-${isDark() ? 'd' : 'l'}-${p.id}-${p.outline.length}-${p.outline.slice(2, 8).join('.')}`
  const snapSeen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { snapSeen.unobserve(e.target); snapQueue.push(e.target._snap); runSnaps() }
  }, { rootMargin: '200px' })
  function cardMap(p, card) {
    const key = snapKey(p)
    const show = (url) => { card.style.backgroundImage = `url("${url}")`; card.classList.add('outline--map') }
    if (snapUrls.has(key)) { show(snapUrls.get(key)); return }
    card._snap = { p, key, show }
    // Already drawn on an earlier visit: straight from this phone's cache, no queue.
    openSnapCache().then((c) => c && c.match('/card/' + key)).then(async (hit) => {
      if (hit) { const url = URL.createObjectURL(await hit.blob()); snapUrls.set(key, url); show(url) }
      else if (card.isConnected) snapSeen.observe(card)
    }).catch(() => card.isConnected && snapSeen.observe(card))
  }
  const openSnapCache = () => (snapCache !== null ? Promise.resolve(snapCache) : (window.caches ? caches.open('ellenial-maps-cards').catch(() => false) : Promise.resolve(false)).then((c) => (snapCache = c)))
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 60))
  async function runSnaps() {
    if (snapBusy || !snapQueue.length || !window.maplibregl) return
    snapBusy = true
    const job = snapQueue.shift()
    try {
      if (snapUrls.has(job.key)) { job.show(snapUrls.get(job.key)); return }
      await openSnapCache()
      await new Promise((ok) => idle(ok))
      const blob = await drawSnap(job.p)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      snapUrls.set(job.key, url)
      job.show(url)
      if (snapCache) snapCache.put('/card/' + job.key, new Response(blob, { headers: { 'content-type': blob.type } })).catch(() => {})
    } catch { /* keep the plain outline */ } finally {
      snapBusy = false
      if (snapQueue.length) runSnaps()
    }
  }
  function drawSnap(p) {
    return new Promise((resolve) => {
      const dark = isDark()
      if (!snapMap || snapMap._dark !== dark) {
        snapMap?.remove()
        const box = document.getElementById('snap-map') || document.body.appendChild(h('div', { id: 'snap-map', 'aria-hidden': 'true' }))
        snapMap = new window.maplibregl.Map({
          container: box, style: window.mapStyle(location.origin, dark), interactive: false, attributionControl: false,
          pixelRatio: 2, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true },
          transformRequest: (url) => ({ url: url.replace('https://tiles.openfreemap.org/', location.origin + '/ofm/') }),
        })
        snapMap._dark = dark
        snapMap._ready = new Promise((ok) => snapMap.once('load', () => {
          snapMap.addSource('shape', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
          const line = dark ? '#BFD8C2' : '#3E6B47'
          snapMap.addLayer({ id: 'shape-fill', type: 'fill', source: 'shape', paint: { 'fill-color': line, 'fill-opacity': 0.28 } })
          snapMap.addLayer({ id: 'shape-line', type: 'line', source: 'shape', paint: { 'line-color': line, 'line-width': 2 } })
          ok()
        }))
      }
      const m = snapMap
      const timer = setTimeout(() => resolve(null), 8000)
      m._ready.then(() => {
        m.getSource('shape').setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [outlineGeo(p)] }, properties: {} })
        m.fitBounds([[p.obox[1], p.obox[0]], [p.obox[3], p.obox[2]]], { padding: 14, maxZoom: 16, duration: 0 })
        m.once('idle', () => { clearTimeout(timer); m.getCanvas().toBlob((b) => resolve(b), 'image/webp', 0.8) })
        m.triggerRepaint()
      })
    })
  }

  // If a photo can't load, show the outline or placeholder instead of a broken image.
  function photoOr(img, setting, cls, p) {
    img.addEventListener('error', () => { img.parentElement?.querySelector('.hero__credit')?.remove(); img.replaceWith(placeholder(setting, cls, p)) }, { once: true })
    return img
  }

  function tags(p) {
    const s = t()
    const out = [h('span', { class: 'tag tag--free' }, p.fee ? s.fee : s.free)]
    if (p.nearby.toilet) out.push(h('span', { class: 'tag tag--facility' }, 'WC'))
    if (p.nearby.water) out.push(h('span', { class: 'tag tag--facility' }, s.waterTap))
    if (p.nearby.benches) out.push(h('span', { class: 'tag' }, s.benches))
    if (state.dog) {
      const st = dogStatus(ruleFor(p))
      if (st && !st.allowed) out.push(h('span', { class: 'tag tag--warn' }, s.noDogsToday))
    }
    return h('div', { class: 'tags' }, out)
  }

  const kicker = (p) => [t().kinds[p.kind] || t().settings[p.setting], p.size && t()[p.size]].filter(Boolean).join(' · ')

  function footer() {
    const s = t()
    return h('footer', { class: 'footer' },
      h('p', { class: 'footer__slogan' }, state.dog ? s.shortWalk : s.footerSlogan),
      h('p', { class: 'footer__line' }, s.footerLine),
      h('p', { class: 'footer__links' }, h('a', { href: '#/about' }, s.about)),
      h('div', { class: 'footer__prefs' }, langSwitch(), themeSwitch()))
  }

  // Auto / Light / Dark, from the shared Ellenial pattern (ellenial-theme.js), saved on this phone only.
  function themeSwitch() {
    const s = t()
    if (!window.EllenialTheme) return null
    return window.EllenialTheme.control({
      label: s.theme, autoHint: s.themeAutoHint, separator: ' · ',
      labels: { auto: s.themeAuto, light: s.themeLight, dark: s.themeDark },
    })
  }

  function langSwitch() {
    const btn = (code) => h('button', {
      type: 'button', class: 'lang', 'aria-pressed': String(lang === code), lang: code,
      onclick: () => { lang = code; store.set('lang', code); render() },
    }, code.toUpperCase())
    return h('span', { class: 'langs', role: 'group', 'aria-label': t().language }, btn('en'), ' | ', btn('sv'))
  }

  function topBar(title, closeIcon) {
    return h('div', { class: 'topbar' },
      h('a', { class: 'round-btn', href: '#/', 'aria-label': closeIcon ? t().close : t().back, onclick: goBack }, svg(closeIcon ? ICON.close : ICON.back)),
      title ? h('h1', { class: 'topbar__title' }, title) : null)
  }
  // Back goes back in history when we came from inside the app, else home.
  let internalNav = false
  function goBack(e) {
    if (internalNav && history.length > 1) { e.preventDefault(); history.back() }
  }

  // ---------- home ----------
  // Layout (round 2): a header with one sideways row of chips and a Both / Map / List toggle,
  // the map filling the rest of the screen, and a pull-up panel over it with sections of
  // sideways photo cards. Tapping a pin selects its card; tapping a card selects its pin.
  let map = null
  let mapReady = false
  let homeScroll = 0
  let panelScroll = 0
  const NEARBY_M = 2000
  const SHELF = 10
  // Phones show the map or the list; computers (900 px and wider) always show both side by side.
  const mapShown = () => state.view !== 'list' || wide.matches

  function renderHome() {
    // While searching, the header (and the field being typed in) stays put; only the results change.
    if (search.open) return renderResults()
    const s = t()
    const home = $('#home')
    const list = visible()
    document.title = `${s.title} · ${s.tagline}`
    home.className = `home home--${state.view}`

    fill($('#home-top'),
      h('div', { class: 'brandbar' }, h('p', { class: 'brand' }, s.title), dogSwitch(false)),
      h('h1', { class: 'sr-only' }, s.homeHeading),
      searchRow(),
      h('div', { class: 'chiprow' },
        h('div', { class: 'chiprow__scroll', role: 'group', 'aria-label': s.setting }, SETTINGS.map((key) => chip(key))),
        h('a', { class: 'chip chip--sm chip--more', href: '#/filters' }, svg(ICON.filter, 14), s.more, activeCount() ? h('span', { class: 'badge' }, activeCount()) : null)),
      h('div', { class: 'toolbar' },
        h('button', { class: 'near-me', type: 'button', onclick: nearMe }, svg(ICON.locate, 16), s.nearMe),
        state.follow ? h('button', { class: 'near-me near-me--reset', type: 'button', onclick: unfollow }, svg(ICON.close, 14), s.wholeArea) : null))

    const near = list.filter((x) => x.d <= NEARBY_M).length
    const sel = state.sel && state.data.places.find((p) => p.id === state.sel)
    const title = state.follow ? s.placesInView(list.length)
      : state.area ? s.placesNearArea(list.filter((x) => x.d <= AREA_M).length || list.length, state.area.name)
      : near ? s.placesNearby(near) : s.placesCount(list.length)
    // On a phone this is the bar along the bottom of the map (count, legend, "Show list"), or the
    // top of the full-screen list. On a computer it heads the list beside the map.
    fill($('#panel-head'),
      sel ? selectedCard(sel, list.find((x) => x.p.id === sel.id)?.d ?? metres(from(), sel)) : null,
      h('div', { class: 'sheet__count' },
        h('div', { class: 'sheet__lead' },
          h('h2', { class: 'sheet__title' }, title),
          h('span', { class: 'legend' },
            h('span', { class: 'legend__item' }, legendDot('toilet', 'toilet'), s.toilet),
            h('span', { class: 'legend__item' }, legendDot('water', 'tap'), s.waterTap),
            state.dog ? h('span', { class: 'legend__item' }, legendDot('dog', 'dogrun'), s.dogRun) : null)),
        h('button', { class: 'pill-btn pill-btn--soft sheet__switch', type: 'button', onclick: () => setView('list') }, s.showList, svg(ICON.next, 16))),
      state.dog ? dogStrip() : null)
    // In the list: a floating button back to the map.
    fill($('#map-fab'), h('button', { class: 'pill-btn map-fab', type: 'button', onclick: () => setView('map') }, settingIcon('town', 18), s.showMap))

    const dogShelf = ['dog', list.filter(({ p }) => goodWithDog(p))]
    const shelves = [
      ...(state.dog ? [dogShelf] : []),
      ['closest', list],
      ...(state.dog ? [] : [dogShelf]),
      ['nature', list.filter(({ p }) => p.setting === 'nature')],
      ['indoor', list.filter(({ p }) => p.setting === 'libraries' || p.nearby.shelter)],
    ]
    fill($('#panel-body'),
      list.length
        ? shelves.map(([key, items]) => items.length ? shelf(s.sections[key], items.slice(0, SHELF)) : null)
        : h('div', { class: 'empty sheet__pad' }, h('p', null, s.nothingFound),
          h('button', { class: 'pill-btn', type: 'button', onclick: () => { state.filters = { settings: [], size: 'any', nearby: [] }; saveFilters(); render() } }, s.clearFilters)),
      h('div', { class: 'sheet__pad' }, footer()))

    $('#map').setAttribute('aria-label', s.mapLabel)
    home.hidden = false
    updateMap(list)
    requestAnimationFrame(() => { if (map && mapShown()) map.resize() })
  }

  function setView(v) {
    state.view = v
    store.set('view', v)
    render()
    if (v === 'list') { $('#panel-head').scrollIntoView?.({ block: 'start' }); window.scrollTo(0, 0) }
  }
  // Back from "places in this area" to places near the person (or the picked town).
  function unfollow() {
    state.follow = null
    const o = from()
    if (map) { map.flyTo({ center: [o.lon, o.lat], zoom: state.area ? 13 : state.me ? 13 : 11 }) }
    render()
  }

  function chip(key) {
    const on = state.filters.settings.includes(key)
    return h('button', {
      type: 'button', class: 'chip chip--sm', 'aria-pressed': String(on),
      onclick: () => { toggle(state.filters.settings, key); saveFilters(); render() },
    }, t().settings[key])
  }
  const toggle = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v) }

  // "Good with a dog": outdoors, no dog ban today, and room to walk (big, nature) or a dog run close by.
  function goodWithDog(p) {
    if (p.setting === 'libraries') return false
    const st = dogStatus(ruleFor(p))
    if (st && !st.allowed) return false
    return p.size === 'big' || p.setting === 'nature' || p._dogRun <= 500
  }

  function placeImg(p, w, hgt, cls) {
    return p.photo
      ? photoOr(h('img', { class: cls, src: p.photo.src, alt: '', loading: 'lazy', width: w, height: hgt }), p.setting, cls, p)
      : placeholder(p.setting, cls, p)
  }

  function shelf(title, items) {
    return h('section', { class: 'shelf' },
      h('h3', { class: 'shelf__title' }, title),
      h('div', { class: 'shelf__row' }, items.map(({ p, d }) => photoCard(p, d))))
  }

  function photoCard(p, d) {
    const s = t()
    const st = state.dog ? dogStatus(ruleFor(p)) : null
    return h('a', {
      class: 'pcard' + (state.sel === p.id ? ' is-selected' : ''), href: placeHref(p), 'data-id': p.id,
      onclick: (e) => {
        // With the map on screen, the first tap shows the place on the map; the second opens it.
        if (mapShown() && state.sel !== p.id) { e.preventDefault(); select(p.id, 'card') }
      },
    },
    placeImg(p, 168, 112, 'pcard__img'),
    h('span', { class: 'pcard__name' }, p.name),
    h('span', { class: 'pcard__meta' }, `${s.km(d)} · ${t().kinds[p.kind] || t().settings[p.setting]}`),
    st && !st.allowed ? h('span', { class: 'tag tag--warn pcard__tag' }, s.noDogsToday) : null)
  }

  function selectedCard(p, d) {
    const s = t()
    return h('div', { class: 'selcard' },
      h('a', { class: 'selcard__main', href: placeHref(p) },
        placeImg(p, 64, 64, 'selcard__img'),
        h('span', { class: 'selcard__body' },
          h('span', { class: 'card__kind' }, kicker(p)),
          h('span', { class: 'card__name' }, p.name),
          h('span', { class: 'card__dist' }, s.km(d))),
        h('span', { class: 'selcard__open' }, s.openPlace, svg(ICON.next, 16))),
      h('button', { class: 'selcard__close', type: 'button', 'aria-label': s.clearSelection, onclick: () => select(null) }, svg(ICON.close, 16)))
  }

  function select(id, origin) {
    state.sel = id
    renderHome()
    const p = id && state.data.places.find((x) => x.id === id)
    if (p && map && origin === 'card') {
      const b = map.getBounds()
      if (!b.contains([p.lon, p.lat]) || map.getZoom() < 13) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14), padding: { bottom: panelCover() } })
    }
    if (p) requestAnimationFrame(() => $(`.pcard[data-id="${CSS.escape(p.id)}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }))
  }

  // With "Bringing a dog?" on: one line in the always-visible part of the panel that says what
  // changed, and leads to today's dog rules.
  function dogStrip() {
    const s = t()
    const r = state.data.dogRules.national
    const on = inRange(r.from, r.to)
    return h('a', { class: 'dogstrip', href: '#/dog' },
      h('span', { class: 'dogstrip__text' },
        h('span', { class: 'dogstrip__title' }, s.dogStripTitle),
        h('span', { class: 'dogstrip__line' }, on ? s.dogStripOn(fmtDay(r.to)) : s.dogStripOff(fmtDay(r.from)))),
      svg(ICON.next, 18))
  }

  // ---------- search (decided 5 Nov 2026: option A, a field always on screen) ----------
  // Searches a small name list (/data/sweden/search.json, built weekly) on the phone itself:
  // our places by name, and Swedish towns and city areas. Nothing typed is ever sent anywhere.
  const search = { open: false, q: '' }
  const fold = (x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const TOWN_ORDER = { city: 0, town: 1, suburb: 2, quarter: 3, village: 4 }
  const MAX_RESULTS = 5
  const AREA_M = 5000 // "places near Kungsbacka" counts places within this of the town centre

  const searchInput = h('input', {
    type: 'search', class: 'search__input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search',
    onfocus: () => openSearch(),
    oninput: (e) => { search.q = e.target.value; renderResults() },
    // Enter / the keyboard's search key closes the keyboard so the results are in view.
    onkeydown: (e) => { if (e.key === 'Escape') closeSearch(); else if (e.key === 'Enter') { e.preventDefault(); searchInput.blur() } },
  })

  function searchRow() {
    const s = t()
    searchInput.placeholder = s.searchPlaceholder
    searchInput.setAttribute('aria-label', s.searchLabel)
    if (state.area && !search.open) {
      // A picked town: shown in the field's place, with a way back to "near you".
      return h('div', { class: 'search search--area' },
        settingIcon('town', 18),
        h('button', { type: 'button', class: 'search__area', onclick: () => { searchInput.value = ''; search.q = ''; requestAnimationFrame(() => searchInput.focus()); openSearch() } }, state.area.name),
        h('button', { type: 'button', class: 'search__clear', 'aria-label': s.searchBackToNear, onclick: clearArea }, svg(ICON.close, 14)))
    }
    return h('label', { class: 'search' }, settingIcon('search', 18), searchInput,
      search.q ? h('button', { type: 'button', class: 'search__clear', 'aria-label': s.searchClear, onclick: () => { searchInput.value = ''; search.q = ''; searchInput.focus(); renderResults() } }, svg(ICON.close, 14)) : null)
  }

  // The name list is split by the first two letters of every word (search/<ab>.json, a few KB
  // each), so the first results show almost at once. Parts already fetched are kept for the visit.
  const shardKey = (q) => q.slice(0, 2).replace(/[^a-z0-9]/g, '_')
  const shards = new Map() // key -> { places, towns } | 'loading' | 'failed'
  function loadShard(key) {
    if (shards.has(key)) return
    // index.json lists which parts exist; a part that doesn't exist simply has no matches.
    if (Array.isArray(state.idx.search) && !state.idx.search.includes(key)) { shards.set(key, { places: [], towns: [] }); return }
    shards.set(key, 'loading')
    fetch(`/data/sweden/search/${key}.json`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json() })
      .then((d) => shards.set(key, {
        places: d.places.map(([name, id, lat, lon, kind, setting]) => ({ name, f: fold(name), id, lat, lon, kind, setting })),
        towns: (d.towns || []).map(([name, type, lat, lon, near]) => ({ name, f: fold(name), type, lat, lon, near })),
      }))
      .catch(() => shards.set(key, 'failed'))
      .finally(() => renderResults())
  }

  function openSearch() {
    if (search.open) return
    search.open = true
    $('#home').classList.add('home--searching')
    const s = t()
    // Cancel takes the dog switch's place while searching.
    $('#home-top .brandbar').replaceChildren(h('p', { class: 'brand' }, s.title), h('button', { type: 'button', class: 'search__cancel', onclick: closeSearch }, s.cancel))
    const row = $('#home-top .search')
    if (row && !row.contains(searchInput)) row.replaceWith(searchRow())
    renderResults()
  }

  function closeSearch() {
    search.open = false
    search.q = ''
    searchInput.value = ''
    searchInput.blur()
    $('#home').classList.remove('home--searching')
    fill($('#search-results'))
    renderHome()
  }

  // Where a typed word starts in a name: 0 = the name starts with it, 1 = a later word does.
  function matchAt(f, q) {
    if (f.startsWith(q)) return { score: 0, at: 0 }
    const m = f.match(new RegExp('[\\s\\-–/(]' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return m ? { score: 1, at: m.index + 1 } : null
  }

  // The name with the typed part in bold. fold() keeps the length of Swedish names, so positions match.
  function marked(name, at, len) {
    return [name.slice(0, at), h('b', null, name.slice(at, at + len)), name.slice(at + len)]
  }

  function renderResults() {
    const box = $('#search-results')
    if (!search.open) return
    const s = t()
    const q = fold(search.q.trim())
    // No explanation text (Ellen, 5 Nov): an empty field shows nothing until two letters are typed.
    if (q.length < 2) return fill(box)
    const key = shardKey(q)
    loadShard(key)
    const part = shards.get(key)
    if (part === 'failed') { shards.delete(key); return fill(box, h('p', { class: 'search-hint' }, s.searchUnavailable)) }
    if (part === 'loading') return fill(box, h('p', { class: 'search-hint' }, s.loading))
    const o = from()
    const places = []
    for (const p of part.places) { const m = matchAt(p.f, q); if (m) places.push({ p, m, d: metres(o, p) }) }
    places.sort((a, b) => a.m.score - b.m.score || a.d - b.d)
    const towns = []
    for (const x of part.towns) { const m = matchAt(x.f, q); if (m) towns.push({ x, m, d: metres(o, x) }) }
    towns.sort((a, b) => a.m.score - b.m.score || TOWN_ORDER[a.x.type] - TOWN_ORDER[b.x.type] || a.d - b.d)
    if (!places.length && !towns.length) {
      return fill(box, h('div', { class: 'search-empty' },
        settingIcon('nature', 40),
        h('h2', { class: 'search-empty__title' }, s.searchNothingTitle(search.q.trim())),
        h('p', null, s.searchNothingText),
        h('p', null, s.searchNothingTry),
        h('div', { class: 'search-empty__actions' },
          h('a', { class: 'pill-btn pill-btn--wide', href: '#/filters', onclick: () => closeSearch() }, s.searchBrowseFilters),
          h('a', { class: 'pill-btn pill-btn--wide pill-btn--outline', href: 'https://lunch.ellenial.app/', rel: 'noopener' }, s.searchLunch))))
    }
    const len = q.length
    fill(box,
      places.length ? [h('p', { class: 'search-label' }, s.searchPlaces), places.slice(0, MAX_RESULTS).map(({ p, m, d }) =>
        h('button', { type: 'button', class: 'sresult', onclick: () => pickPlace(p) },
          h('span', { class: `sresult__icon sresult__icon--${p.setting}` }, settingIcon(p.setting, 20)),
          h('span', { class: 'sresult__text' },
            h('span', { class: 'sresult__name' }, marked(p.name, m.at, len)),
            h('span', { class: 'sresult__meta' }, `${s.kindShort[p.kind] || s.settings[p.setting]} · ${s.km(d)}`))))] : null,
      towns.length ? [h('p', { class: 'search-label' }, s.searchTowns), towns.slice(0, MAX_RESULTS).map(({ x, m }) =>
        h('button', { type: 'button', class: 'sresult', onclick: () => pickTown(x) },
          h('span', { class: 'sresult__icon sresult__icon--town' }, settingIcon('town', 20)),
          h('span', { class: 'sresult__text' },
            h('span', { class: 'sresult__name' }, marked(x.name, m.at, len)),
            h('span', { class: 'sresult__meta' }, s.townKind(x.type, x.near)))))] : null)
  }

  async function pickPlace(p) {
    closeSearch()
    await loadCells([cellOf(p.lat, p.lon)])
    select(p.id)
    if (map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 15), padding: { bottom: panelCover() } })
  }

  async function pickTown(x) {
    state.area = { name: x.name, lat: x.lat, lon: x.lon }
    state.follow = null
    state.sel = null
    closeSearch()
    await loadCells(around(state.area))
    $('#panel-body').scrollTop = 0
    renderHome()
    if (map) map.flyTo({ center: [x.lon, x.lat], zoom: x.type === 'city' ? 11.5 : 13, padding: { bottom: panelCover() } })
  }

  function clearArea() {
    state.area = null
    renderHome()
    const o = from()
    if (map) map.flyTo({ center: [o.lon, o.lat], zoom: state.me ? 13 : 11, padding: { bottom: panelCover() } })
  }

  function nearMe(e) {
    const s = t()
    const btn = e.currentTarget
    if (!('geolocation' in navigator)) return note(s.nearMeFailed)
    btn.disabled = true
    btn.lastChild.textContent = s.nearMeBusy
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        state.me = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        state.area = null
        state.follow = null
        btn.lastChild.textContent = s.nearMeBusy
        await loadCells(around(state.me))
        renderHome()
        if (map && mapShown()) map.flyTo({ center: [state.me.lon, state.me.lat], zoom: 13, padding: { bottom: panelCover() } })
      },
      () => { btn.disabled = false; btn.lastChild.textContent = s.nearMe; note(s.nearMeFailed) },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 })
  }

  function note(text) {
    const n = $('#note')
    n.textContent = text
    n.hidden = false
    clearTimeout(note.timer)
    note.timer = setTimeout(() => { n.hidden = true }, 6000)
  }

  // On computers (900 px and wider, like ellenial weather) the list sits beside the map instead of over it.
  const wide = window.matchMedia('(min-width: 900px)')
  wide.addEventListener?.('change', () => { if (map) requestAnimationFrame(() => map.resize()) })
  const panelCover = () => (state.view === 'map' && !wide.matches ? $('#panel-head').offsetHeight : 0)


  // ---------- the map ----------
  const isDark = () => window.EllenialTheme ? window.EllenialTheme.resolved() === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches

  // Pins: a coloured disc with an icon, drawn once per theme from icons.js. Places get the setting's
  // icon; toilets, water taps and dog runs get their own smaller pins, so no kind of pin is told
  // apart by colour alone (Ellenial accessibility rule).
  const FACILITY_PINS = (dark) => [
    ['fac-toilet', 'toilet', '#4F6676', '#FFFFFF', 40],
    ['fac-tap', 'tap', '#2F82B0', '#FFFFFF', 40],
    ['fac-dogrun', 'dogrun', dark ? '#C7B4F0' : '#8E63B3', dark ? '#1A1430' : '#FFFFFF', 48],
  ]
  const pinCache = {}
  function pinImages(dark) {
    if (pinCache[dark]) return pinCache[dark]
    const fillC = dark ? '#B39AE8' : '#342E86', ring = dark ? '#17141F' : '#FFFFFF', ink = dark ? '#1A1430' : '#FFFFFF'
    const jobs = SETTINGS.map((key) => ['pin-' + key, key, fillC, ink, 56]).concat(FACILITY_PINS(dark)) // sizes are 2x css px
    pinCache[dark] = Promise.all(jobs.map(([id, key, fill, iconInk, S]) => new Promise((resolve) => {
      const c = document.createElement('canvas'); c.width = S; c.height = S
      const g = c.getContext('2d')
      const drawn = ART.has(key)
      // Ellen's drawings carry their own colours, so they sit on a calm paper disc (dark: a dark
      // disc) with a brand ring; the Lucide ones keep the coloured disc with a white line icon.
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2)
      g.fillStyle = drawn ? (dark ? '#221E2C' : '#FFFBF5') : fill; g.fill()
      g.lineWidth = drawn ? 3 : 4; g.strokeStyle = drawn ? (dark ? '#B39AE8' : '#342E86') : ring; g.stroke()
      const img = new Image()
      const d = Math.round(S * (drawn ? 0.68 : 0.54))
      img.onload = () => { g.drawImage(img, (S - d) / 2, (S - d) / 2, d, d); resolve([id, g.getImageData(0, 0, S, S)]) }
      img.onerror = () => resolve([id, g.getImageData(0, 0, S, S)])
      if (drawn) { img.src = `/art/${key}-light.png`; return }
      const inner = (window.EM_ICONS || {})[key]
      if (!inner) return resolve([id, g.getImageData(0, 0, S, S)])
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${iconInk}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText)
    })))
    return pinCache[dark]
  }

  function initMap() {
    if (map || !window.maplibregl) return
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')
      if (!gl) throw new Error('no webgl')
      window.maplibregl.setWorkerUrl('/vendor/maplibre-gl-csp-worker.js')
      let dark = isDark()
      map = new window.maplibregl.Map({
        container: 'map',
        style: window.mapStyle(location.origin, dark),
        center: AT ? [AT.lon, AT.lat] : [CENTRE.lon, CENTRE.lat],
        zoom: AT ? AT.z : 11,
        minZoom: 5,
        maxZoom: 18,
        attributionControl: false,
        cooperativeGestures: false,
        // Tiles and fonts listed by OpenFreeMap point at its own address; send them through ours.
        transformRequest: (url) => ({ url: url.replace('https://tiles.openfreemap.org/', location.origin + '/ofm/') }),
      })
      map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      // A small credit line that is always visible, instead of MapLibre's "i" box. That box opens
      // by itself on load and after a theme change (so credits are seen once), which felt like it
      // opened unasked. A line that never hides meets OpenStreetMap's attribution rules without it.
      const credit = h('div', { class: 'map-credit' },
        h('a', { href: 'https://www.openstreetmap.org/copyright', rel: 'noopener noreferrer', target: '_blank' }, '© OpenStreetMap'), ' · ',
        h('a', { href: 'https://openmaptiles.org/', rel: 'noopener noreferrer', target: '_blank' }, 'OpenMapTiles'), ' · ',
        h('a', { href: 'https://openfreemap.org/', rel: 'noopener noreferrer', target: '_blank' }, 'OpenFreeMap'))
      map.getContainer().append(credit)
      // Our own pins sit on top of the base map. A new theme means a new base style, which drops
      // them, so they are added again every time a style finishes loading.
      const addOwnLayers = async () => {
        const forDark = dark
        const pins = await pinImages(forDark)
        if (forDark !== dark || map.getLayer('em-places')) return
        for (const [id, data] of pins) if (!map.hasImage(id)) map.addImage(id, data, { pixelRatio: 2 })
        const empty = { type: 'FeatureCollection', features: [] }
        for (const id of ['places', 'toilets', 'water', 'dogparks', 'me']) if (!map.getSource('em-' + id)) map.addSource('em-' + id, { type: 'geojson', data: empty })
        const ink = dark ? '#17141F' : '#FFFFFF'
        const brand = dark ? '#B39AE8' : '#342E86'
        const facility = (id, src, image, minzoom) => map.addLayer({ id, type: 'symbol', source: src, minzoom,
          layout: { 'icon-image': image, 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 15, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
        facility('em-toilets', 'em-toilets', 'fac-toilet', 12)
        facility('em-water', 'em-water', 'fac-tap', 12)
        facility('em-dogparks', 'em-dogparks', 'fac-dogrun', 0)
        map.addLayer({ id: 'em-sel', type: 'circle', source: 'em-places', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 24, 'circle-color': brand, 'circle-opacity': 0.22, 'circle-stroke-color': brand, 'circle-stroke-width': 2.5 } })
        map.addLayer({
          id: 'em-places', type: 'symbol', source: 'em-places',
          layout: {
            'icon-image': ['concat', 'pin-', ['get', 'setting']],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 12, 0.8, 15, 1],
            'icon-allow-overlap': true, 'icon-ignore-placement': true,
            'symbol-sort-key': ['get', 'rank'],
          },
        })
        // The selected place's name beside its pin, so it's clear what was tapped (Ellen, 5 Nov).
        map.addLayer({
          id: 'em-sel-label', type: 'symbol', source: 'em-places', filter: ['==', ['get', 'id'], ''],
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 15, 'text-anchor': 'left', 'text-offset': [1.9, 0], 'text-max-width': 14, 'text-allow-overlap': true, 'text-ignore-placement': true },
          paint: { 'text-color': dark ? '#F3EEF8' : '#1F1A2E', 'text-halo-color': dark ? '#17141F' : '#FEF2E2', 'text-halo-width': 2.5 },
        })
        map.addLayer({ id: 'em-me', type: 'circle', source: 'em-me', paint: { 'circle-radius': 7, 'circle-color': dark ? '#F3EEF8' : '#1F1A2E', 'circle-stroke-color': dark ? '#17141F' : '#FEF2E2', 'circle-stroke-width': 3 } })
        mapReady = true
        updateMap(visible())
      }
      // Squares for what the map shows, once zoomed in enough to see places.
      const zoomHint = h('div', { class: 'map-hint', hidden: true }, t().zoomIn)
      map.getContainer().append(zoomHint)
      const loadView = async () => {
        const zoomedIn = map.getZoom() >= 8
        zoomHint.hidden = zoomedIn
        if (!zoomedIn) return
        const b = map.getBounds()
        const keys = cellsIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast())
        if (keys.length <= 60 && await loadCells(keys)) updateMap(visible())
      }
      map.on('moveend', loadView)
      // The list follows the map: a move or zoom by the person (not one the app made) sets the
      // area the list shows. A tiny nudge doesn't count.
      let moveStart = null
      map.on('movestart', (e) => { moveStart = e.originalEvent ? { c: map.getCenter(), z: map.getZoom() } : null })
      map.on('moveend', (e) => {
        if (!moveStart && !e.originalEvent) return
        const c = map.getCenter(), z = map.getZoom()
        if (moveStart && Math.abs(z - moveStart.z) < 0.05 && metres({ lat: c.lat, lon: c.lng }, { lat: moveStart.c.lat, lon: moveStart.c.lng }) < 40) return
        moveStart = null
        if (z < 10) return // zoomed out to a whole region: too many to list, keep the previous area
        const b = map.getBounds()
        state.follow = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast(), lat: c.lat, lon: c.lng }
        renderHome()
      })
      map.on('load', () => {
        addOwnLayers()
        loadView()
        // First tap on a pin selects it (and its card); a second tap on the same pin opens it.
        map.on('click', (e) => {
          if (!map.getLayer('em-places')) return
          const f = map.queryRenderedFeatures(e.point, { layers: ['em-places'] })[0]
          const id = f?.properties?.id
          if (!id) { if (state.sel) select(null); return }
          if (state.sel === id) { const p = state.data.places.find((x) => x.id === id); internalNav = true; location.hash = p ? placeHref(p) : '#/' } else select(id, 'pin')
        })
        map.on('mouseenter', 'em-places', () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', 'em-places', () => { map.getCanvas().style.cursor = '' })
        window.EllenialTheme?.onChange(({ resolved }) => {
          if ((resolved === 'dark') === dark) return
          dark = resolved === 'dark'
          mapReady = false
          map.once('style.load', addOwnLayers)
          map.setStyle(window.mapStyle(location.origin, dark), { diff: false })
        })
      })
      // A linked spot with no matching place: a plain labelled pin. A DOM marker, so it survives
      // theme changes without being added again. The label is set as text, never as HTML.
      if (AT && !AT.match) {
        const el = h('div', { class: 'at-pin', role: 'img', 'aria-label': AT.name || t().linkedSpot },
          h('span', { class: 'at-pin__dot' }), h('span', { class: 'at-pin__label' }, AT.name || t().linkedSpot))
        new window.maplibregl.Marker({ element: el, anchor: 'left', offset: [-9, 0] }).setLngLat([AT.lon, AT.lat]).addTo(map)
      }
      map.on('error', (e) => console.warn('map:', e.error?.message || e))
    } catch (err) {
      console.warn('Map unavailable:', err.message)
      $('#map').classList.add('map--off')
      map = null
    }
  }

  const fc = (points, props) => ({ type: 'FeatureCollection', features: points.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon ?? p[1], p.lat ?? p[0]] }, properties: props ? props(p, i) : {} })) })

  function updateMap(list) {
    if (!map || !mapReady) return
    const d = state.data
    // The selected pin is drawn last so it sits on top.
    map.getSource('em-places').setData(fc(list.map((x) => x.p), (p) => ({ id: p.id, setting: p.setting, name: p.name, rank: p.id === state.sel ? 1 : 0 })))
    map.setFilter('em-sel', ['==', ['get', 'id'], state.sel || ''])
    map.setFilter('em-sel-label', ['==', ['get', 'id'], state.sel || ''])
    map.getSource('em-toilets').setData(fc(d.toilets))
    map.getSource('em-water').setData(fc(d.water))
    map.getSource('em-dogparks').setData(fc(state.dog ? d.dogParks : []))
    map.getSource('em-me').setData(fc(state.me ? [state.me] : []))
  }

  // ---------- filters (a sheet over the home screen) ----------
  function renderFiltersSheet() {
    const s = t()
    const f = state.filters
    const seg = (val, label) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(f.size === val), onclick: () => { f.size = val; saveFilters(); render() } }, label)
    const nearChip = (key, label) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.nearby.includes(key)), onclick: () => { toggle(f.nearby, key); saveFilters(); render() } }, label)
    const n = state.data.places.filter(matches).length
    const close = (e) => { if (internalNav && history.length > 1) { e?.preventDefault(); history.back() } else location.hash = '#/' }
    return h('div', { class: 'modal', onkeydown: (e) => { if (e.key === 'Escape') close() } },
      h('div', { class: 'modal__backdrop', onclick: close }),
      h('div', { class: 'modal__sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'filters-title' },
        h('div', { class: 'modal__head' },
          h('h2', { id: 'filters-title', class: 'topbar__title' }, s.filtersHeading),
          h('button', { class: 'round-btn', type: 'button', 'aria-label': s.close, onclick: close }, svg(ICON.close))),
        h('div', { class: 'modal__body' },
          h('section', { class: 'group' }, h('h3', { class: 'label' }, s.setting),
            h('div', { class: 'chips' }, SETTINGS.map((key) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.settings.includes(key)), onclick: () => { toggle(f.settings, key); saveFilters(); render() } }, s.settings[key])))),
          h('section', { class: 'group' }, h('h3', { class: 'label' }, s.size),
            h('div', { class: 'seg', role: 'group', 'aria-label': s.size }, seg('any', s.sizeAny), seg('small', s.sizeSmall), seg('big', s.sizeBig))),
          h('section', { class: 'group' }, h('h3', { class: 'label' }, s.nearbyHeading),
            h('div', { class: 'chips' }, nearChip('toilet', s.toilet), nearChip('water', s.waterTap), nearChip('benches', s.benches), nearChip('shelter', s.shelter))),
          dogSwitch(true)),
        h('div', { class: 'modal__foot' }, h('button', { class: 'pill-btn pill-btn--wide', type: 'button', onclick: close }, s.showPlaces(n)))))
  }

  // ---------- a place ----------
  // ---------- a small gallery (Ellen, 5 Nov): up to 5 more photos from the place's Commons
  // category, fetched weekly with their credits (gallery/<id>.json). Tapping one shows it big with
  // its own credit; the arrows step through them; the last tile leads to all photos on Commons.
  const galleries = new Map()
  function gallery(p, hero) {
    const s = t()
    const strip = h('div', { class: 'gallery', role: 'group', 'aria-label': s.galleryLabel })
    const show = (photos, i) => {
      const ph = photos[i]
      hero.querySelector('.hero__img')?.replaceWith(photoOr(h('img', { class: 'hero__img', src: ph.src, alt: '', width: ph.w, height: ph.h }), p.setting, 'hero__img', p))
      hero.querySelector('.hero__credit')?.remove()
      hero.append(h('a', { class: 'hero__credit', href: ph.page, rel: 'noopener noreferrer', target: '_blank' }, s.photoBy(ph.by, ph.licence)))
      strip.querySelectorAll('.gallery__thumb').forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)))
      strip.querySelectorAll('.gallery__thumb')[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
      const count = hero.querySelector('.hero__count')
      if (count) count.textContent = `${i + 1} / ${photos.length}`
      strip.dataset.at = i
    }
    const build = (extra) => {
      const photos = [p.photo, ...extra].filter(Boolean)
      if (photos.length < 2) return
      fill(strip,
        photos.map((ph, i) => h('button', { type: 'button', class: 'gallery__thumb', 'aria-pressed': String(i === 0), 'aria-label': s.galleryShow(i + 1, photos.length), onclick: () => show(photos, i) },
          h('img', { src: ph.src, alt: '', loading: 'lazy', width: 96, height: 72 }))),
        p.morePhotos ? h('a', { class: 'gallery__more', href: p.morePhotos, rel: 'noopener noreferrer', target: '_blank' }, s.galleryAll, svg(ICON.out, 14)) : null)
      strip.dataset.at = 0
      const step = (d) => show(photos, (Number(strip.dataset.at) + d + photos.length) % photos.length)
      hero.append(h('div', { class: 'hero__steps' },
        h('button', { type: 'button', class: 'hero__step', 'aria-label': s.galleryPrev, onclick: () => step(-1) }, svg(ICON.back, 18)),
        h('span', { class: 'hero__count', 'aria-live': 'polite' }, `1 / ${photos.length}`),
        h('button', { type: 'button', class: 'hero__step', 'aria-label': s.galleryNext, onclick: () => step(1) }, svg(ICON.next, 18))))
    }
    if (galleries.has(p.id)) build(galleries.get(p.id))
    else fetch(`/data/sweden/gallery/${encodeURIComponent(p.id)}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { list.forEach((ph) => { ph.src = ownPhoto(ph.src) }); galleries.set(p.id, list); build(list) })
      .catch(() => {})
    return strip
  }

  // ---------- "Where it is": a small real map on the place page with the place's own shape
  // (Ellen, 5 Nov: cheap context for the outline cards). The outline is stored scaled to its own
  // corners (obox), so it can be put back on the map. One small map, removed when the page closes.
  let placeMap = null
  function dropPlaceMap() { if (placeMap) { placeMap.remove(); placeMap = null } }
  function outlineGeo(p) {
    const [w, hh, ...xy] = p.outline
    const [south, west, north, east] = p.obox
    const lat0 = (south + north) / 2
    const kLat = 111320, kLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
    const span = Math.max((east - west) * kLon, (north - south) * kLat)
    const ring = []
    for (let i = 0; i + 1 < xy.length; i += 2) ring.push([west + (xy[i] / 100) * span / kLon, north - (xy[i + 1] / 100) * span / kLat])
    ring.push(ring[0])
    return ring
  }
  function whereItIs(p) {
    const s = t()
    if (!window.maplibregl) return null
    const box = h('div', { class: 'where__map', role: 'img', 'aria-label': s.whereLabel(p.name) })
    requestAnimationFrame(() => {
      if (!box.isConnected) return
      dropPlaceMap()
      try {
        const dark = isDark()
        const hasShape = Array.isArray(p.outline) && Array.isArray(p.obox)
        placeMap = new window.maplibregl.Map({
          container: box, style: window.mapStyle(location.origin, dark), interactive: false, attributionControl: false,
          center: [p.lon, p.lat], zoom: 15,
          transformRequest: (url) => ({ url: url.replace('https://tiles.openfreemap.org/', location.origin + '/ofm/') }),
        })
        if (hasShape) placeMap.fitBounds([[p.obox[1], p.obox[0]], [p.obox[3], p.obox[2]]], { padding: 28, maxZoom: 16, duration: 0 })
        placeMap.on('load', () => {
          const ink = { nature: '#4F8A5B', urban: '#4F8A5B', gardens: '#4F8A5B', water: '#3D6F8A' }[p.setting] || (dark ? '#B39AE8' : '#342E86')
          const line = dark ? { nature: '#BFD8C2', urban: '#BFD8C2', gardens: '#BFD8C2', water: '#C9D4E0' }[p.setting] || '#B39AE8' : ink
          if (hasShape) {
            placeMap.addSource('shape', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [outlineGeo(p)] }, properties: {} } })
            placeMap.addLayer({ id: 'shape-fill', type: 'fill', source: 'shape', paint: { 'fill-color': line, 'fill-opacity': 0.25 } })
            placeMap.addLayer({ id: 'shape-line', type: 'line', source: 'shape', paint: { 'line-color': line, 'line-width': 2.5 } })
          } else {
            placeMap.addSource('pt', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: {} } })
            placeMap.addLayer({ id: 'pt', type: 'circle', source: 'pt', paint: { 'circle-radius': 9, 'circle-color': dark ? '#B39AE8' : '#342E86', 'circle-stroke-color': dark ? '#17141F' : '#FEF2E2', 'circle-stroke-width': 3 } })
          }
        })
      } catch { box.classList.add('where__map--off') }
    })
    return h('section', { class: 'where' },
      h('h2', { class: 'label' }, s.whereTitle),
      box,
      h('p', { class: 'where__credit' }, '© OpenStreetMap · OpenFreeMap'))
  }

  function renderPlace(id, cell) {
    const s = t()
    const p = state.data.places.find((x) => x.id === id)
    if (!p) {
      // Not loaded yet: fetch its square, then show it. Unknown place: go home.
      if (cell && state.idx.cells[cell] != null && !loadedCells.has(cell)) {
        loadCells([cell]).then(render)
        return h('div', { class: 'status' }, h('p', null, s.loading))
      }
      location.replace('#/'); return null
    }
    document.title = `${p.name} · ${s.title}`
    const ph = p.photo
    const links = [
      p.website ? h('a', { class: 'pill-btn', href: p.website, rel: 'noopener noreferrer', target: '_blank' }, s.theirWebsite, svg(ICON.out, 14)) : null,
      h('a', { class: 'pill-btn pill-btn--soft', href: `https://www.openstreetmap.org/directions?to=${p.lat}%2C${p.lon}#map=15/${p.lat}/${p.lon}`, rel: 'noopener noreferrer', target: '_blank' }, s.directions, svg(ICON.out, 14)),
      p.morePhotos && !p.gallery ? h('a', { class: 'pill-btn pill-btn--soft', href: p.morePhotos, rel: 'noopener noreferrer', target: '_blank' }, s.morePhotos, svg(ICON.out, 14)) : null,
    ]
    const fac = [
      p.nearby.toilet ? h('span', { class: 'tag tag--facility tag--lg' }, art('toilet', 18), s.toilet) : null,
      p.nearby.water ? h('span', { class: 'tag tag--facility tag--lg' }, art('tap', 18), s.waterTap) : null,
      p.nearby.benches ? h('span', { class: 'tag tag--lg' }, s.benches) : null,
      p.nearby.shelter ? h('span', { class: 'tag tag--lg' }, art('shelter', 18), s.shelter) : null,
    ].filter(Boolean)

    const hero = h('div', { class: 'hero' },
      ph ? photoOr(h('img', { class: 'hero__img', src: ph.src, alt: '', width: ph.w, height: ph.h }), p.setting, 'hero__img', p) : placeholder(p.setting, 'hero__img', p),
      h('a', { class: 'round-btn hero__back', href: '#/', 'aria-label': s.back, onclick: goBack }, svg(ICON.back)),
      ph ? h('a', { class: 'hero__credit', href: ph.page, rel: 'noopener noreferrer', target: '_blank' }, s.photoBy(ph.by, ph.licence)) : null)
    return h('div', { class: 'page page--place' },
      h('div', { class: 'place-media' }, hero, p.gallery ? gallery(p, hero) : null),
      h('div', { class: 'place' },
        h('p', { class: 'kicker' }, [kicker(p), p.fee ? s.fee : s.free].join(' · ')),
        h('h1', { class: 'place__name' }, p.name),
        p.ha ? h('p', { class: 'muted' }, s.sizeHa(p.ha)) : null,
        h('div', { class: 'links' }, links),
        fac.length ? h('div', { class: 'tags' }, fac) : null,
        whereItIs(p),
        !ph ? h('p', { class: 'muted small' }, s.noPhoto, ' ', h('a', { href: 'https://commons.wikimedia.org/wiki/Special:UploadWizard', rel: 'noopener noreferrer', target: '_blank' }, s.addPhoto)) : null,
        state.dog ? placeDogCard(p) : null,
        h('div', { class: 'place__foot' },
          h('p', { class: 'muted small' }, s.dataNote),
          h('a', { class: 'fix', href: `https://www.openstreetmap.org/${p.osm}`, rel: 'noopener noreferrer', target: '_blank' }, s.fixIt))),
      footer())
  }

  function placeDogCard(p) {
    const s = t()
    const rule = ruleFor(p)
    const st = dogStatus(rule)
    const nat = state.data.dogRules.national
    const run = nearestDogRun(p, 1500)
    if (!st && p.setting !== 'nature' && !run && inArea(p, state.idx.localDogArea)) return null
    const monthLetters = t().months.map((m) => m[0].toUpperCase())
    const nowMonth = new Date().getMonth()
    return h('section', { class: 'panel' },
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, s.dogs),
        st ? h('span', { class: 'tag ' + (st.allowed ? 'tag--free' : 'tag--warn') }, st.allowed ? s.dogsAllowedNow : s.dogsNotNow) : null),
      st ? h('div', { class: 'months', role: 'img', 'aria-label': st.text },
        st.months.map((ok, i) => h('div', { class: 'months__m' + (i === nowMonth ? ' months__m--now' : '') }, h('span', { class: 'months__bar' + (ok ? ' months__bar--ok' : '') }), h('span', { class: 'months__l' }, monthLetters[i])))) : null,
      st ? h('p', { class: 'small' }, st.text) : null,
      !st && p.setting === 'nature' ? h('p', { class: 'small' }, s.natureSeasonText(fmtDay(nat.from), fmtDay(nat.to))) : null,
      run ? h('p', { class: 'small' }, s.dogRunNearby(`${run.p.name || s.unnamedDogRun} (${s.km(run.d)})`)) : null,
      !st && !inArea(p, state.idx.localDogArea) ? h('p', { class: 'muted small' }, s.dogsCheckLocal) : null,
      st ? h('p', { class: 'muted small' }, `${s.source}: `, h('a', { href: rule.sourceUrl, rel: 'noopener noreferrer', target: '_blank' }, rule.source)) : null)
  }

  function nearestDogRun(o, max) {
    let best = null
    for (const p of state.data.dogParks) { const d = metres(o, p); if (d <= max && (!best || d < best.d)) best = { p, d } }
    return best
  }

  // ---------- dog page ----------
  function renderDog() {
    const s = t()
    const nat = state.data.dogRules.national
    const on = inRange(nat.from, nat.to)
    const o = from()
    const runs = state.data.dogParks.map((p) => ({ p, d: metres(o, p) })).sort((a, b) => a.d - b.d).slice(0, 5)
    // Gothenburg's own rules only make sense when you're in Gothenburg.
    const local = inArea(o, state.idx.localDogArea)
    const beachRule = local ? state.data.dogRules.local.find((r) => r.id === 'beach-summer-ban') : null
    const beachesClosed = beachRule && inRange(beachRule.from, beachRule.to)
    // Position of today on a Jan–Dec bar.
    const d = new Date()
    const dayOfYear = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 864e5
    const pos = (md) => { const [m, dd] = md.split('-').map(Number); return ((Date.UTC(2001, m - 1, dd) - Date.UTC(2001, 0, 1)) / 864e5 / 365) * 100 }
    document.title = `${s.withYourDog} · ${s.title}`
    return h('div', { class: 'page page--dog' },
      topBar(null),
      h('p', { class: 'kicker' }, s.withYourDog),
      h('h1', { class: 'heading' }, s.dogHeading),
      h('section', { class: 'panel' },
        h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, s.natureSeason), h('span', { class: 'tag ' + (on ? 'tag--warn' : 'tag--free') }, on ? s.natureSeasonOn : s.natureSeasonOff)),
        h('div', { class: 'season', role: 'img', 'aria-label': `${fmtDay(nat.from)} – ${fmtDay(nat.to)}` },
          h('span', { class: 'season__band', style: `left:${pos(nat.from)}%;width:${pos(nat.to) - pos(nat.from)}%` }),
          h('span', { class: 'season__today', style: `left:${(dayOfYear / 365) * 100}%` })),
        h('div', { class: 'season__axis' }, h('span', null, t().months[0].slice(0, 3)), h('span', null, `${fmtDay(nat.from)} – ${fmtDay(nat.to)}`), h('span', null, t().months[11].slice(0, 3))),
        h('p', { class: 'small' }, on ? s.natureSeasonText(fmtDay(nat.from), fmtDay(nat.to)) : s.natureSeasonBack(fmtDay(nat.from))),
        h('p', { class: 'muted small' }, `${s.source}: `, h('a', { href: nat.sourceUrl, rel: 'noopener noreferrer', target: '_blank' }, nat.source))),
      runs.length ? h('section', { class: 'panel' },
        h('h2', { class: 'panel__title' }, state.me ? s.dogRunsHeading : s.dogRunsHeadingCentre),
        h('ul', { class: 'rows' }, runs.map(({ p, d }) => h('li', { class: 'row' },
          h('span', null, h('span', { class: 'row__name' }, p.name || s.unnamedDogRun), p.fenced ? h('span', { class: 'muted small' }, ` · ${s.fenced}`) : null),
          h('span', { class: 'muted small' }, s.km(d)))))) : null,
      beachRule ? h('section', { class: 'panel' },
        h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, s.beachesHeading), h('span', { class: 'tag ' + (beachesClosed ? 'tag--warn' : 'tag--free') }, beachesClosed ? s.dogsNotNow : s.dogsAllowedNow)),
        h('p', { class: 'small' }, beachRule.match.join(', ') + '. ' + s.dogsBannedBetween(fmtDay(beachRule.from), fmtDay(beachRule.to))),
        h('p', { class: 'small' }, beachesClosed ? s.beachesClosed : s.beachesOpen),
        h('p', { class: 'muted small' }, `${s.source}: `, h('a', { href: beachRule.sourceUrl, rel: 'noopener noreferrer', target: '_blank' }, beachRule.source))) : null,
      !local ? h('p', { class: 'small muted' }, s.dogsCheckLocal) : null,
      h('section', { class: 'group' },
        h('p', { class: 'small' }, s.cafesLinkOut),
        h('div', { class: 'links' },
          h('a', { class: 'pill-btn pill-btn--soft', href: 'https://hundtipset.se/', rel: 'noopener noreferrer', target: '_blank' }, 'Hundtipset', svg(ICON.out, 14)),
          h('a', { class: 'pill-btn pill-btn--soft', href: 'https://hundstan.se/', rel: 'noopener noreferrer', target: '_blank' }, 'Hundstan', svg(ICON.out, 14)))),
      footer())
  }

  // ---------- about ----------
  function renderAbout() {
    const s = t()
    const date = new Intl.DateTimeFormat(lang === 'sv' ? 'sv-SE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(state.data.generated))
    const ext = (href, text) => h('a', { href, rel: 'noopener noreferrer', target: '_blank' }, text)
    document.title = `${s.aboutHeading} · ${s.title}`
    return h('div', { class: 'page page--about' },
      topBar(null),
      h('h1', { class: 'heading' }, s.aboutHeading),
      h('p', null, s.aboutIntro, ' ', ext('https://ellenial.app', 'ellenial.app')),
      h('h2', { class: 'subheading' }, s.privacyHeading), h('p', null, s.privacyText),
      h('h2', { class: 'subheading' }, s.dataHeading), h('p', null, s.dataText(date)),
      h('h2', { class: 'subheading' }, s.creditsHeading),
      h('ul', { class: 'credits' },
        h('li', null, ext('https://www.openstreetmap.org/copyright', s.creditOsm)),
        h('li', null, ext('https://openfreemap.org', s.creditTiles)),
        h('li', null, ext('https://commons.wikimedia.org', s.creditPhotos)),
        h('li', null, s.creditDogs),
        h('li', null, s.creditCode),
        h('li', null, s.creditIcons)),
      h('p', null, s.codeText, ' ', ext('https://github.com/phoenixcyberpunk/ellenial-maps', 'GitHub')),
      footer())
  }

  // ---------- routing ----------
  function render() {
    document.documentElement.lang = lang
    if (!state.data) return
    const route = location.hash.replace(/^#\/?/, '')
    const page = $('#page')
    const [name, arg, arg2] = route.split('/')
    const onHome = !name || name === 'filters'
    // In the Both view the map and panel fill the screen, so the page itself doesn't scroll.
    document.body.classList.toggle('is-locked', onHome && mapShown())
    if (onHome) {
      dropPlaceMap()
      const wasAway = $('#home').hidden
      page.hidden = true
      fill(page)
      renderHome()
      if (wasAway) requestAnimationFrame(() => { $('#panel-body').scrollTop = panelScroll })
      fill($('#sheet-root'), name === 'filters' ? renderFiltersSheet() : null)
      if (name === 'filters') requestAnimationFrame(() => $('.modal__sheet .round-btn')?.focus({ preventScroll: true }))
      render.last = name || ''
      return
    }
    fill($('#sheet-root'))
    dropPlaceMap()
    const wasHome = !$('#home').hidden
    if (wasHome) { homeScroll = scrollY; panelScroll = $('#panel-body').scrollTop }
    const view = name === 'place' ? renderPlace(decodeURIComponent(arg || ''), arg2) : name === 'dog' ? renderDog() : name === 'about' ? renderAbout() : null
    if (!view) { location.replace('#/'); return }
    $('#home').hidden = true
    fill(page, view)
    page.hidden = false
    if (wasHome || name !== render.last) scrollTo(0, 0)
    render.last = name
  }

  let lastRoute = ''
  addEventListener('hashchange', () => {
    const route = location.hash.replace(/^#\/?/, '')
    const toHome = !route
    const fromSheet = lastRoute === 'filters'
    render()
    if (toHome && lastRoute && !fromSheet) requestAnimationFrame(() => scrollTo(0, homeScroll))
    lastRoute = route
  })
  // Links inside the app count as internal, so Back uses history.
  document.addEventListener('click', (e) => { const a = e.target.closest?.('a[href^="#/"]'); if (a) internalNav = true })

  // ---------- start ----------
  // ---------- data: an index, then only the map squares needed ----------
  // /data/sweden/index.json says which squares exist; each square's file holds its places,
  // toilets, water taps and dog runs. Squares load around you (for the sections) and for what
  // the map shows, so a phone never downloads all of Sweden.
  const { cellOf, cellsIn } = window.EllenialCells
  // Photos are Maps' own copies under /photos/ (scripts/fetch-photos.mjs, 6 Nov 2026), never
  // straight from Wikimedia. Older addresses are still mapped here so a stray one never reaches
  // Wikimedia: /photo/ and /thumb/ no longer exist, so it fails and shows the drawn placeholder.
  const ownPhoto = (u) => (u || '').split('?')[0]
    .replace('https://upload.wikimedia.org/', '/photo/')
    .replace('https://thumb.wikimedia.org/', '/thumb/')
  const loadedCells = new Map() // key -> 'loading' | 'done'
  const placeIds = new Set()
  const placeHref = (p) => `#/place/${p.id}/${cellOf(p.lat, p.lon)}`
  const around = (o) => cellsIn(o.lat - 0.2, o.lon - 0.4, o.lat + 0.2, o.lon + 0.4)
  const inArea = (o, a) => a && o.lat >= a.south && o.lat <= a.north && o.lon >= a.west && o.lon <= a.east

  async function loadCells(keys) {
    const want = keys.filter((k) => state.idx.cells[k] != null && !loadedCells.has(k))
    if (!want.length) return false
    for (const k of want) loadedCells.set(k, 'loading')
    const parts = await Promise.all(want.map(async (k) => {
      try {
        const res = await fetch(`/data/sweden/${k}.json`)
        if (!res.ok) throw new Error(res.status)
        loadedCells.set(k, 'done')
        return res.json()
      } catch { loadedCells.delete(k); return null }
    }))
    const d = state.data
    for (const part of parts.filter(Boolean)) {
      for (const p of part.places) if (!placeIds.has(p.id)) { placeIds.add(p.id); if (p.photo) p.photo.src = ownPhoto(p.photo.src); d.places.push(p) }
      d.toilets.push(...part.toilets); d.water.push(...part.water); d.dogParks.push(...part.dogParks)
    }
    // How far each place is from the closest dog run, for the "Good with a dog" section.
    for (const p of d.places) p._dogRun = d.dogParks.reduce((m, r) => Math.min(m, metres(p, r)), Infinity)
    return true
  }

  async function load() {
    const s = t()
    const status = $('#status')
    status.hidden = false
    fill(status, h('p', null, s.loading))
    try {
      const res = await fetch('/data/sweden/index.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(res.status)
      state.idx = await res.json()
      state.data = { places: [], toilets: [], water: [], dogParks: [], dogRules: state.idx.dogRules, generated: state.idx.generated }
      // A link straight to a place carries its square; load that too.
      const linked = location.hash.match(/^#\/place\/[^/]+\/(\d+_\d+)/)
      await loadCells([...around(from()), ...(linked ? [linked[1]] : [])])
      status.hidden = true
      if (AT) {
        // Nearest of our places to the linked spot, if it is close enough to be the same place.
        let best = null, bestD = Infinity
        for (const p of state.data.places) { const d = metres(AT, p); if (d < bestD) { best = p; bestD = d } }
        if (best && bestD <= MATCH_M) { AT.match = best.id; state.sel = best.id }
        else if (AT.name && !document.createElement('canvas').getContext('webgl')) note(AT.name)
      }
      render()
      initMap()
      if (AT?.match) requestAnimationFrame(() => $(`.pcard[data-id="${CSS.escape(AT.match)}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest' }))
    } catch {
      fill(status, h('p', null, s.loadFailed), h('button', { class: 'pill-btn', type: 'button', onclick: load }, s.tryAgain))
    }
  }
  lastRoute = location.hash.replace(/^#\/?/, '')
  load()
})()
