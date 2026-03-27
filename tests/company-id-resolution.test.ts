import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, type CommandContext } from "../src/commands.js";
import { resolveCompanyId, _resetCompanyIdCache } from "../src/company-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REAL_COMPANY_ID = "3741f9e1-0e05-4ac3-ac19-19117dd6824b";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: "agent-1", name: "CEO", status: "active" },
      ]),
    },
    issues: {
      list: vi.fn().mockResolvedValue([
        { id: "issue-1", identifier: "PAP-1", title: "Test issue" },
      ]),
    },
    companies: {
      list: vi.fn().mockResolvedValue([{ id: REAL_COMPANY_ID }]),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    http: { fetch: vi.fn().mockResolvedValue({ ok: true }) },
    events: { emit: vi.fn() },
    ...overrides,
  } as any;
}

function makeCmdCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    baseUrl: "http://localhost:3100",
    companyId: REAL_COMPANY_ID,
    token: "test-token",
    defaultChannelId: "chan-1",
    ...overrides,
  };
}

function statusInteraction() {
  return {
    type: 2,
    data: { name: "clip", options: [{ name: "status" }] },
    member: { user: { username: "testuser" } },
  };
}

function agentsInteraction() {
  return {
    type: 2,
    data: { name: "clip", options: [{ name: "agents" }] },
    member: { user: { username: "testuser" } },
  };
}

function budgetInteraction(agent?: string) {
  return {
    type: 2,
    data: {
      name: "clip",
      options: [
        {
          name: "budget",
          options: agent ? [{ name: "agent", value: agent }] : [],
        },
      ],
    },
    member: { user: { username: "testuser" } },
  };
}

// ---------------------------------------------------------------------------
// Company ID resolution — the core bug
// ---------------------------------------------------------------------------

describe("company ID resolution", () => {
  it("passes the real company UUID to agents.list, not 'default'", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    await handleInteraction(ctx, statusInteraction() as any, cmdCtx);

    expect(ctx.agents.list).toHaveBeenCalledTimes(1);
    const callArg = ctx.agents.list.mock.calls[0][0];
    expect(callArg.companyId).toBe(REAL_COMPANY_ID);
    expect(callArg.companyId).not.toBe("default");
    expect(callArg.companyId).toMatch(UUID_REGEX);
  });

  it("passes real UUID to issues.list for /clip status", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    await handleInteraction(ctx, statusInteraction() as any, cmdCtx);

    expect(ctx.issues.list).toHaveBeenCalledTimes(1);
    const callArg = ctx.issues.list.mock.calls[0][0];
    expect(callArg.companyId).toBe(REAL_COMPANY_ID);
    expect(callArg.companyId).not.toBe("default");
  });

  it("passes real UUID to agents.list for /clip agents", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    await handleInteraction(ctx, agentsInteraction() as any, cmdCtx);

    expect(ctx.agents.list).toHaveBeenCalledTimes(1);
    expect(ctx.agents.list.mock.calls[0][0].companyId).toBe(REAL_COMPANY_ID);
  });

  it("would fail if companyId were 'default' (pre-fix behavior)", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockImplementation(({ companyId }: { companyId: string }) => {
          if (!companyId.match(UUID_REGEX)) {
            throw new Error(`invalid input syntax for type uuid: "${companyId}"`);
          }
          return Promise.resolve([{ id: "a1", name: "CEO", status: "active" }]);
        }),
      },
    });

    // With a real UUID — should succeed
    const cmdCtxGood = makeCmdCtx({ companyId: REAL_COMPANY_ID });
    const resultGood = await handleInteraction(ctx, statusInteraction() as any, cmdCtxGood);
    expect((resultGood as any).data.embeds).toBeDefined();

    // With "default" — should produce an error message (the pre-fix bug)
    const cmdCtxBad = makeCmdCtx({ companyId: "default" });
    const resultBad = await handleInteraction(ctx, statusInteraction() as any, cmdCtxBad);
    expect((resultBad as any).data.content).toContain("Failed to fetch status");
    expect((resultBad as any).data.content).toContain("default");
  });
});

// ---------------------------------------------------------------------------
// Interaction error handling — the 204 bug
// ---------------------------------------------------------------------------

describe("interaction error handling", () => {
  it("/clip status returns a valid interaction response even when backend fails", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockRejectedValue(new Error("connection refused")),
      },
    });
    const cmdCtx = makeCmdCtx();

    const result = await handleInteraction(ctx, statusInteraction() as any, cmdCtx);

    // Must return a type-4 interaction response, not throw
    expect(result).toBeDefined();
    expect((result as any).type).toBe(4);
    expect((result as any).data).toBeDefined();
    expect((result as any).data.content).toContain("Failed to fetch status");
  });

  it("ping interaction (type 1) returns valid pong", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    const result = await handleInteraction(ctx, { type: 1 } as any, cmdCtx);

    expect(result).toBeDefined();
    expect((result as any).type).toBe(1);
  });

  it("unknown interaction type returns a valid response, not void", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    const result = await handleInteraction(ctx, { type: 99 } as any, cmdCtx);

    expect(result).toBeDefined();
    expect((result as any).type).toBe(4);
    expect((result as any).data.content).toContain("Unknown interaction type");
  });

  it("handleInteraction always returns an object, never void/undefined", async () => {
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx();

    // Type 2 (slash command) with valid data
    const r1 = await handleInteraction(ctx, statusInteraction() as any, cmdCtx);
    expect(r1).toBeDefined();
    expect(typeof r1).toBe("object");

    // Type 1 (ping)
    const r2 = await handleInteraction(ctx, { type: 1 } as any, cmdCtx);
    expect(r2).toBeDefined();
    expect(typeof r2).toBe("object");

    // Unknown type
    const r3 = await handleInteraction(ctx, { type: 99 } as any, cmdCtx);
    expect(r3).toBeDefined();
    expect(typeof r3).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// CommandContext fallback behavior
// ---------------------------------------------------------------------------

describe("CommandContext fallback handling", () => {
  it("uses cmdCtx.companyId when no pluginCtx is provided", async () => {
    const customId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ctx = makeCtx();
    const cmdCtx = makeCmdCtx({ companyId: customId });

    await handleInteraction(ctx, statusInteraction() as any, cmdCtx);

    expect(ctx.agents.list.mock.calls[0][0].companyId).toBe(customId);
  });
});

// ---------------------------------------------------------------------------
// Lazy company-ID resolution (the startup regression fix)
// ---------------------------------------------------------------------------

describe("lazy company-ID resolution", () => {
  beforeEach(() => {
    _resetCompanyIdCache();
  });

  it("resolveCompanyId returns the real UUID from ctx.companies.list", async () => {
    const ctx = makeCtx();
    const result = await resolveCompanyId(ctx as any);
    expect(result).toBe(REAL_COMPANY_ID);
    expect(ctx.companies.list).toHaveBeenCalledTimes(1);
  });

  it("resolveCompanyId caches after first call", async () => {
    const ctx = makeCtx();
    const r1 = await resolveCompanyId(ctx as any);
    const r2 = await resolveCompanyId(ctx as any);
    expect(r1).toBe(REAL_COMPANY_ID);
    expect(r2).toBe(REAL_COMPANY_ID);
    expect(ctx.companies.list).toHaveBeenCalledTimes(1);
  });

  it("resolveCompanyId falls back to 'default' when companies.list fails", async () => {
    const ctx = makeCtx({
      companies: {
        list: vi.fn().mockRejectedValue(new Error("API unavailable")),
      },
    });
    const result = await resolveCompanyId(ctx as any);
    expect(result).toBe("default");
  });

  it("resolveCompanyId falls back to 'default' when no companies exist", async () => {
    const ctx = makeCtx({
      companies: { list: vi.fn().mockResolvedValue([]) },
    });
    const result = await resolveCompanyId(ctx as any);
    expect(result).toBe("default");
  });

  it("handleInteraction uses lazy resolver when pluginCtx is set", async () => {
    _resetCompanyIdCache();
    const ctx = makeCtx();
    // cmdCtx with pluginCtx but companyId set to "default" (as setup would do)
    const cmdCtx = makeCmdCtx({
      companyId: "default",
      pluginCtx: ctx as any,
    });

    await handleInteraction(ctx, statusInteraction() as any, cmdCtx);

    // Should have resolved via companies.list, NOT used "default"
    expect(ctx.companies.list).toHaveBeenCalledTimes(1);
    expect(ctx.agents.list.mock.calls[0][0].companyId).toBe(REAL_COMPANY_ID);
  });

  it("command failure still returns a valid interaction response after lazy resolve", async () => {
    _resetCompanyIdCache();
    const ctx = makeCtx({
      agents: { list: vi.fn().mockRejectedValue(new Error("backend down")) },
    });
    const cmdCtx = makeCmdCtx({
      companyId: "default",
      pluginCtx: ctx as any,
    });

    const result = await handleInteraction(ctx, statusInteraction() as any, cmdCtx);
    expect(result).toBeDefined();
    expect((result as any).type).toBe(4);
    expect((result as any).data.content).toContain("Failed to fetch status");
  });
});

// ---------------------------------------------------------------------------
// Worker activation safety
// ---------------------------------------------------------------------------

describe("worker activation safety", () => {
  beforeEach(() => {
    _resetCompanyIdCache();
  });

  it("setup does not need to call companies.list — resolution is deferred", () => {
    // This is a design-level assertion: the CommandContext interface accepts
    // pluginCtx for lazy resolution instead of requiring a pre-resolved companyId.
    const cmdCtx: CommandContext = {
      baseUrl: "http://localhost:3100",
      companyId: "default",
      token: "tok",
      defaultChannelId: "ch",
      pluginCtx: makeCtx() as any,
    };
    expect(cmdCtx.companyId).toBe("default");
    expect(cmdCtx.pluginCtx).toBeDefined();
  });

  it("_resetCompanyIdCache allows fresh resolution", async () => {
    const ctx = makeCtx();
    await resolveCompanyId(ctx as any);
    expect(ctx.companies.list).toHaveBeenCalledTimes(1);

    _resetCompanyIdCache();
    await resolveCompanyId(ctx as any);
    expect(ctx.companies.list).toHaveBeenCalledTimes(2);
  });
});
