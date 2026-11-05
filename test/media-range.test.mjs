import test from 'node:test';
import assert from 'node:assert/strict';
import {CHUNK_SIZE,parseRange,rangeResponse} from '../public/media-range.js';
const media={size:104857600,type:'video/mp4'};
test('video ranges include suffixes, end-of-file and reject invalid requests',()=>{
 assert.deepEqual(parseRange('bytes=-16',media.size),{start:104857584,end:104857599,partial:true});
 assert.deepEqual(parseRange('bytes=2-999999999',media.size),{start:2,end:104857599,partial:true});
 for(const header of ['bytes=104857600-','bytes=4-2','bytes=-0','bytes=','bytes=0-1,4-5'])assert.equal(parseRange(header,media.size),null);
});
test('a byte range spanning two stored chunks preserves boundaries and order',async()=>{
 const seen=[];const r=rangeResponse(new Request('https://app.test/media',{headers:{Range:`bytes=${CHUNK_SIZE-3}-${CHUNK_SIZE+2}`}}),media,async(part,lo,hi)=>{seen.push([part,lo,hi]);return new Uint8Array(hi-lo+1).fill(part+1)});
 assert.equal(r.status,206);assert.equal(r.headers.get('Content-Length'),'6');
 assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[1,1,1,2,2,2]);
 assert.deepEqual(seen,[[0,CHUNK_SIZE-3,CHUNK_SIZE-1],[1,0,2]]);
});
test('the first video bytes arrive before the remaining file and prefetch is bounded',async()=>{
 const seen=[],aborted=[];
 const r=rangeResponse(new Request('https://app.test/media',{headers:{Range:'bytes=0-'}}),media,async(part,lo,hi,signal)=>{
  seen.push(part);if(part===0)return new Uint8Array(hi-lo+1).fill(7);
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted.push(part);reject(Error('cancelled'))},{once:true}));
 });
 const reader=r.body.getReader();const first=await reader.read();assert.equal(first.value.byteLength,CHUNK_SIZE);assert.deepEqual(seen,[0,1,2]);assert.equal(r.headers.get('Content-Length'),'104857600');await reader.cancel();assert.deepEqual(aborted,[1,2]);
});
test('suffix and HEAD requests do not download unneeded chunks',async()=>{
 let calls=0;const head=rangeResponse(new Request('https://app.test/media',{method:'HEAD'}),media,()=>{calls++;throw Error('must not fetch')});assert.equal(head.status,200);assert.equal(calls,0);
 const suffix=rangeResponse(new Request('https://app.test/media',{headers:{Range:'bytes=-16'}}),media,async(part,lo,hi)=>{assert.equal(part,19);assert.equal(lo,CHUNK_SIZE-16);return new Uint8Array(hi-lo+1).fill(9)});assert.equal((await suffix.arrayBuffer()).byteLength,16);
});
