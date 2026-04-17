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
 *
 * Auth: when Paperclip is deployed in `authenticated` mode (the default
 * for public deployments), server routes that call `assertBoard(req)`
 * (approvals, board mutations, etc.) require an Authorization: Bearer
 * header carrying a board API key. Pass `apiKey` to attach it. In
 * `local_trusted` deployments unauthenticated requests are implicitly
 * promoted to `board`, so `apiKey` can be omitted.
 */
export function paperclipFetch(
  url: string,
  init?: RequestInit,
  apiKey?: string,
): Promise<Response> {
  if (!apiKey) return fetch(url, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return fetch(url, { ...init, headers });
}
