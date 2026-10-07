// One injectable fetch() for the v2 server libs (Upstash REST, Resend, Paddle API). Tests replace it.
let testFetch = null;

/** Tests inject `async (url, init) => Response`; pass null to restore the global fetch. */
export function setFetchForTests(fake) {
  testFetch = fake || null;
}

/** fetch() with a timeout (ms). Throws on network errors and timeouts, like fetch itself. */
export function httpFetch(url, init = {}, timeoutMs = 8000) {
  const impl = testFetch || globalThis.fetch;
  return impl(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
}
