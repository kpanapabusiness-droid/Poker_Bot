// Security + render-efficiency tests for the overlay. Run with: node test/test-security.js
// 1. A player whose name is HTML/script must show up as plain text, never as markup.
// 2. The panel must not be rebuilt when nothing on the table has changed.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (info !== '' ? '  →  ' + JSON.stringify(info) : '')); }
}

(async () => {
  const EVIL = `<img src=x onerror="window.__pwned=1">"'\`<b>x</b>`;
  // Put the evil name on the player who is still in the hand (Player1), in the seat and in the log.
  const html = src('test/fixtures/snap6.html').split('Player1').join(EVIL.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: 'outside-only', url: 'https://www.torn.com/page.php?sid=holdem' });
  const w = dom.window, errs = [];
  w.console.warn = (...a) => errs.push(a.join(' '));
  for (const f of ['poker-engine.js', 'torn-adapter.js', 'strategy.js', 'tracker.js', 'logger.js', 'torn-poker-coach.user.js']) w.eval(src(f));
  await new Promise(r => setTimeout(r, 1500));
  const panel = w.document.getElementById('poker-coach-host').shadowRoot.getElementById('poker-coach-panel');

  console.log('\nBooby-trapped player name');
  check('Panel rendered', !!panel && /CALL|RAISE|FOLD/.test(panel.textContent));
  check('No <img> injected into the panel', panel.querySelectorAll('img').length === 0);
  check('No <b>x</b> from the name became markup', ![...panel.querySelectorAll('b')].some(b => b.textContent === 'x'));
  check('No element has an onerror attribute', panel.querySelectorAll('[onerror]').length === 0);
  check('The name is shown literally as text', panel.textContent.includes('<img src=x onerror='), panel.textContent.slice(0, 120));
  check('Injected code never ran', !w.__pwned);
  check('No errors', errs.length === 0, errs);

  console.log('\nRender only on change');
  let writes = 0;
  const desc = Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML');
  Object.defineProperty(panel, 'innerHTML', { set(v) { writes++; desc.set.call(this, v); }, get() { return desc.get.call(this); } });
  await new Promise(r => setTimeout(r, 2100)); // ~5 ticks with an unchanged table
  check('No redraws while the table is unchanged (5 ticks)', writes === 0, writes);
  panel.querySelector('[data-pc="report"]').click();
  check('Clicking a tab redraws immediately', writes === 1, writes);
  await new Promise(r => setTimeout(r, 900));
  check('…and then stays quiet again', writes === 1, writes);
  // Change the table: bump the pot text → panel should redraw on the next tick
  panel.querySelector('[data-pc="coach"]').click();
  const before = writes;
  const pot = w.document.querySelector('[class*="totalPotWrap___"]');
  pot.innerHTML = '<div><b>POT:</b> $999</div>';
  await new Promise(r => setTimeout(r, 900));
  check('Redraws when the table changes', writes > before, [before, writes]);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  w.close();
  process.exit(fail ? 1 : 0);
})();
