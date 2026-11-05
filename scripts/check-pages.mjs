import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const context={window:{}};vm.runInNewContext(readFileSync('public/config.js','utf8'),context);
const config=context.window.DRAFTROOM_CONFIG;
assert.equal(config?.supabaseUrl,'https://nfnhapavxiyobacvdrym.supabase.co','Configure the Supabase backend before publishing.');
assert.equal(typeof config.publishableKey,'string');
assert.ok(config.publishableKey.length>20);
assert.ok(!config.publishableKey.startsWith('sb_secret_'),'Secret keys must not be published');
if(config.publishableKey.startsWith('eyJ')){const claims=JSON.parse(Buffer.from(config.publishableKey.split('.')[1],'base64url'));assert.equal(claims.role,'anon','Only the anon key belongs in a static frontend.');}
const html=readFileSync('public/index.html','utf8');assert.ok(html.includes('./viewer.js'));assert.ok(html.includes('./config.js'));
console.log('Public Supabase configuration and GitHub Pages paths verified.');
