/*! ellenial-theme.js · shared Ellenial pattern · AGPL-3.0 · no dependencies, no tracking
 *
 * Auto / Light / Dark for any Ellenial app. The choice is saved on this device only
 * (localStorage), never sent anywhere, no account.
 *
 * HOW TO USE IN ANOTHER ELLENIAL APP
 * 1. Copy this file into the app's public folder, unchanged.
 * 2. Load it in <head>, BEFORE the stylesheet, as a normal (not async/defer) script, so the
 *    page is painted in the right colours from the first frame:
 *      <script src="/ellenial-theme.js" data-light="#FEF2E2" data-dark="#17141F"></script>
 *    data-light / data-dark = the browser bar colour (meta theme-color) for each theme.
 *    Optional data-key="…" if one origin hosts several apps that want separate choices.
 * 3. In CSS, light colours on :root, dark colours on :root[data-theme="dark"]. Keep the same
 *    dark block under @media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }
 *    so the page still follows the phone when JavaScript is off.
 * 4. Put the switch somewhere: EllenialTheme.control({ labels: { auto, light, dark } })
 *    returns a ready <span role="group"> with three buttons (one tap each). Style the classes
 *    .theme-switch and .theme-switch__btn[aria-pressed="true"] in the app.
 * 5. Anything drawn outside CSS (maps, canvas, charts) listens for changes:
 *    EllenialTheme.onChange(({ resolved }) => redraw(resolved === 'dark'))
 *
 * TESTING: add ?theme=light or ?theme=dark (or ?theme=auto) to the address. It applies to
 * that visit only and is NOT saved, so a shared test link never changes anyone's own choice.
 * Tapping the switch still saves as normal.
 *
 * API: EllenialTheme.get()      -> 'auto' | 'light' | 'dark'  (what is chosen)
 *      EllenialTheme.resolved() -> 'light' | 'dark'           (what is shown)
 *      EllenialTheme.set(pref)  -> saves and applies
 *      EllenialTheme.onChange(fn) -> returns an unsubscribe function
 *      EllenialTheme.control(opts) -> the switch element
 * The <html> element gets data-theme="light|dark" (shown) and data-theme-pref="auto|light|dark".
 */
;(function () {
  'use strict'
  var PREFS = ['auto', 'light', 'dark']
  var script = document.currentScript
  var cfg = (script && script.dataset) || {}
  var KEY = cfg.key || 'ellenial:theme'
  var root = document.documentElement
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  var listeners = []
  var controls = []

  function read() {
    try { var v = localStorage.getItem(KEY); return PREFS.indexOf(v) > 0 ? v : 'auto' } catch (e) { return 'auto' }
  }
  function write(pref) {
    try { pref === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref) } catch (e) { /* private mode: fine */ }
  }
  function fromUrl() {
    try { var v = new URLSearchParams(location.search).get('theme'); return PREFS.indexOf(v) >= 0 ? v : null } catch (e) { return null }
  }

  var pref = fromUrl() || read()

  function resolve(p) { return p === 'auto' ? (media && media.matches ? 'dark' : 'light') : p }

  function apply() {
    var shown = resolve(pref)
    root.setAttribute('data-theme', shown)
    root.setAttribute('data-theme-pref', pref)
    root.style.colorScheme = shown
    var bar = shown === 'dark' ? cfg.dark : cfg.light
    if (bar) {
      var metas = document.querySelectorAll('meta[name="theme-color"]')
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', bar)
    }
    for (var j = 0; j < controls.length; j++) syncControl(controls[j])
    var info = { pref: pref, resolved: shown }
    for (var k = 0; k < listeners.length; k++) { try { listeners[k](info) } catch (e) { console.warn('theme listener:', e) } }
  }

  function set(p) {
    if (PREFS.indexOf(p) < 0) return
    pref = p
    write(p)
    apply()
  }

  // The phone switching between light and dark only matters while on Auto.
  function onSystem() { if (pref === 'auto') apply() }
  if (media) media.addEventListener ? media.addEventListener('change', onSystem) : media.addListener(onSystem)

  // Another tab of the same app changed the choice: follow it.
  window.addEventListener('storage', function (e) { if (e.key === KEY && !fromUrl()) { pref = read(); apply() } })

  function syncControl(el) {
    var btns = el.querySelectorAll('[data-theme-value]')
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-theme-value') === pref))
  }

  function control(opts) {
    opts = opts || {}
    var labels = opts.labels || { auto: 'Auto', light: 'Light', dark: 'Dark' }
    var el = document.createElement('span')
    el.className = opts.className || 'theme-switch'
    el.setAttribute('role', 'group')
    el.setAttribute('aria-label', opts.label || 'Theme')
    PREFS.forEach(function (p, i) {
      if (i && opts.separator != null) el.append(opts.separator)
      var b = document.createElement('button')
      b.type = 'button'
      b.className = (opts.className || 'theme-switch') + '__btn'
      b.setAttribute('data-theme-value', p)
      b.textContent = labels[p]
      if (p === 'auto' && opts.autoHint) b.title = opts.autoHint
      b.addEventListener('click', function () { set(p) })
      el.append(b)
    })
    // Apps re-render often; forget switches that are no longer on the page.
    controls = controls.filter(function (c) { return c.isConnected })
    controls.push(el)
    syncControl(el)
    return el
  }

  window.EllenialTheme = {
    get: function () { return pref },
    resolved: function () { return resolve(pref) },
    set: set,
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn }) } },
    control: control,
  }

  apply()
})()
