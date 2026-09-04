# Cafe Fantasia — Project Context for Claude Code

This is a digital conversion of a physical board game called Cafe Fantasia,
built collaboratively in Claude.ai chat sessions before moving here. This
file exists so a fresh Claude Code session has the context those chats
built up, without needing to rediscover it.

## What this repo is

A single-page browser game: `index.html` + `game.js`, real image files
under `assets/`, hosted live via GitHub Pages at whatever URL your repo
settings show under Settings → Pages. No build step, no dependencies —
open `index.html` directly or push to `main` and Pages redeploys
automatically in a minute or two.

- `index.html` — page shell + `GAME_DATA` (card names, costs, prices, and
  *paths* to images — not the images themselves)
- `game.js` — all game logic: rules engine, AI opponent (Player 2, simple
  heuristics, not an LLM), rendering, everything
- `game_data.json` — same data as what's inlined in `index.html`, kept as
  a plain file purely for readable diffs; not loaded at runtime
- `test_harness.js` — runs the game headlessly in Node (no browser) to
  sanity-check logic changes: `node test_harness.js`
- `assets/` — organized by type (`recipes/`, `guests/`, `events/`,
  `restaurant/`, `map/`, `ingredients/`, `guest-types/`, `dice/`, `misc/`)

## Known gotcha — GitHub's 100-file upload limit

GitHub's web drag-and-drop UI silently drops files past ~100 in one
batch. This has caused multiple rounds of "missing image, 404 in
console" bugs — always upload one `assets/` subfolder at a time when
adding many files through the web UI (not relevant if you're using git
directly, which doesn't have this limit).

## Rules of the game (current state)

- 2 players (browser demo is fixed at 2; the original board game
  supports 1-4). Player 1 is human, Player 2 is AI.
- Turn = 3 "prep" actions (develop dish, buy item, explore, open branch,
  hunt, fish, pick fruit, part-time job, cultivate, renovate, expand
  storage), then unlimited cooking (gated by guest capacity, not action
  count), then "End turn".
- Village exploration is a fixed graph map (`MAP_NODES`/`MAP_EDGES` in
  `game.js`) matching the painted `assets/map/map-bg.jpg` art. Both
  players start with a free branch at "start". Explore reveals an
  adjacent village; Open Branch ($20) works on any explored, unclaimed
  village.
- Everyone starts with a wooden spoon; silver/golden are purchasable via
  the "Shop" button. Spoon tier scales hunting/fishing/fruit-picking
  results and garden growth.
- A dish becomes a "specialty" at its own `maxStars` (varies per recipe,
  0-4) — not a flat 3 stars.
- Game ends via: Michelin Inspector event card drawn while any player has
  3+ specialty dishes (rates ALL players, ends immediately for whoever
  qualifies), or round 25 reached. Winner = highest final score:
  `sum(stars²)×2 + floor(money/5) + renovationLevel + branches×4`.
- After cooking: 75% chance of a guest card (art matches the dish's
  guest type — cat/giant/elf — via `guestImagesByType`), 25% chance of an
  event card. Guest/event card art already has the name and effect text
  baked into the image — the reveal modal shows just the (enlarged)
  image, no redundant text overlay.
- Card effects live in `GUEST_HANDLERS` / `EVENT_HANDLERS` in `game.js`,
  keyed by card name.

## What's NOT done yet

- Real multiplayer (Player 2 is a local heuristic AI, not a network
  player) — this is the natural next big step now that the project has a
  real hosted home.
- A separate Node.js "rules engine" package exists from earlier in the
  project but drifted out of sync with this browser version's rules
  multiple times — treat `game.js` in this repo as the current source of
  truth for rules unless told otherwise.
- 1-4 player support (currently hardcoded to 2).

## Working style established so far

- Small, verifiable changes — the designer (repo owner) reviews visually
  after each change and iterates.
- When touching game logic, run `node test_harness.js` before considering
  a change done.
- Image assets come from the designer as PNGs/zips; they get compressed
  and placed under the matching `assets/` subfolder with descriptive
  filenames matching what's already there (check `index.html`'s
  `GAME_DATA` for the exact filenames a given card expects before adding
  new art).
