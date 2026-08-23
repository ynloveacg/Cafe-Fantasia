# Cafe Fantasia — Playable Preview

This is the browser demo, restructured as a real project instead of one
giant file. Open `index.html` in any browser to play (double-click works
fine locally, no server needed) — or host it via GitHub Pages for a real
shareable link (see below).

## Structure

```
index.html          The page shell + game data (small — just names, costs,
                     and *paths* to images, not the images themselves)
game.js              All game logic (rules, AI opponent, rendering)
game_data.json       Same data as what's inlined in index.html, kept here
                     as a plain file so changes are easy to review/diff —
                     not actually loaded at runtime, index.html already
                     has it inlined for reliability (works offline, no
                     CORS issues when opened as a local file)
test_harness.js      A small Node script that runs the game headlessly
                     (no browser) to sanity-check logic changes — run
                     with `node test_harness.js`
assets/
  recipes/           r01-star0.jpg, r01-star1.jpg, ... one image per
                     recipe per star level it can reach
  guests/             g01-cat.jpg, g01-elf.jpg, g01-giant.jpg, ... one
                     image per guest card per type
  events/            e01.jpg, e02.jpg, ... one per event card
  restaurant/        level-0.jpg through level-10.jpg (renovation levels)
  map/               map-bg.jpg (the village map background)
  ingredients/        fish.jpg, meat.jpg, etc.
  guest-types/        cat.jpg, elf.jpg, giant.jpg (small badge icons)
  dice/               dice0.png, dice1.png, dice2.png
  misc/               everything else (gameboard banner, menu/log
                     backgrounds, fishing/hunting result art, etc.)
```

## Updating an image

Just replace the file in `assets/` with the same name. That's it — no
rebuild step, no re-embedding, no touching `index.html` or `game.js`.
Refresh the page and the new art shows up.

**Adding a brand-new card or renaming something** does need one small
edit — add/update the entry in `index.html`'s inlined `GAME_DATA` (search
for the card's name) so it points at the new file's path. `game_data.json`
shows the same data in a more readable form if you want to check the
shape of things first.

## Updating game rules or UI

Everything lives in `game.js` — one file, no build step. Edit it directly.
`test_harness.js` is there so you (or a future Claude session) can check
that changes don't break the core logic without opening a browser:

```bash
node test_harness.js
```

## Hosting it for real (optional)

Once this is on GitHub: repo Settings → Pages → Source: "Deploy from a
branch" → Branch: `main`, folder `/ (root)` → Save. GitHub gives you a
real `https://<username>.github.io/<repo>/` URL a minute or two later —
shareable with anyone, no download required.
