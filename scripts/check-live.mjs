import fs from 'node:fs/promises';
import vm from 'node:vm';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.argv[2];if(!base?.startsWith('https://'))throw Error('Public Pages URL is required');
const {editorKey}=JSON.parse(await fs.readFile('data/deployment-links.json','utf8'));
const qa=JSON.parse(await fs.readFile('data/deployment-test.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const measurements=[];
async function open(context,draftId,key){
 const page=await context.newPage();
 await page.addInitScript(({key})=>{
  location.hash=key;
  window.__videoFrames=[];
  document.addEventListener('loadeddata',async event=>{
   const video=event.target;if(video.tagName!=='VIDEO'||!video.currentSrc.includes('/__media/'))return;
   const firstFrameMs=Math.round(performance.now());
   const session=new URL(video.currentSrc).searchParams.get('session');
   const channel=new MessageChannel();const timer=setTimeout(()=>channel.port1.close(),3000);
   channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();window.__videoFrames.push({id:video.dataset.mediaId,firstFrameMs,bytes:e.data.bytes})};
   navigator.serviceWorker.controller?.postMessage({type:'media-stats',session},[channel.port2]);
  },true);
 },{key});
 const response=await page.goto(base+'?draft='+draftId);assert.ok(response?.ok(),'Public page unavailable');
 return page;
}
async function playback(page,media,label){
 await page.waitForFunction(id=>window.__videoFrames?.some(frame=>frame.id===id),media.id,{timeout:180000});
 const frame=await page.evaluate(id=>window.__videoFrames.find(frame=>frame.id===id),media.id);
 assert.ok(await page.locator('video').evaluate(v=>v.currentSrc.includes('/__media/')),'Expected byte-range streaming');
 await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0,null,{timeout:30000});
 if(media.size>=52428800)assert.ok(frame.bytes<media.size,'The first frame should not wait for the full video');
 measurements.push({label,size:media.size,firstFrameMs:frame.firstFrameMs,bytesBeforeFirstFrame:frame.bytes});
 console.log(`PASS ${label}: first frame ${frame.firstFrameMs}ms, ${frame.bytes}/${media.size} bytes transferred.`);
}
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const errors=[];context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
 const page=await open(context,qa.draftId,editorKey);await page.locator('[data-profile="username"]').waitFor({timeout:60000});
 await playback(page,qa.media[0],'100MiB-editor');
 await page.getByRole('button',{name:'다음 슬라이드'}).click();await page.waitForFunction(()=>document.querySelector('.media>img')?.complete);
 await page.reload();await playback(page,qa.media[0],'100MiB-reload');
 const reviewer=await open(context,qa.draftId,qa.clientKey);await reviewer.locator('.phone').waitFor({timeout:60000});assert.equal(await reviewer.locator('[data-draft]').count(),1);assert.equal(await reviewer.locator('[data-profile]').count(),0);assert.equal(await reviewer.locator('#feedback').count(),0);await playback(reviewer,qa.media[0],'100MiB-reviewer');
 // Read-only check of the exact draft the user reported; never modify its content.
 const reported=process.env.REVIEW_DRAFT_ID;
 if(reported){
  const configContext={window:{}};vm.runInNewContext(await fs.readFile('public/config.js','utf8'),configContext);globalThis.DRAFTROOM_CONFIG=configContext.window.DRAFTROOM_CONFIG;
  const {cloudApi}=await import('../public/cloud.js');const state=await cloudApi(editorKey,'state');const draft=state.drafts.find(d=>d.id===reported);
  const index=draft?.media.findIndex(m=>m.type.startsWith('video/'))??-1;
  if(index>=0){
  const client=await open(context,draft.id,draft.clientKey);await client.locator('.phone').waitFor({timeout:60000});if(index>0)await client.locator('[data-slide="'+index+'"]').click();await playback(client,draft.media[index],'reported-review-link');
  }else console.log('Reported draft was removed or no longer contains video; standard streaming checks passed.');
 }
 assert.deepEqual(errors,[]);await fs.writeFile('data/playback-performance.json',JSON.stringify(measurements));console.log('PASS: public playback/reload, streaming client preview and scoped read-only access.');
}catch(error){console.error('Public browser verification failed: '+error.name);process.exitCode=1;}finally{await browser.close()}
