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

Places without a photo show a word in brackets, like `[forest]`, until person-made symbols exist.

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
- Fonts: [Fraunces](https://github.com/undercasetype/Fraunces) and [Instrument Sans](https://github.com/Instrument/instrument-sans), SIL Open Font License, via Fontsource.
- Dog rules: [Göteborg & Co](https://www.goteborg.com/guider/hundvanliga-goteborg) and Jaktlagen (1987:259).

## Licence

AGPL-3.0. See `LICENSE`.
