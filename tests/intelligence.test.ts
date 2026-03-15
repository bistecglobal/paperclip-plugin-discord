import { describe, it, expect } from "vitest";
import { extractSignals, mergeSignals, type Signal } from "../src/intelligence.js";
import type { DiscordChannelMessage } from "../src/discord-api.js";

function makeMessage(
  overrides: Partial<DiscordChannelMessage> = {},
): DiscordChannelMessage {
  return {
    id: "msg-1",
    content: "Hello world, this is a test message",
    author: { id: "user-1", username: "testuser" },
    timestamp: "2026-03-15T12:00:00Z",
    member: { roles: [] },
    ...overrides,
  };
}

const ROLE_WEIGHT_MAP = new Map([
  ["role-admin", 5],
  ["role-contrib", 3],
  ["role-member", 1],
]);

describe("extractSignals", () => {
  it("detects feature wishes", () => {
    const messages = [
      makeMessage({ content: "I wish we had better logging for agent runs" }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.category).toBe("feature_wish");
  });

  it("detects pain points", () => {
    const messages = [
      makeMessage({ content: "The dashboard doesn't work on mobile, it's broken" }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.category).toBe("pain_point");
  });

  it("only flags maintainer_directive when author has weight >= 3", () => {
    const messages = [
      makeMessage({
        content: "We're planning to release the new budget system next week",
        member: { roles: ["role-member"] },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0); // weight 1, needs >= 3

    const adminMessages = [
      makeMessage({
        content: "We're planning to release the new budget system next week",
        member: { roles: ["role-admin"] },
      }),
    ];
    const adminSignals = extractSignals(adminMessages, ROLE_WEIGHT_MAP, "ch-1");
    expect(adminSignals).toHaveLength(1);
    expect(adminSignals[0]?.category).toBe("maintainer_directive");
  });

  it("skips bot messages", () => {
    const messages = [
      makeMessage({
        content: "I wish we had better support",
        author: { id: "bot-1", username: "github[bot]" },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0);
  });

  it("skips very short messages", () => {
    const messages = [makeMessage({ content: "bug" })];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals).toHaveLength(0);
  });

  it("assigns correct author weight from roles", () => {
    const messages = [
      makeMessage({
        content: "I wish we had a Discord integration for notifications",
        member: { roles: ["role-contrib"] },
      }),
    ];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals[0]?.authorWeight).toBe(3);
  });

  it("truncates long message text to 500 chars", () => {
    const longContent = "I wish we had " + "x".repeat(600);
    const messages = [makeMessage({ content: longContent })];
    const signals = extractSignals(messages, ROLE_WEIGHT_MAP, "ch-1");
    expect(signals[0]?.text.length).toBeLessThanOrEqual(500);
  });
});

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    category: "feature_wish",
    text: "I wish we had better logging",
    author: "testuser",
    authorWeight: 1,
    channelId: "ch-1",
    timestamp: "2026-03-15T12:00:00Z",
    messageId: "msg-1",
    ...overrides,
  };
}

describe("mergeSignals", () => {
  it("deduplicates by messageId", () => {
    const existing = [makeSignal({ messageId: "msg-1" })];
    const incoming = [
      makeSignal({ messageId: "msg-1", text: "duplicate" }),
      makeSignal({ messageId: "msg-2", text: "new signal" }),
    ];
    const merged = mergeSignals(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(merged.map((s) => s.messageId)).toContain("msg-1");
    expect(merged.map((s) => s.messageId)).toContain("msg-2");
  });

  it("keeps original when duplicate exists", () => {
    const existing = [makeSignal({ messageId: "msg-1", text: "original" })];
    const incoming = [makeSignal({ messageId: "msg-1", text: "should be ignored" })];
    const merged = mergeSignals(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("original");
  });

  it("sorts by weight descending, then timestamp descending", () => {
    const existing = [makeSignal({ messageId: "msg-1", authorWeight: 1, timestamp: "2026-03-10T00:00:00Z" })];
    const incoming = [
      makeSignal({ messageId: "msg-2", authorWeight: 5, timestamp: "2026-03-12T00:00:00Z" }),
      makeSignal({ messageId: "msg-3", authorWeight: 3, timestamp: "2026-03-14T00:00:00Z" }),
    ];
    const merged = mergeSignals(existing, incoming);
    expect(merged[0]?.authorWeight).toBe(5);
    expect(merged[1]?.authorWeight).toBe(3);
    expect(merged[2]?.authorWeight).toBe(1);
  });

  it("handles empty inputs", () => {
    expect(mergeSignals([], [])).toHaveLength(0);
    expect(mergeSignals([makeSignal()], [])).toHaveLength(1);
    expect(mergeSignals([], [makeSignal()])).toHaveLength(1);
  });
});
