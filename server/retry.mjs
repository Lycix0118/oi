import { setTimeout as delay } from "node:timers/promises";
export const retryable = (status) =>
  [408, 429, 500, 502, 503, 504].includes(status);
// Only retry before consuming a stream; never replay output or file mutations.
export async function fetchRetry(fetchImpl, url, options, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, options);
      if (!retryable(response.status) || attempt >= retries) return response;
    } catch (error) {
      if (options.signal?.aborted || attempt >= retries) throw error;
    }
    const header = response?.headers.get("retry-after");
    const requested = header
      ? Number.isFinite(Number(header))
        ? Number(header) * 1000
        : Date.parse(header) - Date.now()
      : 0;
    await response?.body?.cancel();
    await delay(
      Math.min(30000, Math.max(requested || 0, 500 * 2 ** attempt)) +
        Math.random() * 200,
      undefined,
      { signal: options.signal },
    );
  }
}
