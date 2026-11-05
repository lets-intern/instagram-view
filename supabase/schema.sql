begin;

create table if not exists public.draftroom_workspaces (
 id uuid primary key default gen_random_uuid(),
 editor_hash text not null unique,
 editor_key text,
 reviewer_hash text not null unique,
 reviewer_key text not null
);
alter table public.draftroom_workspaces add column if not exists editor_key text;
create table if not exists public.draftroom_accounts (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.draftroom_workspaces(id),
 payload jsonb not null
);
create table if not exists public.draftroom_drafts (
 id uuid primary key default gen_random_uuid(),
 account_id uuid not null references public.draftroom_accounts(id),
 client_key text not null default encode(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()),'hex'),
 payload jsonb not null,
 created_at timestamptz not null default now()
);
create table if not exists public.draftroom_media (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.draftroom_workspaces(id),
 name text not null,
 mime text not null check(mime in ('image/jpeg','image/png','video/mp4','video/quicktime')),
 bytes bigint not null check(bytes between 1 and 104857600),
 chunks integer not null check(chunks between 1 and 20),
 ready boolean not null default false
);
alter table public.draftroom_workspaces enable row level security;
alter table public.draftroom_accounts enable row level security;
alter table public.draftroom_drafts enable row level security;
alter table public.draftroom_media enable row level security;
revoke all on public.draftroom_workspaces,public.draftroom_accounts,public.draftroom_drafts,public.draftroom_media from anon,authenticated;

create or replace function public.draftroom_hash(k text) returns text
language sql immutable set search_path='' as $$select encode(sha256(convert_to(k,'UTF8')),'hex')$$;
revoke all on function public.draftroom_hash(text) from public;

create or replace function public.draftroom_validate_profile(p jsonb) returns void
language plpgsql set search_path='' as $$
declare k text;
begin
 for k in select unnest(array['name','username','displayName']) loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(trim(p->>k)) not between 1 and 100 then raise exception '계정 이름은 1~100자로 입력하세요';end if;
 end loop;
 if jsonb_typeof(p->'verified') is distinct from 'boolean' then raise exception '인증 배지 값 오류';end if;
end$$;
revoke all on function public.draftroom_validate_profile(jsonb) from public;

create or replace function public.draftroom_validate_draft(p jsonb) returns void
language plpgsql set search_path='' as $$
declare k text;
begin
 if jsonb_typeof(p->'type') is distinct from 'string' or jsonb_typeof(p->'ratio') is distinct from 'string' or jsonb_typeof(p->'fit') is distinct from 'string' or jsonb_typeof(p->'status') is distinct from 'string' or (p->>'type') not in ('carousel','reel') or (p->>'ratio') not in ('1 / 1','4 / 5','1.91 / 1') or (p->>'fit') not in ('cover','contain') or (p->>'status') not in ('검토 대기','승인','수정 필요') then raise exception '설정 값 오류';end if;
 for k in select unnest(array['name','caption','audio','time','location']) loop
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>20000 then raise exception '텍스트 값 오류';end if;
 end loop;
 for k in select unnest(array['likes','commentCount']) loop
  if jsonb_typeof(p->k) is distinct from 'number' or (p->>k)::numeric<0 then raise exception '숫자 값 오류';end if;
 end loop;
 if jsonb_typeof(p->'media') is distinct from 'array' or jsonb_array_length(p->'media')>(case when p->>'type'='reel' then 1 else 20 end) then raise exception '미디어 수 제한 초과';end if;
end$$;
revoke all on function public.draftroom_validate_draft(jsonb) from public;

-- Called only by the project administrator, never by a browser.
create or replace function public.draftroom_initialize() returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text:=encode(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()),'hex');r text:=encode(uuid_send(gen_random_uuid())||uuid_send(gen_random_uuid()),'hex');w uuid;
begin
 if exists(select 1 from public.draftroom_workspaces) then select editor_key,reviewer_key into e,r from public.draftroom_workspaces limit 1;return jsonb_build_object('existing',true,'editorKey',e,'reviewKey',r);end if;
 insert into public.draftroom_workspaces(editor_hash,editor_key,reviewer_hash,reviewer_key)values(public.draftroom_hash(e),e,public.draftroom_hash(r),r)returning id into w;
 insert into public.draftroom_accounts(workspace_id,payload)values(w,'{"name":"렛츠커리어","username":"lets.career","displayName":"렛츠커리어","verified":false}'::jsonb);
 return jsonb_build_object('editorKey',e,'reviewKey',r);
end$$;
revoke all on function public.draftroom_initialize() from public,anon,authenticated;
grant execute on function public.draftroom_initialize() to service_role;

-- Every metadata operation is scoped by an unguessable capability. The public API key alone grants nothing.
create or replace function public.draftroom_api(p_key text,p_path text,p_method text default 'GET',p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;ed boolean:=false;client_id uuid;target uuid;account_id uuid;profile jsonb;draft_payload jsonb;result jsonb;item jsonb;m public.draftroom_media;d public.draftroom_drafts;request_id text;parts integer;
begin
 if p_key is null or p_key!~'^[a-f0-9]{64}$' then raise exception '유효한 공유 링크가 필요합니다' using errcode='42501';end if;
 select id,editor_hash=public.draftroom_hash(p_key) into w,ed from public.draftroom_workspaces where editor_hash=public.draftroom_hash(p_key) or reviewer_hash=public.draftroom_hash(p_key);
 if w is null then
  select dd.id,aa.workspace_id into client_id,w from public.draftroom_drafts dd join public.draftroom_accounts aa on aa.id=dd.account_id where dd.client_key=p_key;
 end if;
 if w is null then raise exception '유효한 공유 링크가 필요합니다' using errcode='42501';end if;
 ed:=coalesce(ed,false);
 if p_path='state' and p_method='GET' then
  select jsonb_build_object('editor',ed,'client',client_id is not null,'reviewKey',case when ed then(select reviewer_key from public.draftroom_workspaces where id=w)else null end,
   'accounts',coalesce((select jsonb_agg(a.payload||jsonb_build_object('id',a.id))from public.draftroom_accounts a where a.workspace_id=w and(client_id is null or a.id=(select x.account_id from public.draftroom_drafts x where x.id=client_id))),'[]'::jsonb),
   'drafts',coalesce((select jsonb_agg(dd.payload||jsonb_build_object('id',dd.id,'accountId',a.id,'username',a.payload->'username','displayName',a.payload->'displayName','verified',a.payload->'verified','avatar',a.payload->'avatar')||case when ed then jsonb_build_object('clientKey',dd.client_key)else '{}'::jsonb end order by dd.created_at,dd.id)from public.draftroom_drafts dd join public.draftroom_accounts a on a.id=dd.account_id where a.workspace_id=w and(client_id is null or dd.id=client_id)),'[]'::jsonb))into result;
  return result;
 end if;
 if not ed then raise exception '읽기 전용 링크입니다' using errcode='42501';end if;
 -- Serialize a workspace's metadata mutations, including account/draft membership checks.
 perform 1 from public.draftroom_workspaces where id=w for update;
 if p_path='accounts' and p_method='POST' then
  profile:='{"name":"새 계정","username":"new.account","displayName":"새 계정","verified":false}'::jsonb||p_data;
  profile:=profile-array['id','workspace_id','avatar'];perform public.draftroom_validate_profile(profile);
  insert into public.draftroom_accounts(workspace_id,payload)values(w,profile)returning id into target;
  return profile||jsonb_build_object('id',target);
 elsif p_path~'^accounts/[a-f0-9-]+$' and p_method='PATCH' then
  target:=split_part(p_path,'/',2)::uuid;
  select a.payload into profile from public.draftroom_accounts a where a.id=target and a.workspace_id=w;
  if profile is null then raise exception '계정을 찾을 수 없습니다';end if;
  profile:=profile||(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)from jsonb_each(p_data)where key=any(array['name','username','displayName','verified','avatar']));
  perform public.draftroom_validate_profile(profile);
  if profile->'avatar' is not null and profile->'avatar'<>'null'::jsonb then
   select * into m from public.draftroom_media mm where mm.id=(profile->'avatar'->>'id')::uuid and mm.workspace_id=w and mm.ready and mm.mime like 'image/%';
   if m.id is null then raise exception '프로필 이미지 오류';end if;
   profile:=jsonb_set(profile,'{avatar}',jsonb_build_object('id',m.id,'name',m.name,'type',m.mime,'size',m.bytes,'chunks',m.chunks));
  end if;
  update public.draftroom_accounts set payload=profile where id=target;return profile||jsonb_build_object('id',target);
 elsif p_path='drafts' and p_method='POST' then
  account_id:=(p_data->>'accountId')::uuid;
  if not exists(select 1 from public.draftroom_accounts a where a.id=account_id and a.workspace_id=w)then raise exception '계정을 선택하세요';end if;
  draft_payload:='{"name":"새로운 초안","type":"carousel","caption":"","likes":128,"commentCount":8,"time":"방금 전","location":"","ratio":"4 / 5","fit":"cover","status":"검토 대기","audio":"오리지널 오디오","media":[]}'::jsonb;
  if p_data ? 'name' then draft_payload:=jsonb_set(draft_payload,'{name}',p_data->'name');end if;
  perform public.draftroom_validate_draft(draft_payload);
  insert into public.draftroom_drafts(account_id,payload)values(account_id,draft_payload)returning * into d;
  return draft_payload||jsonb_build_object('id',d.id,'accountId',d.account_id,'clientKey',d.client_key);
 elsif p_path~'^drafts/[a-f0-9-]+$' and p_method in ('PATCH','DELETE') then
  target:=split_part(p_path,'/',2)::uuid;
  select dd.* into d from public.draftroom_drafts dd join public.draftroom_accounts a on a.id=dd.account_id where dd.id=target and a.workspace_id=w;
  if d.id is null then raise exception '초안을 찾을 수 없습니다';end if;
  if p_method='DELETE' then delete from public.draftroom_drafts where id=target;return '{"ok":true}'::jsonb;end if;
  draft_payload:=d.payload||(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)from jsonb_each(p_data)where key=any(array['name','type','caption','likes','commentCount','time','location','ratio','fit','status','audio','media','cover']));
  perform public.draftroom_validate_draft(draft_payload);
  result:='[]'::jsonb;
  for item in select value from jsonb_array_elements(draft_payload->'media') loop
   select * into m from public.draftroom_media mm where mm.id=(item->>'id')::uuid and mm.workspace_id=w and mm.ready;
   if m.id is null or(draft_payload->>'type'='reel' and m.mime not like 'video/%')then raise exception '미디어를 확인하세요';end if;
   result:=result||jsonb_build_array(jsonb_build_object('id',m.id,'name',m.name,'type',m.mime,'size',m.bytes,'chunks',m.chunks));
  end loop;
  draft_payload:=jsonb_set(draft_payload,'{media}',result);
  if draft_payload->'cover' is not null and draft_payload->'cover'<>'null'::jsonb then
   select * into m from public.draftroom_media mm where mm.id=(draft_payload->'cover'->>'id')::uuid and mm.workspace_id=w and mm.ready and mm.mime like 'image/%';
   if m.id is null then raise exception '커버 이미지를 확인하세요';end if;
   draft_payload:=jsonb_set(draft_payload,'{cover}',jsonb_build_object('id',m.id,'name',m.name,'type',m.mime,'size',m.bytes,'chunks',m.chunks));
  end if;
  update public.draftroom_drafts set payload=draft_payload where id=target;return draft_payload||jsonb_build_object('id',target,'accountId',d.account_id,'clientKey',d.client_key);
 elsif p_path='upload/register' and p_method='POST' then
  parts:=ceil((p_data->>'size')::numeric/5242880)::integer;
  insert into public.draftroom_media(workspace_id,name,mime,bytes,chunks)values(w,left(p_data->>'name',255),p_data->>'type',(p_data->>'size')::bigint,parts)returning * into m;
  return jsonb_build_object('id',m.id,'name',m.name,'type',m.mime,'size',m.bytes,'chunks',m.chunks);
 elsif p_path~'^upload/[a-f0-9-]+/complete$' and p_method='POST' then
  target:=split_part(p_path,'/',2)::uuid;select * into m from public.draftroom_media mm where mm.id=target and mm.workspace_id=w;
  if m.id is null then raise exception '업로드 정보를 찾을 수 없습니다';end if;
  for parts in 0..m.chunks-1 loop
   if not exists(select 1 from storage.objects o where o.bucket_id='draftroom-media' and o.name=target::text||'/'||parts::text and (o.metadata->>'size')::bigint=least(5242880,m.bytes-parts::bigint*5242880)) then raise exception '업로드 조각이 누락되었거나 크기가 다릅니다';end if;
  end loop;
  update public.draftroom_media set ready=true where id=target;return jsonb_build_object('ok',true);
 end if;
 raise exception '지원하지 않는 요청입니다';
end$$;
revoke all on function public.draftroom_api(text,text,text,jsonb) from public;
grant execute on function public.draftroom_api(text,text,text,jsonb) to anon,authenticated;

create or replace function public.draftroom_storage_allowed(object_name text,writing boolean default false) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare k text;w uuid;mid uuid;d public.draftroom_drafts;a public.draftroom_accounts;m public.draftroom_media;
begin
 k:=coalesce(current_setting('request.headers',true),'{}')::jsonb->>'x-client-info';
 if k is null or k!~'^[a-f0-9]{64}$' or object_name!~'^[a-f0-9-]{36}/[0-9]{1,2}$' then return false;end if;
 mid:=split_part(object_name,'/',1)::uuid;
 select * into m from public.draftroom_media where id=mid;
 if m.id is null or split_part(object_name,'/',2)::integer>=m.chunks then return false;end if;
 select id into w from public.draftroom_workspaces where editor_hash=public.draftroom_hash(k);
 if w=m.workspace_id then return not writing or not m.ready;end if;
 if writing or not m.ready then return false;end if;
 select id into w from public.draftroom_workspaces where reviewer_hash=public.draftroom_hash(k);
 if w=m.workspace_id then return true;end if;
 select dd.* into d from public.draftroom_drafts dd where dd.client_key=k;
 if d.id is null then return false;end if;
 select * into a from public.draftroom_accounts where id=d.account_id;
 if a.workspace_id<>m.workspace_id then return false;end if;
 return exists(select 1 from jsonb_array_elements(d.payload->'media')item where item->>'id'=mid::text)or d.payload->'cover'->>'id'=mid::text or a.payload->'avatar'->>'id'=mid::text;
exception when invalid_text_representation then return false;
end$$;
revoke all on function public.draftroom_storage_allowed(text,boolean) from public;
grant execute on function public.draftroom_storage_allowed(text,boolean) to anon,authenticated;

-- All original files, including 100MiB video, are stored as <=5MiB objects.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('draftroom-media','draftroom-media',false,5242880,array['application/octet-stream'])
on conflict(id)do update set public=false,file_size_limit=5242880,allowed_mime_types=array['application/octet-stream'];
drop policy if exists draftroom_media_read on storage.objects;
create policy draftroom_media_read on storage.objects for select to anon,authenticated using(bucket_id='draftroom-media' and public.draftroom_storage_allowed(name,false));
drop policy if exists draftroom_media_insert on storage.objects;
create policy draftroom_media_insert on storage.objects for insert to anon,authenticated with check(bucket_id='draftroom-media' and public.draftroom_storage_allowed(name,true));
commit;
