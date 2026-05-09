import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInteraction, type CommandContext } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Helpers — minimal PluginContext + fetch stub
// ---------------------------------------------------------------------------

const stateStore = new Map<string, unknown>();

function makeCtx() {
  stateStore.clear();
  return {
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }) =>
        Promise.resolve(stateStore.get(stateKey) ?? null),
      ),
      set: vi.fn().mockImplementation(({ stateKey }: { stateKey: string }, value: unknown) => {
        stateStore.set(stateKey, value);
        return Promise.resolve(undefined);
      }),
    },
    http: { fetch: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

const PROJECT_KEYFLOW = { id: "proj-keyflow", name: "Keyflow", slug: "keyflow" };
const AGENT_CTO = { id: "agent-cto", name: "CTO" };
const AGENT_VERIFIER = { id: "agent-verifier", name: "Verifier" };
const AGENT_CEO = { id: "agent-ceo", name: "CEO" };

const COMPANY_ID = "company-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchStub(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (urlIn: string | URL | Request, init?: RequestInit) => {
    const url = typeof urlIn === "string" ? urlIn : urlIn.toString();
    calls.push({ url, init });

    if (url.endsWith(`/api/companies/${COMPANY_ID}/projects`)) {
      return new Response(JSON.stringify([PROJECT_KEYFLOW]), { status: 200 });
    }
    if (url.endsWith(`/api/companies/${COMPANY_ID}/agents`)) {
      return new Response(JSON.stringify([AGENT_CTO, AGENT_VERIFIER, AGENT_CEO]), { status: 200 });
    }
    if (url.endsWith(`/api/companies/${COMPANY_ID}/issues`)) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      return new Response(
        JSON.stringify({
          id: "issue-new",
          identifier: "SPE-100",
          title: body.title,
          assigneeAgentId: body.assigneeAgentId,
          projectId: body.projectId,
        }),
        { status: 201 },
      );
    }
    return new Response("not stubbed", { status: 404 });
  }) as any;
  return { calls };
}

function buildCmdCtx(extra?: Partial<CommandContext>): CommandContext {
  return {
    baseUrl: "http://127.0.0.1:3100",
    companyId: COMPANY_ID,
    token: "x",
    paperclipBoardApiKey: "",
    defaultChannelId: "default-1",
    config: { enableSpecPaperCommands: true },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Routing: each subcommand assigns to the right SpecPaper agent
// ---------------------------------------------------------------------------

describe("SpecPaper /clip subcommands — agent routing", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["propose", AGENT_CTO.id, { idea: "Add CI gate for lint" }],
    ["brainstorm", AGENT_CTO.id, { change: "add-ci-gate" }],
    ["plan", AGENT_CTO.id, { change: "add-ci-gate" }],
    ["build", AGENT_CTO.id, { change: "add-ci-gate" }],
    ["archive", AGENT_CTO.id, { change: "add-ci-gate" }],
    ["verify", AGENT_VERIFIER.id, { change: "add-ci-gate" }],
    ["principle-override", AGENT_CEO.id, { principle: "prefer-oss", rationale: "Customer demands SaaS" }],
  ];

  for (const [command, expectedAgentId, args] of cases) {
    it(`/clip ${command} → assigns issue to ${expectedAgentId}`, async () => {
      const { calls } = installFetchStub();
      const ctx = makeCtx();

      const interactionOptions = Object.entries({ ...args, project: "Keyflow" }).map(([name, value]) => ({ name, value }));

      await handleInteraction(
        ctx,
        {
          type: 2,
          data: { name: "clip", options: [{ name: command, type: 1, options: interactionOptions }] },
          member: { user: { username: "test" } },
          channel_id: "channel-1",
        } as any,
        buildCmdCtx(),
      );

      const issueCreate = calls.find((c) => c.url.endsWith("/issues"));
      expect(issueCreate, `expected an issue-create POST for /clip ${command}`).toBeDefined();
      const body = JSON.parse(String(issueCreate!.init?.body));
      expect(body.assigneeAgentId).toBe(expectedAgentId);
      expect(body.projectId).toBe(PROJECT_KEYFLOW.id);
      // Title carries the !command marker so SpecPaper agents can grep it
      expect(body.title.startsWith(`!${command}`)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Project resolution: explicit project: arg vs channel-project-map fallback
// ---------------------------------------------------------------------------

describe("SpecPaper /clip subcommands — project resolution", () => {
  it("falls back to channel-project-map when project: arg is missing", async () => {
    const { calls } = installFetchStub();
    const ctx = makeCtx();
    // Wire mapping: this channel → Keyflow
    stateStore.set("channel-project-map", { Keyflow: "channel-keyflow" });

    await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{ name: "propose", type: 1, options: [{ name: "idea", value: "X" }] }],
        },
        member: { user: { username: "test" } },
        channel_id: "channel-keyflow",
      } as any,
      buildCmdCtx(),
    );

    const issueCreate = calls.find((c) => c.url.endsWith("/issues"));
    expect(issueCreate).toBeDefined();
    const body = JSON.parse(String(issueCreate!.init?.body));
    expect(body.projectId).toBe(PROJECT_KEYFLOW.id);
  });

  it("returns ephemeral error when project cannot be resolved", async () => {
    installFetchStub();
    const ctx = makeCtx();

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [{ name: "propose", type: 1, options: [{ name: "idea", value: "X" }] }],
        },
        member: { user: { username: "test" } },
        channel_id: "unmapped-channel",
      } as any,
      buildCmdCtx(),
    ) as any;

    // type 4 = CHANNEL_MESSAGE_WITH_SOURCE; flags 64 = ephemeral
    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
    expect(result.data.content).toMatch(/project/i);
  });
});

// ---------------------------------------------------------------------------
// Config gating: disabled flag refuses cleanly
// ---------------------------------------------------------------------------

describe("SpecPaper /clip subcommands — config gating", () => {
  it("refuses when enableSpecPaperCommands is false", async () => {
    const { calls } = installFetchStub();
    const ctx = makeCtx();

    const result = await handleInteraction(
      ctx,
      {
        type: 2,
        data: {
          name: "clip",
          options: [
            {
              name: "propose",
              type: 1,
              options: [{ name: "idea", value: "X" }, { name: "project", value: "Keyflow" }],
            },
          ],
        },
        member: { user: { username: "test" } },
        channel_id: "channel-1",
      } as any,
      buildCmdCtx({ config: { enableSpecPaperCommands: false } }),
    ) as any;

    expect(result.type).toBe(4);
    expect(result.data.flags).toBe(64);
    expect(result.data.content).toMatch(/disabled/i);
    // No issue should be created
    expect(calls.find((c) => c.url.endsWith("/issues"))).toBeUndefined();
  });
});
