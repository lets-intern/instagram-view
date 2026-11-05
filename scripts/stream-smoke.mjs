import {chromium} from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const key='a'.repeat(64),id='00000000-0000-4000-8000-000000000001';
const video=new Uint8Array(104857600);video.set(await fs.readFile('test/fixtures/video.mp4'));
const profile={id:'account',name:'Test',username:'preview.test',displayName:'Preview',verified:false};
const draft={id:'draft',accountId:'account',username:profile.username,displayName:profile.displayName,verified:false,name:'Stream test',type:'carousel',caption:'Preview',fit:'cover',ratio:'4 / 5',likes:1,commentCount:0,time:'방금 전',status:'검토 대기',media:[{id,type:'video/mp4',size:video.length,chunks:20,name:'100MiB.mp4'}]};
let release;const gate=new Promise(resolve=>release=resolve);let delivered=0;const requests=[];
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/config.js'){res.setHeader('Content-Type','text/javascript');return res.end(`window.DRAFTROOM_CONFIG=${JSON.stringify({supabaseUrl:'http://127.0.0.1:3146',publishableKey:'sb_publishable_testing_key'})}`)}
 if(url.pathname==='/rest/v1/rpc/draftroom_api'){for await(const _ of req){}res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({editor:false,client:true,accounts:[profile],drafts:[draft]}))}
 if(url.pathname.startsWith('/storage/')){
  assert.equal(req.headers['x-client-info'],key);
  const part=Number(url.pathname.split('/').at(-1));requests.push(part);
  if(part>0&&part<19)await gate;
  const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
  const lo=match?Number(match[1]):0,hi=match?Number(match[2]):5242879;
  const bytes=video.subarray(part*5242880+lo,part*5242880+hi+1);
  res.writeHead(match?206:200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length,...(match?{'Content-Range':`bytes ${lo}-${hi}/5242880`}:{})});delivered+=bytes.length;return res.end(bytes);
 }
 const pathname=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!/^[\w.-]+$/.test(pathname)){res.writeHead(404);return res.end()}
 const data=await fs.readFile('public/'+pathname);res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');res.end(data);
}catch{if(!res.headersSent)res.writeHead(500);res.end()}}).listen(3146,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const started=Date.now();await page.goto('http://127.0.0.1:3146/?draft=draft#'+key);
 await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0,null,{timeout:30000});
 const elapsed=Date.now()-started;assert.ok(delivered<video.length,'Playback must begin before the entire file arrives');
 assert.ok(await page.locator('video').evaluate(v=>v.currentSrc.includes('/__media/')),'Browser should use byte-range streaming');
 console.log(`PASS: 100MiB playback began after ${delivered} bytes in ${elapsed}ms while later chunks were deliberately blocked.`);
 const virtual=await page.locator('video').evaluate(v=>v.currentSrc);
 const tail=await page.evaluate(async url=>{const r=await fetch(url,{headers:{Range:'bytes=-16'}});return {status:r.status,bytes:[...new Uint8Array(await r.arrayBuffer())]}},virtual);assert.equal(tail.status,206);assert.equal(tail.bytes.length,16);assert.ok(tail.bytes.every(x=>x===0));
 // Force a worker restart and verify the owning page restores its media context.
 const cdp=await page.context().newCDPSession(page);await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
 const recovered=await page.evaluate(async url=>{const r=await fetch(url,{headers:{Range:'bytes=0-15'}});return {status:r.status,bytes:[...new Uint8Array(await r.arrayBuffer())]}},virtual);assert.equal(recovered.status,206);assert.deepEqual(recovered.bytes,[...video.slice(0,16)]);
 assert.deepEqual(errors,[]);console.log('PASS: suffix ranges and playback context recovery after worker restart.');
}finally{release();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
