const fs=require('fs'),{JSDOM}=require('jsdom');
const src=f=>fs.readFileSync(f,'utf8');
(async()=>{let fail=0;
for (const n of [1,2,4,5,6]) {
  const dom=new JSDOM('<body>'+src('test/fixtures/snap'+n+'.html')+'</body>',{runScripts:'outside-only'});
  const w=dom.window, errs=[]; w.console.warn=(...a)=>errs.push(a.join(' '));
  w.eval(src('poker-engine.js')); w.eval(src('torn-adapter.js')); w.eval(src('strategy.js')); w.eval(src('tracker.js')); w.eval(src('torn-poker-coach.user.js'));
  await new Promise(r=>setTimeout(r,1500));
  const p=w.document.getElementById('poker-coach-panel');
  console.log('snap'+n+': '+(p?p.textContent.replace(/\s+/g,' ').trim():'NO PANEL'));
  if(!p||errs.length){fail++;console.log('  errors:',errs);} w.close();
} process.exit(fail)})();
