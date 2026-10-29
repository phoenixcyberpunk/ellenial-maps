// ellenial maps: one small script, no framework, no tracking.
// Views: home (#/), filters (#/filters), a place (#/place/<id>), dog (#/dog), about (#/about).
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
    back: ['M15 18l-6-6 6-6'], close: ['M6 6l12 12', 'M18 6L6 18'], out: ['M7 17L17 7', 'M8 7h9v9'],
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
  const SETTINGS = ['nature', 'water', 'urban', 'squares', 'gardens', 'view', 'libraries']
  const HOME_CHIPS = ['nature', 'water', 'urban', 'view']
  const PAGE = 30

  const state = {
    data: null,
    filters: Object.assign({ settings: [], size: 'any', nearby: [] }, store.get('filters', {})),
    dog: store.get('dog', false) === true,
    me: null,
    shown: PAGE,
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
  const from = () => state.me || CENTRE

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
  const visible = () => {
    const o = from()
    return state.data.places.filter(matches).map((p) => ({ p, d: metres(o, p) })).sort((a, b) => a.d - b.d)
  }
  const activeCount = () => state.filters.settings.filter((s) => !HOME_CHIPS.includes(s)).length + (state.filters.size !== 'any' ? 1 : 0) + state.filters.nearby.length

  // ---------- shared bits ----------
  function dogSwitch(withHint) {
    const s = t()
    return h('button', {
      class: 'dog-switch' + (withHint ? ' dog-switch--row' : ''), 'aria-pressed': String(state.dog), type: 'button',
      onclick: () => { state.dog = !state.dog; store.set('dog', state.dog); render() },
    },
    withHint ? h('span', { class: 'dog-switch__text' }, h('span', { class: 'dog-switch__label' }, s.dogSwitchLong), h('span', { class: 'dog-switch__hint' }, s.dogSwitchHint)) : s.dogSwitch,
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'switch__knob' })))
  }

  function placeholder(setting, cls) {
    return h('div', { class: `placeholder placeholder--${setting} ${cls || ''}`, role: 'img', 'aria-label': t().noPhoto }, h('span', null, t().placeholders[setting]))
  }

  // If a photo can't load, show the bracket placeholder instead of a broken image.
  function photoOr(img, setting, cls) {
    img.addEventListener('error', () => { img.parentElement?.querySelector('.hero__credit')?.remove(); img.replaceWith(placeholder(setting, cls)) }, { once: true })
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
      h('p', { class: 'footer__links' }, h('a', { href: '#/about' }, s.about), ' · ', langSwitch()))
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
  let map = null
  let mapReady = false
  let homeScroll = 0

  function renderHome() {
    const s = t()
    const home = $('#home')
    const list = visible()
    document.title = `${s.title} · ${s.tagline}`

    fill($('#home-top'), 
      h('div', { class: 'brandbar' }, h('p', { class: 'brand' }, s.title), dogSwitch(false)),
      h('h1', { class: 'heading' }, s.homeHeading),
      h('div', { class: 'chips', role: 'group', 'aria-label': s.setting },
        HOME_CHIPS.map((key) => chip(key)),
        h('a', { class: 'chip chip--more', href: '#/filters' }, svg(ICON.filter, 16), s.more, activeCount() ? h('span', { class: 'badge' }, activeCount()) : null)))

    fill($('#legend'), 
      h('span', { class: 'legend__item' }, h('span', { class: 'dot dot--place', 'aria-hidden': 'true' }), s.placesCount(list.length)),
      h('span', { class: 'legend__item' }, h('span', { class: 'dot dot--toilet', 'aria-hidden': 'true' }), s.toilet),
      h('span', { class: 'legend__item' }, h('span', { class: 'dot dot--water', 'aria-hidden': 'true' }), s.waterTap),
      state.dog ? h('span', { class: 'legend__item' }, h('span', { class: 'dot dot--dog', 'aria-hidden': 'true' }), s.dogRun) : null,
      h('button', { class: 'near-me', type: 'button', onclick: nearMe }, svg(ICON.locate, 16), s.nearMe))

    const items = list.slice(0, state.shown).map(({ p, d }) => card(p, d))
    fill($('#list'), 
      state.dog ? dogTeaser() : null,
      list.length ? items : h('div', { class: 'empty' }, h('p', null, s.nothingFound),
        h('button', { class: 'pill-btn', type: 'button', onclick: () => { state.filters = { settings: [], size: 'any', nearby: [] }; saveFilters(); render() } }, s.clearFilters)),
      list.length > state.shown ? h('button', { class: 'pill-btn pill-btn--soft show-more', type: 'button', onclick: () => { state.shown += PAGE; renderHome() } }, s.showMore) : null)
    fill($('#home-footer'), footer())
    $('#map').setAttribute('aria-label', s.mapLabel)
    updateMap(list)
    home.hidden = false
  }

  function chip(key) {
    const on = state.filters.settings.includes(key)
    return h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(on),
      onclick: () => { toggle(state.filters.settings, key); saveFilters(); state.shown = PAGE; render() },
    }, t().settings[key])
  }
  const toggle = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v) }

  function card(p, d) {
    const s = t()
    return h('a', { class: 'card', href: `#/place/${p.id}` },
      p.photo ? photoOr(h('img', { class: 'card__img', src: p.photo.src, alt: '', loading: 'lazy', width: 72, height: 72 }), p.setting, 'card__img') : placeholder(p.setting, 'card__img'),
      h('div', { class: 'card__body' },
        h('div', { class: 'card__head' }, h('span', { class: 'card__name' }, p.name), h('span', { class: 'card__dist' }, s.km(d))),
        h('span', { class: 'card__kind' }, kicker(p)),
        tags(p)))
  }

  function dogTeaser() {
    const s = t()
    const r = state.data.dogRules.national
    const on = inRange(r.from, r.to)
    return h('a', { class: 'card card--dog', href: '#/dog' },
      h('div', { class: 'card__body' },
        h('div', { class: 'card__head' }, h('span', { class: 'card__name' }, s.withYourDog), h('span', { class: 'tag ' + (on ? 'tag--warn' : 'tag--free') }, on ? s.natureSeasonOn : s.natureSeasonOff)),
        h('span', { class: 'card__kind' }, `${s.natureSeason}: ${fmtDay(r.from)} – ${fmtDay(r.to)}`)))
  }

  function nearMe(e) {
    const s = t()
    const btn = e.currentTarget
    if (!('geolocation' in navigator)) return note(s.nearMeFailed)
    btn.disabled = true
    btn.lastChild.textContent = s.nearMeBusy
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.me = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        state.shown = PAGE
        renderHome()
        if (map) map.flyTo({ center: [state.me.lon, state.me.lat], zoom: 13 })
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

  // ---------- the map ----------
  function initMap() {
    if (map || !window.maplibregl) return
    try {
      const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')
      if (!gl) throw new Error('no webgl')
      window.maplibregl.setWorkerUrl('/vendor/maplibre-gl-csp-worker.js')
      const dark = matchMedia('(prefers-color-scheme: dark)').matches
      map = new window.maplibregl.Map({
        container: 'map',
        style: window.mapStyle(location.origin, dark),
        center: [CENTRE.lon, CENTRE.lat],
        zoom: 11,
        minZoom: 9,
        maxZoom: 18,
        attributionControl: false,
        cooperativeGestures: true,
        // Tiles and fonts listed by OpenFreeMap point at its own address; send them through ours.
        transformRequest: (url) => ({ url: url.replace('https://tiles.openfreemap.org/', location.origin + '/ofm/') }),
      })
      map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right')
      map.addControl(new window.maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap · OpenFreeMap' }))
      map.on('load', () => {
        const empty = { type: 'FeatureCollection', features: [] }
        for (const id of ['places', 'toilets', 'water', 'dogparks', 'me']) map.addSource('em-' + id, { type: 'geojson', data: empty })
        const ink = dark ? '#1F1C19' : '#FFFFFF'
        map.addLayer({ id: 'em-toilets', type: 'circle', source: 'em-toilets', minzoom: 12, paint: { 'circle-radius': 4.5, 'circle-color': '#4F6676', 'circle-stroke-color': ink, 'circle-stroke-width': 1.5 } })
        map.addLayer({ id: 'em-water', type: 'circle', source: 'em-water', minzoom: 12, paint: { 'circle-radius': 4.5, 'circle-color': '#2F82B0', 'circle-stroke-color': ink, 'circle-stroke-width': 1.5 } })
        map.addLayer({ id: 'em-dogparks', type: 'circle', source: 'em-dogparks', paint: { 'circle-radius': 6, 'circle-color': '#B4530A', 'circle-stroke-color': ink, 'circle-stroke-width': 2 } })
        map.addLayer({ id: 'em-places', type: 'circle', source: 'em-places', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 14, 8], 'circle-color': '#3F6B4E', 'circle-stroke-color': ink, 'circle-stroke-width': 2 } })
        map.addLayer({ id: 'em-me', type: 'circle', source: 'em-me', paint: { 'circle-radius': 7, 'circle-color': '#2A2420', 'circle-stroke-color': '#FAF7F2', 'circle-stroke-width': 3 } })
        map.on('click', 'em-places', (e) => { const id = e.features[0]?.properties?.id; if (id) { internalNav = true; location.hash = `#/place/${id}` } })
        map.on('mouseenter', 'em-places', () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', 'em-places', () => { map.getCanvas().style.cursor = '' })
        mapReady = true
        updateMap(visible())
      })
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
    map.getSource('em-places').setData(fc(list.map((x) => x.p), (p) => ({ id: p.id })))
    map.getSource('em-toilets').setData(fc(d.toilets))
    map.getSource('em-water').setData(fc(d.water))
    map.getSource('em-dogparks').setData(fc(state.dog ? d.dogParks : []))
    map.getSource('em-me').setData(fc(state.me ? [state.me] : []))
  }

  // ---------- filters ----------
  function renderFilters() {
    const s = t()
    const f = state.filters
    const seg = (val, label) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(f.size === val), onclick: () => { f.size = val; saveFilters(); render() } }, label)
    const nearChip = (key, label) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.nearby.includes(key)), onclick: () => { toggle(f.nearby, key); saveFilters(); render() } }, label)
    const n = state.data.places.filter(matches).length
    document.title = `${s.filtersHeading} · ${s.title}`
    return h('div', { class: 'page page--filters' },
      topBar(s.filtersHeading, true),
      h('section', { class: 'group' }, h('h2', { class: 'label' }, s.setting),
        h('div', { class: 'chips' }, SETTINGS.map((key) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(f.settings.includes(key)), onclick: () => { toggle(f.settings, key); saveFilters(); render() } }, s.settings[key])))),
      h('section', { class: 'group' }, h('h2', { class: 'label' }, s.size),
        h('div', { class: 'seg', role: 'group', 'aria-label': s.size }, seg('any', s.sizeAny), seg('small', s.sizeSmall), seg('big', s.sizeBig))),
      h('section', { class: 'group' }, h('h2', { class: 'label' }, s.nearbyHeading),
        h('div', { class: 'chips' }, nearChip('toilet', s.toilet), nearChip('water', s.waterTap), nearChip('benches', s.benches), nearChip('shelter', s.shelter))),
      dogSwitch(true),
      h('div', { class: 'sticky-cta' }, h('a', { class: 'pill-btn pill-btn--wide', href: '#/', onclick: () => { state.shown = PAGE } }, s.showPlaces(n))))
  }

  // ---------- a place ----------
  function renderPlace(id) {
    const s = t()
    const p = state.data.places.find((x) => x.id === id)
    if (!p) { location.replace('#/'); return null }
    document.title = `${p.name} · ${s.title}`
    const ph = p.photo
    const links = [
      p.website ? h('a', { class: 'pill-btn', href: p.website, rel: 'noopener noreferrer', target: '_blank' }, s.theirWebsite, svg(ICON.out, 14)) : null,
      h('a', { class: 'pill-btn pill-btn--soft', href: `https://www.openstreetmap.org/directions?to=${p.lat}%2C${p.lon}#map=15/${p.lat}/${p.lon}`, rel: 'noopener noreferrer', target: '_blank' }, s.directions, svg(ICON.out, 14)),
      p.morePhotos ? h('a', { class: 'pill-btn pill-btn--soft', href: p.morePhotos, rel: 'noopener noreferrer', target: '_blank' }, s.morePhotos, svg(ICON.out, 14)) : null,
    ]
    const fac = [
      p.nearby.toilet ? h('span', { class: 'tag tag--facility tag--lg' }, h('b', null, 'WC'), s.toilet) : null,
      p.nearby.water ? h('span', { class: 'tag tag--facility tag--lg' }, svg(ICON.drop, 12), s.waterTap) : null,
      p.nearby.benches ? h('span', { class: 'tag tag--lg' }, s.benches) : null,
      p.nearby.shelter ? h('span', { class: 'tag tag--lg' }, s.shelter) : null,
    ].filter(Boolean)

    return h('div', { class: 'page page--place' },
      h('div', { class: 'hero' },
        ph ? photoOr(h('img', { class: 'hero__img', src: ph.src, alt: '', width: ph.w, height: ph.h }), p.setting, 'hero__img') : placeholder(p.setting, 'hero__img'),
        h('a', { class: 'round-btn hero__back', href: '#/', 'aria-label': s.back, onclick: goBack }, svg(ICON.back)),
        ph ? h('a', { class: 'hero__credit', href: ph.page, rel: 'noopener noreferrer', target: '_blank' }, s.photoBy(ph.by, ph.licence)) : null),
      h('div', { class: 'place' },
        h('p', { class: 'kicker' }, [kicker(p), p.fee ? s.fee : s.free].join(' · ')),
        h('h1', { class: 'place__name' }, p.name),
        p.ha ? h('p', { class: 'muted' }, s.sizeHa(p.ha)) : null,
        h('div', { class: 'links' }, links),
        fac.length ? h('div', { class: 'tags' }, fac) : null,
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
    if (!st && p.setting !== 'nature' && !run) return null
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
    const beachRule = state.data.dogRules.local.find((r) => r.id === 'beach-summer-ban')
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
        h('li', null, s.creditCode)),
      h('p', null, s.codeText, ' ', ext('https://github.com/phoenixcyberpunk/ellenial-maps', 'GitHub')),
      footer())
  }

  // ---------- routing ----------
  function render() {
    document.documentElement.lang = lang
    if (!state.data) return
    const route = location.hash.replace(/^#\/?/, '')
    const page = $('#page')
    const [name, arg] = route.split('/')
    if (!name) {
      page.hidden = true
      fill(page)
      renderHome()
      if (map) requestAnimationFrame(() => map.resize())
      return
    }
    const wasHome = !$('#home').hidden
    if (wasHome) homeScroll = scrollY
    const view = name === 'filters' ? renderFilters() : name === 'place' ? renderPlace(decodeURIComponent(arg || '')) : name === 'dog' ? renderDog() : name === 'about' ? renderAbout() : null
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
    render()
    if (toHome && lastRoute) requestAnimationFrame(() => scrollTo(0, homeScroll))
    lastRoute = route
  })
  // Links inside the app count as internal, so Back uses history.
  document.addEventListener('click', (e) => { const a = e.target.closest?.('a[href^="#/"]'); if (a) internalNav = true })

  // ---------- start ----------
  async function load() {
    const s = t()
    const status = $('#status')
    status.hidden = false
    fill(status, h('p', null, s.loading))
    try {
      const res = await fetch('/data/places.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(res.status)
      state.data = await res.json()
      status.hidden = true
      render()
      initMap()
    } catch {
      fill(status, h('p', null, s.loadFailed), h('button', { class: 'pill-btn', type: 'button', onclick: load }, s.tryAgain))
    }
  }
  lastRoute = location.hash.replace(/^#\/?/, '')
  load()
})()
