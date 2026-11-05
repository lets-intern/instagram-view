import fs from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.argv[2];if(!base?.startsWith('https://'))throw Error('Public Pages URL is required');
const {editorKey}=JSON.parse(await fs.readFile('data/deployment-links.json','utf8'));
const qa=JSON.parse(await fs.readFile('data/deployment-test.json','utf8'));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=base+'?draft='+qa.draftId+'#'+editorKey;
 let loaded=false;for(let attempt=0;attempt<6;attempt++){const response=await page.goto(url);if(response?.ok()){loaded=true;break}await page.waitForTimeout(5000)}assert.ok(loaded,'Pages did not become ready');
 await page.locator('[data-profile="username"]').waitFor({timeout:60000});
 await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,null,{timeout:180000});
 await page.waitForTimeout(500);assert.ok(await page.locator('video').evaluate(v=>v.currentTime>0));
 await page.getByRole('button',{name:'다음 슬라이드'}).click();await page.waitForFunction(()=>document.querySelector('.media>img')?.complete);
 await page.reload();await page.waitForFunction(()=>document.querySelector('video')?.readyState>=2,null,{timeout:180000});
 const reviewer=await context.newPage();reviewer.on('pageerror',e=>errors.push(e.message));await reviewer.goto(base+'?draft='+qa.draftId+'#'+qa.clientKey);await reviewer.locator('.phone').waitFor({timeout:60000});assert.equal(await reviewer.locator('[data-draft]').count(),1);assert.equal(await reviewer.locator('[data-profile]').count(),0);assert.equal(await reviewer.locator('#feedback').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: public GitHub Pages, 100MiB browser playback/reload, carousel, client-only preview.');
}finally{await browser.close()}
