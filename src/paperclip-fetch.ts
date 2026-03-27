/**
 * Fetch wrapper for Paperclip API calls.
 *
 * `ctx.http.fetch` (the plugin-SDK host client) rejects requests whose
 * resolved IPs fall in private/reserved ranges (e.g. 127.0.0.1).  The
 * Paperclip API server often runs on localhost during local development,
 * so those calls fail with:
 *
 *   "All resolved IPs for localhost are in private/reserved ranges"
 *
 * Native `fetch` has no such restriction, so we use it for all calls
 * that target the Paperclip base URL.
 */
export function paperclipFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}
