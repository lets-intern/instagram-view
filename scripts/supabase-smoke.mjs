import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const context={window:{}};vm.runInNewContext(await fs.readFile('public/config.js','utf8'),context);
globalThis.DRAFTROOM_CONFIG=context.window.DRAFTROOM_CONFIG;
const {cloudApi,cloudUpload,cloudMedia}=await import('../public/cloud.js');
const config=globalThis.DRAFTROOM_CONFIG;
const {editorKey}=JSON.parse(await fs.readFile('data/deployment-links.json','utf8'));
const path='data/deployment-test.json';
if(process.argv.includes('--cleanup')){
 const qa=JSON.parse(await fs.readFile(path,'utf8'));
 if(qa.draftId)await cloudApi(editorKey,'drafts/'+qa.draftId,'DELETE').catch(()=>{});
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!key)throw Error('Cleanup credential missing');
 const prefixes=qa.media.flatMap(m=>Array.from({length:m.chunks},(_,i)=>m.id+'/'+i));
 if(prefixes.length){const r=await fetch(config.supabaseUrl+'/storage/v1/object/draftroom-media',{method:'DELETE',headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({prefixes})});assert.ok(r.ok,'Temporary media cleanup failed: '+r.status)}
 console.log('Temporary cloud test draft and media removed.');
}else{
 const qa={media:[]};const record=()=>fs.writeFile(path,JSON.stringify(qa));await record();
 const state=await cloudApi(editorKey,'state');assert.equal(state.editor,true);assert.ok(state.accounts.length);
 await assert.rejects(()=>cloudApi('0'.repeat(64),'state'));
 const draft=await cloudApi(editorKey,'drafts','POST',{accountId:state.accounts[0].id,name:'배포 자동 점검 · 임시'});qa.draftId=draft.id;qa.clientKey=draft.clientKey;await record();
 const video=await fs.readFile('test/fixtures/video.mp4');const bytes=new Uint8Array(104857600);bytes.set(video);
 const expected=createHash('sha256').update(bytes).digest('hex');
 const media=await cloudUpload(editorKey,new File([bytes],'100MiB-check.mp4',{type:'video/mp4'}),()=>{});qa.media.push(media);await record();
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const picture=await cloudUpload(editorKey,new File([image],'check.png',{type:'image/png'}),()=>{});qa.media.push(picture);await record();
 await cloudApi(editorKey,'drafts/'+draft.id,'PATCH',{media:[media,picture],caption:'배포 자동 확인 #검토'});
 const scoped=await cloudApi(draft.clientKey,'state');assert.equal(scoped.editor,false);assert.equal(scoped.drafts.length,1);assert.equal(scoped.drafts[0].media[0].size,104857600);
 await assert.rejects(()=>cloudApi(draft.clientKey,'drafts/'+draft.id,'PATCH',{caption:'blocked'}));
 const url=await cloudMedia(draft.clientKey,media);try{const restored=await(await fetch(url)).arrayBuffer();assert.equal(restored.byteLength,104857600);assert.equal(createHash('sha256').update(new Uint8Array(restored)).digest('hex'),expected)}finally{URL.revokeObjectURL(url)}
 console.log('PASS: live Supabase 100MiB upload/reassembly, profile state, scoped preview, denied edits.');
}
