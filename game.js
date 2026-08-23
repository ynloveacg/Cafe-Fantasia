

const INGREDIENT_TYPES = ["meat", "fruit", "fish", "vegetable", "wheat"];
const SPOON_PRICES = { wooden: 2, silver: 20, golden: 40 };
const SPOON_LEVEL_BONUS = { none: 0, wooden: 1, silver: 2, golden: 3 };
const SPOON_RANK = { none: 0, wooden: 1, silver: 2, golden: 3 };
const FRIDGE_PRICE = 50;
// ASSUMPTION: only silver (1→3, 2→4) and golden (1→5, 2→6) were specified;
// wooden follows the same +2-per-tier pattern (1→1, 2→2). Flagged in chat —
// easy to change here if wooden should behave differently.
const HUNTING_RESULTS = {
  none: { 0: 0, 1: 0, 2: 0 },
  wooden: { 0: 0, 1: 1, 2: 2 },
  silver: { 0: 0, 1: 3, 2: 4 },
  golden: { 0: 0, 1: 5, 2: 6 },
};
const FRUIT_PICKING_RESULTS = { wooden: 2, silver: 4, golden: 6 };
const CUSTOM_DIE_FACES = [0, 0, 0, 1, 1, 2];
const AI_PLAYER_ID = "p2";

// Village exploration map — matches the uploaded layout. "start" is where
// both players begin with a free branch. Every other node is unexplored
// (village === null) until a player Explores into it.
// x/y are percentages of the map image's width/height, read directly off
// the numbered reference map (OCR-extracted + visually cross-checked).
const MAP_NODES = [
  { id: "start", x: 18.6, y: 64.5 },
  { id: "v1", x: 9.8, y: 50.0 },
  { id: "v2", x: 24.3, y: 25.0 },
  { id: "v3", x: 31.3, y: 41.0 },
  { id: "v4", x: 43.3, y: 54.8 },
  { id: "v5", x: 56.2, y: 62.1 },
  { id: "v6", x: 41.0, y: 19.7 },
  { id: "v7", x: 50.0, y: 39.8 },
  { id: "v8", x: 56.3, y: 21.6 },
  { id: "v9", x: 65.5, y: 45.2 },
  { id: "v10", x: 81.2, y: 53.9 },
  { id: "v11", x: 71.7, y: 20.3 },
];
// Matches the visible paths on the map art (same topology as before, just
// renumbered to match your reference image's actual node labels 1-11).
const MAP_EDGES = [
  ["v1", "v3"], ["v2", "v3"], ["v2", "v6"], ["v3", "v7"], ["v3", "v4"],
  ["v6", "v8"], ["v7", "v8"], ["v7", "v4"], ["v7", "v9"], ["v8", "v11"],
  ["v9", "v11"], ["v9", "v10"], ["v4", "v5"], ["v5", "v10"], ["v1", "start"], ["v5", "start"],
];
const START_VILLAGE = { cat: 1, giant: 1, elf: 1 };


function neighborsOf(nodeId) {
  const out = [];
  for (const [a, b] of MAP_EDGES) {
    if (a === nodeId) out.push(b);
    else if (b === nodeId) out.push(a);
  }
  return out;
}

function rollDie() {
  return CUSTOM_DIE_FACES[Math.floor(Math.random() * CUSTOM_DIE_FACES.length)];
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function createPlayer(id, name) {
  return {
    id, name, money: 20,
    ingredients: { meat: 0, fruit: 0, fish: 0, vegetable: 2, wheat: 2 },
    wheatStorage: 4, vegetableStorage: 4,
    wheatExpansions: 0, vegetableExpansions: 0,
    recipes: [], spoon: "wooden", hasFridge: false,
    renovationLevel: 0, points: 0, guestsServedTotal: 0,
    position: "start",
    branches: ["start"],
    guestCapacityRemaining: { cat: 0, giant: 0, elf: 0 }, // recomputed at the start of each of their turns
    pendingChoice: null,
    nextTurnActionDelta: 0,
    turnFlags: { tipMultiplier: 1, tipsVoided: false },
    savedDieRoll: null,
    pendingMafiaOffer: false,
    mafiaOfferQueued: false,
    pendingVloggerBonus: false,
  };
}

// Wheat/vegetable are capped by the player's farm/garden storage size;
// everything else (meat/fish/fruit) has no storage limit.
function storageCap(p, type) {
  if (type === "wheat") return p.wheatStorage;
  if (type === "vegetable") return p.vegetableStorage;
  return Infinity;
}
function gainIngredient(p, type, amount) {
  const cap = storageCap(p, type);
  p.ingredients[type] = Math.min(cap, (p.ingredients[type] || 0) + amount);
}

let state = null;
let botRunning = false;

function recipeDef(id) { return GAME_DATA.recipes.find((r) => r.id === id); }
function cardDef(id) {
  const g = GAME_DATA.guests.find((c) => c.id === id);
  if (g) return { ...g, kind: "guest" };
  const e = GAME_DATA.events.find((c) => c.id === id);
  if (e) return { ...e, kind: "event" };
  return null;
}
function isSpecialty(r) {
  const def = recipeDef(r.recipeId);
  return def.maxStars > 0 && r.stars >= def.maxStars;
}

const MAX_RENOVATION_LEVEL = 10;
function addRenovation(p, amount) {
  p.renovationLevel = Math.max(0, Math.min(MAX_RENOVATION_LEVEL, p.renovationLevel + amount));
}
// Renovation tip: a flat bonus added every time a dish is served, based on
// which tier the player's renovation level has reached.
function renovationTipBonus(level) {
  if (level >= 10) return 4;
  if (level >= 7) return 3;
  if (level >= 4) return 2;
  if (level >= 1) return 1;
  return 0;
}
function isBot(p) { return p.id === AI_PLAYER_ID; }
function otherPlayerOf(p) { return state.players.find((pl) => pl.id !== p.id); }

// Final score, computed only when the game ends. This is separate from the
// "points" stat tracked during play (from serving guests, Scholar, Stray
// cat, etc.) — that stat still drives some card flavor, but the winner is
// decided entirely by this formula per the house rules:
//   - sum(stars^2) across every owned recipe, times 2
//   - floor(money / 5)
//   - renovationLevel, 1 point each
//   - branches owned, 4 points each (always 0 here — no village/branch
//     mechanic in this simplified preview)
function computeFinalScore(p) {
  const dishPoints = p.recipes.reduce((sum, r) => sum + r.stars * r.stars, 0) * 2;
  const moneyPoints = Math.floor(p.money / 5);
  const renovationPoints = p.renovationLevel;
  const branchPoints = p.branches.length * 4;
  const total = dishPoints + moneyPoints + renovationPoints + branchPoints;
  return { dishPoints, moneyPoints, renovationPoints, branchPoints, total };
}

function endGame(reason) {
  if (state.gameOver) return;
  state.gameOver = true;
  state.winReason = reason;
  const scored = state.players.map((p) => ({ player: p, score: computeFinalScore(p) }));
  scored.sort((a, b) => b.score.total - a.score.total);
  state.finalScores = scored;
  const tie = scored.length > 1 && scored[0].score.total === scored[1].score.total;
  state.winnerId = tie ? null : scored[0].player.id;
  logMsg(
    tie
      ? `Game over (${reason})! It's a tie at ${scored[0].score.total} points.`
      : `Game over (${reason})! ${scored[0].player.name} wins with ${scored[0].score.total} points.`
  );
}

function initGame() {
  document.documentElement.style.setProperty("--menu-bg-url", `url(${GAME_DATA.menuBg2})`);
  document.documentElement.style.setProperty("--log-bg-url", `url(${GAME_DATA.logBg})`);
  const recipePile = shuffle(GAME_DATA.recipes.map((r) => r.id));
  const players = [createPlayer("p1", "Player 1"), createPlayer("p2", "Player 2 (AI)")];
  for (const p of players) {
    const rid = recipePile.shift();
    p.recipes.push({ recipeId: rid, level: 0, stars: 0 });
  }
  const menu = [];
  for (let i = 0; i < 5; i++) if (recipePile.length) menu.push(recipePile.shift());

  const guestPile = shuffle(weightedIds(GAME_DATA.guests));
  const eventPile = shuffle(weightedIds(GAME_DATA.events));

  const villages = { start: { ...START_VILLAGE } };
  for (const node of MAP_NODES) if (node.id !== "start") villages[node.id] = null;

  const branchOwners = { start: [players[0].id, players[1].id] };
  for (const node of MAP_NODES) if (node.id !== "start") branchOwners[node.id] = [];

  const villageDeck = shuffle(GAME_DATA.villagePopulations);

  state = {
    round: 1, turnIndex: 0, actionsLeft: 3, winnerId: null, gameOver: false, winReason: null,
    gameEndDialogShown: false, finalScores: null,
    players, recipePile, recipeDiscard: [], menu, guestPile, eventPile, log: [],
    coldWaveUntilRound: 0, skipNextIngredientDecay: false,
    villages, branchOwners, villageDeck,
    anyRecipeDevelopedThisRound: false,
  };
  refreshGuestCapacity(players[0]);
  logMsg("Game started. Everyone begins with $20, 2 vegetable, 2 wheat, wooden spoon, and a free branch at Start. Player 2 is AI-controlled.");
  render();
}

// Sums guest capacity from every village where this player has a branch.
// Recomputed fresh at the start of each of their turns.
function computeGuestCapacity(p) {
  const cap = { cat: 0, giant: 0, elf: 0 };
  for (const nodeId of p.branches) {
    const v = state.villages[nodeId];
    if (v) { cap.cat += v.cat || 0; cap.giant += v.giant || 0; cap.elf += v.elf || 0; }
  }
  return cap;
}
function refreshGuestCapacity(p) { p.guestCapacityRemaining = computeGuestCapacity(p); }

// Used when a branch opens MID-TURN (not at turn start) — adds the new
// village's capacity to whatever remains, rather than recomputing from
// scratch, so it doesn't wipe out capacity already spent cooking this turn.
function addVillageCapacityToRemaining(p, nodeId) {
  const v = state.villages[nodeId];
  if (!v) return;
  p.guestCapacityRemaining.cat += v.cat || 0;
  p.guestCapacityRemaining.giant += v.giant || 0;
  p.guestCapacityRemaining.elf += v.elf || 0;
}

function currentPlayer() { return state.players[state.turnIndex]; }

function logMsg(msg) {
  state.log.unshift(msg);
  if (state.log.length > 80) state.log.pop();
}

function canAfford(ingredients, cost) {
  return Object.entries(cost).every(([k, v]) => (ingredients[k] || 0) >= v);
}
function payIngredients(ingredients, cost) {
  for (const [k, v] of Object.entries(cost)) ingredients[k] -= v;
}

function spendAction() {
  state.actionsLeft = Math.max(0, state.actionsLeft - 1);
  // Turn no longer auto-ends here — cooking happens after the 3 actions
  // are used up, and the player clicks "Done" (actionDone) when finished.
}

// The only way a turn actually ends now (aside from the bot doing it
// itself) — the player explicitly signals they're done cooking.
function actionDone() {
  endTurn();
  render();
}

function endTurn() {
  const wasLast = state.turnIndex === state.players.length - 1;

  const endingPlayer = currentPlayer();
  if (endingPlayer.pendingMafiaOffer) {
    endingPlayer.pendingMafiaOffer = false;
    logMsg(`${endingPlayer.name}'s Mafia offer expired (only valid during that turn)`);
  }

  // Garden/farm growth happens every time a player ends their turn (not just
  // at round end), scaled by spoon tier, and isn't affected by owning a
  // fridge (fridge only prevents ingredient decay, not growth).
  const growth = SPOON_LEVEL_BONUS[endingPlayer.spoon]; // wooden:1, silver:2, golden:3
  if (growth > 0) {
    if (endingPlayer.ingredients.vegetable > 0) { gainIngredient(endingPlayer, "vegetable", growth); logMsg(`${endingPlayer.name}'s garden yields ${growth} more vegetable (${endingPlayer.spoon} spoon)`); }
    if (endingPlayer.ingredients.wheat > 0) { gainIngredient(endingPlayer, "wheat", growth); logMsg(`${endingPlayer.name}'s farm yields ${growth} more wheat (${endingPlayer.spoon} spoon)`); }
  }

  state.turnIndex = (state.turnIndex + 1) % state.players.length;

  const next = currentPlayer();
  state.actionsLeft = Math.max(1, 3 + next.nextTurnActionDelta);
  next.nextTurnActionDelta = 0;
  next.turnFlags = { tipMultiplier: 1, tipsVoided: false };
  refreshGuestCapacity(next);
  if (next.mafiaOfferQueued) {
    next.mafiaOfferQueued = false;
    next.pendingMafiaOffer = true;
    logMsg(`${next.name} may serve the Mafia this turn!`);
  }

  if (wasLast) {
    if (state.skipNextIngredientDecay) {
      logMsg("Ingredients don't rot this round — Cold wave");
      state.skipNextIngredientDecay = false;
    } else {
      for (const p of state.players) {
        if (!p.hasFridge) {
          const entries = Object.entries(p.ingredients).filter(([, v]) => v > 0);
          if (entries.length) {
            entries.sort((a, b) => b[1] - a[1]);
            p.ingredients[entries[0][0]] -= 1;
          }
        }
      }
    }

    if (!state.anyRecipeDevelopedThisRound && state.menu.length > 0) {
      const discarded = state.menu.pop(); // rightmost slot
      state.recipeDiscard.push(discarded);
      if (recipesAvailable()) state.menu.unshift(drawRecipe()); // new one goes in on the left, shifting the rest right
      logMsg(`No one developed a recipe this round — ${recipeDef(discarded).name} discarded and the menu replenished`);
    }
    state.anyRecipeDevelopedThisRound = false;

    state.round += 1;
    logMsg(`--- Round ${state.round} begins ---`);
    if (state.round > 25 && !state.gameOver) {
      endGame("25-round limit reached, no Michelin rating yet");
    }
  }
}

function weightedIds(cards) {
  const out = [];
  for (const c of cards) {
    let n = c.count;
    if (n === "numPlayers") n = 2; // this demo is fixed at 2 players
    if (typeof n !== "number" || n < 1) n = 1;
    for (let i = 0; i < n; i++) out.push(c.id);
  }
  return out;
}

// After cooking: 3/4 chance the card is a guest (typed to match the dish
// just served), 1/4 chance it's an event.
function drawCard() {
  const roll = Math.random();
  if (roll < 0.75) {
    if (state.guestPile.length === 0) state.guestPile = shuffle(weightedIds(GAME_DATA.guests));
    return { id: state.guestPile.shift(), kind: "guest" };
  } else {
    if (state.eventPile.length === 0) state.eventPile = shuffle(weightedIds(GAME_DATA.events));
    return { id: state.eventPile.shift(), kind: "event" };
  }
}

function recipesAvailable() {
  return state.recipePile.length > 0 || state.recipeDiscard.length > 0;
}

function drawRecipe() {
  if (state.recipePile.length === 0 && state.recipeDiscard.length > 0) {
    state.recipePile = shuffle(state.recipeDiscard);
    state.recipeDiscard = [];
    logMsg("Recipe deck reshuffled from the discard pile");
  }
  return state.recipePile.shift();
}

// ============== ACTIONS ==============
function actionDevelop(slotIndex) {
  const p = currentPlayer();
  if (isBot(p) && !botRunning) return; // guard against stray clicks during bot's turn
  const rid = state.menu[slotIndex];
  const def = recipeDef(rid);
  if (p.recipes.some((r) => r.recipeId === rid) || p.money < def.developCost) return;

  if (p.recipes.length >= 5) {
    p.pendingChoice = {
      cardName: "Develop",
      type: "REPLACE_RECIPE",
      instructions: `You already have 5 recipes. Choose one to replace with ${def.name} ($${def.developCost}).`,
      options: p.recipes.map((r) => r.recipeId),
      newRecipeId: rid,
      newRecipeSlotIndex: slotIndex,
    };
    if (isBot(p)) {
      // bot only swaps if the new dish is clearly better than its worst one
      const worst = [...p.recipes].sort((a, b) => recipeDef(a.recipeId).dishPrice - recipeDef(b.recipeId).dishPrice)[0];
      if (recipeDef(worst.recipeId).dishPrice < def.dishPrice) {
        resolveChoice({ recipeId: worst.recipeId }, p);
      } else {
        p.pendingChoice = null; // not worth it, skip silently
      }
    } else {
      showChoiceModal(p);
    }
    return;
  }

  p.money -= def.developCost;
  p.recipes.push({ recipeId: rid, level: 0, stars: 0 });
  state.menu.splice(slotIndex, 1);
  if (recipesAvailable()) state.menu.push(drawRecipe());
  state.anyRecipeDevelopedThisRound = true;
  logMsg(`${p.name} developed ${def.name} for $${def.developCost}`);
  spendAction();
  render();
}

// Core cook logic, WITHOUT spending the action or advancing the turn — that
// happens when the card-reveal modal is dismissed, so the effect always
// resolves against the player who actually cooked, even if this was their
// last action of the turn (fixes a timing bug where the turn could advance
// before the drawn card's effect applied).
// Cooking is unlimited in count but gated by (a) having used all 3 prep
// actions this turn, and (b) having capacity left for the guest type the
// dish attracts. "star" (common) dishes randomly draw from whichever guest
// types still have capacity remaining.
function pickGuestTypeForCook(p, recipeGuestType) {
  if (recipeGuestType === "cat" || recipeGuestType === "giant" || recipeGuestType === "elf") {
    return p.guestCapacityRemaining[recipeGuestType] > 0 ? recipeGuestType : null;
  }
  // "star" = common dish, serves a random available guest type
  const available = ["cat", "giant", "elf"].filter((t) => p.guestCapacityRemaining[t] > 0);
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

function performCookCore(p, recipeId, mafiaOffer) {
  const pr = p.recipes.find((r) => r.recipeId === recipeId);
  const def = recipeDef(recipeId);
  if (!pr || !canAfford(p.ingredients, def.cookCost)) return null;

  let guestType = pickGuestTypeForCook(p, def.guestType);
  let usingVloggerBonus = false;
  if (!guestType && p.pendingVloggerBonus) {
    // Vlogger's bonus guest bypasses normal capacity entirely — it's an
    // extra guest on top of whatever capacity already allows.
    usingVloggerBonus = true;
    guestType =
      def.guestType === "cat" || def.guestType === "giant" || def.guestType === "elf"
        ? def.guestType
        : ["cat", "giant", "elf"][Math.floor(Math.random() * 3)];
  }
  if (!guestType) return null; // no guest capacity left for this dish's type

  payIngredients(p.ingredients, def.cookCost);
  if (usingVloggerBonus) {
    p.pendingVloggerBonus = false;
  } else {
    p.guestCapacityRemaining[guestType] -= 1;
  }

  const bonus = SPOON_LEVEL_BONUS[p.spoon];
  const cap = def.maxStars * 3;
  pr.level = Math.min(cap, pr.level + bonus);
  pr.stars = Math.floor(pr.level / 3);

  const priceMultiplier = mafiaOffer ? 3 : 1;
  const basePrice = def.dishPrice * priceMultiplier;
  let tips = pr.stars + renovationTipBonus(p.renovationLevel);
  if (p.turnFlags.tipsVoided) tips = 0;
  else tips *= p.turnFlags.tipMultiplier;
  const earnings = basePrice + tips;
  p.money += earnings;
  p.points += 1;
  p.guestsServedTotal += 1;
  if (mafiaOffer) p.pendingMafiaOffer = false;

  logMsg(`${p.name} served a ${guestType} guest ${def.name}${mafiaOffer ? " for the Mafia (3x price)" : ""}${usingVloggerBonus ? " (Reporter bonus guest)" : ""} (level ${pr.level}, ${pr.stars}\u2605), earned $${earnings}`);

  // Reporter's bonus guest is guaranteed to be the Michelin Inspector event
  // — not a random draw from the deck.
  let card;
  let drawnGuestTypeArt = guestType; // which type-variant art to show for guest cards
  if (usingVloggerBonus) {
    card = cardDef("e13"); // Michelin inspector (now an event)
  } else {
    const drawn = drawCard();
    card = cardDef(drawn.id);
  }

  render();
  return { card, ctx: { recipeId, rng: rollDie, guestTypeArt: drawnGuestTypeArt } };
}

function actionCook(recipeId, mafiaOffer) {
  const p = currentPlayer();
  if (isBot(p) && !botRunning) return;
  if (state.actionsLeft > 0) return; // must finish the 3 prep actions before cooking
  const result = performCookCore(p, recipeId, mafiaOffer);
  if (!result) return;
  showCardModal(result.card, result.ctx, p);
}

function actionPartTimeJob() {
  const p = currentPlayer();
  p.money += 4;
  logMsg(`${p.name} worked a part-time job, +$4`);
  spendAction();
  render();
}

function actionHunt() {
  const p = currentPlayer();
  if (state.round <= state.coldWaveUntilRound) { logMsg("Can't hunt this round — Cold wave"); render(); return; }
  const face = rollDie();
  const meat = HUNTING_RESULTS[p.spoon][face];
  p.ingredients.meat += meat;
  logMsg(`${p.name} went hunting with a ${p.spoon} spoon, rolled ${face}, got ${meat} meat`);
  spendAction();
  render();
  if (!isBot(p)) {
    window.__lastDiceContext = { kind: "hunt", player: p, faces: [face] };
    showActionResultModal({
      image: meat > 0 ? GAME_DATA.huntingSuccessImg : GAME_DATA.huntingFailedImg,
      title: `You got ${meat} meat!`,
      subtitle: `${capitalize(p.spoon)} spoon effect: 1 die`,
      diceFaces: [face],
      showSavedDieButton: p.savedDieRoll !== null,
    });
  }
}

function actionFish() {
  const p = currentPlayer();
  if (state.round <= state.coldWaveUntilRound) { logMsg("Can't fish this round — Cold wave"); render(); return; }
  const rank = SPOON_RANK[p.spoon];
  if (rank === 0) { logMsg(`${p.name} needs a spoon to fish`); render(); return; }
  let fish = 0;
  const rolls = [];
  for (let i = 0; i < rank; i++) { const f = rollDie(); rolls.push(f); fish += f; }
  p.ingredients.fish += fish;
  logMsg(`${p.name} fished, rolled [${rolls.join(",")}], got ${fish} fish`);
  spendAction();
  render();
  if (!isBot(p)) {
    window.__lastDiceContext = { kind: "fish", player: p, faces: rolls };
    showActionResultModal({
      image: fish > 0 ? GAME_DATA.fishingSuccessImg : GAME_DATA.fishingFailedImg,
      title: `You got ${fish} fish!`,
      subtitle: `${capitalize(p.spoon)} spoon effect: ${rank} dice`,
      diceFaces: rolls,
      showSavedDieButton: p.savedDieRoll !== null,
    });
  }
}

function actionPickFruit() {
  const p = currentPlayer();
  if (state.round <= state.coldWaveUntilRound) { logMsg("Can't pick fruit this round — Cold wave"); render(); return; }
  const amt = FRUIT_PICKING_RESULTS[p.spoon];
  if (!amt) { logMsg(`${p.name} needs a spoon to pick fruit`); render(); return; }
  p.ingredients.fruit += amt;
  logMsg(`${p.name} picked ${amt} fruit`);
  spendAction();
  render();
  if (!isBot(p)) {
    showActionResultModal({
      image: GAME_DATA.fruitPickingImages[p.spoon],
      title: `You got ${amt} fruit!`,
      subtitle: `${capitalize(p.spoon)} spoon effect: ${amt} fruit (no dice \u2014 fruit picking is a fixed amount)`,
      diceFaces: [],
    });
  }
}

function actionCultivate(type) {
  const p = currentPlayer();
  gainIngredient(p, type, 1);
  logMsg(`${p.name} cultivated ${type} (now ${p.ingredients[type]}/${storageCap(p, type)})`);
  spendAction();
  render();
}

function emptyNeighbors(nodeId) {
  return neighborsOf(nodeId).filter((n) => state.villages[n] === null);
}

function actionExplore() {
  const p = currentPlayer();
  const options = emptyNeighbors(p.position);
  if (options.length === 0 || state.villageDeck.length === 0) return;
  const target = options[Math.floor(Math.random() * options.length)];
  const population = state.villageDeck.shift();
  state.villages[target] = population;
  p.position = target;
  const desc = Object.entries(population).map(([k, v]) => `${v} ${k}`).join(", ");
  logMsg(`${p.name} explored to a new village (${desc})`);
  spendAction();
  render();
}

function sumVillage(v) { return (v.cat || 0) + (v.giant || 0) + (v.elf || 0); }

function eligibleBranchSlots(p) {
  return MAP_NODES
    .map((n) => n.id)
    .filter((id) => state.villages[id] !== null && state.branchOwners[id].length === 0 && !p.branches.includes(id));
}

function actionOpenBranch() {
  const p = currentPlayer();
  if (isBot(p) && !botRunning) return;
  const options = eligibleBranchSlots(p);
  if (options.length === 0 || p.money < 20) return;
  if (options.length === 1) {
    confirmOpenBranch(options[0]);
    return;
  }
  showOpenBranchModal(options);
}

function showOpenBranchModal(options) {
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = "";
  document.getElementById("modalTitle").textContent = "Open a branch";
  document.getElementById("modalEffect").textContent = "Choose which explored village to open a branch in ($20).";
  document.getElementById("modalBody").innerHTML = options.map((id) => {
    const desc = Object.entries(state.villages[id]).map(([k, v]) => `${v} ${k}`).join(", ");
    return `<button onclick="confirmOpenBranch('${id}')">${desc}</button>`;
  }).join("") + `<button onclick="document.getElementById('modalBackdrop').style.display='none'">Cancel</button>`;
  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  backdrop.style.display = "flex";
}

function confirmOpenBranch(nodeId) {
  const p = currentPlayer();
  document.getElementById("modalBackdrop").style.display = "none";
  if (p.branches.includes(nodeId) || state.villages[nodeId] === null || state.branchOwners[nodeId].length > 0 || p.money < 20) return;
  p.money -= 20;
  p.branches.push(nodeId);
  state.branchOwners[nodeId].push(p.id);
  addVillageCapacityToRemaining(p, nodeId);
  logMsg(`${p.name} opened a branch at a village (${Object.entries(state.villages[nodeId]).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  spendAction();
  render();
}

function actionBuySpoon(tier) {
  const p = currentPlayer();
  if (SPOON_RANK[tier] <= SPOON_RANK[p.spoon] || p.money < SPOON_PRICES[tier]) return;
  p.money -= SPOON_PRICES[tier];
  p.spoon = tier;
  logMsg(`${p.name} bought the ${tier} spoon`);
  spendAction();
  render();
}

function actionBuyFridge() {
  const p = currentPlayer();
  if (p.hasFridge || p.money < FRIDGE_PRICE) return;
  p.money -= FRIDGE_PRICE;
  p.hasFridge = true;
  logMsg(`${p.name} bought a fridge`);
  spendAction();
  render();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Shown for Go hunting / Go fishing / Fruit picking — a quick result popup
// with the illustration, dice rolled (if any), title, subtitle, and a
// "Got it" button. Human players only — the AI doesn't need to see this.
function showActionResultModal({ image, title, subtitle, diceFaces, showSavedDieButton }) {
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = image ? `<img src="${image}" style="width:100%;max-width:280px;border-radius:10px;">` : "";
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalEffect").textContent = "";
  let body = `<p style="color:var(--accent);font-weight:600;font-size:13px;margin:-6px 0 14px;">${subtitle}</p>`;
  if (diceFaces && diceFaces.length > 0) {
    body += `<div style="display:flex;gap:10px;justify-content:center;margin-bottom:14px;">` +
      diceFaces.map((f) => `<img src="${GAME_DATA.diceImages[f]}" style="width:44px;height:44px;background:#fff;border-radius:8px;border:1px solid var(--border);">`).join("") +
      `</div>`;
  }
  if (showSavedDieButton) {
    body += `<button onclick="useSavedDieRoll()" style="background:#e0c34a;border-color:#c9ab3a;">Use saved dice result instead</button>`;
  }
  body += `<button onclick="document.getElementById('modalBackdrop').style.display='none'">Got it</button>`;
  document.getElementById("modalBody").innerHTML = body;
  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  backdrop.style.display = "flex";
}

// Fortune teller: consumes the player's banked die result (once) to
// replace a die from their most recent hunt/fish roll, recomputing the
// ingredient gain and refreshing the same result dialog in place.
function useSavedDieRoll() {
  const ctx = window.__lastDiceContext;
  if (!ctx || ctx.player.savedDieRoll === null) return;
  const p = ctx.player;
  const savedFace = p.savedDieRoll;
  p.savedDieRoll = null;

  if (ctx.kind === "hunt") {
    const oldMeat = HUNTING_RESULTS[p.spoon][ctx.faces[0]];
    const newMeat = HUNTING_RESULTS[p.spoon][savedFace];
    p.ingredients.meat += newMeat - oldMeat;
    ctx.faces = [savedFace];
    logMsg(`${p.name} used their saved die roll (${savedFace}) for hunting \u2014 now ${newMeat} meat`);
    render();
    showActionResultModal({
      image: newMeat > 0 ? GAME_DATA.huntingSuccessImg : GAME_DATA.huntingFailedImg,
      title: `You got ${newMeat} meat!`,
      subtitle: `${capitalize(p.spoon)} spoon effect: 1 die (saved roll used)`,
      diceFaces: ctx.faces,
      showSavedDieButton: false,
    });
  } else if (ctx.kind === "fish") {
    const oldSum = ctx.faces.reduce((a, b) => a + b, 0);
    let minIdx = 0;
    for (let i = 1; i < ctx.faces.length; i++) if (ctx.faces[i] < ctx.faces[minIdx]) minIdx = i;
    ctx.faces[minIdx] = savedFace;
    const newSum = ctx.faces.reduce((a, b) => a + b, 0);
    p.ingredients.fish += newSum - oldSum;
    logMsg(`${p.name} used their saved die roll (${savedFace}) for fishing \u2014 now ${newSum} fish`);
    render();
    showActionResultModal({
      image: newSum > 0 ? GAME_DATA.fishingSuccessImg : GAME_DATA.fishingFailedImg,
      title: `You got ${newSum} fish!`,
      subtitle: `${capitalize(p.spoon)} spoon effect: ${ctx.faces.length} dice (saved roll used)`,
      diceFaces: ctx.faces,
      showSavedDieButton: false,
    });
  }
}

function showShopModal() {
  const p = currentPlayer();
  const canAct = !state.gameOver && state.actionsLeft > 0 && !isBot(p);
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = "";
  document.getElementById("modalTitle").textContent = "Shop";
  document.getElementById("modalEffect").textContent = "Choose one purchase (uses 1 action).";
  const items = [];
  if (SPOON_RANK[p.spoon] < SPOON_RANK.silver) {
    items.push({ label: `Silver spoon ($${SPOON_PRICES.silver})`, enabled: canAct && p.money >= SPOON_PRICES.silver, onclick: "shopBuySpoon('silver')" });
  }
  if (SPOON_RANK[p.spoon] < SPOON_RANK.golden) {
    items.push({ label: `Golden spoon ($${SPOON_PRICES.golden})`, enabled: canAct && p.money >= SPOON_PRICES.golden, onclick: "shopBuySpoon('golden')" });
  }
  if (!p.hasFridge) {
    items.push({ label: `Fridge ($${FRIDGE_PRICE})`, enabled: canAct && p.money >= FRIDGE_PRICE, onclick: "shopBuyFridge()" });
  }
  document.getElementById("modalBody").innerHTML =
    (items.length
      ? items.map((i) => `<button ${i.enabled ? "" : "disabled"} onclick="${i.onclick}">${i.label}</button>`).join("")
      : `<p>Nothing left to buy \u2014 you already have the golden spoon and a fridge.</p>`) +
    `<button onclick="document.getElementById('modalBackdrop').style.display='none'">Close</button>`;
  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  backdrop.style.display = "flex";
}
function shopBuySpoon(tier) {
  actionBuySpoon(tier);
  document.getElementById("modalBackdrop").style.display = "none";
}
function shopBuyFridge() {
  actionBuyFridge();
  document.getElementById("modalBackdrop").style.display = "none";
}

function showOtherPlayersModal() {
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = "";
  document.getElementById("modalTitle").textContent = "Other Players";
  document.getElementById("modalEffect").textContent = "";
  const others = state.players.slice(1);
  document.getElementById("modalBody").innerHTML =
    others.map((p, i) => renderPlayerCard(p, i + 1)).join("") +
    `<button onclick="document.getElementById('modalBackdrop').style.display='none'">Close</button>`;
  document.getElementById("modalBackdrop").style.display = "flex";
  document.getElementById("modalBox").classList.add("modal-wide");
}

function actionRenovate() {
  const p = currentPlayer();
  addRenovation(p, 1);
  logMsg(`${p.name} renovated (level ${p.renovationLevel})`);
  spendAction();
  render();
}

const MAX_STORAGE = 12;
const MAX_EXPANSIONS = 3;
const WHEAT_EXPANSION_COST = 10;
const VEGETABLE_EXPANSION_COST = 15;

function actionExpandWheatFarm() {
  const p = currentPlayer();
  if (p.wheatExpansions >= MAX_EXPANSIONS || p.wheatStorage >= MAX_STORAGE || p.money < WHEAT_EXPANSION_COST) return;
  p.money -= WHEAT_EXPANSION_COST;
  p.wheatStorage = Math.min(MAX_STORAGE, p.wheatStorage + 4);
  p.wheatExpansions += 1;
  logMsg(`${p.name} expanded their wheat farm for $${WHEAT_EXPANSION_COST} (storage now ${p.wheatStorage})`);
  spendAction();
  render();
}

function actionExpandVegetableGarden() {
  const p = currentPlayer();
  if (p.vegetableExpansions >= MAX_EXPANSIONS || p.vegetableStorage >= MAX_STORAGE || p.money < VEGETABLE_EXPANSION_COST) return;
  p.money -= VEGETABLE_EXPANSION_COST;
  p.vegetableStorage = Math.min(MAX_STORAGE, p.vegetableStorage + 4);
  p.vegetableExpansions += 1;
  logMsg(`${p.name} expanded their vegetable garden for $${VEGETABLE_EXPANSION_COST} (storage now ${p.vegetableStorage})`);
  spendAction();
  render();
}

// ============== CARD MODAL ==============
function showCardModal(card, ctx, player) {
  const backdrop = document.getElementById("modalBackdrop");
  const imgWrap = document.getElementById("modalImgWrap");
  let img;
  if (card.kind === "guest") {
    const variants = GAME_DATA.guestImagesByType[card.id];
    const type = (ctx && ctx.guestTypeArt) || "cat";
    img = variants && (variants[type] || variants.cat || variants.elf || variants.giant);
  } else {
    img = GAME_DATA.eventImages[card.id];
  }
  // The card art itself already shows the name and effect text, so the
  // modal doesn't repeat them — just the (enlarged) card and a Continue button.
  imgWrap.innerHTML = img ? `<img src="${img}" alt="${card.name}" style="width:480px;height:672px;max-width:90vw;max-height:60vh;object-fit:contain;">` : "";
  document.getElementById("modalTitle").textContent = "";
  document.getElementById("modalEffect").textContent = "";
  const body = document.getElementById("modalBody");
  body.innerHTML = isBot(player)
    ? `<p style="font-style:italic">AI is resolving this...</p>`
    : `<button class="continue-btn" onclick="closeModalAndResolve()">Continue</button>`;
  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  document.getElementById("modalBox").classList.add("modal-transparent");
  backdrop.style.display = "flex";
  window.__pendingCardResolve = { card, ctx, player };
}

function closeModalAndResolve() {
  document.getElementById("modalBackdrop").style.display = "none";
  const { card, ctx, player } = window.__pendingCardResolve;
  window.__pendingCardResolve = null;
  resolveCardEffect(card, ctx, player);
  render();
  if (player.pendingChoice && !isBot(player)) {
    showChoiceModal(player);
  }
}

function showChoiceModal(p) {
  const choice = p.pendingChoice;
  window.__activeChoicePlayer = p;
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = "";
  document.getElementById("modalTitle").textContent = choice.cardName;
  document.getElementById("modalEffect").textContent = choice.instructions;
  document.getElementById("modalBody").innerHTML = renderChoiceBody(choice, p);
  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  backdrop.style.display = "flex";
}

function renderChoiceBody(choice, p) {
  switch (choice.type) {
    case "MONEY_FOR_POINTS":
      return `<div class="row-btns"><button onclick="resolveChoice({accept:true})">Yes, $5 \u2192 2 pts</button><button onclick="resolveChoice({accept:false})">No thanks</button></div>`;
    case "FREE_COOK_SET":
      return `<div class="row-btns"><button onclick="resolveChoice({accept:true})">Cook free set</button><button onclick="resolveChoice({accept:false})">Skip</button></div>`;
    case "EXTRA_OR_LOSE_ACTION":
      return `<div class="row-btns"><button onclick="resolveChoice({choice:'extra'})">Pay $6 \u2192 +1 action</button><button onclick="resolveChoice({choice:'lose'})">-1 action \u2192 $6</button></div>`;
    case "LEVEL_UP_DISH":
      return choice.options.map((rid) => `<button onclick="resolveChoice({recipeId:'${rid}'})">${recipeDef(rid).name}</button>`).join("");
    case "HALF_PRICE_ELF_RECIPE":
      return choice.options.map((rid) => {
        const d = recipeDef(rid);
        return `<button onclick="resolveChoice({recipeId:'${rid}'})">${d.name} ($${Math.ceil(d.developCost / 2)})</button>`;
      }).join("");
    case "SELL_RECIPES":
      if (p.recipes.length === 0) return `<button onclick="resolveChoice({recipeIds:[]})">No recipes to sell</button>`;
      return p.recipes.map((r) => {
        const d = recipeDef(r.recipeId);
        return `<button onclick="resolveChoice({recipeIds:['${r.recipeId}']})">Sell ${d.name} ($${d.developCost})</button>`;
      }).join("") + `<button onclick="resolveChoice({recipeIds:[]})">Sell nothing</button>`;
    case "EXCHANGE_INGREDIENTS": {
      const opts = INGREDIENT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("");
      return `
        <div>From: <select id="exFrom">${opts}</select> To: <select id="exTo">${opts}</select></div>
        <button onclick="resolveExchange()">Exchange 1</button>
        <button onclick="resolveChoice({from:[],to:'wheat'})">Skip</button>`;
    }
    case "OPEN_BRANCH_HALF_PRICE":
      return choice.options.map((id) => {
        const desc = Object.entries(state.villages[id]).map(([k, v]) => `${v} ${k}`).join(", ");
        return `<button onclick="resolveChoice({nodeId:'${id}'})">${desc} ($10)</button>`;
      }).join("") + `<button onclick="resolveChoice({nodeId:null})">Skip</button>`;
    case "REPLACE_RECIPE":
      return choice.options.map((rid) => {
        const d = recipeDef(rid);
        const owned = p.recipes.find((r) => r.recipeId === rid);
        return `<button onclick="resolveChoice({recipeId:'${rid}'})">Replace ${d.name} (${owned.stars}\u2605, $${d.dishPrice})</button>`;
      }).join("");
    default:
      return `<button onclick="resolveChoice({})">OK</button>`;
  }
}

function resolveExchange() {
  const from = document.getElementById("exFrom").value;
  const to = document.getElementById("exTo").value;
  resolveChoice({ from: [{ type: from, amount: 1 }], to });
}

// playerOverride lets the bot resolve its own choice without touching the
// (hidden) modal DOM state.
function resolveChoice(params, playerOverride) {
  const p = playerOverride || window.__activeChoicePlayer;
  const choice = p && p.pendingChoice;
  if (!choice) return;

  switch (choice.type) {
    case "EXCHANGE_INGREDIENTS": {
      const { from, to } = params;
      if (from && from.length && (p.ingredients[from[0].type] || 0) >= from[0].amount) {
        p.ingredients[from[0].type] -= from[0].amount;
        gainIngredient(p, to, from[0].amount);
        logMsg(`${p.name} exchanged 1 ${from[0].type} for ${to} via Merchant`);
      }
      break;
    }
    case "OPEN_BRANCH_HALF_PRICE": {
      const nodeId = params.nodeId;
      if (nodeId && p.money >= 10 && !p.branches.includes(nodeId) && state.branchOwners[nodeId].length === 0) {
        p.money -= 10;
        p.branches.push(nodeId);
        state.branchOwners[nodeId].push(p.id);
        addVillageCapacityToRemaining(p, nodeId);
        logMsg(`${p.name} opened a branch at half price ($10) via Investor`);
      } else {
        logMsg(`${p.name} skipped Investor's offer`);
      }
      break;
    }
    case "SELL_RECIPES": {
      let total = 0;
      for (const rid of params.recipeIds) {
        const idx = p.recipes.findIndex((r) => r.recipeId === rid);
        if (idx === -1) continue;
        total += recipeDef(rid).developCost;
        p.recipes.splice(idx, 1);
      }
      p.money += total;
      if (total > 0) logMsg(`${p.name} sold recipe(s) for $${total} via Bard`);
      break;
    }
    case "LEVEL_UP_DISH": {
      const pr = p.recipes.find((r) => r.recipeId === params.recipeId);
      const def = recipeDef(params.recipeId);
      const cap = def.maxStars * 3;
      pr.level = Math.min(cap, pr.level + 3);
      pr.stars = Math.floor(pr.level / 3);
      logMsg(`${p.name}'s ${def.name} leveled up to ${pr.level} via Master`);
      break;
    }
    case "FREE_COOK_SET":
      if (params.accept) {
        const qDef = recipeDef(choice.options.qualifyingDish);
        const sDef = recipeDef(choice.options.sideDish);
        const earnings = qDef.dishPrice + sDef.dishPrice;
        p.money += earnings;
        p.guestsServedTotal += 2;
        p.points += 2;
        logMsg(`${p.name} cooked a free set (${qDef.name} + ${sDef.name}) via Noble, earned $${earnings}`);
      }
      break;
    case "MONEY_FOR_POINTS":
      if (params.accept && p.money >= 5) {
        p.money -= 5;
        p.points += 2;
        logMsg(`${p.name} exchanged $5 for 2 points via Scholar`);
      }
      break;
    case "EXTRA_OR_LOSE_ACTION": {
      const turnStillActive = currentPlayer().id === p.id;
      if (params.choice === "extra" && p.money >= 6) {
        p.money -= 6;
        if (turnStillActive) state.actionsLeft += 1;
        logMsg(`${p.name} paid $6 for an extra action via Part-time worker`);
      } else if (params.choice === "lose") {
        if (turnStillActive) state.actionsLeft = Math.max(0, state.actionsLeft - 1);
        p.money += 6;
        logMsg(`${p.name} gave up an action for $6 via Part-time worker`);
      }
      break;
    }
    case "HALF_PRICE_ELF_RECIPE": {
      const def = recipeDef(params.recipeId);
      const price = Math.ceil(def.developCost / 2);
      if (p.money >= price && p.recipes.length < 5) {
        p.money -= price;
        p.recipes.push({ recipeId: params.recipeId, level: 0, stars: 0 });
        logMsg(`${p.name} got ${def.name} for $${price} via Monk`);
      }
      break;
    }
    case "REPLACE_RECIPE": {
      const oldIdx = p.recipes.findIndex((r) => r.recipeId === params.recipeId);
      const newDef = recipeDef(choice.newRecipeId);
      if (oldIdx !== -1 && p.money >= newDef.developCost) {
        state.recipeDiscard.push(p.recipes[oldIdx].recipeId);
        p.recipes.splice(oldIdx, 1);
        p.money -= newDef.developCost;
        p.recipes.push({ recipeId: choice.newRecipeId, level: 0, stars: 0 });
        const slotIdx = state.menu.indexOf(choice.newRecipeId);
        if (slotIdx !== -1) state.menu.splice(slotIdx, 1);
        if (recipesAvailable()) state.menu.push(drawRecipe());
        state.anyRecipeDevelopedThisRound = true;
        logMsg(`${p.name} replaced ${recipeDef(params.recipeId).name} with ${newDef.name} for $${newDef.developCost}`);
      }
      spendAction();
      break;
    }
  }

  p.pendingChoice = null;
  window.__activeChoicePlayer = null;
  document.getElementById("modalBackdrop").style.display = "none";
  render();
}

// ============== GUEST EFFECTS ==============
function gainOne(p, type) { gainIngredient(p, type, 1); logMsg(`${p.name} gained 1 ${type} from a guest`); }

function grantFreeRecipe(p, recipeId, cardName) {
  if (p.recipes.some((r) => r.recipeId === recipeId) || p.recipes.length >= 5) {
    logMsg(`${cardName}'s gift is wasted (already owned or max recipes)`);
    return;
  }
  p.recipes.push({ recipeId, level: 0, stars: 0 });
  logMsg(`${p.name} got a free recipe from ${cardName}`);
}

const GUEST_HANDLERS = {
  "Satisfied guest": (p) => { p.turnFlags.tipMultiplier = 2; logMsg(`${p.name}'s tips are doubled for the rest of this turn`); },
  "Unsatisfied guest": (p) => { p.turnFlags.tipsVoided = true; logMsg(`${p.name} loses tips for the rest of this turn`); },
  Farmer: (p) => gainOne(p, "wheat"),
  Gardener: (p) => gainOne(p, "vegetable"),
  Hunter: (p) => gainOne(p, "meat"),
  Orcharder: (p) => gainOne(p, "fruit"),
  Fisher: (p) => gainOne(p, "fish"),
  Merchant: (p) => { p.pendingChoice = { cardName: "Merchant", type: "EXCHANGE_INGREDIENTS", instructions: "Exchange 1 ingredient for another type." }; },
  Silversmith: (p) => {
    if (p.spoon === "silver" || p.spoon === "golden") { logMsg(`${p.name} already has silver+ spoon`); return; }
    const half = Math.ceil(SPOON_PRICES.silver / 2);
    if (p.money >= half) { p.money -= half; p.spoon = "silver"; logMsg(`${p.name} bought a silver spoon from the Silversmith for $${half}`); }
    else logMsg(`${p.name} can't afford the Silversmith's offer`);
  },
  Glutton: (p, ctx) => {
    if (!ctx.recipeId) return;
    const def = recipeDef(ctx.recipeId);
    if (!canAfford(p.ingredients, def.cookCost)) { logMsg(`${p.name} can't afford to serve the Glutton another ${def.name}`); return; }
    payIngredients(p.ingredients, def.cookCost);
    const earnings = def.dishPrice * 2;
    p.money += earnings; p.points += 1; p.guestsServedTotal += 1;
    logMsg(`${p.name} served the Glutton another ${def.name} for $${earnings}`);
  },
  Mafia: (p) => { p.mafiaOfferQueued = true; logMsg(`${p.name} may serve the Mafia a Fantasy Banquet on their next turn at 3x price`); },
  Investor: (p) => {
    const hasSpecialty = p.recipes.some(isSpecialty);
    const options = eligibleBranchSlots(p);
    if (hasSpecialty && options.length > 0) {
      p.pendingChoice = { cardName: "Investor", type: "OPEN_BRANCH_HALF_PRICE", instructions: "Open a branch at any explored village for $10 (half price)?", options };
    } else {
      logMsg(`${p.name} doesn't qualify for the Investor's offer (needs a specialty dish and an open, explored village)`);
    }
  },
  Nutritionist: (p) => {
    if (!recipesAvailable()) { logMsg("Nutritionist has no recipes left"); return; }
    if (p.recipes.length >= 5) { logMsg(`${p.name} already has max recipes`); return; }
    const rid = drawRecipe();
    p.recipes.push({ recipeId: rid, level: 0, stars: 0 });
    logMsg(`${p.name} got a free recipe from the Nutritionist`);
  },
  Painter: (p) => { addRenovation(p, 1); logMsg(`Painter renovated ${p.name}'s restaurant (level ${p.renovationLevel})`); },
  Reporter: (p) => { p.pendingVloggerBonus = true; logMsg(`${p.name} may serve 1 extra guest next turn`); },
  Drunk: (p) => { p.renovationLevel = Math.max(0, p.renovationLevel - 1); logMsg(`Drunk lowered ${p.name}'s renovation level to ${p.renovationLevel}`); },
  "Fortune teller": (p) => { const roll = rollDie(); p.savedDieRoll = roll; logMsg(`${p.name} banked a die roll of ${roll} to use later`); },
  Bard: (p) => { p.pendingChoice = { cardName: "Bard", type: "SELL_RECIPES", instructions: "Sell any of your recipes for their full develop price?" }; },
  Master: (p) => {
    const eligible = p.recipes.filter((r) => r.level < recipeDef(r.recipeId).maxStars * 3);
    if (eligible.length === 0) logMsg(`${p.name} has no dish that can level up further`);
    else if (eligible.length === 1) {
      const def = recipeDef(eligible[0].recipeId);
      const cap = def.maxStars * 3;
      eligible[0].level = Math.min(cap, eligible[0].level + 3);
      eligible[0].stars = Math.floor(eligible[0].level / 3);
      logMsg(`Master boosted ${p.name}'s ${def.name} to level ${eligible[0].level}`);
    } else {
      p.pendingChoice = { cardName: "Master", type: "LEVEL_UP_DISH", instructions: "Choose a dish to increase its level by 3.", options: eligible.map((r) => r.recipeId) };
    }
  },
  Noble: (p) => {
    const sideDish = p.recipes.find((r) => recipeDef(r.recipeId).sideDish);
    const qualifying = p.recipes.find((r) => r.stars >= 2);
    if (sideDish && qualifying) {
      p.pendingChoice = {
        cardName: "Noble",
        type: "FREE_COOK_SET",
        instructions: `Cook ${recipeDef(qualifying.recipeId).name} together with ${recipeDef(sideDish.recipeId).name} for free (no ingredients, but you still earn both dishes' price)?`,
        options: { qualifyingDish: qualifying.recipeId, sideDish: sideDish.recipeId },
      };
    } else logMsg(`${p.name} doesn't qualify for the Noble's offer`);
  },
  Scholar: (p) => { if (p.money >= 5) p.pendingChoice = { cardName: "Scholar", type: "MONEY_FOR_POINTS", instructions: "Exchange $5 for 2 points?" }; },
  "Part-time worker": (p) => { p.pendingChoice = { cardName: "Part-time worker", type: "EXTRA_OR_LOSE_ACTION", instructions: "Pay $6 for an extra action, or lose an action for $6?" }; },
  "Wine seller": (p) => grantFreeRecipe(p, "r27", "Wine seller"),
  "Whisky seller": (p) => grantFreeRecipe(p, "r28", "Whisky seller"),
  Monk: (p) => {
    const onlyVeg = p.recipes.every((r) => { const d = recipeDef(r.recipeId); return !d.cookCost.meat && !d.cookCost.fish; });
    if (onlyVeg) {
      const elfRecipes = GAME_DATA.recipes.filter((r) => r.guestType === "elf");
      p.pendingChoice = { cardName: "Monk", type: "HALF_PRICE_ELF_RECIPE", instructions: "Choose any elf recipe at half price.", options: elfRecipes.map((r) => r.id) };
    } else logMsg(`${p.name} isn't vegetarian-only, Monk's offer doesn't apply`);
  },
  Adventurer: (p) => {
    const options = emptyNeighbors(p.position);
    if (options.length === 0 || state.villageDeck.length === 0) {
      logMsg(`${p.name}'s Adventurer has nowhere left to explore nearby`);
      return;
    }
    const target = options[Math.floor(Math.random() * options.length)];
    const population = state.villageDeck.shift();
    state.villages[target] = population;
    p.position = target;
    if (state.branchOwners[target].length === 0) {
      p.branches.push(target);
      state.branchOwners[target].push(p.id);
      addVillageCapacityToRemaining(p, target);
      logMsg(`Adventurer helped ${p.name} explore and open a free branch at a new village`);
    } else {
      logMsg(`Adventurer helped ${p.name} explore to a new village, but it already has a branch`);
    }
  },
};

// ============== EVENT EFFECTS ==============
const EVENT_HANDLERS = {
  "Monster attack": () => {
    for (const p of state.players) {
      const roll = rollDie();
      if (roll > 0) { p.points += 3; logMsg(`Monster attack: ${p.name} rolled ${roll}, gained 3 points`); }
      else { p.renovationLevel = Math.max(0, p.renovationLevel - 1); logMsg(`Monster attack: ${p.name} rolled 0, renovation down to ${p.renovationLevel}`); }
    }
  },
  // Now an event: rates EVERY player's restaurant, not just whoever drew it.
  // Anyone with 3+ specialty dishes ends the game outright; the rest bank
  // bonus points equal to their specialty count.
  "Michelin inspector": () => {
    let winner = null;
    for (const p of state.players) {
      const count = p.recipes.filter(isSpecialty).length;
      if (count >= 3 && !winner) {
        winner = p;
      } else if (count > 0) {
        p.points += count;
        logMsg(`${p.name}'s restaurant earns ${count} Michelin point(s) (needs 3 specialty dishes for a full rating)`);
      } else {
        logMsg(`${p.name} has no specialty dishes for the Michelin Inspector to rate`);
      }
    }
    if (winner) {
      logMsg(`${winner.name}'s restaurant is rated 3-star Michelin!`);
      endGame(`${winner.name} earned a 3-star Michelin rating`);
    }
  },
  "Stray cat": (p) => {
    if (p.ingredients.fish > 0) { p.ingredients.fish -= 1; p.points += 1; logMsg(`${p.name} gave the Stray cat a fish and gained 1 point`); }
    else logMsg(`${p.name} has no fish to give the Stray cat`);
  },
  Fundraising: (p) => {
    const other = otherPlayerOf(p);
    const amount = Math.min(30, Math.floor(p.money / 10));
    if (amount > 0) { p.money -= amount; other.money += amount; logMsg(`Fundraising: ${p.name} gave $${amount} to ${other.name}`); }
  },
  Festival: () => { for (const p of state.players) p.nextTurnActionDelta += 1; logMsg("Festival: everyone gains 1 action on their next turn"); },
  Vacation: () => { for (const p of state.players) p.nextTurnActionDelta -= 1; logMsg("Vacation: everyone loses 1 action on their next turn"); },
  "Heat wave": () => {
    for (const p of state.players) {
      const entries = Object.entries(p.ingredients).filter(([, v]) => v > 0);
      if (!entries.length) continue;
      entries.sort((a, b) => b[1] - a[1]);
      p.ingredients[entries[0][0]] -= 1;
      logMsg(`Heat wave: ${p.name} lost 1 ${entries[0][0]}`);
    }
  },
  Flood: () => {
    for (const p of state.players) {
      let lost = 0;
      for (const t of INGREDIENT_TYPES) if (p.ingredients[t] > 0) { p.ingredients[t] -= 1; lost += 1; }
      if (lost > 0) { p.ingredients.fish += lost; logMsg(`Flood: ${p.name} lost ${lost} ingredient(s), gained ${lost} fish`); }
    }
  },
  "Hygiene rating": (p) => {
    const diff = p.recipes.length - p.renovationLevel;
    if (diff > 0) {
      const penalty = 3 * diff;
      p.money = Math.max(0, p.money - penalty);
      p.nextTurnActionDelta -= 1;
      logMsg(`Hygiene rating: ${p.name} lost $${penalty} and 1 next-turn action`);
    }
  },
  Harvest: () => { for (const p of state.players) { gainIngredient(p, "wheat", 2); gainIngredient(p, "vegetable", 2); p.ingredients.fruit += 2; } logMsg("Harvest: everyone gains 2 wheat, 2 vegetable, 2 fruit"); },
  "Rent collection": (p) => {
    if (p.branches.length > 0) {
      const amount = p.branches.length * 10;
      p.money += amount;
      logMsg(`Rent collection: ${p.name} earned $${amount} from ${p.branches.length} branch(es)`);
    } else {
      logMsg(`${p.name} has no branches yet — Rent collection has no effect`);
    }
  },
  "Cooking contest": () => {
    const proficiency = (p) => Math.max(0, ...p.recipes.filter(isSpecialty).map((r) => r.stars), 0);
    const scores = state.players.map((p) => ({ p, score: proficiency(p) }));
    const maxScore = Math.max(...scores.map((s) => s.score));
    if (maxScore === 0) { logMsg("Cooking contest: nobody has a specialty dish yet"); return; }
    const winners = scores.filter((s) => s.score === maxScore);
    const share = Math.floor(50 / winners.length);
    for (const w of winners) { w.p.money += share; w.p.pendingVloggerBonus = true; logMsg(`Cooking contest: ${w.p.name} wins $${share} and a Vlogger next turn`); }
  },
  "Cold wave": () => { state.coldWaveUntilRound = state.round + 1; state.skipNextIngredientDecay = true; logMsg("Cold wave: hunting/fishing/fruit-picking blocked next round, ingredients won't rot"); },
  "Flee market": (p) => {
    const next = otherPlayerOf(p);
    const entries = Object.entries(next.ingredients).filter(([, v]) => v > 0);
    if (entries.length) {
      entries.sort((a, b) => b[1] - a[1]);
      next.ingredients[entries[0][0]] -= 1;
      gainIngredient(p, entries[0][0], 1);
      logMsg(`Flee market: ${p.name} took 1 ${entries[0][0]} from ${next.name}`);
    } else { gainIngredient(p, "wheat", 1); logMsg(`Flee market: ${p.name} took 1 wheat from the bank`); }
  },
};

function resolveCardEffect(card, ctx, player) {
  const handler = card.kind === "guest" ? GUEST_HANDLERS[card.name] : EVENT_HANDLERS[card.name];
  if (!handler) { logMsg(`(${card.name} effect not implemented in this demo)`); return; }
  handler(player, ctx);
}

// ============== AI OPPONENT ==============
function maybeStartBotTurn() {
  if (!state.gameOver && isBot(currentPlayer()) && !botRunning && document.getElementById("modalBackdrop").style.display !== "flex") {
    runBotTurn();
  }
}

async function runBotTurn() {
  botRunning = true;
  setThinking(true);

  let guard = 0;
  while (!state.gameOver && isBot(currentPlayer()) && state.actionsLeft > 0 && guard < 15) {
    guard++;
    await sleep(600);
    await performOneBotAction();
  }

  guard = 0;
  while (!state.gameOver && isBot(currentPlayer()) && guard < 20) {
    guard++;
    const cooked = await performBotCooking();
    if (!cooked) break;
    await sleep(500);
  }

  if (!state.gameOver && isBot(currentPlayer())) {
    await sleep(400);
    actionDone();
  }

  setThinking(false);
  botRunning = false;
}

function setThinking(on) {
  const el = document.getElementById("aiThinking");
  if (el) el.style.display = on ? "inline" : "none";
}

// Phase 1: the 3 prep actions (everything except cooking). Growing guest
// capacity (branches) is prioritized early since capacity gates the whole
// cooking phase that follows.
async function performOneBotAction() {
  const p = currentPlayer();

  if (p.branches.length < 4) {
    const branchOptions = eligibleBranchSlots(p);
    if (branchOptions.length > 0 && p.money >= 20) {
      branchOptions.sort((a, b) => sumVillage(state.villages[b]) - sumVillage(state.villages[a]));
      confirmOpenBranch(branchOptions[0]);
      return;
    }
    if (emptyNeighbors(p.position).length > 0 && state.villageDeck.length > 0) {
      actionExplore();
      return;
    }
  }

  {
    const options = state.menu.filter((rid) => !p.recipes.some((r) => r.recipeId === rid) && p.money >= recipeDef(rid).developCost);
    if (options.length > 0 && p.recipes.length < 5) {
      options.sort((a, b) => recipeDef(b).dishPrice - recipeDef(a).dishPrice);
      actionDevelop(state.menu.indexOf(options[0]));
      return;
    }
  }

  const deficits = {};
  for (const t of INGREDIENT_TYPES) deficits[t] = 0;
  for (const r of p.recipes) {
    for (const [t, v] of Object.entries(recipeDef(r.recipeId).cookCost)) {
      const short = v - (p.ingredients[t] || 0);
      if (short > 0) deficits[t] += short;
    }
  }
  const coldwave = state.round <= state.coldWaveUntilRound;
  const needed = Object.entries(deficits).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (needed.length > 0) {
    const [type] = needed[0];
    if (type === "meat" && !coldwave) { actionHunt(); return; }
    if (type === "fish" && !coldwave && SPOON_RANK[p.spoon] > 0) { actionFish(); return; }
    if (type === "fruit" && !coldwave && SPOON_RANK[p.spoon] > 0) { actionPickFruit(); return; }
    if (type === "vegetable" || type === "wheat") {
      const atCap = p.ingredients[type] >= storageCap(p, type);
      if (!atCap) { actionCultivate(type); return; }
      if (type === "wheat" && p.wheatExpansions < MAX_EXPANSIONS && p.wheatStorage < MAX_STORAGE && p.money >= WHEAT_EXPANSION_COST) { actionExpandWheatFarm(); return; }
      if (type === "vegetable" && p.vegetableExpansions < MAX_EXPANSIONS && p.vegetableStorage < MAX_STORAGE && p.money >= VEGETABLE_EXPANSION_COST) { actionExpandVegetableGarden(); return; }
      // storage capped and can't afford to expand — fall through to other priorities
    }
  }

  const nextTier = p.spoon === "none" ? "wooden" : p.spoon === "wooden" ? "silver" : p.spoon === "silver" ? "golden" : null;
  if (nextTier && p.money >= SPOON_PRICES[nextTier] + 10) { actionBuySpoon(nextTier); return; }

  if (p.money >= 10 && p.renovationLevel < 3) { actionRenovate(); return; }

  actionPartTimeJob();
}

// Phase 2: cook repeatedly until guest capacity or ingredients run out.
function bestCookableRecipe(p) {
  const options = p.recipes.filter((r) => {
    const def = recipeDef(r.recipeId);
    if (!canAfford(p.ingredients, def.cookCost)) return false;
    if (def.guestType === "star") {
      return p.guestCapacityRemaining.cat > 0 || p.guestCapacityRemaining.giant > 0 || p.guestCapacityRemaining.elf > 0;
    }
    return p.guestCapacityRemaining[def.guestType] > 0;
  });
  if (options.length === 0) return null;
  options.sort((a, b) => {
    const da = recipeDef(a.recipeId), db = recipeDef(b.recipeId);
    return (db.dishPrice + b.stars) - (da.dishPrice + a.stars);
  });
  return options[0].recipeId;
}

async function performBotCooking() {
  const p = currentPlayer();

  if (p.pendingMafiaOffer) {
    const fb = p.recipes.find((r) => r.recipeId === "r29");
    const anyCapacity = p.guestCapacityRemaining.cat > 0 || p.guestCapacityRemaining.giant > 0 || p.guestCapacityRemaining.elf > 0;
    if (fb && anyCapacity && canAfford(p.ingredients, recipeDef("r29").cookCost)) {
      await botCook("r29", true);
      return true;
    }
  }

  const best = bestCookableRecipe(p);
  if (best) {
    await botCook(best, false);
    return true;
  }
  return false;
}

async function botCook(recipeId, mafiaOffer) {
  const p = currentPlayer();
  const result = performCookCore(p, recipeId, mafiaOffer);
  if (!result) return;
  showCardModal(result.card, result.ctx, p);
  await sleep(1100);
  closeModalAndResolve();
  if (p.pendingChoice) {
    await sleep(900);
    autoResolveBotChoice(p);
  }
}

function autoResolveBotChoice(p) {
  const choice = p.pendingChoice;
  if (!choice) return;
  let params = {};
  switch (choice.type) {
    case "MONEY_FOR_POINTS": params = { accept: p.money >= 10 }; break;
    case "FREE_COOK_SET": params = { accept: true }; break;
    case "EXTRA_OR_LOSE_ACTION": params = { choice: p.money >= 20 ? "extra" : "lose" }; break;
    case "LEVEL_UP_DISH": params = { recipeId: choice.options[0] }; break;
    case "HALF_PRICE_ELF_RECIPE": {
      const affordable = choice.options.filter((rid) => p.money >= Math.ceil(recipeDef(rid).developCost / 2));
      params = { recipeId: affordable[0] || choice.options[0] };
      break;
    }
    case "SELL_RECIPES": params = { recipeIds: [] }; break;
    case "EXCHANGE_INGREDIENTS": params = { from: [], to: "wheat" }; break;
    case "OPEN_BRANCH_HALF_PRICE": {
      const opts = [...choice.options].sort((a, b) => sumVillage(state.villages[b]) - sumVillage(state.villages[a]));
      params = { nodeId: p.money >= 10 ? opts[0] : null };
      break;
    }
    default: params = {};
  }
  resolveChoice(params, p);
}

// ============== RENDERING ==============
function formatCost(cost) { return Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(", "); }

function renderPlayerCard(p, i, cookSectionHtml) {
  const ing = INGREDIENT_TYPES.map((t) => {
    const cap = storageCap(p, t);
    const maxSuffix = cap < Infinity ? ` (Max:${cap})` : "";
    const icon = GAME_DATA.ingredientImages[t];
    const iconHtml = icon ? `<img class="ing-icon" src="${icon}" alt="${t}" title="${t}">` : `${t} `;
    return `<span class="pill">${iconHtml}${p.ingredients[t]}${maxSuffix}</span>`;
  }).join("");

  const isCurrent = i === state.turnIndex;
  const canRenovate = isCurrent && !isBot(p) && !state.gameOver && state.actionsLeft > 0;
  const restaurantImg = GAME_DATA.restaurantImages[Math.min(10, p.renovationLevel)];

  const recipeCards = p.recipes.map((r) => renderOwnedRecipe(r, p, i)).join("");
  const emptySlots = Array.from({ length: Math.max(0, 5 - p.recipes.length) })
    .map(() => `<div class="recipe-card empty-slot">empty</div>`).join("");

  const renoRow = Array.from({ length: 10 }, (_, idx) => {
    const level = idx + 1;
    const tip = renovationTipBonus(level);
    const prevTip = renovationTipBonus(level - 1);
    const showTip = tip > prevTip;
    const done = p.renovationLevel >= level;
    const isNext = isCurrent && !done && p.renovationLevel === level - 1;
    const cls = done ? "done" : isNext ? "current" : "";
    const onclick = isNext && canRenovate ? `onclick="actionRenovate()"` : "";
    return `<div class="reno-pill ${cls}" ${onclick} style="${isNext && canRenovate ? "cursor:pointer;" : ""}">Lv${level}${showTip ? `<br>+$${tip} tip` : ""}</div>`;
  }).join("");

  return `
    <div class="player${isCurrent ? " active" : ""}">
      <div class="player-topsection">
        <div class="player-header-row">
          <div class="stat-row" style="margin:0;">${ing}</div>
          <div class="player-name">${p.name}</div>
          <div class="player-money">$${p.money}</div>
        </div>
        <div class="recipes-owned">${recipeCards}${emptySlots}</div>
        ${cookSectionHtml || ""}
      </div>
      <div class="restaurant-view" style="background-image:url(${restaurantImg});">
        <div class="restaurant-badges">
          <span class="pill status-pill">${p.spoon} spoon</span>
          <span class="pill status-pill">${p.hasFridge ? "Fridge" : "No Fridge"}</span>
        </div>
        <div class="renovation-overlay">
          <div style="font-size:11px;margin-bottom:4px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.6);">Renovation level (tap the highlighted one to renovate)</div>
          <div class="renovation-row">${renoRow}</div>
        </div>
      </div>
    </div>`;
}

const MAP_ACTION_BUTTONS = [
  { x: 12, y: 8, label: "Go hunting", sub: "success \u00d7 spoon tier", fn: "actionHunt()", gate: "canAct" },
  { x: 45, y: 6, label: "Explore", sub: "Reveal a village", fn: "actionExplore()", gate: "canExplore" },
  { x: 64, y: 6, label: "Open branch", sub: "$20", fn: "actionOpenBranch()", gate: "canOpenBranch" },
  { x: 88, y: 18, label: "Go fishing", sub: "# of dice = spoon tier", fn: "actionFish()", gate: "canAct" },
  { x: 6, y: 32, label: "Shop", sub: "", fn: "showShopModal()", gate: "canShop" },
  { x: 6, y: 60, label: "Part-time job", sub: "+$4", fn: "actionPartTimeJob()", gate: "canAct" },
  { x: 90, y: 45, label: "Fruit picking", sub: "2 \u00d7 spoon tier", fn: "actionPickFruit()", gate: "canAct" },
  { x: 26, y: 78, label: "Cultivate veggie", sub: "+1 veggie", fn: "actionCultivate('vegetable')", gate: "canAct" },
  { x: 26, y: 90, label: "Upgrade garden", sub: "veggie storage +4", fn: "actionExpandVegetableGarden()", gate: "canExpandVeg" },
  { x: 58, y: 78, label: "Cultivate wheat", sub: "+1 wheat", fn: "actionCultivate('wheat')", gate: "canAct" },
  { x: 58, y: 90, label: "Upgrade farm", sub: "wheat storage +4", fn: "actionExpandWheatFarm()", gate: "canExpandWheat" },
];

function renderMap(gates) {
  const p1 = state.players[0], p2 = state.players[1];
  let html = `<img src="${GAME_DATA.mapBg}" alt="Village map" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">`;

  for (const node of MAP_NODES) {
    const village = state.villages[node.id];
    const isStart = node.id === "start";
    if (!isStart && !village) continue; // only show badges for revealed villages
    const pop = isStart ? START_VILLAGE : village;
    const label = Object.entries(pop).map(([k, v]) => {
      const icon = GAME_DATA.guestTypeImages[k];
      const iconHtml = icon ? `<img src="${icon}" alt="${k}" style="width:13px;height:13px;object-fit:contain;vertical-align:-2px;">` : k[0].toUpperCase();
      return `${iconHtml}${v}`;
    }).join(" ");
    const badgeLabel = (isStart ? "Start " : "") + label;
    html += `<div style="position:absolute;left:${node.x}%;top:${node.y}%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.92);border-radius:8px;padding:3px 7px;font-size:10px;font-weight:600;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.2);">${badgeLabel}</div>`;

    const owners = state.branchOwners[node.id] || [];
    owners.forEach((pid, idx) => {
      const color = pid === "p1" ? "#c1502e" : "#4a7c59";
      html += `<div class="map-pin" style="left:${node.x}%;top:calc(${node.y}% - 16px - ${idx * 20}px);background:${color};">${pid === "p1" ? "P1" : "P2"}</div>`;
    });
  }

  for (const btn of MAP_ACTION_BUTTONS) {
    const enabled = gates[btn.gate];
    html += `<button class="map-btn" style="left:${btn.x}%;top:${btn.y}%;" ${enabled ? "" : "disabled"} onclick="${btn.fn}">${btn.label}${btn.sub ? `<small>${btn.sub}</small>` : ""}</button>`;
  }

  return html;
}

function render() {
  document.getElementById("roundNum").textContent = state.round;
  document.getElementById("turnPlayer").textContent = currentPlayer().name;
  document.getElementById("actionsLeft").textContent = state.actionsLeft;

  const winBanner = document.getElementById("winBanner");
  if (state.gameOver && state.finalScores) {
    winBanner.style.display = "block";
    if (state.winnerId) {
      const winner = state.finalScores.find((s) => s.player.id === state.winnerId);
      winBanner.textContent = `${winner.player.name} wins with ${winner.score.total} final points! (${state.winReason})`;
    } else {
      winBanner.textContent = `It's a tie at ${state.finalScores[0].score.total} points! (${state.winReason})`;
    }
  } else winBanner.style.display = "none";

  const p = currentPlayer();
  const humansTurn = !isBot(p);
  const prepPhase = state.actionsLeft > 0;
  const canAct = !state.gameOver && prepPhase && humansTurn; // the 3 prep actions
  const canCook = !state.gameOver && !prepPhase && humansTurn; // cooking phase, gated by guest capacity instead

  const capIcon = (type) => {
    const icon = GAME_DATA.guestTypeImages[type];
    return icon ? `<img src="${icon}" alt="${type}" style="width:16px;height:16px;object-fit:contain;vertical-align:-3px;">` : type;
  };
  const cookInfoText = prepPhase
    ? `<em>Finish your 3 actions (${state.actionsLeft} left) to unlock cooking.</em>`
    : `Guest capacity remaining this turn:
      <span class="pill">${capIcon("cat")} ${p.guestCapacityRemaining.cat}</span>
      <span class="pill">${capIcon("giant")} ${p.guestCapacityRemaining.giant}</span>
      <span class="pill">${capIcon("elf")} ${p.guestCapacityRemaining.elf}</span>
      &mdash; cook from the recipes below. Common ("star") dishes serve a random available guest type.`;

  const offers = [];
  if (!state.gameOver && humansTurn && !prepPhase && p.pendingMafiaOffer) {
    const fb = p.recipes.find((r) => r.recipeId === "r29");
    if (fb) offers.push(`<button class="offer-btn" onclick="actionCook('r29', true)">Serve Mafia: Fantasy Banquet (3x price)</button>`);
  }

  const cookSectionHtml = `
    <div class="cook-section">
      <div class="cook-info">${cookInfoText}</div>
      <button class="end-turn-btn" ${!state.gameOver && humansTurn ? "" : "disabled"} onclick="actionDone()">End turn</button>
    </div>
    ${offers.length ? `<div class="actions-row" style="margin-bottom:10px;">${offers.join("")}</div>` : ""}`;

  const player1Panel = document.getElementById("player1Panel");
  player1Panel.innerHTML = renderPlayerCard(state.players[0], 0, cookSectionHtml);

  const menuRow = document.getElementById("menuRow");
  menuRow.innerHTML = "";
  state.menu.forEach((rid, idx) => {
    const def = recipeDef(rid);
    const img = GAME_DATA.recipeImagesByStar[rid][0];
    const owned = p.recipes.some((r) => r.recipeId === rid);
    const disabled = !canAct || owned || p.money < def.developCost;
    const guestIcon = GAME_DATA.guestTypeImages[def.guestType];
    const guestBadgeContent = guestIcon
      ? `<img src="${guestIcon}" alt="${def.guestType}" style="width:20px;height:20px;object-fit:contain;">`
      : "\u2605"; // "star" (common) dishes have no single-type icon
    const card = document.createElement("div");
    card.className = "recipe-market-card";
    card.innerHTML = `
      <img src="${img}" alt="${def.name}">
      <div class="guest-badge" title="${def.guestType === "star" ? "common (any guest)" : def.guestType}">${guestBadgeContent}</div>
      <div class="body">
        <div class="name">${def.name}</div>
        <div>$${def.developCost} to unlock</div>
        <button ${disabled ? "disabled" : ""} onclick="actionDevelop(${idx})">Develop</button>
      </div>`;
    menuRow.appendChild(card);
  });

  const canExpandWheat = canAct && p.wheatExpansions < MAX_EXPANSIONS && p.wheatStorage < MAX_STORAGE && p.money >= WHEAT_EXPANSION_COST;
  const canExpandVeg = canAct && p.vegetableExpansions < MAX_EXPANSIONS && p.vegetableStorage < MAX_STORAGE && p.money >= VEGETABLE_EXPANSION_COST;
  const canExplore = canAct && emptyNeighbors(p.position).length > 0 && state.villageDeck.length > 0;
  const canOpenBranch = canAct && eligibleBranchSlots(p).length > 0 && p.money >= 20;
  const canShop = canAct && (SPOON_RANK[p.spoon] < SPOON_RANK.golden || !p.hasFridge);
  document.getElementById("mapContainer").innerHTML = renderMap({ canAct, canExpandWheat, canExpandVeg, canExplore, canOpenBranch, canShop });

  document.getElementById("log").innerHTML = state.log.map((m) => `<div>${m}</div>`).join("");

  if (!botRunning) maybeStartBotTurn();

  if (state.gameOver && !state.gameEndDialogShown) {
    state.gameEndDialogShown = true;
    showGameEndDialog();
  }
}

function showGameEndDialog() {
  const backdrop = document.getElementById("modalBackdrop");
  document.getElementById("modalImgWrap").innerHTML = "";
  document.getElementById("modalTitle").textContent = "Game Over!";
  document.getElementById("modalEffect").textContent = state.winnerId
    ? `${state.finalScores.find((s) => s.player.id === state.winnerId).player.name} wins! (${state.winReason})`
    : `It's a tie! (${state.winReason})`;

  const body = document.getElementById("modalBody");
  body.innerHTML = state.finalScores.map(({ player, score }) => `
    <div style="text-align:left;border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;">
      <strong>${player.name} \u2014 ${score.total} points</strong>
      <div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.6;">
        Dishes (\u03a3 stars\u00b2 \u00d7 2): ${score.dishPoints} pts
        &mdash; ${player.recipes.map((r) => `${recipeDef(r.recipeId).name} ${r.stars}\u2605`).join(", ") || "none"}<br>
        Money: $${player.money} \u2192 ${score.moneyPoints} pts<br>
        Renovation: ${player.renovationLevel} \u00d7 1 = ${score.renovationPoints} pts<br>
        Branches: ${player.branches.length} \u00d7 4 = ${score.branchPoints} pts
      </div>
    </div>
  `).join("") + `<button onclick="document.getElementById('modalBackdrop').style.display='none'">Close</button>`;

  document.getElementById("modalBox").classList.remove("modal-wide");
  document.getElementById("modalBox").classList.remove("modal-transparent");
  backdrop.style.display = "flex";
}

function renderOwnedRecipe(r, p, playerIdx) {
  const def = recipeDef(r.recipeId);
  const isCurrent = playerIdx === state.turnIndex;
  const guestTypeAvailable = def.guestType === "star"
    ? p.guestCapacityRemaining.cat > 0 || p.guestCapacityRemaining.giant > 0 || p.guestCapacityRemaining.elf > 0
    : p.guestCapacityRemaining[def.guestType] > 0;
  const canCook = isCurrent && !isBot(p) && !state.gameOver && state.actionsLeft <= 0 && canAfford(p.ingredients, def.cookCost) && guestTypeAvailable;
  const tooltip = `Needs: ${formatCost(def.cookCost)} \u2014 Price: $${def.dishPrice} \u2014 Guest type: ${def.guestType === "star" ? "common (any)" : def.guestType}`;
  const starImages = GAME_DATA.recipeImagesByStar[r.recipeId];
  const img = (starImages && starImages[r.stars]) || (starImages && starImages[0]);
  const onclick = canCook ? `onclick="actionCook('${r.recipeId}')"` : "";
  return `
    <div class="recipe-card">
      <div class="recipe-thumb-wrap${canCook ? " cookable" : ""}" ${onclick} title="${tooltip}">
        <img class="recipe-thumb" src="${img}" alt="${def.name}" style="opacity:${canCook ? 1 : 0.5};">
        <span class="cook-label">Cook</span>
      </div>
      <div class="recipe-name-label">${def.name} (${r.stars}\u2605)</div>
    </div>`;
}

initGame();


