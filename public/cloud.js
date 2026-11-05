// Supabase REST adapter. No service-role or management key belongs in this file.
export const config=globalThis.DRAFTROOM_CONFIG;
export const cloud=!!config?.supabaseUrl;
const cache=new Map();
function headers(key){const h={apikey:config.publishableKey,'x-client-info':key};if(config.publishableKey.startsWith('eyJ'))h.Authorization='Bearer '+config.publishableKey;return h;}
export async function cloudApi(key,path,method='GET',data={}){
 if(!config.publishableKey)throw Error('Supabase 공개 키 설정이 필요합니다');
 const r=await fetch(config.supabaseUrl+'/rest/v1/rpc/draftroom_api',{method:'POST',headers:{...headers(key),'Content-Type':'application/json'},body:JSON.stringify({p_key:key,p_path:path,p_method:method,p_data:data})});
 const result=await r.json();if(!r.ok)throw Error(result.message||'저장소 요청 실패');return result;
}
async function retry(fn){let last;for(let i=0;i<3;i++){try{return await fn()}catch(e){last=e;if(i<2)await new Promise(r=>setTimeout(r,400*(i+1)));}}throw last;}
export async function cloudUpload(key,file,progress){
 if(file.size<1||file.size>104857600)throw Error('파일당 최대 100MB입니다');
 const type=file.type||(/\.mov$/i.test(file.name)?'video/quicktime':'');
 const m=await cloudApi(key,'upload/register','POST',{name:file.name,type,size:file.size});
 for(let part=0;part<m.chunks;part++){
  const blob=file.slice(part*5242880,Math.min(file.size,(part+1)*5242880));
  await retry(async()=>{
   const r=await fetch(config.supabaseUrl+'/storage/v1/object/draftroom-media/'+m.id+'/'+part,{method:'POST',headers:{...headers(key),'Content-Type':'application/octet-stream','cache-control':'max-age=0'},body:blob});
   // The UUID path is owned by this upload. A previous retry may already have stored it.
   if(r.status===409)return;
   if(!r.ok){const err=await r.json().catch(()=>({}));if(err.statusCode==='409'||err.error==='Duplicate')return;throw Error(err.message||'업로드 조각 저장 실패')}
  });progress(Math.round((part+1)/m.chunks*100));
 }
 await cloudApi(key,'upload/'+m.id+'/complete','POST');return m;
}
export async function cloudMedia(key,m){
 if(cache.has(m.id))return cache.get(m.id);
 const promise=(async()=>{const chunks=new Array(m.chunks);let next=0;async function download(){while(next<m.chunks){const part=next++;chunks[part]=await retry(async()=>{const r=await fetch(config.supabaseUrl+'/storage/v1/object/authenticated/draftroom-media/'+m.id+'/'+part,{headers:headers(key),cache:'no-store'});if(!r.ok)throw Error('미디어 조각을 불러올 수 없습니다');return r.blob()})}}await Promise.all(Array.from({length:Math.min(4,m.chunks)},download));return URL.createObjectURL(new Blob(chunks,{type:m.type}))})();
 cache.set(m.id,promise);try{return await promise}catch(e){cache.delete(m.id);throw e}
}

const videoSessions = new Map(), playbackUrls = new Map();
let workerReady;
function messageWorker(worker, data) {
 return new Promise((resolve,reject)=>{
  const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();reject(Error('영상 재생 준비 시간이 초과되었습니다'))},5000);
  channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data)};
  worker.postMessage(data,[channel.port2]);
 });
}
async function prepareWorker(){
 if(!workerReady)workerReady=(async()=>{
  navigator.serviceWorker.addEventListener('message',event=>{
   if(event.data?.type==='media-context-needed')event.ports[0]?.postMessage(videoSessions.get(event.data.session)||null);
  });
  const updated=await navigator.serviceWorker.register(new URL('./media-worker.js',import.meta.url),{type:'module',scope:new URL('./',import.meta.url).pathname,updateViaCache:'none'});
  const installing=updated.installing||updated.waiting;
  if(installing&&installing.state!=='activated')await new Promise((resolve,reject)=>{installing.addEventListener('statechange',()=>{if(installing.state==='activated')resolve();else if(installing.state==='redundant')reject(Error('영상 재생 업데이트 실패'))})});
  const registration=await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{navigator.serviceWorker.removeEventListener('controllerchange',changed);reject(Error('영상 재생 준비 실패'))},5000);function changed(){clearTimeout(timer);resolve()}navigator.serviceWorker.addEventListener('controllerchange',changed,{once:true})});
  return registration;
 })();
 return workerReady;
}
export async function cloudVideo(key,m){
 if(typeof navigator==='undefined'||!navigator.serviceWorker||!globalThis.isSecureContext)return cloudMedia(key,m);
 const cacheKey=key+':'+m.id;
 if(playbackUrls.has(cacheKey))return playbackUrls.get(cacheKey);
 const task=(async()=>{
  try{
   await Promise.race([prepareWorker(),new Promise((_,reject)=>setTimeout(()=>reject(Error("영상 재생 준비 실패")),8000))]);const session=crypto.randomUUID();const context={key,media:m,config};videoSessions.set(session,context);
   await messageWorker(navigator.serviceWorker.controller,{type:'media-context',session,context});
   const url=new URL('./__media/'+m.id,import.meta.url);url.searchParams.set('session',session);return url.href;
  }catch{return cloudMedia(key,m)}
 })();playbackUrls.set(cacheKey,task);return task;
}
