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
 const promise=(async()=>{const chunks=[];for(let part=0;part<m.chunks;part++){const blob=await retry(async()=>{const r=await fetch(config.supabaseUrl+'/storage/v1/object/authenticated/draftroom-media/'+m.id+'/'+part,{headers:headers(key),cache:'no-store'});if(!r.ok)throw Error('미디어 조각을 불러올 수 없습니다');return r.blob()});chunks.push(blob)}return URL.createObjectURL(new Blob(chunks,{type:m.type}))})();
 cache.set(m.id,promise);try{return await promise}catch(e){cache.delete(m.id);throw e}
}
