const vm = require('vm');
const fs = require('fs');

function makeEl() {
  const el = { innerHTML: '', textContent: '', style: {}, value: '', src: '', children: [] };
  el.appendChild = (child) => { el.children.push(child); };
  const classes = new Set();
  el.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  return el;
}
const elements = {};
const ids = ['boardImg','roundNum','turnPlayer','actionsLeft','winBanner','player1Panel','player2Panel',
  'mapContainer','menuRow','actionsRow','offersRow','cookInfo','doneRow','log',
  'modalBackdrop','modalBox','modalImgWrap','modalTitle','modalEffect','modalBody','aiThinking'];
for (const id of ids) elements[id] = makeEl();

const documentMock = {
  getElementById: (id) => elements[id] || makeEl(),
  createElement: () => makeEl(),
  documentElement: { style: { setProperty: () => {} } },
};

const sandbox = { document: documentMock, console, setTimeout, Math, Object, JSON, Array, window: {} };
sandbox.window = sandbox;
vm.createContext(sandbox);

const gameData = JSON.parse(fs.readFileSync('game_data.json', 'utf-8'));
sandbox.GAME_DATA = gameData;

const code = fs.readFileSync('game.js', 'utf-8');
vm.runInContext(code, sandbox, { filename: 'game.js' });
vm.runInContext('this.getState = () => state; this.getBotRunning = () => botRunning;', sandbox);

console.log('=== Initial state ===');
const st0 = sandbox.getState();
console.log('P1 branches:', st0.players[0].branches, 'position:', st0.players[0].position);

module.exports = { sandbox };
