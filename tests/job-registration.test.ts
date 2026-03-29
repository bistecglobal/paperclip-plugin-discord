import { describe, it, expect, vi } from "vitest";
import manifest from "../src/manifest.js";

// ---------------------------------------------------------------------------
// The bug: job handlers were registered inside config-conditional blocks,
// so when a feature flag was off the runtime had no handler for the job key
// declared in the manifest — causing a crash at runtime.
//
// These tests verify that every jobKey in the manifest receives a registered
// handler regardless of the config values passed to setup().
// ---------------------------------------------------------------------------

// Capture the setup function from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
const { capturedSetups } = vi.hoisted(() => {
  const capturedSetups: Array<(ctx: any) => Promise<void>> = [];
  return { capturedSetups };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedSetups.push(def.setup);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

/**
 * Build a minimal PluginContext stub that records job registrations.
 */
function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const registeredJobs = new Map<string, Function>();

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: "fake-secret-ref",
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: false,
    notifyOnIssueDone: false,
    notifyOnApprovalCreated: false,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "http://localhost:3100",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: false,
    escalationTimeoutMinutes: 30,
    maxAgentsPerThread: 5,
    enableMediaPipeline: false,
    mediaChannelIds: [],
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    proactiveScanIntervalMinutes: 15,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    dailyDigestTime: "09:00",
    bidailySecondTime: "17:00",
    tridailyTimes: "07:00,13:00,19:00",
    ...configOverrides,
  };

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(defaultConfig) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      register: vi.fn().mockImplementation((key: string, handler: Function) => {
        registeredJobs.set(key, handler);
      }),
    },
    tools: {
      register: vi.fn(),
    },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn() },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    },
  } as any;

  return { ctx, registeredJobs };
}

/** Extract just the jobKeys from the manifest. */
const manifestJobKeys = manifest.jobs!.map((j) => j.jobKey);

async function runSetup(configOverrides: Record<string, unknown> = {}) {
  const { ctx, registeredJobs } = buildPluginContext(configOverrides);
  await getSetup()(ctx);
  return { ctx, registeredJobs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("job handler registration vs manifest", () => {
  it("manifest declares expected job keys", () => {
    expect(manifestJobKeys).toEqual(
      expect.arrayContaining([
        "discord-intelligence-scan",
        "check-escalation-timeouts",
        "check-watches",
        "discord-daily-digest",
      ]),
    );
  });

  it("registers ALL manifest job handlers when all features are DISABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: false,
      enableIntelligence: false,
      intelligenceChannelIds: [],
      digestMode: "off",
      enableEscalations: false,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("registers ALL manifest job handlers when all features are ENABLED", async () => {
    const { registeredJobs } = await runSetup({
      enableProactiveSuggestions: true,
      enableIntelligence: true,
      intelligenceChannelIds: ["ch-intel"],
      digestMode: "daily",
      enableEscalations: true,
    });

    for (const jobKey of manifestJobKeys) {
      expect(registeredJobs.has(jobKey), `Missing handler for job "${jobKey}"`).toBe(true);
    }
  });

  it("check-watches handler early-returns when proactive suggestions disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableProactiveSuggestions: false,
    });

    const handler = registeredJobs.get("check-watches")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("proactive suggestions disabled"),
    );
  });

  it("discord-daily-digest handler early-returns when digest mode is off", async () => {
    const { registeredJobs, ctx } = await runSetup({
      digestMode: "off",
    });

    const handler = registeredJobs.get("discord-daily-digest")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("digest mode is off"),
    );
  });

  it("logs at debug level (not info) when digest mode is off", async () => {
    const { ctx } = await runSetup({ digestMode: "off" });

    // The info log should NOT contain "Daily digest job registered"
    const infoMessages = ctx.logger.info.mock.calls.map((c: any[]) => c[0]);
    expect(infoMessages).not.toContainEqual(
      expect.stringContaining("Daily digest job registered"),
    );

    // Instead, the debug log should contain the registration message
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("Daily digest job registered"),
      expect.objectContaining({ mode: "off" }),
    );
  });

  it("logs at info level when digest mode is active", async () => {
    const { ctx } = await runSetup({ digestMode: "daily" });

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Daily digest job registered",
      expect.objectContaining({ mode: "daily" }),
    );
  });

  it("discord-intelligence-scan handler early-returns when intelligence disabled", async () => {
    const { registeredJobs, ctx } = await runSetup({
      enableIntelligence: false,
      intelligenceChannelIds: [],
    });

    const handler = registeredJobs.get("discord-intelligence-scan")!;
    expect(handler).toBeDefined();

    await handler();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("intelligence disabled"),
    );
  });
});
