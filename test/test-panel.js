// Panel container + placement tests. Run with: node test/test-panel.js
// 1. The panel lives in an (open) shadow root, not in Torn's DOM, and Torn CSS on #poker-coach-panel can't reach it.
// 2. A saved position that is off-screen (e.g. after moving to a smaller window) is pulled back on-screen.
// 3. Dragging can't push the panel off-screen.
// 4. SPR is 0 (not hero's stack / pot) when the only opponent is all-in.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, f), 'utf8');
const FILES = ['poker-engine.js', 'torn-adapter.js', 'strategy.js', 'tracker.js', 'logger.js', 'torn-poker-coach.user.js'];

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== '' ? '  →  ' + JSON.stringify(info) : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

async function boot({ savedPos, testState, setup } = {}) {
  const dom = new JSDOM(`<body>${src('test/fixtures/snap6.html')}</body>`,
    { runScripts: 'outside-only', url: 'https://www.torn.com/page.php?sid=holdem', pretendToBeVisual: true });
  const w = dom.window, errs = [];
  w.console.warn = (...a) => errs.push(a.join(' '));
  if (savedPos) w.localStorage.setItem('pokerCoachPos', JSON.stringify(savedPos));
  if (testState) w.__coachTestState = testState;
  if (setup) setup(w);
  for (const f of FILES) w.eval(src(f));
  await wait(900);
  const host = w.document.getElementById('poker-coach-host');
  const panel = host && host.shadowRoot && host.shadowRoot.getElementById('poker-coach-panel');
  return { w, host, panel, errs };
}

(async () => {
  console.log('Shadow root');
  {
    const { w, host, panel, errs } = await boot();
    check('Host element exists and has an open shadow root', !!(host && host.shadowRoot));
    check('Panel is inside the shadow root', !!panel);
    check('Panel is NOT in the page DOM directly', w.document.getElementById('poker-coach-panel') === null);
    // (Style isolation itself can't be tested here: jsdom wrongly applies page CSS inside shadow roots; real browsers don't.)
    check("Panel's root node is the shadow root (page selectors can't reach it)", panel && panel.getRootNode() === host.shadowRoot);
    check('Panel rendered content', panel && /Equity|Reading hand|Not in this hand/.test(panel.textContent), panel && panel.textContent.slice(0, 80));
    check('No warnings', errs.length === 0, errs);
    w.close();
  }

  console.log('Saved position is clamped on-screen');
  {
    const { w, panel } = await boot({ savedPos: { left: '5000px', top: '-300px' } });
    const left = parseFloat(panel.style.left), top = parseFloat(panel.style.top);
    check('left pulled inside the window', left >= 0 && left <= w.innerWidth - 270, left);
    check('top pulled to ≥ 0', top === 0, top);
    w.close();
  }
  {
    const { w, panel } = await boot({ savedPos: { left: '200px', top: '300px' } });
    check('An on-screen saved position is kept as-is', panel.style.left === '200px' && panel.style.top === '300px', [panel.style.left, panel.style.top]);
    w.close();
  }
  {
    const { w, panel, errs } = await boot({ savedPos: { left: 'auto', top: 'garbage' } });
    check('A corrupt saved position is ignored (default spot kept)', panel.style.right === '16px' && errs.length === 0, [panel.style.right, errs]);
    w.close();
  }

  console.log('Dragging is clamped');
  {
    const { w, panel } = await boot();
    const ev = (type, x, y) => new w.MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y });
    panel.dispatchEvent(ev('mousedown', 100, 100));
    w.document.dispatchEvent(ev('mousemove', -4000, 9000));
    w.document.dispatchEvent(ev('mouseup', -4000, 9000));
    const left = parseFloat(panel.style.left), top = parseFloat(panel.style.top);
    check('Drag far left stops at 0', left === 0, left);
    check('Drag far down keeps a grab strip visible', top <= w.innerHeight - 40 && top >= 0, top);
    const saved = JSON.parse(w.localStorage.getItem('pokerCoachPos'));
    check('Clamped position is what gets saved', saved.left === panel.style.left && saved.top === panel.style.top, saved);
    w.close();
  }

  console.log('SPR with an all-in opponent');
  {
    const state = {
      handId: 't1', heroInHand: true, isHeroTurn: true, street: 'flop', heroCards: ['As', 'Ad'], board: ['Ks', '7d', '2c'],
      pot: 400, toCall: 0, heroStack: 1500, heroBet: 0, dealerSlot: 1,
      players: [
        { slot: 0, name: 'Hero', isHero: true, inHand: true, stack: 1500, bet: 0 },
        { slot: 1, name: 'Shover', inHand: true, stack: 0, bet: 0, isButton: true },
      ],
      actions: [{ type: 'post', actor: 'Hero', blind: 'BB', amount: 10 }, { type: 'street', street: 'flop' }],
    };
    const { w, panel, errs } = await boot({ testState: state });
    const m = panel.textContent.replace(/\s+/g, ' ').match(/SPR\s*([\d.—]+)/);
    check('SPR shows 0.0 when the opponent has nothing behind', m && m[1] === '0.0', m && m[1]);
    check('No warnings', errs.length === 0, errs);
    w.close();
  }

  console.log('Tampermonkey menu commands (no globals)');
  {
    const menu = {}, downloads = [];
    let confirmAnswer = false;
    const { w, panel, errs } = await boot({ setup: w => {
      w.GM_registerMenuCommand = (label, fn) => { menu[label] = fn; };
      w.confirm = () => confirmAnswer; w.alert = () => {};
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    }});
    check('window.PokerCoach is gone', w.PokerCoach === undefined);
    const want = ['Download Session CSV', 'Export Hand History', 'Import Hand History…', 'Reset Hand History',
      'Export Player Stats', 'Import Player Stats…', 'Reset Player Stats'];
    check('All menu commands registered', want.every(k => typeof menu[k] === 'function'), Object.keys(menu));
    menu['Download Session CSV'](); menu['Export Hand History'](); menu['Export Player Stats']();
    check('CSV download', /^poker-coach-hands-\d{4}-\d\d-\d\d\.csv$/.test(downloads[0]), downloads);
    check('Hand history JSON download', /^poker-coach-hand-history-.*\.json$/.test(downloads[1]), downloads);
    check('Player stats JSON download', /^poker-coach-player-stats-.*\.json$/.test(downloads[2]), downloads);
    // seed something resettable, then check confirm() gates the reset
    w.localStorage.setItem('pokerCoachPos', '{}');
    const statsBefore = w.localStorage.getItem('pokerCoachTracker');
    confirmAnswer = false; menu['Reset Player Stats']();
    check('Reset cancelled → stats untouched', w.localStorage.getItem('pokerCoachTracker') === statsBefore);
    confirmAnswer = true; menu['Reset Player Stats'](); menu['Reset Hand History']();
    const t = JSON.parse(w.localStorage.getItem('pokerCoachTracker') || 'null');
    check('Reset confirmed → no players tracked', !t || Object.keys(t.players || {}).length === 0, t);
    check('Panel still rendered after resets', /players tracked/.test(panel.textContent) || /Not in this hand|Reading hand/.test(panel.textContent));
    check('No warnings', errs.length === 0, errs);
    w.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
