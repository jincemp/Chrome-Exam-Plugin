import { chromium } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
const root = '/home/user/Chrome-Exam-Plugin';
const outDir = '/tmp/claude-0/-home-user-Chrome-Exam-Plugin/c720cb98-5fad-5b6c-8dbc-e271f96d6b91/scratchpad/shots2';
mkdirSync(outDir, { recursive: true });
const SETTINGS = { apiKey:'sk-test', model:'gpt-5.4-nano', effort:'low', baseUrl:'https://api.openai.com/v1', endpoint:'auto', showWhy:true, extraInstructions:'' };
function stub(state){globalThis.chrome={storage:{local:{get:async(d)=>({...d,...state.settings}),set:async()=>{}},session:{get:async(k)=>(state.job?{[k]:state.job}:{}),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},tabs:{query:async()=>[{id:1,url:'https://example.test/exam'}]},runtime:{openOptionsPage(){},sendMessage:async()=>state.scan||{ok:true,questionCount:12}},permissions:{request:async()=>false,contains:async()=>true}};}
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((req,res)=>{const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const f=path.join(root,rel);let b;try{b=readFileSync(f);}catch{res.writeHead(404).end();return;}res.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream'});res.end(b);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});

const mk=(n)=>Array.from({length:n},(_,i)=>({number:String(i+1),label:'b',answer:'230.34',why:'',confidence:'high'}));

const CASES = {
  'meta-modest': { settings:SETTINGS, job:{status:'done',url:'https://example.test/exam',answers:mk(12),meta:{model:'gpt-5.4-nano', windowed:true}} },
  'meta-plain': { settings:SETTINGS, job:{status:'done',url:'https://example.test/exam',answers:mk(12),meta:{model:'gpt-5.4-nano'}} },
  'frames-long': { settings:SETTINGS, job:{status:'error',url:'https://example.test/exam',error:{message:'The questions are inside an embedded frame.',hint:'Chrome needs your permission to read it.',kind:'frames',origins:['https://quiz-delivery-platform.examservices.example.com','https://cdn.another-host.example.org']}} },
};
for (const [name,state] of Object.entries(CASES)) {
  const ctx=await browser.newContext({viewport:{width:300,height:600},colorScheme:'light',deviceScaleFactor:2});
  const page=await ctx.newPage();
  await page.addInitScript(stub,state);
  page.on('pageerror',e=>console.error('ERR',name,e.message));
  await page.goto(`${origin}/popup/popup.html`);
  await page.waitForTimeout(250);
  const m = await page.evaluate(()=>{
    const g=(id)=>{const e=document.getElementById(id); if(!e) return null; const r=e.getBoundingClientRect(); return {w:+r.width.toFixed(1),h:+r.height.toFixed(1),sw:e.scrollWidth,cw:e.clientWidth,text:e.textContent};};
    return {copy:g('copy'),rerun:g('rerun'),meta:g('answers-meta'),grant:g('grant'),docH:document.documentElement.scrollHeight, bodySW:document.body.scrollWidth};
  });
  console.log(name, JSON.stringify(m));
  await page.screenshot({path:path.join(outDir,`${name}.png`)});
  await ctx.close();
}

// flash / resize on open: measure document height at first paint vs settled
{
  const ctx=await browser.newContext({viewport:{width:300,height:600},colorScheme:'dark',deviceScaleFactor:2});
  const page=await ctx.newPage();
  await page.addInitScript(stub,{settings:SETTINGS,job:null});
  await page.goto(`${origin}/popup/popup.html`,{waitUntil:'commit'});
  await page.waitForTimeout(0);
  const heights=[];
  for(let i=0;i<12;i++){ heights.push(await page.evaluate(()=>document.documentElement.scrollHeight)); await page.waitForTimeout(25); }
  console.log('open heights (dark, idle):', JSON.stringify(heights));
  await ctx.close();
}
await browser.close();
server.close();
