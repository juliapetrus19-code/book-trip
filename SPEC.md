# BookTrip — technical specification (the contract)

BookTrip is a website: a visitor types a book title and "steps inside" it. For any book the site shows
a short retelling, key terms, every notable character (with a cute 3D voxel figure in the style of
blocky "voxel diorama" art), similar-book recommendations and a 3D "trip into the book" mini-film.
Premium extras: AI portrait of a character (image model) and a real AI video (video model).

Languages: Russian (`ru`), Ukrainian (`uk`), English (`en`). Every UI string exists in all three.
Brand: **BookTrip** — RU «Путешествие внутрь любой книги», UK «Подорож усередину будь-якої книги»,
EN "Step inside any book".

Everything below is a CONTRACT between modules written by different people. Do not rename exported
functions, element ids, CSS custom properties, JSON fields or enum values. If you need something
extra, ADD it (new optional field / new export) — never change or remove what is specified.

---------------------------------------------------------------------------------------------------
## 1. Stack and layout

- Static front-end: plain ES modules, no framework, no build step. Served as-is by Vercel.
- three.js is vendored as ONE file `vendor/three.min.js` (r186). Import it ONLY through the import
  map name `"three"`: `import * as THREE from "three"`. The bundle also exports `OrbitControls`,
  `RoundedBoxGeometry` and `BufferGeometryUtils` (`import { OrbitControls } from "three"`).
- Fonts (Google Fonts, already linked in index.html): `Unbounded` (display, 500–900),
  `Inter` (UI/body, 400–800), `Playfair Display` (literary accents, 600, italic). All have Cyrillic.
- Back-end: Vercel Functions in `/api/*.js` (Node 20+, ESM, web-standard handlers:
  `export async function GET(request) { return Response.json(...) }`). Shared code in `/api/_lib/`
  (files under `_lib` are not routed). Only dependency: `@anthropic-ai/sdk`.
- Without API keys (or when opened as static files) the site runs in **demo mode** on the bundled
  books in `data/books/*.json`. With keys it runs in **live mode** for any book.

```
index.html            app shell (both views), import map, fonts       [owner: core]
css/base.css          tokens, reset, nav, buttons, glass, modals, toasts [owner: core + home]
css/home.css          home hero, search, 3D ring                       [owner: home]
css/book.css          book page                                        [owner: book-ui]
js/app.js             boot, router, search flow, data loading, i18n    [owner: app]
js/i18n.js            UI strings ru/uk/en + t()                         [owner: app]
js/api.js             client data layer: demo + live + cache            [owner: app]
js/covers.js          generative book covers (SVG)                      [owner: home]
js/ring.js            3D cover carousel                                 [owner: home]
js/voxel.js           voxel character engine                            [owner: voxel]
js/film.js            3D "trip into the book" mini-film                 [owner: film]
js/book-view.js       renders a BookView into #view-book                [owner: book-ui]
js/util.js            esc(), el(), hash(), etc. (shared helpers)        [owner: core]
data/catalog.json     list of demo books (generated from data/books)    [owner: data]
data/books/<id>.json  full demo book data, all 3 languages              [owner: data]
api/*.js, api/_lib/*  serverless API                                    [owner: backend]
dev/*.html            dev/test pages for engines (not linked from site) [owners]
tests/*               node tests (API, data validation), e2e scripts
```

---------------------------------------------------------------------------------------------------
## 2. Data model

### 2.1 BookView — what the UI renders (ONE language)

```js
{
  id: "little-prince",          // demo: slug; live: canonical slug from /api/resolve
  lang: "ru",                   // "ru" | "uk" | "en"
  source: "demo",               // "demo" | "live"
  title: "Маленький принц",
  originalTitle: "Le Petit Prince",
  author: "Антуан де Сент-Экзюпери",
  year: 1943,                   // integer or null; negative = BC
  genre: "Философская сказка",
  tagline: "Сказка для взрослых о том, что зорко одно лишь сердце.",  // ≤ 120 chars
  cover: Cover,
  // --- part "overview" (may arrive later in live mode) ---
  summary: ["абзац", "..."],   // 4–7 paragraphs, 50–110 words each, spoiler-complete retelling
  themes: ["Дружба", "..."],   // 3–6 short labels
  terms: [{ term: "Астероид B-612", definition: "1–2 sentences" }],   // 6–14 items
  similar: [{ title: "...", author: "...", why: "1 sentence why it is similar" }],   // 4–6
  // --- part "characters" ---
  characters: [Character],      // 4–14, most important first
  // --- part "film" ---
  film: Film
}
```
In live mode the parts `overview`, `characters`, `film` arrive separately; until a part arrives its
fields are `undefined` and the UI shows skeletons for that part.

### 2.2 Cover
```js
{ bg: "#1b2a4a", bg2: "#0e1630", fg: "#f6e7b0", accent: "#ff8a5b",
  motif: "star" }   // enum COVER_MOTIFS
```
COVER_MOTIFS = `star, rose, crown, sword, ship, key, eye, tree, moon, sun, castle, mask, feather,
heart, skull, compass, wave, mountain, bird, book, ring, flame, clock, leaf, lantern, wand, fox,
anchor, dagger, hat`

### 2.3 Character
```js
{
  id: "fox",                    // [a-z0-9-], unique within the book
  name: "Лис",
  role: "supporting",           // enum: protagonist | antagonist | supporting | minor
  traits: ["мудрый", "терпеливый", "верный"],   // 3–5 short words
  description: "2–4 sentences: who they are, what they do in the story, how they change.",
  appearance: Appearance,
  portraitPrompt: "English, 1–2 sentences describing ONLY the look (no names of real people/actors)"
}
```

### 2.4 Appearance — drives the voxel figure (language-independent)
All colors are `#rrggbb`. Every field is required (use "none" where nothing applies).
```js
{
  creature: "human",   // human | elf | dwarf | hobbit | fox | cat | dog | rabbit | bear | owl |
                       // dragon | snake | horse | robot | ghost | mouse | bird | wolf | pig | lion
  gender: "male",      // male | female | neutral
  age: "adult",        // child | teen | adult | elder
  build: "average",    // slim | average | broad | small | tall
  skin: "#f1c7a3",     // skin, or fur/scales colour for animals
  hair: { style: "short", color: "#3b2a1a" },
        // style: none | short | long | bun | ponytail | curly | spiky | bob | braids | mohawk | wavy | messy
  facialHair: "none",  // none | mustache | beard | long_beard | stubble
  eyes: "#3a5a8a",
  top: { kind: "shirt", color: "#2e5c9a", accent: "#f0f0f0", pattern: "plain" },
        // kind: shirt | tshirt | jacket | coat | dress | robe | armor | sweater | suit | tunic | vest | gown
        // pattern: plain | stripes | checks | dots | embroidery
  bottom: { kind: "pants", color: "#2b2b35" },     // pants | skirt | shorts | robe | none
  shoes: "#4a3020",
  headwear: "none",    // none | crown | wizard_hat | top_hat | cap | bow | hood | helmet | headscarf |
                       // flower_wreath | feather_hat | beanie | tiara | bandana | tricorn | straw_hat
  headwearColor: "#000000",
  accessory: "none",   // none | glasses | round_glasses | scarf | cape | backpack | necklace |
                       // eyepatch | monocle | wings | tie | bowtie | belt_sword
  accessoryColor: "#000000",
  holding: "none"      // none | wand | sword | book | lantern | rose | staff | pipe | shield |
                       // bow_weapon | umbrella | cup | key | flower | letter | rapier | pistol |
                       // telescope | map | basket | microphone | candle | spear | magnifier
}
```

### 2.5 Film — the 3D "trip into the book"
```js
{
  title: "Путешествие на астероид B-612",
  intro: "Narration, 2nd person: you open the book and fall inside…",   // 1–2 sentences
  outro: "Narration: the pages close, you are back…",                     // 1–2 sentences
  scenes: [Scene],             // 5–7, in story order
  videoPrompts: ["English cinematic prompt for an 8-second clip", "...", "..."]  // exactly 3
}
```
### 2.6 Scene
```js
{
  title: "Встреча с Лисом",
  setting: "meadow",   // space | forest | city | village | castle | desert | sea | ship | room |
                       // snow | garden | mountains | school | ballroom | battlefield | cave | island |
                       // street | train | meadow | library | tavern | palace | swamp | church
  time: "day",         // dawn | day | dusk | night
  weather: "clear",    // clear | rain | snow | fog | stars | wind
  cast: ["prince", "fox"],     // 1–4 character ids from `characters`
  props: ["flower", "tree"],   // 0–5 from SCENE_PROPS
  action: "talk",      // talk | walk | dance | fight | travel | discover | rest | celebrate | sad | chase
  camera: "orbit",     // orbit | dolly_in | pan | crane | fly_over | close_up
  mood: "magical",     // calm | magical | tense | joyful | melancholic | epic | mysterious | romantic
  narration: "2–3 sentences, 2nd person, present tense: you are standing next to…",
  line: { speaker: "fox", text: "a short paraphrased line (never a long verbatim quote)" }  // or null
}
```
SCENE_PROPS = `tree, pine, palm, house, tower, castle, lamp, rose, flower, rock, volcano, star,
moon, planet, boat, ship, table, chair, bookshelf, fire, fountain, bench, fence, well, carriage,
chest, door, bridge, tent, crystal, clock, piano, statue, cake, barrel, cart, throne, bed,
desk, window, mushroom, bush, sign, telescope, cauldron, candles, gate, grave, train`

Enums live in ONE place: `js/enums.js` (front-end) and `api/_lib/enums.js` (back-end, same values).
Unknown enum values coming from anywhere must be tolerated (fall back to a sensible default) — never
crash the page.

### 2.7 Demo data file `data/books/<id>.json` (all languages in one file)
```js
{
  id: "little-prince", year: 1943,
  cover: Cover,
  i18n: {
    ru: { title, originalTitle, author, genre, tagline, summary, themes, terms, similar,
          film: { title, intro, outro, scenes: [{ title, narration, line: {text} | null }] },
          characters: { "<charId>": { name, traits, description } } },
    uk: { ...same shape... },
    en: { ...same shape... }
  },
  characters: [ { id, role, appearance, portraitPrompt } ],          // shared, language-independent
  film: { scenes: [ { setting, time, weather, cast, props, action, camera, mood,
                      line: { speaker } | null } ],                   // shared structure
          videoPrompts: [ ... 3 English prompts ... ] }
}
```
Optional top-level `aliases: [string]` = extra search strings (alternative titles, transliterations, short names).
`film.scenes[i]` (shared) and `i18n[lang].film.scenes[i]` (texts) are merged by index.
`js/api.js` converts a demo file + lang into a BookView. `data/catalog.json` is an array of
`{ id, year, cover, title: {ru,uk,en}, author: {ru,uk,en}, aliases: [ ...search strings ] }`.

---------------------------------------------------------------------------------------------------
## 3. Live API (Vercel functions)

All GET responses that depend only on the query are CDN-cacheable:
`Cache-Control: public, max-age=3600, s-maxage=31536000, stale-while-revalidate=86400`.
Errors: JSON `{ error: "code", message: "human readable" }` with proper status, never cached.
Error codes: `not_configured` (503), `bad_request` (400), `rate_limited` (429), `not_found` (404),
`upstream` (502), `forbidden` (403).

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | `{ live: bool, portraits: bool, video: bool, premiumCodeRequired: bool, model: string }` (no secrets) |
| `GET /api/resolve?q=&lang=` | identify the book: `{ found: true, id, title, originalTitle, author, year, genre, tagline, cover }` or `{ found: false, suggestions: [{ title, author }] }` |
| `GET /api/overview?id=&title=&author=&lang=` | `{ summary, themes, terms, similar }` |
| `GET /api/characters?id=&title=&author=&lang=` | `{ characters: [Character + portraitToken] }` |
| `GET /api/film?id=&title=&author=&lang=&cast=<id:Name,id:Name…>` | `Film` + `videoToken` |
| `GET /api/portrait?book=&char=&lang=&prompt=&token=` | `image/png` (or jpeg) bytes; demo books: `?demo=<bookId>&char=<charId>` (prompt read from data file) |
| `POST /api/video` body `{ id, title, prompts:[3], token }`, header `x-premium-code` | `{ jobs: ["<opId>", ...] }` |
| `GET /api/video?op=<opId>` | `{ done: false }` or `{ done: true, url: "/api/video?file=<signed>" }` |
| `GET /api/video?file=<signed>` | streams `video/mp4` |

- Claude: model from env `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `client.beta.messages.create`
  with `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`,
  `output_config: { effort, format: { type: "json_schema", schema } }`. Always check
  `stop_reason` (`refusal`, `max_tokens`) before parsing. Effort: resolve `low`, others `medium`
  (env `BOOK_EFFORT` overrides).
- Images & video: Google Gemini API (env `GEMINI_API_KEY`). Image model env `GEMINI_IMAGE_MODEL`
  (default `gemini-2.5-flash-image`), video model env `GEMINI_VIDEO_MODEL`
  (default `veo-3.1-fast-generate-preview`). Keys never leave the server.
- `portraitToken` / `videoToken` = HMAC-SHA256 (env `SIGNING_SECRET`, falling back to a hash of the
  Anthropic key) over the exact prompt(s) + ids. The portrait/video endpoints only accept signed
  prompts, so nobody can use our keys as a free image/video generator.
- Video is premium: requires env `PREMIUM_CODE`; the client sends it in `x-premium-code`. If
  `PREMIUM_CODE` is unset, video is disabled (`forbidden`).
- Best-effort in-memory rate limit per IP (e.g. 30 text requests / 10 min, 10 portraits / 10 min).

---------------------------------------------------------------------------------------------------
## 4. Front-end module contracts

### js/util.js  (core)
`esc(str)` HTML-escape · `el(tag, attrs, ...children)` · `hashStr(str) → uint32` ·
`seeded(n) → () => float` deterministic PRNG · `prefersReducedMotion() → bool` ·
`slugify(str)` · `debounce(fn, ms)`.
**All text that came from AI or data files MUST be inserted with textContent or `esc()`.**

### js/enums.js  (core)
Exports arrays for every enum in §2 (`COVER_MOTIFS, SCENE_PROPS, SETTINGS, ...`).

### js/i18n.js  (app)
`export const STRINGS = { ru: {...}, uk: {...}, en: {...} }`, `export function t(key, vars)`,
`export function getLang()`, `export function setLang(lang)` (persists `localStorage['bt-lang']`,
sets `<html lang>`, dispatches `window` event `"bt:lang"` with `detail.lang`),
`export function applyI18n(root=document)` — fills `[data-i18n]` (textContent),
`[data-i18n-ph]` (placeholder), `[data-i18n-aria]` (aria-label). Default language: saved, else from
`navigator.language` (uk → uk, ru/be/kk → ru, else en).

### js/covers.js  (home)
`coverSVG(cover, { title, author, w=260, h=390 }) → string` — a self-contained SVG string (escape
text!). Beautiful generative cover: background gradient bg→bg2, motif illustration, title and
author typography. Deterministic for the same input.

### js/ring.js  (home)
`createRing(container, items, { onOpen(item), reducedMotion }) → { destroy(), shuffle(), setItems(items) }`
`items` = array of `{ id, title, author, cover }`. True 3D perspective ring of cover cards
(CSS 3D or three.js — implementer's choice), continuous slow spin, drag/swipe to spin with inertia,
tap empty area → "flick" (random fast spin that settles), tap a card → `onOpen(item)`.

### js/voxel.js  (voxel)
- `buildCharacter(appearance, opts?) → THREE.Group` — voxel figure ~1 unit = 1 voxel, feet at y=0,
  facing +z. Group has `userData.parts = { head, body, armL, armR, legL, legR, held }` for animation.
- `renderPortrait(appearance, { size=512, background: "studio" | "transparent" | "#hex", pose: "idle" | "wave" } ) → Promise<string>` — PNG data URL. Uses ONE shared offscreen WebGLRenderer (never create a renderer per character). Results memoized by JSON of the args.
- `createViewer(container, appearance) → { dispose() }` — interactive turntable (drag to rotate),
  soft studio light, grass-tile base, idle animation.
- `animateCharacter(group, action, t)` — applies a pose for time `t` seconds for actions:
  `idle, talk, walk, dance, fight, wave, sad, celebrate`.
- Style: cute chunky voxel figures like modern voxel/diorama art — big head (~45% of height), simple
  dark eyes with a white highlight, blush on cheeks, small smile, blocky hair with volume,
  readable clothes colours, soft shadows. Animals are recognisable (ears/snout/tail/wings).

### js/film.js  (film)
`createFilm(container, { book: BookView, lang, tts: true, onScene(i), onEnd() }) → { play(), pause(), restart(), dispose(), get playing() }`
Renders the mini-film in a 16:9 canvas inside `container` (container provides the size). Uses
`voxel.buildCharacter` for the cast and procedural voxel dioramas for settings/props. Sequence:
book-opening intro (pages fly, camera dives in) → scenes (each ~7–10 s or as long as its narration
lasts) → outro (book closes). Subtitles overlay (narration + speaker line), scene title card,
optional TTS via `speechSynthesis` (voice for `lang` if available; silently skip if not). Must
tolerate missing/unknown enums and cast ids. Pauses when the tab is hidden. Respects reduced motion
(no camera shake, slower moves).

### js/api.js  (app)
`getHealth()`, `searchBooks(query, lang) → Promise<{ demo: BookView|null, live: {found, ...}|null, suggestions }>`,
`loadDemoBook(id, lang) → BookView`, `loadLivePart(bookMeta, part, lang)`, caching in localStorage
(`bt-cache:<id>:<lang>:<part>`, LRU ≤ 40 entries, try/catch around storage).

### js/book-view.js  (book-ui)
`renderBook(root, book, { lang, health, onSearch(query), onBack() }) → { update(book), dispose() }`
`update(book)` is called again whenever a live part arrives — re-render only the changed sections.

---------------------------------------------------------------------------------------------------
## 5. Visual language

Dark "deep space" stage like a premium tech product page; content on frosted-glass panels; cyan light.
Tokens are in `css/base.css` `:root` — use them, do not invent new colours for shared things.
- Signature button `.btn-glow`: near-black body with a bank of cyan light pooled at its FOOT
  (multi-stop bottom gradient clipped by the button's own rounded rect, `overflow:hidden`), thin
  bright streak on the top edge, white Inter 600 label. No outer halo glow.
- Character stage cards are LIGHT (soft warm-grey studio backdrop + green grass tile base) to echo
  the voxel diorama reference image — they pop against the dark page.
- Motion: entrance animations once; continuous motion only for the ring and starfield; everything
  honours `prefers-reduced-motion`.
- Mobile first-class: 320px … 2560px, no horizontal scroll, tap targets ≥ 44px.
