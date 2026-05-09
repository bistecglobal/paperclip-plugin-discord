import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";
import { humanizeStatus } from "./formatters.js";
import { withRetry, throwOnRetryableStatus } from "./retry.js";
import { paperclipFetch } from "./paperclip-fetch.js";
import { handleHandoffButton, handleDiscussionButton, handleAcpCommand } from "./session-registry.js";
import { resolveCompanyId } from "./company-resolver.js";
import { getEscalation } from "./escalation-state.js";
import {
  type Workflow,
  type WorkflowStep,
  getWorkflowStore,
  saveWorkflowStore,
  runWorkflow,
  resumeWorkflowAfterApproval,
  BUILTIN_COMMANDS,
} from "./workflow-engine.js";

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
  focused?: boolean;
}

interface InteractionData {
  name: string;
  custom_id?: string;
  component_type?: number;
  options?: InteractionOption[];
}

interface Interaction {
  type: number;
  data?: InteractionData;
  member?: { user: { username: string } };
  channel_id?: string;
}

export interface CommandContext {
  baseUrl: string;
  companyId: string;
  /** Discord bot token — used for Discord API calls. */
  token: string;
  /** Optional Paperclip board API key — attached to Paperclip API calls that
   * require board authentication (approve/reject, create issues, etc.).
   * Empty string disables the Authorization header, which is correct for
   * `local_trusted` deployments. */
  paperclipBoardApiKey?: string;
  defaultChannelId: string;
  /** PluginContext for lazy company-ID resolution at command time. */
  pluginCtx?: PluginContext;
  /** Snapshot of plugin config used to gate command behavior. */
  config?: Record<string, unknown>;
}

function getOption(
  options: InteractionOption[] | undefined,
  name: string,
): string | undefined {
  return options
    ?.find((o) => o.name === name)
    ?.value?.toString();
}

export const SLASH_COMMANDS = [
  {
    name: "clip",
    description: "Manage your Paperclip instance from Discord",
    options: [
      {
        name: "status",
        description: "Show active agents and recent task completions",
        type: 1,
      },
      {
        name: "approve",
        description: "Approve a pending approval",
        type: 1,
        options: [
          {
            name: "id",
            description: "The approval ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "budget",
        description: "Check an agent's remaining budget",
        type: 1,
        options: [
          {
            name: "agent",
            description: "Agent name or ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "issues",
        description: "List open issues with optional project filter",
        type: 1,
        options: [
          {
            name: "project",
            description: "Filter by project name",
            type: 3,
            required: false,
            autocomplete: true,
          },
        ],
      },
      {
        name: "agents",
        description: "Show all agents with status indicators",
        type: 1,
        options: [
          {
            name: "company",
            description: "Filter by company name or ID",
            type: 3,
            required: false,
            autocomplete: true,
          },
        ],
      },
      {
        name: "companies",
        description: "List available companies",
        type: 1,
      },
      {
        name: "projects",
        description: "List projects with optional company filter",
        type: 1,
        options: [
          {
            name: "company",
            description: "Filter by company name or ID",
            type: 3,
            required: false,
            autocomplete: true,
          },
        ],
      },
      {
        name: "help",
        description: "List all available /clip and /acp commands",
        type: 1,
      },
      {
        name: "connect",
        description: "Link this channel to a Paperclip company",
        type: 1,
        options: [
          {
            name: "company",
            description: "Company name or ID",
            type: 3,
            required: false,
          },
        ],
      },
      {
        name: "connect-channel",
        description: "Map current Discord channel to a Paperclip project",
        type: 1,
        options: [
          {
            name: "project",
            description: "Project name to map to this channel",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "digest",
        description: "Configure daily digest for this channel",
        type: 1,
        options: [
          {
            name: "action",
            description: "on, off, or status",
            type: 3,
            required: true,
            choices: [
              { name: "on", value: "on" },
              { name: "off", value: "off" },
              { name: "status", value: "status" },
            ],
          },
          {
            name: "mode",
            description: "Digest mode (daily, bidaily, tridaily)",
            type: 3,
            required: false,
            choices: [
              { name: "daily", value: "daily" },
              { name: "bidaily", value: "bidaily" },
              { name: "tridaily", value: "tridaily" },
            ],
          },
        ],
      },
      {
        name: "propose",
        description: "SpecPaper: file a proposal for a change",
        type: 1,
        options: [
          { name: "idea", description: "One-line description of the proposed change", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "brainstorm",
        description: "SpecPaper: run a brainstorm session for a change",
        type: 1,
        options: [
          { name: "change", description: "Change slug", type: 3, required: true },
          { name: "technique", description: "Optional brain-methods technique name", type: 3, required: false },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "plan",
        description: "SpecPaper: generate spec / design / tasks for a change",
        type: 1,
        options: [
          { name: "change", description: "Change slug", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "build",
        description: "SpecPaper: start the wave-based build for a change",
        type: 1,
        options: [
          { name: "change", description: "Change slug", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "verify",
        description: "SpecPaper: run static + dynamic audits for a change",
        type: 1,
        options: [
          { name: "change", description: "Change slug", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "archive",
        description: "SpecPaper: archive a completed change",
        type: 1,
        options: [
          { name: "change", description: "Change slug", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "principle-override",
        description: "SpecPaper: request a CEO override of a default principle",
        type: 1,
        options: [
          { name: "principle", description: "Principle id (e.g. prefer-oss)", type: 3, required: true },
          { name: "rationale", description: "Why we are overriding for this project / change", type: 3, required: true },
          { name: "project", description: "Project name (defaults to channel-mapped project)", type: 3, required: false },
        ],
      },
      {
        name: "commands",
        description: "Manage workflow-based custom commands",
        type: 2,
        options: [
          {
            name: "import",
            description: "Import a workflow command from JSON",
            type: 1,
            options: [
              {
                name: "json",
                description: "Inline JSON workflow definition",
                type: 3,
                required: false,
              },
            ],
          },
          {
            name: "list",
            description: "List all registered workflow commands",
            type: 1,
          },
          {
            name: "run",
            description: "Execute a workflow command by name",
            type: 1,
            options: [
              {
                name: "name",
                description: "Workflow command name",
                type: 3,
                required: true,
              },
              {
                name: "args",
                description: "Arguments to pass to the workflow",
                type: 3,
                required: false,
              },
            ],
          },
          {
            name: "delete",
            description: "Delete a workflow command",
            type: 1,
            options: [
              {
                name: "name",
                description: "Workflow command name to delete",
                type: 3,
                required: true,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "acp",
    description: "Manage coding agent sessions via Agent Client Protocol",
    options: [
      {
        name: "spawn",
        description: "Start a new coding agent session in a thread",
        type: 1,
        options: [
          {
            name: "agent",
            description: "Agent name to spawn",
            type: 3,
            required: true,
          },
          {
            name: "task",
            description: "Task description for the agent",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "status",
        description: "Check the status of an ACP session",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "cancel",
        description: "Cancel a running ACP session",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "close",
        description: "Close a completed ACP session and archive the thread",
        type: 1,
        options: [
          {
            name: "session",
            description: "The ACP session ID",
            type: 3,
            required: true,
          },
        ],
      },
    ],
  },
];

export async function handleInteraction(
  ctx: PluginContext,
  interaction: Interaction,
  cmdCtx: CommandContext,
): Promise<unknown> {
  if (interaction.type === 1) {
    return { type: 1 };
  }

  if (interaction.type === 2 && interaction.data) {
    await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);
    return handleSlashCommand(ctx, interaction.data, interaction.member, cmdCtx, interaction.channel_id);
  }

  if (interaction.type === 3 && interaction.data) {
    return handleButtonClick(ctx, interaction.data, interaction.member?.user.username, cmdCtx);
  }

  if (interaction.type === 4 && interaction.data) {
    return handleAutocomplete(ctx, interaction.data, cmdCtx);
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown interaction type.",
    ephemeral: true,
  });
}

async function handleSlashCommand(
  ctx: PluginContext,
  data: InteractionData,
  member?: { user: { username: string } },
  cmdCtx?: CommandContext,
  interactionChannelId?: string,
): Promise<unknown> {
  // Lazy company-ID resolution: resolve on first command, not at startup.
  const companyId = cmdCtx?.pluginCtx
    ? await resolveCompanyId(cmdCtx.pluginCtx)
    : (cmdCtx?.companyId ?? "default");

  if (data.name === "acp") {
    return handleAcpCommand(
      ctx,
      cmdCtx?.token ?? "",
      data,
      companyId,
      cmdCtx?.defaultChannelId ?? "",
    );
  }

  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/clip status`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name;
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";

  switch (subName) {
    case "status":
      return handleStatus(ctx, companyId);
    case "approve":
      return handleApprove(
        ctx,
        getOption(subcommand.options ?? [], "id"),
        member?.user.username,
        baseUrl,
        cmdCtx?.paperclipBoardApiKey,
      );
    case "budget":
      return handleBudget(ctx, getOption(subcommand.options ?? [], "agent"), companyId);
    case "issues":
      return handleIssues(ctx, companyId, getOption(subcommand.options ?? [], "project"), baseUrl);
    case "agents":
      return handleAgents(ctx, companyId, getOption(subcommand.options ?? [], "company"), cmdCtx?.baseUrl);
    case "companies":
      return handleCompanies(ctx);
    case "projects":
      return handleProjects(ctx, companyId, getOption(subcommand.options ?? [], "company"));
    case "help":
      return handleHelp();
    case "connect":
      return handleConnect(ctx, getOption(subcommand.options ?? [], "company"));
    case "connect-channel":
      return handleConnectChannel(ctx, getOption(subcommand.options ?? [], "project") ?? "", interactionChannelId);
    case "digest":
      return handleDigest(
        ctx,
        getOption(subcommand.options ?? [], "action") ?? "status",
        getOption(subcommand.options ?? [], "mode"),
      );
    case "commands":
      return handleCommands(ctx, subcommand, cmdCtx);
    case "propose":
    case "brainstorm":
    case "plan":
    case "build":
    case "verify":
    case "archive":
    case "principle-override":
      return handleSpecPaperCommand(ctx, subName, subcommand, cmdCtx, interactionChannelId, companyId);
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown command: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleAutocomplete(
  ctx: PluginContext,
  data: InteractionData,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const subcommand = data.options?.[0];
  if (!subcommand) return { type: 8, data: { choices: [] } };

  const focusedOption = subcommand.options?.find((o) => o.focused);
  if (!focusedOption) return { type: 8, data: { choices: [] } };

  const query = (focusedOption.value?.toString() ?? "").toLowerCase();

  try {
    if (focusedOption.name === "company") {
      const companies = await ctx.companies.list();
      const filtered = companies
        .filter((c: { id: string; name?: string }) => {
          const name = (c.name ?? c.id).toLowerCase();
          return !query || name.includes(query) || c.id.toLowerCase().includes(query);
        })
        .slice(0, 25);
      return {
        type: 8,
        data: {
          choices: filtered.map((c: { id: string; name?: string }) => ({
            name: c.name ?? c.id,
            value: c.name ?? c.id,
          })),
        },
      };
    }

    if (focusedOption.name === "project") {
      const companyId = cmdCtx?.pluginCtx
        ? await resolveCompanyId(cmdCtx.pluginCtx)
        : (cmdCtx?.companyId ?? "default");
      const projects = await ctx.projects.list({ companyId, limit: 100 });
      const filtered = projects
        .filter((p) => {
          const name = (p.name ?? p.id).toLowerCase();
          return !query || name.includes(query);
        })
        .slice(0, 25);
      return {
        type: 8,
        data: {
          choices: filtered.map((p) => ({
            name: p.name ?? p.id,
            value: p.name ?? p.id,
          })),
        },
      };
    }
  } catch {
    // Autocomplete failures should return empty choices, not error messages
  }

  return { type: 8, data: { choices: [] } };
}

async function handleStatus(ctx: PluginContext, companyId: string): Promise<unknown> {
  try {
    const [allAgents, activeIssues, doneIssues] = await Promise.all([
      ctx.agents.list({ companyId }),
      ctx.issues.list({ companyId, status: "in_progress", limit: 10 }),
      ctx.issues.list({ companyId, status: "done", limit: 5 }),
    ]);

    const agents = allAgents.filter(
      (a: { status?: string | null }) => a.status === "active" || a.status === "running",
    );

    const agentList = agents.length > 0
      ? agents.map((a: { name?: string | null; id: string; title?: string | null; role?: string | null }) => {
          const label = a.name ?? a.id;
          const detail = a.title || a.role;
          return detail ? `- **${label}** — ${detail}` : `- **${label}**`;
        }).join("\n")
      : "No active agents";

    const activeList = activeIssues.length > 0
      ? activeIssues.map((i: { identifier: string | null; id: string; title?: string; assigneeAgentId?: string | null; executionAgentNameKey?: string | null }) => {
          const tag = i.identifier ?? i.id;
          const agent = i.executionAgentNameKey ? ` _(${i.executionAgentNameKey})_` : "";
          return `- **${tag}** ${i.title ?? ""}${agent}`;
        }).join("\n")
      : "No active work";

    const doneList = doneIssues.length > 0
      ? doneIssues.map((i: { identifier: string | null; id: string; title?: string }) => `- **${i.identifier ?? i.id}** ${i.title ?? ""}`).join("\n")
      : "No recent completions";

    const embeds: DiscordEmbed[] = [
      {
        title: "Paperclip Status",
        color: COLORS.BLUE,
        fields: [
          { name: `Active Agents (${agents.length})`, value: agentList },
          { name: `In Progress (${activeIssues.length})`, value: activeList },
          { name: `Recent Completions (${doneIssues.length})`, value: doneList },
        ],
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch status: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleApprove(
  ctx: PluginContext,
  approvalId: string | undefined,
  username?: string,
  baseUrl?: string,
  apiKey?: string,
): Promise<unknown> {
  if (!approvalId) {
    return respondToInteraction({
      type: 4,
      content: "Missing approval ID. Usage: `/clip approve id:<approval-id>`",
      ephemeral: true,
    });
  }

  try {
    const url = `${baseUrl ?? "http://localhost:3100"}/api/approvals/${approvalId}/approve`;
    const resp = await withRetry(async () => {
      const r = await paperclipFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decidedByUserId: `discord:${username ?? "unknown"}` }),
      }, apiKey);
      throwOnRetryableStatus(r);
      return r;
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`API ${resp.status}: ${body}`);
    }

    await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    ctx.logger.info("Approval via Discord", { approvalId, username });

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Approval Resolved",
        description: `Approved by **${username ?? "Discord user"}**.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to approve ${approvalId}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleBudget(
  ctx: PluginContext,
  agentQuery: string | undefined,
  companyId: string,
): Promise<unknown> {
  if (!agentQuery) {
    return respondToInteraction({
      type: 4,
      content: "Missing agent name. Usage: `/clip budget agent:<name>`",
      ephemeral: true,
    });
  }

  try {
    const agents = await ctx.agents.list({ companyId });
    const agent = agents.find(
      (a: { id: string; name: string }) =>
        a.id === agentQuery || a.name === agentQuery ||
        a.name.toLowerCase() === agentQuery.toLowerCase(),
    );

    if (!agent) {
      return respondToInteraction({
        type: 4,
        content: `Agent not found: ${agentQuery}`,
        ephemeral: true,
      });
    }

    const budgetState = await ctx.state.get({
      scopeKind: "agent",
      scopeId: agent.id,
      stateKey: "budget",
    }) as { spent?: number; limit?: number } | null;

    const spent = budgetState?.spent ?? 0;
    const limit = budgetState?.limit ?? 0;
    const remaining = limit - spent;
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;

    return respondToInteraction({
      type: 4,
      embeds: [
        {
          title: `Budget: ${agent.name ?? agent.id}`,
          color: remaining > 0 ? COLORS.GREEN : COLORS.RED,
          fields: [
            { name: "Spent", value: `$${spent.toFixed(2)}`, inline: true },
            { name: "Limit", value: `$${limit.toFixed(2)}`, inline: true },
            { name: "Remaining", value: `$${remaining.toFixed(2)} (${pct}% used)`, inline: true },
          ],
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        },
      ],
      ephemeral: true,
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to look up budget for ${agentQuery}: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleIssues(
  ctx: PluginContext,
  companyId: string,
  projectFilter?: string,
  baseUrl?: string,
): Promise<unknown> {
  try {
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const filtered = projectFilter
      ? issues.filter((i: { project?: { name?: string } | null }) => {
          const projName = i.project?.name ?? "";
          return projName.toLowerCase().includes(projectFilter.toLowerCase());
        })
      : issues;

    if (filtered.length === 0) {
      const filter = projectFilter ? ` for project "${projectFilter}"` : "";
      return respondToInteraction({
        type: 4,
        content: `No issues found${filter}.`,
        ephemeral: true,
      });
    }

    const statusEmoji: Record<string, string> = {
      done: "✅", todo: "📋", in_progress: "🔄", backlog: "📥", blocked: "🚫", in_review: "🔍",
    };

    const fields = filtered.map((i: { identifier?: string | null; id: string; title?: string; status: string }) => {
      const emoji = statusEmoji[i.status] ?? "📋";
      const id = i.identifier ?? i.id;
      return {
        name: `${emoji} ${id} — ${humanizeStatus(i.status)}`,
        value: i.title ?? "(untitled)",
      };
    });

    const embeds: DiscordEmbed[] = [
      {
        title: `Open Issues${projectFilter ? ` (${projectFilter})` : ""}`,
        color: COLORS.BLUE,
        fields,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch issues: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleAgents(
  ctx: PluginContext,
  companyId: string,
  companyFilter?: string,
  baseUrl?: string,
): Promise<unknown> {
  try {
    let resolvedCompanyId = companyId;
    let companyLabel: string | undefined;

    if (companyFilter) {
      const companies = await ctx.companies.list();
      const match = companies.find(
        (c: { id: string; name?: string }) =>
          c.id === companyFilter || c.name?.toLowerCase() === companyFilter.toLowerCase(),
      );
      if (!match) {
        const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
        return respondToInteraction({
          type: 4,
          content: `Company "${companyFilter}" not found. Available: ${names || "none"}`,
          ephemeral: true,
        });
      }
      resolvedCompanyId = match.id;
      companyLabel = match.name ?? match.id;
    }

    const agents = await ctx.agents.list({ companyId: resolvedCompanyId });

    if (agents.length === 0) {
      const suffix = companyLabel ? ` for ${companyLabel}` : "";
      return respondToInteraction({ type: 4, content: `No agents found${suffix}.`, ephemeral: true });
    }

    const statusEmoji: Record<string, string> = {
      active: "🟢", error: "🔴", paused: "🟡", idle: "⚪", running: "🔵",
    };

    const statusLabel: Record<string, string> = {
      active: "Active", error: "Error", paused: "Paused", idle: "Idle", running: "Running",
    };

    const lines = agents.map((a: { name?: string | null; id: string; status: string; title?: string | null; role?: string | null }) => {
      const emoji = statusEmoji[a.status] ?? "⚪";
      const label = a.name ?? a.id;
      const detail = a.title || a.role;
      const statusText = statusLabel[a.status] ?? a.status;
      return detail
        ? `${emoji} **${label}** — ${detail} · ${statusText}`
        : `${emoji} **${label}** — ${statusText}`;
    });

    const title = companyLabel ? `Agents (${companyLabel})` : "Agents";
    const embeds: DiscordEmbed[] = [
      {
        title,
        description: lines.join("\n"),
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch agents: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleCompanies(ctx: PluginContext): Promise<unknown> {
  try {
    const companies = await ctx.companies.list();

    if (companies.length === 0) {
      return respondToInteraction({ type: 4, content: "No companies found.", ephemeral: true });
    }

    const lines = companies.map((c: { id: string; name?: string }) => {
      const label = c.name ?? c.id;
      return `📋 **${label}**\n\u00A0\u00A0\u00A0\u00A0ID: \`${c.id}\``;
    });

    const embeds: DiscordEmbed[] = [
      {
        title: `Companies (${companies.length})`,
        description: lines.join("\n"),
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch companies: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleProjects(
  ctx: PluginContext,
  companyId: string,
  companyFilter?: string,
): Promise<unknown> {
  try {
    let resolvedCompanyId = companyId;
    let companyLabel: string | undefined;

    if (companyFilter) {
      const companies = await ctx.companies.list();
      const match = companies.find(
        (c: { id: string; name?: string }) =>
          c.id === companyFilter || c.name?.toLowerCase() === companyFilter.toLowerCase(),
      );
      if (!match) {
        const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
        return respondToInteraction({
          type: 4,
          content: `Company "${companyFilter}" not found. Available: ${names || "none"}`,
          ephemeral: true,
        });
      }
      resolvedCompanyId = match.id;
      companyLabel = match.name ?? match.id;
    }

    const projects = (await ctx.projects.list({
      companyId: resolvedCompanyId,
      limit: 100,
    })) as Array<{
      id: string;
      name?: string;
      status?: string;
      targetDate?: string | null;
    }>;

    if (projects.length === 0) {
      const suffix = companyLabel ? ` for ${companyLabel}` : "";
      return respondToInteraction({ type: 4, content: `No projects found${suffix}.`, ephemeral: true });
    }

    const statusEmoji: Record<string, string> = {
      in_progress: "🔄",
      completed: "✅",
      planned: "📋",
      on_hold: "⏸️",
      cancelled: "🚫",
    };

    const lines = projects.map((p) => {
      const emoji = statusEmoji[p.status ?? ""] ?? "📁";
      const label = p.name ?? p.id;
      const status = p.status ? ` · ${humanizeStatus(p.status)}` : "";
      return `${emoji} **${label}**${status}\n\u00A0\u00A0\u00A0\u00A0ID: \`${p.id}\``;
    });

    const title = companyLabel ? `Projects (${companyLabel})` : `Projects (${projects.length})`;
    const embeds: DiscordEmbed[] = [
      {
        title,
        description: lines.join("\n"),
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      },
    ];

    return respondToInteraction({ type: 4, embeds, ephemeral: true });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to fetch projects: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

function handleHelp(): unknown {
  const commands = [
    "`/clip status` — Show active agents and recent completions",
    "`/clip companies` — List available companies",
    "`/clip projects [company]` — List projects",
    "`/clip issues [project]` — List open issues",
    "`/clip agents [company]` — Show all agents with status",
    "`/clip approve <id>` — Approve a pending approval",
    "`/clip budget <agent>` — Check agent budget",
    "`/clip connect [company]` — Link channel to a company",
    "`/clip connect-channel <project>` — Map channel to a project",
    "`/clip digest <on|off|status> [mode]` — Configure daily digest",
    "`/clip commands import [json]` — Import a workflow command",
    "`/clip commands list` — List workflow commands",
    "`/clip commands run <name> [args]` — Run a workflow command",
    "`/clip commands delete <name>` — Delete a workflow command",
    "`/clip help` — Show this help message",
    "",
    "`/acp spawn <agent> <task>` — Start an agent session in a thread",
    "`/acp status <session>` — Check session status",
    "`/acp cancel <session>` — Cancel a session",
    "`/acp close <session>` — Close and archive a session thread",
  ];

  const embeds: DiscordEmbed[] = [
    {
      title: "Paperclip Bot Commands",
      description: commands.join("\n"),
      color: COLORS.BLUE,
      footer: { text: "Paperclip" },
    },
  ];

  return respondToInteraction({ type: 4, embeds, ephemeral: true });
}

async function handleConnect(
  ctx: PluginContext,
  companyArg?: string,
): Promise<unknown> {
  if (!companyArg?.trim()) {
    try {
      const companies = await ctx.companies.list();
      const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
      return respondToInteraction({
        type: 4,
        content: `Usage: \`/clip connect company:<name>\`\nAvailable: ${names || "none"}`,
        ephemeral: true,
      });
    } catch {
      return respondToInteraction({
        type: 4,
        content: "Usage: `/clip connect company:<name>`",
        ephemeral: true,
      });
    }
  }

  try {
    const input = companyArg.trim();
    const companies = await ctx.companies.list();
    const match = companies.find(
      (c: { id: string; name?: string }) =>
        c.id === input || c.name?.toLowerCase() === input.toLowerCase(),
    );

    if (!match) {
      const names = companies.map((c: { name?: string; id: string }) => c.name || c.id).join(", ");
      return respondToInteraction({
        type: 4,
        content: `Company "${input}" not found. Available: ${names || "none"}`,
        ephemeral: true,
      });
    }

    await ctx.state.set(
      { scopeKind: "instance", stateKey: `company_default` },
      { companyId: match.id, companyName: match.name ?? input, linkedAt: new Date().toISOString() },
    );

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Company Connected",
        description: `Linked to company: **${match.name ?? input}**`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

async function handleConnectChannel(
  ctx: PluginContext,
  projectName: string,
  channelId?: string,
): Promise<unknown> {
  if (!projectName.trim()) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/clip connect-channel project:<project-name>`",
      ephemeral: true,
    });
  }

  if (!channelId) {
    return respondToInteraction({
      type: 4,
      content: "Could not determine the current channel. Please run this command in the channel you want to map.",
      ephemeral: true,
    });
  }

  try {
    const existing = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "channel-project-map",
    })) as Record<string, string> | null;

    const channelMap = existing ?? {};
    channelMap[projectName.trim()] = channelId;

    await ctx.state.set(
      { scopeKind: "instance", stateKey: "channel-project-map" },
      channelMap,
    );

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Channel Mapped",
        description: `Mapped project **${projectName.trim()}** to this channel.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    return respondToInteraction({
      type: 4,
      content: `Failed to map channel: ${error instanceof Error ? error.message : String(error)}`,
      ephemeral: true,
    });
  }
}

// ---------------------------------------------------------------------------
// SpecPaper subcommands
//
// These are convenience wrappers that file Paperclip issues with the right
// shape for the SpecPaper company's agents (CTO / verifier / CEO). They are
// gated by `enableSpecPaperCommands` config (default false) but always
// registered with Discord — handlers cleanly refuse if the flag is off.
//
// Each command:
//   1. Resolves the target project — preferring the explicit `project:` arg,
//      then falling back to `channel-project-map` for the current channel.
//   2. Looks up the routing agent by name (CTO, Verifier, CEO).
//   3. POSTs a new issue to /api/companies/{cid}/issues with title that
//      surfaces the action (`!propose <idea>`, `!plan <change>`, …) so
//      agents that already grep for those markers stay happy.
//   4. Replies to the interaction with a small embed pointing at the issue.
// ---------------------------------------------------------------------------

const SPECPAPER_AGENT_BY_COMMAND: Record<string, string> = {
  propose: "CTO",
  brainstorm: "CTO",
  plan: "CTO",
  build: "CTO",
  archive: "CTO",
  verify: "Verifier",
  "principle-override": "CEO",
};

async function specpaperResolveProjectId(
  ctx: PluginContext,
  baseUrl: string,
  apiKey: string | undefined,
  companyId: string,
  explicitName: string | null,
  channelId: string | undefined,
): Promise<{ projectId: string; projectName: string } | { error: string }> {
  let nameOrSlug = explicitName?.trim() || null;

  // Fall back to channel mapping
  if (!nameOrSlug && channelId) {
    const channelMap = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "channel-project-map",
    })) as Record<string, string> | null;
    if (channelMap) {
      const matchedName = Object.entries(channelMap).find(
        ([, mappedChannelId]) => mappedChannelId === channelId,
      )?.[0];
      if (matchedName) nameOrSlug = matchedName;
    }
  }

  if (!nameOrSlug) {
    return {
      error:
        "Could not determine the project. Pass `project:<name>` or run `/clip connect-channel project:<name>` in this channel first.",
    };
  }

  // Look up via Paperclip API
  const res = await paperclipFetch(
    `${baseUrl}/api/companies/${companyId}/projects`,
    { method: "GET" },
    apiKey,
  );
  if (!res.ok) {
    return { error: `Paperclip projects lookup failed: HTTP ${res.status}` };
  }
  const projects = (await res.json()) as Array<{ id: string; name: string; slug?: string | null }>;
  const target = nameOrSlug.toLowerCase();
  const match = projects.find(
    (p) =>
      p.name?.toLowerCase() === target ||
      (p.slug ?? "").toLowerCase() === target,
  );
  if (!match) {
    return { error: `Project "${nameOrSlug}" not found in this company.` };
  }
  return { projectId: match.id, projectName: match.name };
}

async function specpaperResolveAgentId(
  ctx: PluginContext,
  baseUrl: string,
  apiKey: string | undefined,
  companyId: string,
  agentName: string,
): Promise<{ id: string; name: string } | null> {
  const res = await paperclipFetch(
    `${baseUrl}/api/companies/${companyId}/agents`,
    { method: "GET" },
    apiKey,
  );
  if (!res.ok) return null;
  const agents = (await res.json()) as Array<{ id: string; name: string }>;
  const target = agentName.toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === target) ?? null;
}

async function handleSpecPaperCommand(
  ctx: PluginContext,
  command: string,
  subcommand: { name: string; options?: InteractionOption[] },
  cmdCtx: CommandContext | undefined,
  channelId: string | undefined,
  companyId: string,
): Promise<unknown> {
  const config = (cmdCtx?.config ?? {}) as { enableSpecPaperCommands?: boolean };
  if (config.enableSpecPaperCommands === false) {
    return respondToInteraction({
      type: 4,
      content:
        "SpecPaper commands are disabled on this instance. Enable `enableSpecPaperCommands` in the plugin config.",
      ephemeral: true,
    });
  }

  const opts = subcommand.options ?? [];
  const projectArg = getOption(opts, "project") || null;
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";
  const apiKey = cmdCtx?.paperclipBoardApiKey;

  const projectResolution = await specpaperResolveProjectId(
    ctx,
    baseUrl,
    apiKey,
    companyId,
    projectArg,
    channelId,
  );
  if ("error" in projectResolution) {
    return respondToInteraction({ type: 4, content: projectResolution.error, ephemeral: true });
  }
  const { projectId, projectName } = projectResolution;

  const agentName = SPECPAPER_AGENT_BY_COMMAND[command];
  if (!agentName) {
    return respondToInteraction({ type: 4, content: `Unknown SpecPaper command: ${command}`, ephemeral: true });
  }
  const agent = await specpaperResolveAgentId(ctx, baseUrl, apiKey, companyId, agentName);
  if (!agent) {
    return respondToInteraction({
      type: 4,
      content: `No agent named "${agentName}" in this company. Make sure the SpecPaper company is imported.`,
      ephemeral: true,
    });
  }

  // Build the issue title + description
  let title: string;
  let description: string;
  switch (command) {
    case "propose": {
      const idea = (getOption(opts, "idea") || "").trim();
      if (!idea) {
        return respondToInteraction({ type: 4, content: "Provide `idea:<text>` for /clip propose.", ephemeral: true });
      }
      title = `!propose ${idea}`;
      description = `**SpecPaper proposal request from Discord**\n\nIdea: ${idea}\n\nRun \`specpaper propose "${idea.replace(/"/g, '\\"')}"\` per your skill instructions. Slugify the idea, write \`.specpaper/changes/<slug>/proposal.md\`, run \`docs-sync.sh\`, and comment on this issue with the change slug. Mark this issue \`done\` when the proposal artifact is in place.`;
      break;
    }
    case "brainstorm": {
      const change = (getOption(opts, "change") || "").trim();
      const technique = (getOption(opts, "technique") || "").trim();
      if (!change) return respondToInteraction({ type: 4, content: "Provide `change:<slug>` for /clip brainstorm.", ephemeral: true });
      title = `!brainstorm ${change}`;
      description = `**SpecPaper brainstorm request**\n\nChange: \`${change}\`${technique ? `\nTechnique: \`${technique}\`` : ""}\n\nRun the \`specpaper-brainstorm\` skill against this change. Apply the anti-bias protocol, generate ≥50 ideas, surface top 5 with rationale. Write \`.specpaper/changes/${change}/brainstorm.md\`, run \`docs-sync.sh\`, post the top 5 to the project channel via \`discord-sync.sh brainstorm-summary\`. Mark this issue \`done\` when complete.`;
      break;
    }
    case "plan": {
      const change = (getOption(opts, "change") || "").trim();
      if (!change) return respondToInteraction({ type: 4, content: "Provide `change:<slug>`.", ephemeral: true });
      title = `!plan ${change}`;
      description = `**SpecPaper plan request**\n\nChange: \`${change}\`\n\nRun \`specpaper plan ${change}\`. Read \`COMPANY.md\` principles + the change's \`context.yaml\`. Produce \`spec.md\`, \`design.md\` (with \`## Principles applied\` section), and \`tasks.md\` (with explicit \`Agent:\` routing or globs). Run \`docs-sync.sh\`. Mark done.`;
      break;
    }
    case "build": {
      const change = (getOption(opts, "change") || "").trim();
      if (!change) return respondToInteraction({ type: 4, content: "Provide `change:<slug>`.", ephemeral: true });
      title = `!build ${change}`;
      description = `**SpecPaper build request**\n\nChange: \`${change}\`\n\nRun \`specpaper build ${change}\`. Wave-based delegation per the routing rules in \`config.yaml\`. End each heartbeat in \`in_review\` until all wave issues close. Trigger verifier + e2e-tester audits in parallel after the last wave.`;
      break;
    }
    case "verify": {
      const change = (getOption(opts, "change") || "").trim();
      if (!change) return respondToInteraction({ type: 4, content: "Provide `change:<slug>`.", ephemeral: true });
      title = `!verify ${change}`;
      description = `**SpecPaper static spec audit**\n\nChange: \`${change}\`\n\nRun the verifier flow: \`verify.sh collect\` → \`verify-context.sh\` → audit spec acceptance criteria + design.md \`Principles applied\` section against the diff. Produce \`verify-report.md\`. Run \`docs-sync.sh\`. Mark this issue done with PASS/PARTIAL/FAIL in the summary.`;
      break;
    }
    case "archive": {
      const change = (getOption(opts, "change") || "").trim();
      if (!change) return respondToInteraction({ type: 4, content: "Provide `change:<slug>`.", ephemeral: true });
      title = `!archive ${change}`;
      description = `**SpecPaper archive request**\n\nChange: \`${change}\`\n\nValidate that \`verify-report.md\` and \`e2e-report.md\` are both PASS, then run \`specpaper archive ${change}\`. Move to \`.specpaper/changes/archive/<date>-${change}/\`. Update STATUS.md. Close the change issue + sync tracker.`;
      break;
    }
    case "principle-override": {
      const principle = (getOption(opts, "principle") || "").trim();
      const rationale = (getOption(opts, "rationale") || "").trim();
      if (!principle || !rationale) {
        return respondToInteraction({
          type: 4,
          content: "Provide both `principle:<id>` and `rationale:<text>`.",
          ephemeral: true,
        });
      }
      title = `!principle-override ${principle}`;
      description = `**CEO principle override request**\n\nPrinciple: \`${principle}\`\nRationale: ${rationale}\n\nRecord the decision in \`.specpaper/decisions/<id>.md\` with the principle id, the change/project context, and your reasoning. Update affected \`design.md\` Principles applied sections. Mark this issue \`done\` once the decision is recorded.`;
      break;
    }
    default:
      return respondToInteraction({ type: 4, content: `Unknown SpecPaper command: ${command}`, ephemeral: true });
  }

  // POST the issue
  try {
    const res = await paperclipFetch(
      `${baseUrl}/api/companies/${companyId}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title,
          description,
          assigneeAgentId: agent.id,
          status: "todo",
          labels: ["specpaper", `from-${command}`],
        }),
      },
      apiKey,
    );
    if (!res.ok) {
      const text = await res.text();
      return respondToInteraction({
        type: 4,
        content: `Failed to create issue: HTTP ${res.status} — ${text.slice(0, 200)}`,
        ephemeral: true,
      });
    }
    const created = (await res.json()) as { id: string; identifier?: string | null; title?: string };
    return respondToInteraction({
      type: 4,
      embeds: [
        {
          title: `Filed: ${created.identifier ?? created.id.slice(0, 8)}`,
          description: `${created.title ?? title}\n\nProject: **${projectName}** • Assignee: **${agent.name}**`,
          color: COLORS.GREEN,
          footer: { text: "Paperclip — SpecPaper" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (err) {
    return respondToInteraction({
      type: 4,
      content: `Failed to create issue: ${err instanceof Error ? err.message : String(err)}`,
      ephemeral: true,
    });
  }
}

async function handleDigest(
  ctx: PluginContext,
  action: string,
  mode?: string,
): Promise<unknown> {
  const stateKey = "digest-config";

  if (action === "status") {
    const config = (await ctx.state.get({
      scopeKind: "instance",
      stateKey,
    })) as { mode?: string; enabled?: boolean } | null;

    const currentMode = config?.mode ?? "off";
    const enabled = config?.enabled ?? false;

    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Configuration",
        fields: [
          { name: "Enabled", value: enabled ? "Yes" : "No", inline: true },
          { name: "Mode", value: currentMode, inline: true },
        ],
        color: COLORS.BLUE,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
      ephemeral: true,
    });
  }

  if (action === "off") {
    await ctx.state.set(
      { scopeKind: "instance", stateKey },
      { mode: "off", enabled: false },
    );
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Disabled",
        description: "Daily digest has been turned off.",
        color: COLORS.GRAY,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (action === "on") {
    const digestMode = mode ?? "daily";
    await ctx.state.set(
      { scopeKind: "instance", stateKey },
      { mode: digestMode, enabled: true },
    );
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: "Digest Enabled",
        description: `Daily digest set to **${digestMode}** mode.`,
        color: COLORS.GREEN,
        footer: { text: "Paperclip" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  return respondToInteraction({
    type: 4,
    content: "Usage: `/clip digest action:<on|off|status> [mode:<daily|bidaily|tridaily>]`",
    ephemeral: true,
  });
}

async function handleButtonClick(
  ctx: PluginContext,
  data: InteractionData,
  username?: string,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const customId = data.custom_id ?? data.name;
  const actor = username ?? "Discord user";
  const base = cmdCtx?.baseUrl ?? "http://localhost:3100";
  const token = cmdCtx?.token ?? "";
  const apiKey = cmdCtx?.paperclipBoardApiKey ?? "";

  if (customId.startsWith("approval_approve_")) {
    const approvalId = customId.replace("approval_approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, action: "approve", actor });

    try {
      const resp = await withRetry(async () => {
        const r = await paperclipFetch(`${base}/api/approvals/${approvalId}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
        }, apiKey);
        throwOnRetryableStatus(r);
        return r;
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`API ${resp.status}: ${body}`);
      }
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to approve via API", { approvalId, error: String(err) });
      return {
        type: 7,
        data: {
          embeds: [{
            title: "Approval Failed",
            description: `Could not approve — ${err instanceof Error ? err.message : String(err)}`,
            color: COLORS.RED,
            footer: { text: "Paperclip" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Approved** by ${actor}`,
          color: COLORS.GREEN,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  if (customId.startsWith("approval_reject_")) {
    const approvalId = customId.replace("approval_reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, action: "reject", actor });

    try {
      const resp = await withRetry(async () => {
        const r = await paperclipFetch(`${base}/api/approvals/${approvalId}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `discord:${actor}` }),
        }, apiKey);
        throwOnRetryableStatus(r);
        return r;
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`API ${resp.status}: ${body}`);
      }
      await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    } catch (err) {
      ctx.logger.error("Failed to reject via API", { approvalId, error: String(err) });
      return {
        type: 7,
        data: {
          embeds: [{
            title: "Rejection Failed",
            description: `Could not reject — ${err instanceof Error ? err.message : String(err)}`,
            color: COLORS.RED,
            footer: { text: "Paperclip" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    return {
      type: 7,
      data: {
        embeds: [{
          title: "Approval Resolved",
          description: `**Rejected** by ${actor}`,
          color: COLORS.RED,
          footer: { text: "Paperclip" },
          timestamp: new Date().toISOString(),
        }],
        components: [],
      },
    };
  }

  if (customId.startsWith("esc_")) {
    return handleEscalationButton(ctx, customId, actor, base);
  }

  if (customId.startsWith("handoff_")) {
    return handleHandoffButton(ctx, token, customId, actor);
  }

  if (customId.startsWith("disc_")) {
    return handleDiscussionButton(ctx, token, customId, actor);
  }

  if (customId.startsWith("wf_approve_") || customId.startsWith("wf_reject_")) {
    return handleWorkflowApprovalButton(ctx, customId, actor, cmdCtx);
  }

  if (customId.startsWith("issue_reopen_")) {
    const issueId = customId.replace("issue_reopen_", "");
    ctx.logger.info("Reopen button clicked", { issueId, actor });
    try {
      const issueCompanyId = await resolveIssueCompanyId(ctx, issueId);
      await ctx.issues.update(issueId, { status: "todo" }, issueCompanyId);
    } catch (err) {
      ctx.logger.error("Failed to reopen issue", { issueId, error: String(err) });
      return {
        type: 7,
        data: {
          embeds: [{ title: "Reopen Failed", description: `Could not reopen — ${err instanceof Error ? err.message : String(err)}`, color: COLORS.RED, footer: { text: "Paperclip" }, timestamp: new Date().toISOString() }],
          components: [],
        },
      };
    }
    return {
      type: 7,
      data: {
        embeds: [{ title: "Issue Reopened", description: `Reopened by **${actor}**`, color: COLORS.YELLOW, footer: { text: "Paperclip" }, timestamp: new Date().toISOString() }],
        components: [],
      },
    };
  }

  if (customId.startsWith("issue_assign_")) {
    const issueId = customId.replace("issue_assign_", "");
    ctx.logger.info("Assign to Me button clicked", { issueId, actor });
    try {
      const issueCompanyId = await resolveIssueCompanyId(ctx, issueId);
      const issue = await ctx.issues.get(issueId, issueCompanyId) as {
        assigneeUserId?: string | null;
        assigneeAgentId?: string | null;
      } | null;

      if (issue?.assigneeUserId || issue?.assigneeAgentId) {
        return respondToInteraction({
          type: 4,
          content: "Could not assign — issue already has an assignee.",
          ephemeral: true,
        });
      }

      await ctx.issues.update(
        issueId,
        { assigneeUserId: `discord:${actor}` } as Record<string, unknown>,
        issueCompanyId,
      );
    } catch (err) {
      ctx.logger.error("Failed to assign issue", { issueId, error: String(err) });
      const rawMessage = err instanceof Error ? err.message : String(err);
      const friendlyMessage = rawMessage.includes("Assignee user not found")
        ? "your Discord user is not linked to a Paperclip board user"
        : rawMessage;
      return respondToInteraction({ type: 4, content: `Could not assign — ${friendlyMessage}`, ephemeral: true });
    }
    return respondToInteraction({ type: 4, content: `✅ Assigned to **${actor}**`, ephemeral: true });
  }

  if (customId.startsWith("digest_blocked_")) {
    const companyId = customId.replace("digest_blocked_", "");
    ctx.logger.info("View Blocked button clicked", { companyId, actor });
    try {
      const issues = await ctx.issues.list({ companyId, status: "blocked", limit: 20 });
      if (issues.length === 0) {
        return respondToInteraction({ type: 4, content: "No blocked issues found.", ephemeral: true });
      }
      const lines = issues.map((i: { identifier?: string | null; id: string; title: string; blockerReason?: string }) => {
        const reason = i.blockerReason ? `\n  → ${i.blockerReason}` : "";
        return `• **${i.identifier ?? i.id}** — ${i.title}${reason}`;
      });
      return respondToInteraction({ type: 4, content: `🚫 **Blocked Issues (${issues.length})**\n\n${lines.join("\n").slice(0, 1900)}`, ephemeral: true });
    } catch (err) {
      ctx.logger.error("Failed to fetch blocked issues", { companyId, error: String(err) });
      return respondToInteraction({ type: 4, content: `Could not fetch blocked issues — ${err instanceof Error ? err.message : String(err)}`, ephemeral: true });
    }
  }

  return respondToInteraction({
    type: 4,
    content: "Unknown button action.",
    ephemeral: true,
  });
}

async function handleEscalationButton(
  ctx: PluginContext,
  customId: string,
  actor: string,
  _baseUrl: string,
): Promise<unknown> {
  // Button custom_id format: esc_{action}_{companyId}_{escalationId}
  // Legacy format (pre-fix): esc_{action}_{escalationId}
  // CompanyId is a UUID (contains hyphens), escalationId starts with "esc_".
  // We split on "_" to get the action, then look for a UUID-shaped segment.
  const parts = customId.split("_");
  const action = parts[1];
  const remaining = parts.slice(2).join("_");

  // Try to extract embedded companyId: UUID pattern before the escalation ID
  const uuidEscMatch = remaining.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(esc_.+)$/i,
  );
  const embeddedCompanyId = uuidEscMatch ? uuidEscMatch[1] : null;
  const escalationId = uuidEscMatch ? uuidEscMatch[2] : remaining;

  ctx.logger.info("Escalation button clicked", { escalationId, action, actor, embeddedCompanyId });

  const companyIdForLookup = embeddedCompanyId ?? await resolveCompanyId(ctx);
  const record = await getEscalation(ctx, escalationId, companyIdForLookup) as {
    escalationId: string; companyId: string; agentName: string;
    reason: string; suggestedReply?: string; status: string;
  } | null;

  if (!record) {
    return respondToInteraction({ type: 4, content: `Escalation \`${escalationId}\` not found.`, ephemeral: true });
  }

  if (record.status !== "pending") {
    return respondToInteraction({ type: 4, content: `Escalation already ${record.status}.`, ephemeral: true });
  }

  const companyId = record.companyId || "default";

  const resolveRecord = async (resolution: string): Promise<void> => {
    record!.status = "resolved";
    await ctx.state.set(
      { scopeKind: "company", scopeId: companyId, stateKey: `escalation_${escalationId}` },
      {
        ...record,
        resolvedAt: new Date().toISOString(),
        resolvedBy: `discord:${actor}`,
        resolution,
      },
    );
    await ctx.metrics.write(METRIC_NAMES.escalationsResolved, 1);
    ctx.events.emit("escalation-resolved", companyId, {
      escalationId,
      action: resolution,
      resolvedBy: actor,
      suggestedReply: record.suggestedReply,
    });
  };

  switch (action) {
    case "suggest": {
      await resolveRecord("suggested_reply");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - RESOLVED`,
            description: `**Suggested reply accepted** by ${actor}`,
            color: COLORS.GREEN,
            fields: [
              { name: "Reason", value: record.reason.slice(0, 1024) },
              ...(record.suggestedReply ? [{ name: "Reply Used", value: record.suggestedReply.slice(0, 1024) }] : []),
            ],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "reply": {
      await resolveRecord("human_reply");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - RESOLVED`,
            description: `**${actor}** is replying to the customer directly.`,
            color: COLORS.GREEN,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "override": {
      await resolveRecord("agent_override");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - OVERRIDDEN`,
            description: `**${actor}** has overridden the agent.`,
            color: COLORS.GREEN,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    case "dismiss": {
      await resolveRecord("dismissed");
      return {
        type: 7,
        data: {
          embeds: [{
            title: `Escalation from ${record.agentName} - DISMISSED`,
            description: `Dismissed by ${actor}`,
            color: COLORS.GRAY,
            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
            footer: { text: "Paperclip Escalation" },
            timestamp: new Date().toISOString(),
          }],
          components: [],
        },
      };
    }

    default:
      return respondToInteraction({ type: 4, content: `Unknown escalation action: ${action}`, ephemeral: true });
  }
}

async function resolveIssueCompanyId(
  ctx: PluginContext,
  issueId: string,
): Promise<string> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    const issue = await ctx.issues.get(issueId, company.id);
    if (issue) return company.id;
  }
  throw new Error(`Issue not found: ${issueId}`);
}

// ---------------------------------------------------------------------------
// /clip commands subcommands
// ---------------------------------------------------------------------------

async function handleCommands(
  ctx: PluginContext,
  subcommandGroup: InteractionOption,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const sub = subcommandGroup.options?.[0];
  if (!sub) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/clip commands list`.",
      ephemeral: true,
    });
  }

  const companyId = await resolveCompanyId(ctx);
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";
  const token = cmdCtx?.token ?? "";
  const channelId = cmdCtx?.defaultChannelId ?? "";

  switch (sub.name) {
    case "import":
      return handleCommandsImport(ctx, companyId, getOption(sub.options ?? [], "json"));
    case "list":
      return handleCommandsList(ctx, companyId);
    case "run":
      return handleCommandsRun(
        ctx,
        companyId,
        baseUrl,
        token,
        channelId,
        getOption(sub.options ?? [], "name") ?? "",
        getOption(sub.options ?? [], "args") ?? "",
        cmdCtx?.paperclipBoardApiKey ?? "",
      );
    case "delete":
      return handleCommandsDelete(ctx, companyId, getOption(sub.options ?? [], "name") ?? "");
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown commands subcommand: ${sub.name}`,
        ephemeral: true,
      });
  }
}

async function handleCommandsImport(
  ctx: PluginContext,
  companyId: string,
  jsonStr?: string,
): Promise<unknown> {
  if (!jsonStr?.trim()) {
    return respondToInteraction({
      type: 4,
      content: "Provide a JSON workflow via the `json` option.\n\nExample:\n```json\n{\"name\":\"greet\",\"steps\":[{\"type\":\"send_message\",\"message\":\"Hello {{args}}!\"}]}\n```",
      ephemeral: true,
    });
  }

  let parsed: { name?: string; description?: string; steps?: WorkflowStep[] };
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    return respondToInteraction({
      type: 4,
      content: "Invalid JSON. Please provide a valid workflow definition.",
      ephemeral: true,
    });
  }

  if (!parsed.name || typeof parsed.name !== "string") {
    return respondToInteraction({
      type: 4,
      content: "Workflow must have a `name` field.",
      ephemeral: true,
    });
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return respondToInteraction({
      type: 4,
      content: "Workflow must have at least one step in the `steps` array.",
      ephemeral: true,
    });
  }

  const name = parsed.name.toLowerCase().trim();

  if (BUILTIN_COMMANDS.has(name)) {
    return respondToInteraction({
      type: 4,
      content: `Cannot override built-in command: \`${name}\``,
      ephemeral: true,
    });
  }

  const store = await getWorkflowStore(ctx, companyId);
  const workflow: Workflow = {
    name,
    description: parsed.description,
    steps: parsed.steps,
    createdAt: new Date().toISOString(),
  };
  store.workflows[name] = workflow;
  await saveWorkflowStore(ctx, companyId, store);

  ctx.logger.info("Workflow command imported", { name, steps: workflow.steps.length });

  return respondToInteraction({
    type: 4,
    embeds: [{
      title: "Workflow Imported",
      description: `**${name}** — ${workflow.steps.length} step(s)`,
      color: COLORS.GREEN,
      fields: workflow.description ? [{ name: "Description", value: workflow.description }] : [],
      footer: { text: "Paperclip Workflow Commands" },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function handleCommandsList(
  ctx: PluginContext,
  companyId: string,
): Promise<unknown> {
  const store = await getWorkflowStore(ctx, companyId);
  const names = Object.keys(store.workflows);

  if (names.length === 0) {
    return respondToInteraction({
      type: 4,
      content: "No workflow commands registered. Use `/clip commands import` to add one.",
      ephemeral: true,
    });
  }

  const lines = names.map((n) => {
    const wf = store.workflows[n]!;
    const date = wf.createdAt ? new Date(wf.createdAt).toLocaleDateString() : "unknown";
    return `- **${n}** — ${wf.steps.length} step(s), created ${date}${wf.description ? ` — ${wf.description}` : ""}`;
  });

  return respondToInteraction({
    type: 4,
    embeds: [{
      title: "Workflow Commands",
      description: lines.join("\n"),
      color: COLORS.BLUE,
      footer: { text: "Paperclip Workflow Commands" },
      timestamp: new Date().toISOString(),
    }],
    ephemeral: true,
  });
}

async function handleCommandsRun(
  ctx: PluginContext,
  companyId: string,
  baseUrl: string,
  token: string,
  channelId: string,
  name: string,
  args: string,
  paperclipBoardApiKey: string,
): Promise<unknown> {
  if (!name.trim()) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/clip commands run name:<command-name> [args:<arguments>]`",
      ephemeral: true,
    });
  }

  const normalized = name.toLowerCase().trim();
  const store = await getWorkflowStore(ctx, companyId);
  const workflow = store.workflows[normalized];

  if (!workflow) {
    return respondToInteraction({
      type: 4,
      content: `Workflow command not found: \`${normalized}\``,
      ephemeral: true,
    });
  }

  // Acknowledge immediately, then run workflow
  const result = await runWorkflow({
    ctx,
    token,
    channelId,
    companyId,
    baseUrl,
    paperclipBoardApiKey,
    workflow,
    args,
  });

  if (result.suspended) {
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: `Workflow: ${normalized}`,
        description: `Completed ${result.stepsCompleted} step(s), waiting for approval...`,
        color: COLORS.YELLOW,
        footer: { text: "Paperclip Workflow Commands" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (!result.ok) {
    return respondToInteraction({
      type: 4,
      embeds: [{
        title: `Workflow Failed: ${normalized}`,
        description: `Failed at step ${result.stepsCompleted + 1}: ${result.error ?? "Unknown error"}`,
        color: COLORS.RED,
        footer: { text: "Paperclip Workflow Commands" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  await ctx.metrics.write(METRIC_NAMES.workflowsExecuted, 1);

  return respondToInteraction({
    type: 4,
    embeds: [{
      title: `Workflow Complete: ${normalized}`,
      description: `All ${result.stepsCompleted} step(s) executed successfully.`,
      color: COLORS.GREEN,
      footer: { text: "Paperclip Workflow Commands" },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function handleCommandsDelete(
  ctx: PluginContext,
  companyId: string,
  name: string,
): Promise<unknown> {
  if (!name.trim()) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/clip commands delete name:<command-name>`",
      ephemeral: true,
    });
  }

  const normalized = name.toLowerCase().trim();
  const store = await getWorkflowStore(ctx, companyId);

  if (!store.workflows[normalized]) {
    return respondToInteraction({
      type: 4,
      content: `Workflow command not found: \`${normalized}\``,
      ephemeral: true,
    });
  }

  delete store.workflows[normalized];
  await saveWorkflowStore(ctx, companyId, store);

  ctx.logger.info("Workflow command deleted", { name: normalized });

  return respondToInteraction({
    type: 4,
    embeds: [{
      title: "Workflow Deleted",
      description: `Removed workflow command: **${normalized}**`,
      color: COLORS.GRAY,
      footer: { text: "Paperclip Workflow Commands" },
      timestamp: new Date().toISOString(),
    }],
  });
}

// ---------------------------------------------------------------------------
// Workflow approval button handler
// ---------------------------------------------------------------------------

async function handleWorkflowApprovalButton(
  ctx: PluginContext,
  customId: string,
  actor: string,
  cmdCtx?: CommandContext,
): Promise<unknown> {
  const approved = customId.startsWith("wf_approve_");
  const approvalId = customId.replace(/^wf_(approve|reject)_/, "");
  const companyId = await resolveCompanyId(ctx);
  const baseUrl = cmdCtx?.baseUrl ?? "http://localhost:3100";
  const token = cmdCtx?.token ?? "";
  const channelId = cmdCtx?.defaultChannelId ?? "";

  ctx.logger.info("Workflow approval button clicked", { approvalId, approved, actor });

  const result = await resumeWorkflowAfterApproval(
    ctx,
    token,
    channelId,
    companyId,
    baseUrl,
    approvalId,
    approved,
    cmdCtx?.paperclipBoardApiKey ?? "",
  );

  const statusText = approved ? "Approved" : "Rejected";
  const color = approved ? COLORS.GREEN : COLORS.RED;

  const embeds: DiscordEmbed[] = [{
    title: `Workflow ${statusText}`,
    description: `**${statusText}** by ${actor}${!approved ? " — workflow stopped." : result.ok ? " — workflow resumed." : ` — resume failed: ${result.error}`}`,
    color,
    footer: { text: `Approval: ${approvalId}` },
    timestamp: new Date().toISOString(),
  }];

  return {
    type: 7,
    data: { embeds, components: [] },
  };
}
