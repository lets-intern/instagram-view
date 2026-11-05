#!/usr/bin/env bash
set -euo pipefail
fixture=${VIDEO_FIXTURE:-/tmp/draftroom-100mb.mp4}
image=${DRAFTROOM_IMAGE:-draftroom:deploy}
name="draftroom-validation-$$"
volume="$name-data"
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"
}
cleanup() {
  docker_local rm -f "$name" >/dev/null 2>&1 || true
  docker_local volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[ -f "$fixture" ]
docker_local volume create "$volume" >/dev/null
docker_local run -d --name "$name" -v "$volume:/data" "$image" >/dev/null
docker_local cp "$fixture" "$name:/tmp/fixture.mp4"
docker_local exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,createReadStream,statSync} from 'node:fs';
const db=JSON.parse(readFileSync('/data/state.json'));
const base='http://127.0.0.1:3000';
assert.equal((await fetch(base+'/healthz')).status,200);
assert.equal(statSync('/tmp/fixture.mp4').size,104857600);
const headers={Authorization:'Bearer '+db.edit,'Content-Type':'application/json'};
const d=await(await fetch(base+'/api/drafts',{method:'POST',headers,body:JSON.stringify({name:'container-persistence',caption:'영구 볼륨 확인'})})).json();
const uploaded=await fetch(base+'/api/upload',{method:'POST',headers:{Authorization:'Bearer '+db.edit,'Content-Type':'video/mp4'},body:createReadStream('/tmp/fixture.mp4'),duplex:'half'});
assert.equal(uploaded.status,201);const m=await uploaded.json();assert.equal(m.size,104857600);
assert.equal((await fetch(base+'/api/drafts/'+d.id,{method:'PATCH',headers,body:JSON.stringify({media:[{...m,name:'100MiB.mp4'}]})})).status,200);
const r=await fetch(base+'/api/media/'+m.id,{headers:{Authorization:'Bearer '+d.clientKey,Range:'bytes=0-1023'}});
assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,1024);
console.log('PASS: container health, 100MiB upload, scoped media range');
JS
docker_local rm -f "$name" >/dev/null
docker_local run -d --name "$name" -v "$volume:/data" "$image" >/dev/null
docker_local exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:3000/healthz')).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
const db=JSON.parse(readFileSync('/data/state.json'));
const res=await fetch('http://127.0.0.1:3000/api/state',{headers:{Authorization:'Bearer '+db.edit}});assert.equal(res.status,200);
const state=await res.json();const d=state.drafts.find(d=>d.name==='container-persistence');assert.equal(d.caption,'영구 볼륨 확인');assert.equal(statSync('/data/media/'+d.media[0].id).size,104857600);
console.log('PASS: fresh container restored account, draft, caption, media and keys from persistent volume');
JS
