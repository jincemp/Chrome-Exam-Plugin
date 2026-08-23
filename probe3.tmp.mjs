import { chromium } from 'playwright-core';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const root='/home/user/Chrome-Exam-Plugin';
const SETTINGS={apiKey:'sk-test',model:'gpt-5.4-nano',effort:'low',baseUrl:'https://api.openai.com/v1',endpoint:'auto',showWhy:true,extraInstructions:''};
function stub(state){
  const slow=(v,ms)=>new Promise(r=>setTimeout(()=>r(v),ms));
  globalThis.chrome={storage:{local:{get:async(d)=>slow({...d,...state.settings},30),set:async()=>{}},session:{get:async(k)=>slow(state.job?{[k]:state.job}:{},30),set:async()=>{},remove:async()=>{}},onChanged:{addListener:()=>{}}},tabs:{query:async()=>slow([{id:1,url:'https://example.test/exam'}],30)},runtime:{openOptionsPage(){},sendMessage:async()=>slow(state.scan||{ok:true,questionCount:12},300)},permissions:{request:async()=>false,contains:async()=>true}};
}
const TYPES={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server=http.createServer((req,res)=>{const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const f=path.join(root,rel);let b;try{b=readFileSync(f);}catch{res.writeHead(404).end();return;}res.writeHead(200,{'content-type':TYPES[path.extname(f)]||'application/octet-stream'});res.end(b);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await browser.newContext({viewport:{width:300,height:600},colorScheme:'dark',deviceScaleFactor:1});
const page=await ctx.newPage();
await page.addInitScript(stub,{settings:SETTINGS,job:null});
await page.goto(`${origin}/popup/popup.html`,{waitUntil:'commit'});
const samples=[];
for(let i=0;i<30;i++){
  samples.push(await page.evaluate(()=>{
    const app=document.querySelector('.app');
    return app? Math.round(app.getBoundingClientRect().height+24) : -1;
  }).catch(()=>-2));
  await page.waitForTimeout(20);
}
console.log('popup content height over 600ms:', JSON.stringify(samples));
await browser.close(); server.close();
