// Opens the Report tab in a simulated browser with a pre-seeded hand log. Run with: node test/test-report-ui.js
const fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const root=path.join(__dirname,'..');
const src=f=>fs.readFileSync(path.join(root,f),'utf8');
const L=require('../logger.js');
(async()=>{
  // pre-seed a hand log in localStorage, then open the Report tab
  let d=null; const lg=L.create({load:()=>d,save:x=>d=JSON.parse(JSON.stringify(x)),now:()=>Date.now()});
  const players=[{isHero:true,name:'H',slot:0},{name:'V',slot:1}];
  const pre=[{type:'post',actor:'H',amount:10},{type:'street',street:'flop'},{type:'bet',actor:'V',amount:50}];
  const base={handId:'x',heroInHand:true,heroCards:['As','Kd'],board:['Qs','7d','2c'],heroStack:1000,heroBet:0,players,street:'flop',pot:100,toCall:50};
  lg.observe({...base,isHeroTurn:true,actions:pre},{action:'FOLD',amount:0,tag:'FOLD',ev:0,options:[{action:'FOLD',amount:0,ev:0},{action:'CALL',amount:50,ev:-20}]},{position:'BTN',bb:10});
  lg.observe({...base,isHeroTurn:false,actions:[...pre,{type:'call',actor:'H',amount:50},{type:'win',actor:'V',amount:170}]},null,{position:'BTN',bb:10});
  const dom=new JSDOM('<body>'+src('test/fixtures/snap6.html')+'</body>',{runScripts:'outside-only',url:'https://www.torn.com/page.php?sid=holdem'});
  const w=dom.window, errs=[]; w.console.warn=(...a)=>errs.push(a.join(' '));
  w.localStorage.setItem('pokerCoachHands', JSON.stringify(d));
  for (const f of ['poker-engine.js','torn-adapter.js','strategy.js','tracker.js','logger.js','torn-poker-coach.user.js']) w.eval(src(f));
  await new Promise(r=>setTimeout(r,1500));
  const p=w.document.getElementById('poker-coach-panel');
  console.log('COACH:', p.textContent.replace(/\s+/g,' ').slice(0,90), '...', (p.textContent.match(/Session:[^·]*·[^·]*·[^\n]*/)||[''])[0].replace(/\s+/g,' ').slice(0,60));
  p.querySelector('[data-pc="report"]').click();
  console.log('REPORT:', p.textContent.replace(/\s+/g,' ').slice(0,520));
  p.querySelector('[data-pc="coach"]').click();
  console.log('BACK TO COACH:', /Equity/.test(p.textContent));
  const rep=p.textContent;
  p.querySelector('[data-pc="report"]').click();
  const ok = errs.length===0;
  console.log('errors:', errs);
  console.log(ok ? '\nreport UI ok' : '\nreport UI FAILED');
  process.exit(ok?0:1);
})();
