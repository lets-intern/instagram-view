#!/usr/bin/env python3
"""Provision this app's namespaced Supabase resources and publish GitHub Pages.
Credentials are read only from the environment. No credential values are logged.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import urllib.error

REF = 'nfnhapavxiyobacvdrym'
PROJECT_URL = f'https://{REF}.supabase.co'
REPO = 'lets-intern/instagram-view'
ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / 'data' / 'deployment-links.json'

def request(url, token, method='GET', data=None):
    req = urllib.request.Request(url, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Draftroom-deployment',
    }, data=json.dumps(data).encode() if data is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        # Do not dump response bodies: management responses can contain keys.
        raise RuntimeError(f'{method} {req.host}{req.selector.split("?")[0]}: HTTP {exc.code}') from None

def git(*args, allow_failure=False):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    if r.returncode and not allow_failure:
        raise RuntimeError('Git command failed: ' + args[0] + '. Local files have been preserved.')
    return r

def cleanup_test(endpoint, token, service_key):
    qa = ROOT/'data'/'deployment-test.json'
    if not qa.exists():
        return
    subprocess.run(['node','scripts/supabase-smoke.mjs','--cleanup'],check=True,cwd=ROOT,env={**os.environ,'SUPABASE_SERVICE_ROLE_KEY':service_key})
    ids = json.loads(qa.read_text()).get('media', [])
    import re
    ids = [m['id'] for m in ids if re.fullmatch(r'[a-f0-9-]{36}',m.get('id',''))]
    if ids:
        values = ','.join("'"+mid+"'" for mid in ids)
        request(endpoint+'/database/query',token,'POST',{'query':'delete from public.draftroom_media where id in ('+values+');'})
    print('Temporary deployment test data cleaned up.')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--ci', action='store_true')
    parser.add_argument('--cleanup-only', action='store_true')
    args = parser.parse_args()
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        raise RuntimeError('Set SUPABASE_ACCESS_TOKEN securely in environment settings; do not paste it into chat or scripts.')
    github = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
    if args.publish and not github:
        raise RuntimeError('GitHub API authentication is required to configure Pages.')
    endpoint = f'https://api.supabase.com/v1/projects/{REF}'
    project = request(endpoint, token)
    if project.get('id', project.get('ref')) != REF:
        raise RuntimeError('Project identity could not be verified.')
    print('Supabase project access verified.')
    keys = request(endpoint + '/api-keys', token)
    public_key = next((k.get('api_key') for k in keys if k.get('name') == 'anon'), None)
    if not public_key:
        raise RuntimeError('The project anon/public API key is unavailable.')
    service_key = next((k.get('api_key') for k in keys if k.get('name') == 'service_role'), None)
    if args.cleanup_only:
        if not service_key:
            raise RuntimeError('Storage cleanup credential is unavailable.')
        cleanup_test(endpoint, token, service_key)
        return
    migration = (ROOT / 'supabase' / 'schema.sql').read_text()
    request(endpoint + '/database/query', token, 'POST', {'query': migration})
    result = request(endpoint + '/database/query', token, 'POST', {'query': 'select public.draftroom_initialize() as setup;'})
    setup = result[0]['setup']
    if setup.get('editorKey'):
        PRIVATE.parent.mkdir(exist_ok=True, mode=0o700)
        fd = os.open(PRIVATE, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'project': REF, 'editorKey': setup['editorKey'], 'reviewKey': setup['reviewKey']}, out)
    elif not PRIVATE.exists():
        raise RuntimeError('An existing workspace was preserved. Its original editor link is needed; no keys were reset.')
    config = {'supabaseUrl': PROJECT_URL, 'publishableKey': public_key}
    (ROOT / 'public' / 'config.js').write_text('window.DRAFTROOM_CONFIG = ' + json.dumps(config) + ';\n')
    print('Supabase schema, private chunked storage, and public frontend configuration prepared.')
    if args.ci:
        subprocess.run(['openssl','pkeyutl','-encrypt','-pubin','-inkey',str(ROOT/'supabase'/'deploy-public.pem'),'-pkeyopt','rsa_padding_mode:oaep','-pkeyopt','rsa_oaep_md:sha256','-in',str(PRIVATE),'-out',str(ROOT/'supabase'/'deployment-access.enc')],check=True,cwd=ROOT)
        if not service_key:
            raise RuntimeError('Storage cleanup credential is unavailable.')
        subprocess.run(['node','scripts/supabase-smoke.mjs'],check=True,cwd=ROOT,env={**os.environ,'SUPABASE_SERVICE_ROLE_KEY':service_key})
        print('Supabase provisioning and live 100MiB storage checks passed.')
        return
    if not args.publish:
        print('Not published. Rerun with --publish to deploy GitHub Pages.')
        return
    remote = git('ls-remote', '--heads', 'origin', 'main').stdout.strip()
    head = git('rev-parse', '--verify', 'HEAD', allow_failure=True)
    if remote:
        if head.returncode:
            raise RuntimeError('Remote main has commits while this checkout is unborn. Review and integrate the remote before publishing.')
        git('fetch', 'origin', 'main')
        if git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD', allow_failure=True).returncode:
            raise RuntimeError('Remote main has new commits. They were preserved; integrate them before publishing.')
    gh = 'https://api.github.com/repos/' + REPO
    repository = request(gh, github)
    if not repository.get('permissions', {}).get('push'):
        raise RuntimeError('GitHub write permission could not be verified.')
    try:
        request(gh + '/pages', github)
    except RuntimeError as exc:
        if 'HTTP 404' not in str(exc):
            raise
        request(gh + '/pages', github, 'POST', {'build_type': 'workflow'})
    git('add', '.github', '.dockerignore', '.gitignore', 'Dockerfile', 'README.md', 'package.json', 'package-lock.json', 'public', 'scripts', 'server.mjs', 'test', 'supabase')
    if git('diff', '--cached', '--quiet', allow_failure=True).returncode:
        git('-c', 'user.name=Codex', '-c', 'user.email=codex@openai.com', 'commit', '-m', 'feat: add account-based draft review with Supabase')
    git('push', 'origin', 'HEAD:main')
    print('Source published to GitHub; Pages deployment workflow started.')
    print('Check deployment: https://github.com/' + REPO + '/actions')
    print('Private workspace links are retained locally in data/deployment-links.json, excluded from Git.')

if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, urllib.error.URLError, KeyError, ValueError) as exc:
        raise SystemExit(str(exc)) from None
