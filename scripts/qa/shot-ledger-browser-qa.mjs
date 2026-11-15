import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

process.env.VITE_DISABLE_REACT_DEVTOOLS = '1';
const html = readFileSync('score.html','utf8').replace(/src="score-app\/score-app\.js[^"]*"/, 'src="/src/score-app/main.js"').replace('<script src="pwa.js" defer></script>','');
const server = await createServer({ configFile:false, cacheDir:process.env.GVDG_SHOT_QA_CACHE || '/tmp/gvdg-shot-ledger-qa',
  optimizeDeps:{ entries:['src/score-app/main.js'] }, server:{ watch:null, host:'127.0.0.1', port:0 }, plugins:[{
    name:'shot-ledger-qa', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/score.html')) return next();
      res.setHeader('Content-Type','text/html'); res.end(await vite.transformIndexHtml(req.url, html));
    }); },
}] });
await server.listen();
const origin=server.resolvedUrls.local[0].replace(/\/$/,'');
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(25000);
  const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  const player={index:0,cardId:'c1',name:'QA Player',isMe:true,canEnterScorecard:true,scores:{1:2},scorecards:{1:{'player:0':2}},throws:{}};
  const card={roundCode:'SHOT12',courseName:'Private ledger QA',layoutName:'Test',status:'live',cardId:'c1',playerIndex:0,recoveryRoundId:'test-generation',rev:3,
    roundConfig:{groupFormat:'singles',scoringStyle:'stroke'}, holes:[{hole:1,par:3,distance_ft:230,tee:{lat:35,lng:-77},target:{lat:35.0005,lng:-77}}],
    cardmates:[player],players:[player],scoreTargets:[{id:'player:0',type:'player',label:'QA Player',playerIndexes:[0],members:['QA Player']}], conflicts:[],missing:[],shotLedgers:{}};
  const writes=[];
  let offline=false;
  await page.routeWebSocket('ws://127.0.0.1:8788/**',()=>{});
  await page.route('http://127.0.0.1:8788/**',async route=>{
    const req=route.request();
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
    const reply=(body,status=200)=>route.fulfill({json:body,status,headers});
    if(req.method()==='OPTIONS') return route.fulfill({status:204,headers});
    const path=new URL(req.url()).pathname;
    if(path==='/me') return reply({sub:'m_qa',name:'QA Player'});
    if(path.endsWith('/live/mine')) return offline ? reply({error:'offline'},503) : reply(card);
    if(path.endsWith('/live/throws') && req.method()==='POST') {
      const body=req.postDataJSON(), prior=card.shotLedgers[0]?.[1];
      if(offline) return reply({error:'offline'},503);
      if(body.recovery.previous !== (prior?.revision ?? null)) return reply({error:'recovery_edit_conflict',ledger:prior},409);
      writes.push(body);
      const ledger={...body.ledger,version:(prior?.version??0)+1,revision:body.recovery.order,scope:'player',label:'QA Player'};
      card.shotLedgers={0:{1:ledger}};
      return reply({ok:true,scorerIndex:0,hole:1,ledger});
    }
    return reply({status:'live',rows:[],clips:[],messages:[]});
  });
  await page.addInitScript(()=>{
    sessionStorage.setItem('gvdg_member_token','qa-private-ledger');
    Object.defineProperty(navigator,'onLine',{get:()=>localStorage.getItem('qa-offline')!=='yes'});
  });
  const btn=(name)=>page.getByRole('button',{name,exact:true});
  const content=(name)=>page.getByText(name,{exact:true});
  async function openLedger() { await btn('Round tools').click(); await btn('Shot details').click(); await page.getByRole('heading',{name:'Shot details · Hole 1'}).waitFor(); }
  await page.goto(origin+'/score.html?round=SHOT12',{waitUntil:'domcontentloaded'});
  await btn('Round tools').waitFor({state:'visible',timeout:60000});
  await openLedger();
  offline=true;
  await page.evaluate(()=>{localStorage.setItem('qa-offline','yes');window.dispatchEvent(new Event('offline'));});
  await btn('Add throw').click();
  await page.getByLabel('Outcome',{exact:true}).selectOption('missed');
  await page.getByLabel('Starting lie',{exact:true}).selectOption('tee');
  await page.getByLabel('Landing or resting lie',{exact:true}).selectOption('fairway');
  await btn('Save shot').click();
  await content('Throw · Missed · from tee · to fairway').waitFor();
  await btn('Add putt').click();
  await page.getByLabel('Outcome',{exact:true}).selectOption('made');
  await content('GPS and measured distances').click();
  await page.getByLabel('Measured starting distance to basket in feet').fill('19');
  await btn('Save shot').click();
  await content('Putt · Made · 19 ft to basket').waitFor();
  assert.equal(writes.length,0);
  await page.reload({waitUntil:'domcontentloaded'});
  await openLedger();
  await content('Putt · Made · 19 ft to basket').waitFor();
  await page.locator('#scoreReactNotificationsApp').getByText('Offline — showing your saved card. Changes sync when reconnected.', {exact:true}).waitFor({state:'hidden',timeout:10000});
  mkdirSync('.omo/evidence/shot-ledger',{recursive:true});
  await page.screenshot({path:'.omo/evidence/shot-ledger/phone.png'});
  offline=false;
  await page.evaluate(()=>{localStorage.removeItem('qa-offline');window.dispatchEvent(new Event('online'));});
  await page.waitForFunction(()=>!document.body.textContent.includes('Shot changes saved on this phone, awaiting sync.'));
  assert.equal(writes.length,2);
  assert.equal(writes[1].recovery.previous,writes[0].recovery.order);
  await btn('Edit stroke 2').click();
  await btn('Remove shot').click();
  await btn('Confirm remove shot').click();
  await content('1 recorded stroke and 2 on the card. Review these shots or the score.').waitFor();
  await btn('Back to round tools').click();
  const shotDetails = await btn('Shot details').elementHandle();
  await page.waitForFunction(button => document.activeElement === button, shotDetails);
  const toolsDialog = page.getByRole('dialog', { name: 'Round tools', exact: true });
  await toolsDialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await toolsDialog.waitFor({ state: 'hidden' });
  const roundTools = await btn('Round tools').elementHandle();
  await page.waitForFunction(button => document.activeElement === button, roundTools);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  assert.deepEqual(errors,[]);
  console.log('Mobile editable shot ledger, offline reload, FIFO sync, removal, and focus verified');
} finally { await browser.close(); await server.close(); }
