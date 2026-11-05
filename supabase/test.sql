-- Run in an isolated Supabase-compatible database after schema.sql. Rolls back all test data.
begin;
do $$
declare setup jsonb;e text;r text;a uuid;b uuid;d jsonb;d2 jsonb;media jsonb;state jsonb;answer jsonb;k text;i integer;
begin
 if exists(select 1 from public.draftroom_workspaces) then raise exception 'Use an empty isolated database for this test';end if;
 setup:=public.draftroom_initialize();e:=setup->>'editorKey';r:=setup->>'reviewKey';
 state:=public.draftroom_api(e,'state');a:=(state->'accounts'->0->>'id')::uuid;
 assert state->>'editor'='true';assert state->>'reviewKey'=r;
 assert not has_table_privilege('anon','public.draftroom_workspaces','select');
 assert not has_function_privilege('anon','public.draftroom_initialize()','execute');
 assert has_function_privilege('anon','public.draftroom_api(text,text,text,jsonb)','execute');
 answer:=public.draftroom_api(e,'accounts','POST','{"name":"브랜드 B","username":"brand.b","displayName":"브랜드 B"}');b:=(answer->>'id')::uuid;
 d:=public.draftroom_api(e,'drafts','POST',jsonb_build_object('accountId',a));k:=d->>'clientKey';
 d2:=public.draftroom_api(e,'drafts','POST',jsonb_build_object('accountId',b));
 answer:=public.draftroom_api(e,'accounts/'||a,'PATCH','{"username":"shared.profile"}');
 state:=public.draftroom_api(k,'state');assert jsonb_array_length(state->'drafts')=1;assert jsonb_array_length(state->'accounts')=1;assert state->'drafts'->0->>'username'='shared.profile';assert not(state->'drafts'->0 ? 'clientKey');
 begin perform public.draftroom_api(k,'drafts/'||(d->>'id'),'PATCH','{"caption":"blocked"}');raise exception 'Read-only write was allowed';exception when insufficient_privilege then null;end;
 begin perform public.draftroom_api(repeat('0',64),'state');raise exception 'Invalid key was allowed';exception when insufficient_privilege then null;end;
 media:=public.draftroom_api(e,'upload/register','POST','{"name":"100MiB.mp4","size":104857600,"type":"video/mp4"}');assert(media->>'chunks')::int=20;
 begin perform public.draftroom_api(e,'upload/'||(media->>'id')||'/complete','POST');raise exception 'Incomplete upload accepted';exception when raise_exception then assert sqlerrm like '%누락%';end;
 for i in 0..19 loop insert into storage.objects(bucket_id,name,metadata)values('draftroom-media',(media->>'id')||'/'||i,jsonb_build_object('size',5242880));end loop;
 perform public.draftroom_api(e,'upload/'||(media->>'id')||'/complete','POST');
 perform public.draftroom_api(e,'drafts/'||(d->>'id'),'PATCH',jsonb_build_object('media',jsonb_build_array(media),'caption','Only draft A'));
 perform set_config('request.headers',jsonb_build_object('x-client-info',k)::text,true);
 assert public.draftroom_storage_allowed((media->>'id')||'/0',false);
 assert not public.draftroom_storage_allowed((media->>'id')||'/0',true);
 perform set_config('request.headers',jsonb_build_object('x-client-info',d2->>'clientKey')::text,true);
 assert not coalesce(public.draftroom_storage_allowed((media->>'id')||'/0',false),false);
 perform set_config('request.headers',jsonb_build_object('x-client-info',e)::text,true);
 assert not public.draftroom_storage_allowed((media->>'id')||'/0',true); -- ready uploads are immutable
 state:=public.draftroom_api(r,'state');assert jsonb_array_length(state->'drafts')=2;assert not(state->'drafts'->0 ? 'clientKey');
 raise notice 'PASS: profile sharing, draft/account scope, read-only links, metadata ACL, 100MiB chunks, incomplete upload rejection, private storage scope and immutability';
end$$;
rollback;
