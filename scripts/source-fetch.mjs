// Bounded retries for official public sources. Validation failures are permanent.
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const MAX_WAIT_MS = 2000;
class SourceFetchError extends Error {
  constructor(code, retryable = false, retryAfter = null) {
    super(code); this.name = 'SourceFetchError'; this.code = code;
    this.retryable = retryable; this.retryAfter = retryAfter;
  }
}
export function sourceFailureReason(error) {
  if (error instanceof SourceFetchError) return error.code;
  if (error?.name === 'AbortError') return 'aborted';
  if (error?.name === 'TimeoutError') return 'timeout';
  return 'invalid source data';
}
function retryAfterMs(value) {
  if (!value) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.min(MAX_WAIT_MS, Math.max(0, delay)) : 0;
}
export function waitForRetry(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, {once: true});
  });
}
async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The rejected body is never consumed or logged. */ }
}
async function readBytes(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) {
    await discard(response); throw new SourceFetchError('source exceeds size limit');
  }
  const chunks = []; let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, {once: true});
    try {
      while (true) {
        signal.throwIfAborted();
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new SourceFetchError('source exceeds size limit'); }
        chunks.push(Buffer.from(value));
      }
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, size);
}
export async function fetchSourceBytes(url, {accept, maxBytes, headers = {}, signal, fetcher = fetch, sleep = waitForRetry, random = Math.random, timeoutMs = 30000} = {}) {
  const initial = new URL(url), origin = initial.origin;
  if (initial.protocol !== 'https:' || initial.username || initial.password || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SourceFetchError('invalid source request');
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let failure;
    try {
      let current = initial.href, response;
      for (let redirects = 0; ; redirects++) {
        response = await fetcher(current, {headers: {...headers, Accept: accept}, cache: 'no-store', redirect: 'manual', signal: attemptSignal});
        attemptSignal.throwIfAborted();
        if (response.url && new URL(response.url).origin !== origin) { await discard(response); throw new SourceFetchError('unexpected source redirect'); }
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await discard(response);
        if (!location || redirects >= 3) throw new SourceFetchError('unexpected source redirect');
        const target = new URL(location, current);
        if (target.origin !== origin || target.username || target.password) throw new SourceFetchError('unexpected source redirect');
        current = target.href;
      }
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after'); await discard(response);
        throw new SourceFetchError(`HTTP ${response.status}`, TRANSIENT_STATUS.has(response.status), retryAfter);
      }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (accept === 'application/json' ? !(type === 'application/json' || type?.endsWith('+json')) : type !== accept) {
        await discard(response); throw new SourceFetchError('unexpected source content type');
      }
      return {buffer: await readBytes(response, maxBytes, attemptSignal), response};
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SourceFetchError) failure = error;
      else if (timeout.aborted || error?.name === 'TimeoutError') failure = new SourceFetchError('timeout', true);
      else if (error instanceof TypeError || TRANSIENT_CODES.has(error?.code) || TRANSIENT_CODES.has(error?.cause?.code)) failure = new SourceFetchError('network error', true);
      else throw error;
    }
    if (!failure.retryable || attempt === 2) throw failure;
    const backoff = Math.min(MAX_WAIT_MS, 250 * 2 ** attempt + 125 * Math.max(0, Math.min(1, random())));
    await sleep(Math.max(backoff, retryAfterMs(failure.retryAfter)), signal);
    signal?.throwIfAborted();
  }
}
