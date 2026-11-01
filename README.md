# ellenial maps

The code behind **[maps.ellenial.app](https://maps.ellenial.app)**: a calm, free map of places to rest and recharge without spending money. Nature, water, city parks, squares, gardens, views and libraries, with toilets and water taps on the map. Gothenburg first.

Made by Ellen, one person, with AI helping on the code. Part of [Ellenial](https://ellenial.app).

## What it stands for

- Free, never paywalled. No ads, no trackers, no accounts, no cookies.
- Your location stays on your phone, and is only used when you tap "Near me".
- Phones only ever talk to maps.ellenial.app. The map, the photos and the place list all come from here, so OpenStreetMap, Wikimedia and others never see who is looking at what.
- Open source (AGPL-3.0).

## How it works

```
Every Monday night (GitHub Actions)              Every visit
OpenStreetMap ─┐                                 Phone ──> maps.ellenial.app
Wikimedia ─────┼─> scripts/build-data.mjs ─> data/gothenburg.json ─> /data/places.json
Dog rules ─────┘   (commits the file; Vercel redeploys)              /ofm/   map tiles (forwarded to OpenFreeMap)
                                                                     /photo/ photos (forwarded to Wikimedia)
```

- **`scripts/build-data.mjs`** asks OpenStreetMap (Overpass) for named parks, nature reserves, gardens, viewpoints, squares, swimming spots and libraries, plus toilets, water taps, benches, shelters and dog runs. It works out each place's setting and size from its outline, what's nearby, and finds an openly licensed photo on Wikimedia Commons with its photographer and licence. If a week's data looks broken (far fewer places than last week), nothing is committed.
- **`data/dog-rules-goteborg.json`** holds Gothenburg's dated dog rules by hand (from Göteborg & Co), plus Sweden's national 1 March – 20 August rule (Jaktlagen). Checked date at the top; update it when the city changes a rule.
- **`site/`** is the app: plain HTML, CSS and one script, no framework. Words in English and Swedish live in `site/i18n.js`; the phone's language decides unless the EN | SV switch is used.
- **`vercel.json`** forwards `/ofm/` to OpenFreeMap and `/photo/` to Wikimedia, and sets strict security headers. The site is `noindex` until it passes the Ellenial release gate.

### Setting and size

| Setting | From OpenStreetMap |
|---|---|
| Nature | nature reserves, and parks of 30 hectares or more |
| Urban | parks under 30 hectares |
| Water | bathing places, swimming areas, beaches |
| Squares | squares and pedestrian areas named "torg" or "plats" |
| Gardens | public gardens (not private or allotment) |
| A view | viewpoints |
| Libraries | libraries |

"Big, open" is 10 hectares or more, measured from the place's outline; "small, cosy" is under that. Points (viewpoints, many squares) have no size.

Places without a photo show a calm placeholder: the setting's colour, its icon and a word in brackets, like `[forest]`.

### Photo coverage (1 Nov 2026, data from 30 Oct)

Photos come from Wikimedia Commons, found through the place's own OpenStreetMap tags (`wikimedia_commons`, `image`) and then Wikidata (photo P18, Commons category P373). After both, **73 of 356 places have a photo (21%) and 283 don't**:

| Setting | With photo | Without |
|---|---|---|
| Nature | 30 of 38 | 8 |
| Squares | 20 of 59 | 39 |
| Urban parks | 11 of 93 | 82 |
| Libraries | 5 of 40 | 35 |
| Water | 4 of 34 | 30 |
| Gardens | 1 of 9 | 8 |
| A view | 2 of 83 | 81 |

Every weekly run now writes `withoutPhoto` and `withoutPhotoBySetting` into `data/report.json`.

### Home screen

One sideways row of filter chips (More opens a sheet with size, nearby and the dog switch), a Both / Map / List toggle (remembered on the phone), the map, and a pull-up panel with a handle and a count of places within 2 km. The panel holds sections of sideways photo cards: Closest, Good with a dog (outdoors, no dog ban today, and big, nature or within 500 m of a dog run), Nature, and Indoor or sheltered (libraries and places with shelter). Up to 10 cards each.

Pins show the setting's icon. Tapping a pin selects it: its card shows at the top of the panel and is outlined in the sections. Tapping a card selects its pin and moves the map to it. A second tap on the same pin or card opens the place. In the List view, cards open straight away.

## Theme: Auto / Light / Dark (shared Ellenial pattern)

`site/ellenial-theme.js` is a small, dependency-free file meant to be copied unchanged into every Ellenial app. It gives a one-tap Auto / Light / Dark switch (in the footer here, next to EN | SV), saved on the phone only in `localStorage` (key `ellenial:theme`; Auto stores nothing). No account, nothing sent anywhere.

- Loaded in `<head>` before the stylesheet, so there is no flash of the wrong colours.
- Sets `data-theme="light|dark"` on `<html>`; CSS keeps dark colours under `:root[data-theme="dark"]`, with the same block under `prefers-color-scheme` for visitors without JavaScript.
- Updates the browser bar colour, follows the phone live while on Auto, and syncs between open tabs.
- Things drawn outside CSS listen with `EllenialTheme.onChange()`; here the map swaps to its dark or light style.
- For testing: `?theme=light`, `?theme=dark` or `?theme=auto` in the address. It applies to that visit only and is never saved.

The header of the file has the five steps for adding it to another app.

## Build locally

```
npm install
node scripts/build-data.mjs --fixture tests/fixture-overpass.json --no-photos   # small offline sample
npm run build                                                                   # then serve dist/
```

`npm run data` builds the real Gothenburg file (needs internet). The map itself needs the Vercel forwards, so locally only the list and markers show.

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Map tiles: [OpenFreeMap](https://openfreemap.org), built on OpenMapTiles.
- Photos: [Wikimedia Commons](https://commons.wikimedia.org), credited per photo.
- Map engine: [MapLibre GL JS](https://maplibre.org) (BSD-3-Clause).
- Icons: [Lucide](https://lucide.dev) (ISC), made by its contributors.
- Fonts: [Fraunces](https://github.com/undercasetype/Fraunces) and [Instrument Sans](https://github.com/Instrument/instrument-sans), SIL Open Font License, via Fontsource.
- Dog rules: [Göteborg & Co](https://www.goteborg.com/guider/hundvanliga-goteborg) and Jaktlagen (1987:259).

## Licence

AGPL-3.0. See `LICENSE`.
