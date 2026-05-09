import { describe, it, expect, vi, beforeEach } from "vitest";
import { createChannel, postPlainMessage } from "../src/discord-api.js";

// ---------------------------------------------------------------------------
// Helpers — minimal PluginContext shape needed by discord-api.ts
// ---------------------------------------------------------------------------

function makeCtx(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    http: { fetch: vi.fn().mockImplementation(fetchImpl) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------

describe("createChannel", () => {
  it("POSTs to /guilds/{guild}/channels with the right payload", async () => {
    const seenInits: RequestInit[] = [];
    const seenUrls: string[] = [];
    const ctx = makeCtx(async (url, init) => {
      seenUrls.push(url);
      seenInits.push(init);
      return jsonResponse({
        id: "1234567890123456789",
        name: "project-checkout-api",
        type: 0,
        parent_id: "9999999999999999999",
        topic: "Managed by SpecPaper",
      });
    });

    const result = await createChannel(ctx, "test-token", "11111", "project-checkout-api", {
      parentId: "9999999999999999999",
      topic: "Managed by SpecPaper",
    });

    expect(result).toEqual({
      id: "1234567890123456789",
      name: "project-checkout-api",
      type: 0,
      parent_id: "9999999999999999999",
      topic: "Managed by SpecPaper",
    });
    expect(seenUrls[0]).toContain("/guilds/11111/channels");
    expect(seenInits[0]?.method).toBe("POST");
    expect(seenInits[0]?.headers as Record<string, string>).toMatchObject({
      Authorization: "Bot test-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(seenInits[0]?.body));
    expect(body).toMatchObject({
      name: "project-checkout-api",
      type: 0,
      parent_id: "9999999999999999999",
      topic: "Managed by SpecPaper",
    });
  });

  it("defaults type to 0 (GUILD_TEXT) when omitted", async () => {
    const seenInits: RequestInit[] = [];
    const ctx = makeCtx(async (_url, init) => {
      seenInits.push(init);
      return jsonResponse({ id: "1", name: "x", type: 0 });
    });

    await createChannel(ctx, "tok", "g", "x");
    expect(JSON.parse(String(seenInits[0]?.body)).type).toBe(0);
  });

  it("returns null and logs when Discord responds non-2xx", async () => {
    const ctx = makeCtx(async () => new Response("permission denied", { status: 403 }));
    const result = await createChannel(ctx, "tok", "g", "name");
    expect(result).toBeNull();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("returns null and logs when fetch throws", async () => {
    const ctx = makeCtx(async () => {
      throw new Error("network down");
    });
    const result = await createChannel(ctx, "tok", "g", "name");
    expect(result).toBeNull();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// postPlainMessage (thin wrapper over postEmbed)
// ---------------------------------------------------------------------------

describe("postPlainMessage", () => {
  it("returns true on a successful post", async () => {
    const ctx = makeCtx(async () => jsonResponse({ id: "msg-1" }));
    const ok = await postPlainMessage(ctx, "tok", "channel-1", "hello world");
    expect(ok).toBe(true);
  });

  it("returns false on a non-retryable Discord API error", async () => {
    // 403 is not in RETRYABLE_STATUS_CODES (429, 500, 502, 503), so it bails fast
    const ctx = makeCtx(async () => new Response("forbidden", { status: 403 }));
    const ok = await postPlainMessage(ctx, "tok", "channel-1", "hello");
    expect(ok).toBe(false);
  });
});
