import { rangeResponse } from './media-range.js';
const sessions = new Map(), transferred = new Map();
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const data = event.data;
  if (data?.type === 'media-context') {
    sessions.set(data.session, data.context);
    event.ports[0]?.postMessage({ ok: true });
  } else if (data?.type === 'media-stats') {
    event.ports[0]?.postMessage({ bytes: transferred.get(data.session) || 0 });
  }
});
async function contextFor(event, session) {
  if (sessions.has(session)) return sessions.get(session);
  // Workers can be restarted by the browser; recover the capability from its owning page.
  const client = event.clientId && await self.clients.get(event.clientId);
  if (!client) return null;
  const channel = new MessageChannel();
  return new Promise(resolve => {
    const timeout = setTimeout(() => { channel.port1.close(); resolve(null); }, 2000);
    channel.port1.onmessage = answer => {
      clearTimeout(timeout); channel.port1.close();
      if (answer.data) sessions.set(session, answer.data);
      resolve(answer.data || null);
    };
    client.postMessage({ type: 'media-context-needed', session }, [channel.port2]);
  });
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const prefix = new URL('./__media/', self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(prefix)) return;
  event.respondWith((async () => {
    const session = url.searchParams.get('session');
    const context = await contextFor(event, session);
    if (!context || url.pathname.slice(prefix.length) !== context.media.id) return new Response('Media session unavailable', {status: 404});
    const {key, media, config} = context;
    return rangeResponse(event.request, media, async (part, lo, hi, signal) => {
      const headers = { apikey: config.publishableKey, 'x-client-info': key, Range: `bytes=${lo}-${hi}` };
      if (config.publishableKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + config.publishableKey;
      let failure;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(config.supabaseUrl + '/storage/v1/object/authenticated/draftroom-media/' + media.id + '/' + part, {headers, signal, cache: 'no-store'});
          if (!r.ok) throw Error('영상 조각 로딩 실패: ' + r.status);
          const bytes = new Uint8Array(await r.arrayBuffer());
          return r.status === 206 ? bytes : bytes.slice(lo, hi + 1);
        } catch (error) {
          if (signal.aborted) throw error;
          failure = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      throw failure;
    }, bytes => transferred.set(session, (transferred.get(session) || 0) + bytes));
  })());
});
