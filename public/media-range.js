// Serve an original file as HTTP byte ranges over its existing 5MiB objects.
export const CHUNK_SIZE = 5242880;
export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end, partial: true };
}
export function rangeResponse(request, media, fetchPart, onBytes = () => {}) {
  const range = parseRange(request.headers.get('Range'), media.size);
  if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.size}` } });
  const headers = { 'Content-Type': media.type, 'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1), 'Cache-Control': 'private, no-store' };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${media.size}`;
  if (request.method === 'HEAD') return new Response(null, {status: range.partial ? 206 : 200, headers});
  const abort = new AbortController();
  let next = Math.floor(range.start / CHUNK_SIZE);
  const last = Math.floor(range.end / CHUNK_SIZE), pending = new Map();
  const schedule = part => {
    if (part > last || pending.has(part) || abort.signal.aborted) return;
    const lo = Math.max(range.start, part * CHUNK_SIZE) - part * CHUNK_SIZE;
    const hi = Math.min(range.end, (part + 1) * CHUNK_SIZE - 1) - part * CHUNK_SIZE;
    const task = Promise.resolve(fetchPart(part, lo, hi, abort.signal));
    task.catch(() => {}); // A cancelled stream can leave prefetched requests unconsumed.
    pending.set(part, task);
  };
  let reader = null, partBytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (next <= last) {
          if (!reader) {
            for (let i = next; i <= Math.min(last, next + 2); i++) schedule(i);
            const source = await pending.get(next);
            if (abort.signal.aborted) return;
            reader = source instanceof Uint8Array
              ? new ReadableStream({start(c) { c.enqueue(source); c.close(); }}).getReader()
              : source.getReader();
            partBytes = 0;
          }
          const {done, value} = await reader.read();
          if (abort.signal.aborted) return;
          if (done) {
            const lo = Math.max(range.start, next * CHUNK_SIZE);
            const hi = Math.min(range.end, (next + 1) * CHUNK_SIZE - 1);
            if (partBytes !== hi - lo + 1) throw Error('영상 조각 크기가 다릅니다');
            reader.releaseLock(); reader = null; pending.delete(next++);
            continue;
          }
          partBytes += value.byteLength; onBytes(value.byteLength);
          controller.enqueue(value);
          return;
        }
        controller.close();
      } catch (error) {
        const cancelled = abort.signal.aborted;
        abort.abort();
        if (!cancelled) controller.error(error);
      }
    },
    cancel() { abort.abort(); reader?.cancel().catch(() => {}); pending.clear(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: range.partial ? 206 : 200, headers });
}
