import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('Supabase adapter stores and restores 100MiB through 20 bounded chunks',async()=>{
 const nativeFetch=globalThis.fetch;
 globalThis.DRAFTROOM_CONFIG={supabaseUrl:'https://storage.example.test',publishableKey:'sb_publishable_test_public_key'};
 const key='a'.repeat(64),id='00000000-0000-4000-8000-000000000001';
 const objects=new Map(),progress=[];let retried=false,completed=false;
 globalThis.fetch=async(url,options={})=>{
  if(String(url).startsWith('blob:'))return nativeFetch(url,options);
  assert.equal(options.headers['x-client-info'],key);
  assert.equal(options.headers.apikey,'sb_publishable_test_public_key');
  if(String(url).includes('/rest/v1/rpc/')){
   const body=JSON.parse(options.body);assert.equal(body.p_key,key);
   if(body.p_path==='upload/register')return Response.json({id,name:'100MiB.mp4',type:'video/mp4',size:104857600,chunks:20});
   assert.equal(body.p_path,'upload/'+id+'/complete');assert.equal(objects.size,20);completed=true;return Response.json({ok:true});
  }
  const part=Number(String(url).split('/').at(-1));
  if(options.method==='POST'){
   assert.ok(options.body.size<=5242880);
   if(part===0&&!retried){retried=true;throw Error('transient network failure')}
   objects.set(part,new Uint8Array(await options.body.arrayBuffer()));return Response.json({ok:true});
  }
  assert.ok(completed);return new Response(objects.get(part));
 };
 let objectUrl;
 try{
  const {cloudUpload,cloudMedia}=await import('../public/cloud.js');
  const bytes=new Uint8Array(104857600).fill(37);
  const expected=createHash('sha256').update(bytes).digest('hex');
  const file=new File([bytes],'100MiB.mp4',{type:'video/mp4'});
  const media=await cloudUpload(key,file,p=>progress.push(p));
  assert.equal(media.size,104857600);assert.equal(progress.length,20);assert.equal(progress.at(-1),100);assert.equal(objects.size,20);
  objectUrl=await cloudMedia(key,media);const restored=await(await nativeFetch(objectUrl)).arrayBuffer();assert.equal(restored.byteLength,104857600);assert.equal(createHash('sha256').update(new Uint8Array(restored)).digest('hex'),expected);
 }finally{globalThis.fetch=nativeFetch;delete globalThis.DRAFTROOM_CONFIG;if(objectUrl)URL.revokeObjectURL(objectUrl)}
});
