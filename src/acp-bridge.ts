import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordEmbed, type DiscordComponent, postEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, DISCORD_API_BASE, MAX_AGENTS_PER_THREAD, MAX_CONVERSATION_TURNS, DISCUSSION_STALE_MS } from "./constants.js";

interface InteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

interface AcpInteractionData {
  options?: InteractionOption[];
}

interface AcpOutputEvent {
  sessionId: string;
  channelId: string;
  threadId: string;
  agentName: string;
  output: string;
  status?: "running" | "completed" | "failed";
}

// --- Multi-agent session types ---

export interface AgentSession {
  sessionId: string;
  agentName: string;
  agentDisplayName: string;
  spawnedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  lastActivityAt: string;
}

interface ThreadSessions {
  sessions: AgentSession[];
}

// --- Handoff types ---

export interface HandoffRecord {
  handoffId: string;
  threadId: string;
  fromAgent: string;
  toAgent: string;
  reason: string;
  context?: string;
  status: "pending" | "approved" | "rejected";
  messageId?: string;
  channelId?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// --- Discussion loop types ---

export interface DiscussionLoop {
  discussionId: string;
  threadId: string;
  initiator: string;
  target: string;
  topic: string;
  maxTurns: number;
  humanCheckpointInterval: number;
  currentTurn: number;
  currentSpeaker: string;
  status: "active" | "paused_checkpoint" | "completed" | "stale" | "cancelled";
  lastActivityAt: string;
  createdAt: string;
}

// --- Output queue types ---

interface QueuedOutput {
  agentDisplayName: string;
  output: string;
  timestamp: number;
}

const outputQueues = new Map<string, QueuedOutput[]>();
const outputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const OUTPUT_FLUSH_DELAY_MS = 500;

function getOption(
  options: InteractionOption[] | undefined,
  name: string,
): string | undefined {
  return options
    ?.find((o) => o.name === name)
    ?.value?.toString();
}

// --- State helpers ---

function sessionsKey(channelId: string, threadId: string): string {
  return `sessions_${channelId}_${threadId}`;
}

async function getThreadSessions(
  ctx: PluginContext,
  channelId: string,
  threadId: string,
): Promise<AgentSession[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: sessionsKey(channelId, threadId),
  });
  if (!raw) return [];
  const data = raw as ThreadSessions;
  return data.sessions ?? [];
}

async function saveThreadSessions(
  ctx: PluginContext,
  channelId: string,
  threadId: string,
  sessions: AgentSession[],
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: sessionsKey(channelId, threadId),
    },
    { sessions } as ThreadSessions,
  );
}

async function getHandoff(
  ctx: PluginContext,
  handoffId: string,
): Promise<HandoffRecord | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `handoff_${handoffId}`,
  });
  return (raw as HandoffRecord) ?? null;
}

async function saveHandoff(
  ctx: PluginContext,
  record: HandoffRecord,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: `handoff_${record.handoffId}`,
    },
    record,
  );
}

async function getDiscussion(
  ctx: PluginContext,
  discussionId: string,
): Promise<DiscussionLoop | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `discussion_${discussionId}`,
  });
  return (raw as DiscussionLoop) ?? null;
}

async function saveDiscussion(
  ctx: PluginContext,
  record: DiscussionLoop,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: `discussion_${record.discussionId}`,
    },
    record,
  );
}

// --- Legacy single-binding compat (read-only, for migration) ---

interface LegacyAcpBinding {
  sessionId: string;
  agentName: string;
  channelId: string;
  threadId: string;
  startedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
}

async function getLegacyBinding(
  ctx: PluginContext,
  threadId: string,
): Promise<LegacyAcpBinding | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `acp_binding_${threadId}`,
  });
  return (raw as LegacyAcpBinding) ?? null;
}

// --- Message routing ---

export function parseAgentMention(text: string, sessions: AgentSession[]): AgentSession | null {
  const mentionMatch = text.match(/@(\S+)/);
  if (!mentionMatch) return null;
  const mention = mentionMatch[1]!.toLowerCase();

  // Exact match first
  for (const s of sessions) {
    if (s.agentName.toLowerCase() === mention || s.agentDisplayName.toLowerCase() === mention) {
      return s;
    }
  }
  // Partial match
  for (const s of sessions) {
    if (
      s.agentName.toLowerCase().startsWith(mention) ||
      s.agentDisplayName.toLowerCase().startsWith(mention)
    ) {
      return s;
    }
  }
  return null;
}

function getMostRecentlyActive(sessions: AgentSession[]): AgentSession | null {
  const running = sessions.filter((s) => s.status === "running");
  if (running.length === 0) return null;
  return running.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  )[0] ?? null;
}

// --- Output sequencing ---

function enqueueOutput(threadId: string, agentDisplayName: string, output: string): void {
  if (!outputQueues.has(threadId)) {
    outputQueues.set(threadId, []);
  }
  outputQueues.get(threadId)!.push({
    agentDisplayName,
    output,
    timestamp: Date.now(),
  });
}

async function flushOutputQueue(
  ctx: PluginContext,
  token: string,
  threadId: string,
  multiAgent: boolean,
): Promise<void> {
  const queue = outputQueues.get(threadId);
  if (!queue || queue.length === 0) return;

  // Drain the queue
  const items = queue.splice(0, queue.length);

  // Sort by timestamp for turn-based delivery
  items.sort((a, b) => a.timestamp - b.timestamp);

  for (const item of items) {
    const truncated = item.output.length > 1900
      ? item.output.slice(0, 1900) + "\n... (truncated)"
      : item.output;

    const prefix = multiAgent ? `**[${item.agentDisplayName}]** ` : "";
    const content = `${prefix}\`\`\`\n${truncated}\n\`\`\``;

    await postEmbed(ctx, token, threadId, { content });
  }

  if (queue.length === 0) {
    outputQueues.delete(threadId);
  }
}

function scheduleFlush(
  ctx: PluginContext,
  token: string,
  threadId: string,
  multiAgent: boolean,
): void {
  if (outputFlushTimers.has(threadId)) return;
  const timer = setTimeout(async () => {
    outputFlushTimers.delete(threadId);
    await flushOutputQueue(ctx, token, threadId, multiAgent);
  }, OUTPUT_FLUSH_DELAY_MS);
  outputFlushTimers.set(threadId, timer);
}

// --- Slash command handler ---

export async function handleAcpCommand(
  ctx: PluginContext,
  data: AcpInteractionData,
): Promise<unknown> {
  const subcommand = data.options?.[0];
  if (!subcommand) {
    return respondToInteraction({
      type: 4,
      content: "Missing subcommand. Try `/acp spawn agent:<name> task:<description>`.",
      ephemeral: true,
    });
  }

  const subName = subcommand.name;

  switch (subName) {
    case "spawn":
      return handleAcpSpawn(ctx, subcommand.options);
    case "status":
      return handleAcpStatus(ctx, subcommand.options);
    case "cancel":
      return handleAcpCancel(ctx, subcommand.options);
    case "close":
      return handleAcpClose(ctx, subcommand.options);
    default:
      return respondToInteraction({
        type: 4,
        content: `Unknown ACP subcommand: ${subName}`,
        ephemeral: true,
      });
  }
}

async function handleAcpSpawn(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const agentName = getOption(options, "agent");
  const task = getOption(options, "task");

  if (!agentName || !task) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp spawn agent:<name> task:<description>`",
      ephemeral: true,
    });
  }

  const sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  ctx.events.emit("acp:message", {
    type: "spawn",
    sessionId,
    agentName,
    task,
  });

  ctx.logger.info("ACP session spawn requested", { sessionId, agentName, task });

  return respondToInteraction({
    type: 4,
    content: `Spawning agent **${agentName}** for task:\n> ${task}\n\nSession: \`${sessionId}\`\nA thread will be created when the agent starts producing output.`,
    ephemeral: false,
  });
}

async function handleAcpStatus(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp status session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "status",
    sessionId,
  });

  return respondToInteraction({
    type: 4,
    content: `Checking status for session \`${sessionId}\`...`,
    ephemeral: true,
  });
}

async function handleAcpCancel(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp cancel session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "cancel",
    sessionId,
  });

  ctx.logger.info("ACP session cancel requested", { sessionId });

  return respondToInteraction({
    type: 4,
    content: `Cancelling session \`${sessionId}\`...`,
    ephemeral: false,
  });
}

async function handleAcpClose(
  ctx: PluginContext,
  options: InteractionOption[] | undefined,
): Promise<unknown> {
  const sessionId = getOption(options, "session");

  if (!sessionId) {
    return respondToInteraction({
      type: 4,
      content: "Usage: `/acp close session:<session-id>`",
      ephemeral: true,
    });
  }

  ctx.events.emit("acp:message", {
    type: "close",
    sessionId,
  });

  ctx.logger.info("ACP session close requested", { sessionId });

  return respondToInteraction({
    type: 4,
    content: `Closing session \`${sessionId}\`. The thread will be archived.`,
    ephemeral: false,
  });
}

// --- Multi-agent spawn (adds to thread session array) ---

export async function spawnAgentInThread(
  ctx: PluginContext,
  token: string,
  channelId: string,
  threadId: string,
  agentName: string,
  sessionId: string,
  maxAgents: number = MAX_AGENTS_PER_THREAD,
): Promise<{ ok: boolean; error?: string }> {
  const sessions = await getThreadSessions(ctx, channelId, threadId);
  const runningSessions = sessions.filter((s) => s.status === "running");

  if (runningSessions.length >= maxAgents) {
    return {
      ok: false,
      error: `Thread already has ${runningSessions.length} active agents (max ${maxAgents}). Close one first.`,
    };
  }

  // Check for duplicate agent name
  const existing = runningSessions.find(
    (s) => s.agentName.toLowerCase() === agentName.toLowerCase(),
  );
  if (existing) {
    return {
      ok: false,
      error: `Agent **${agentName}** is already running in this thread (session \`${existing.sessionId}\`).`,
    };
  }

  const now = new Date().toISOString();
  const session: AgentSession = {
    sessionId,
    agentName,
    agentDisplayName: agentName,
    spawnedAt: now,
    status: "running",
    lastActivityAt: now,
  };

  sessions.push(session);
  await saveThreadSessions(ctx, channelId, threadId, sessions);

  // Post join embed if there are multiple agents
  if (runningSessions.length > 0) {
    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: `Agent Joined: ${agentName}`,
          description: `**${agentName}** has joined the thread. ${runningSessions.length + 1} agents active.\nSession: \`${sessionId}\``,
          color: COLORS.BLUE,
          footer: { text: "Paperclip ACP" },
          timestamp: now,
        },
      ],
    });
  }

  ctx.logger.info("Agent spawned in thread", {
    sessionId,
    agentName,
    threadId,
    totalAgents: runningSessions.length + 1,
  });

  return { ok: true };
}

// --- Thread status (all agents) ---

export async function getThreadStatus(
  ctx: PluginContext,
  channelId: string,
  threadId: string,
): Promise<{ sessions: AgentSession[] }> {
  const sessions = await getThreadSessions(ctx, channelId, threadId);

  // Also check for legacy single-binding
  if (sessions.length === 0) {
    const legacy = await getLegacyBinding(ctx, threadId);
    if (legacy) {
      return {
        sessions: [
          {
            sessionId: legacy.sessionId,
            agentName: legacy.agentName,
            agentDisplayName: legacy.agentName,
            spawnedAt: legacy.startedAt,
            status: legacy.status,
            lastActivityAt: legacy.startedAt,
          },
        ],
      };
    }
  }

  return { sessions };
}

// --- Close specific agent by name ---

export async function closeAgentInThread(
  ctx: PluginContext,
  token: string,
  channelId: string,
  threadId: string,
  agentName: string,
): Promise<{ ok: boolean; error?: string }> {
  const sessions = await getThreadSessions(ctx, channelId, threadId);
  const target = sessions.find(
    (s) => s.agentName.toLowerCase() === agentName.toLowerCase() && s.status === "running",
  );

  if (!target) {
    return { ok: false, error: `No running agent named **${agentName}** in this thread.` };
  }

  target.status = "completed";
  await saveThreadSessions(ctx, channelId, threadId, sessions);

  ctx.events.emit("acp:message", {
    type: "close",
    sessionId: target.sessionId,
  });

  await postEmbed(ctx, token, threadId, {
    embeds: [
      {
        title: `Agent Closed: ${agentName}`,
        description: `**${agentName}** session \`${target.sessionId}\` has been closed.`,
        color: COLORS.GRAY,
        footer: { text: "Paperclip ACP" },
        timestamp: new Date().toISOString(),
      },
    ],
  });

  return { ok: true };
}

// --- Message routing with @mention support ---

export async function routeMessageToAcp(
  ctx: PluginContext,
  channelId: string,
  threadId: string,
  text: string,
): Promise<boolean> {
  const sessions = await getThreadSessions(ctx, channelId, threadId);

  // Fall back to legacy single binding if no multi-agent sessions
  if (sessions.length === 0) {
    const legacy = await getLegacyBinding(ctx, threadId);
    if (!legacy || legacy.status !== "running") return false;

    ctx.events.emit("acp:message", {
      type: "message",
      sessionId: legacy.sessionId,
      channelId,
      threadId,
      text,
    });
    return true;
  }

  const runningSessions = sessions.filter((s) => s.status === "running");
  if (runningSessions.length === 0) return false;

  // 1. Parse @agentname mentions (case-insensitive partial match)
  let target = parseAgentMention(text, runningSessions);

  // 2. Fallback: most recently active agent
  if (!target) {
    target = getMostRecentlyActive(runningSessions);
  }

  if (!target) return false;

  // Check if this message is part of an active discussion loop
  const discussionId = await findActiveDiscussion(ctx, threadId);
  if (discussionId) {
    const discussion = await getDiscussion(ctx, discussionId);
    if (discussion && discussion.status === "paused_checkpoint") {
      // Human message during checkpoint - treat as approval to continue
      discussion.status = "active";
      discussion.lastActivityAt = new Date().toISOString();
      await saveDiscussion(ctx, discussion);
    }
  }

  // Update last activity
  target.lastActivityAt = new Date().toISOString();
  await saveThreadSessions(ctx, channelId, threadId, sessions);

  ctx.events.emit("acp:message", {
    type: "message",
    sessionId: target.sessionId,
    channelId,
    threadId,
    text,
  });

  return true;
}

// --- Output handling with sequencing ---

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: AcpOutputEvent,
): Promise<void> {
  const { sessionId, channelId, threadId, agentName, output, status } = event;

  // Ensure the agent is tracked in the thread sessions array
  let sessions = await getThreadSessions(ctx, channelId, threadId);
  let session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    // Auto-register (backward compat with single-agent spawn flow)
    const now = new Date().toISOString();
    session = {
      sessionId,
      agentName,
      agentDisplayName: agentName,
      spawnedAt: now,
      status: "running",
      lastActivityAt: now,
    };
    sessions.push(session);
    await saveThreadSessions(ctx, channelId, threadId, sessions);
  }

  // Update status and activity
  if (status && status !== session.status) {
    session.status = status;
  }
  session.lastActivityAt = new Date().toISOString();
  await saveThreadSessions(ctx, channelId, threadId, sessions);

  const multiAgent = sessions.filter((s) => s.status === "running" || s.sessionId === sessionId).length > 1;

  // Enqueue and flush with sequencing
  enqueueOutput(threadId, session.agentDisplayName, output);

  // Post terminal status embed
  if (status === "completed" || status === "failed") {
    const statusColor = status === "completed" ? COLORS.GREEN : COLORS.RED;
    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: status === "completed" ? "Agent Completed" : "Agent Failed",
          description: `**${agentName}** session \`${sessionId}\` ${status}.`,
          color: statusColor,
          footer: { text: "Paperclip ACP" },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  // Check if output is part of an active discussion loop
  const discussionId = await findActiveDiscussion(ctx, threadId);
  if (discussionId) {
    await advanceDiscussion(ctx, token, threadId, discussionId, agentName);
  }

  // Schedule flush for queued output
  scheduleFlush(ctx, token, threadId, multiAgent);
}

// --- Thread creation ---

export async function createAcpThread(
  ctx: PluginContext,
  token: string,
  channelId: string,
  agentName: string,
  task: string,
  sessionId: string,
): Promise<string | null> {
  const threadName = `${agentName}: ${task.slice(0, 80)}`;

  try {
    const response = await ctx.http.fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/threads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: threadName,
          type: 11, // PUBLIC_THREAD
          auto_archive_duration: 1440, // 24 hours
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Failed to create ACP thread", {
        status: response.status,
        body: text,
        channelId,
      });
      return null;
    }

    const thread = (await response.json()) as { id: string };
    const threadId = thread.id;

    // Store the session in the multi-agent array
    const now = new Date().toISOString();
    const session: AgentSession = {
      sessionId,
      agentName,
      agentDisplayName: agentName,
      spawnedAt: now,
      status: "running",
      lastActivityAt: now,
    };
    await saveThreadSessions(ctx, channelId, threadId, [session]);

    // Post an initial message in the thread
    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: `Agent Session: ${agentName}`,
          description: `**Task:** ${task}\n**Session:** \`${sessionId}\``,
          color: COLORS.BLUE,
          footer: { text: "Paperclip ACP" },
          timestamp: now,
        },
      ],
    });

    ctx.logger.info("ACP thread created", { threadId, sessionId, agentName });
    return threadId;
  } catch (error) {
    ctx.logger.error("Failed to create ACP thread", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// --- Handoff tool implementation ---

export async function initiateHandoff(
  ctx: PluginContext,
  token: string,
  threadId: string,
  fromAgent: string,
  toAgent: string,
  reason: string,
  handoffContext?: string,
): Promise<{ handoffId: string; status: string }> {
  const handoffId = `hoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Find the thread's channel from sessions
  // We need channelId - scan state keys isn't possible, so we store it on the handoff
  // The caller must provide it or we derive from sessions state
  // For now, post directly to the thread (threadId works as channelId for thread messages)

  const embeds: DiscordEmbed[] = [
    {
      title: `Handoff Request: ${fromAgent} -> ${toAgent}`,
      description: reason.slice(0, 2048),
      color: COLORS.YELLOW,
      fields: [
        { name: "From", value: fromAgent, inline: true },
        { name: "To", value: toAgent, inline: true },
        ...(handoffContext ? [{ name: "Context", value: handoffContext.slice(0, 1024) }] : []),
      ],
      footer: { text: "Paperclip ACP Handoff" },
      timestamp: new Date().toISOString(),
    },
  ];

  const components: DiscordComponent[] = [
    {
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2,
          style: 3, // SUCCESS
          label: "Approve Handoff",
          custom_id: `handoff_approve_${handoffId}`,
        },
        {
          type: 2,
          style: 4, // DANGER
          label: "Reject Handoff",
          custom_id: `handoff_reject_${handoffId}`,
        },
      ],
    },
  ];

  // Post to thread
  const delivered = await postEmbed(ctx, token, threadId, { embeds, components });

  const record: HandoffRecord = {
    handoffId,
    threadId,
    fromAgent,
    toAgent,
    reason,
    context: handoffContext,
    status: "pending",
    channelId: threadId,
    createdAt: new Date().toISOString(),
  };
  await saveHandoff(ctx, record);

  ctx.logger.info("Handoff initiated", { handoffId, fromAgent, toAgent, threadId });

  return { handoffId, status: "pending" };
}

// --- Handoff button handler ---

export async function handleHandoffButton(
  ctx: PluginContext,
  token: string,
  customId: string,
  actor: string,
): Promise<unknown> {
  const parts = customId.split("_");
  const action = parts[1]; // approve or reject
  const handoffId = parts.slice(2).join("_");

  const record = await getHandoff(ctx, handoffId);
  if (!record) {
    return respondToInteraction({
      type: 4,
      content: `Handoff \`${handoffId}\` not found.`,
      ephemeral: true,
    });
  }

  if (record.status !== "pending") {
    return respondToInteraction({
      type: 4,
      content: `Handoff \`${handoffId}\` has already been ${record.status}.`,
      ephemeral: true,
    });
  }

  if (action === "approve") {
    record.status = "approved";
    record.resolvedAt = new Date().toISOString();
    record.resolvedBy = `discord:${actor}`;
    await saveHandoff(ctx, record);

    // Emit acp:message to the target agent with handoff context
    ctx.events.emit("acp:message", {
      type: "message",
      sessionId: `handoff_${handoffId}`,
      channelId: record.channelId,
      threadId: record.threadId,
      text: `[Handoff from ${record.fromAgent}] ${record.reason}${record.context ? `\n\nContext: ${record.context}` : ""}`,
      targetAgent: record.toAgent,
    });

    ctx.logger.info("Handoff approved", { handoffId, actor });

    return {
      type: 7,
      data: {
        embeds: [
          {
            title: `Handoff Approved: ${record.fromAgent} -> ${record.toAgent}`,
            description: `Approved by ${actor}. **${record.toAgent}** is now handling this.`,
            color: COLORS.GREEN,
            fields: [
              { name: "Reason", value: record.reason.slice(0, 1024) },
            ],
            footer: { text: "Paperclip ACP Handoff" },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [],
      },
    };
  }

  if (action === "reject") {
    record.status = "rejected";
    record.resolvedAt = new Date().toISOString();
    record.resolvedBy = `discord:${actor}`;
    await saveHandoff(ctx, record);

    ctx.logger.info("Handoff rejected", { handoffId, actor });

    return {
      type: 7,
      data: {
        embeds: [
          {
            title: `Handoff Rejected: ${record.fromAgent} -> ${record.toAgent}`,
            description: `Rejected by ${actor}. **${record.fromAgent}** continues.`,
            color: COLORS.RED,
            fields: [
              { name: "Reason", value: record.reason.slice(0, 1024) },
            ],
            footer: { text: "Paperclip ACP Handoff" },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [],
      },
    };
  }

  return respondToInteraction({
    type: 4,
    content: `Unknown handoff action: ${action}`,
    ephemeral: true,
  });
}

// --- Discussion loop implementation ---

export async function startDiscussion(
  ctx: PluginContext,
  token: string,
  threadId: string,
  initiator: string,
  target: string,
  topic: string,
  maxTurns: number = 10,
  humanCheckpointInterval: number = 0,
): Promise<{ discussionId: string; status: string }> {
  const discussionId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const clampedMaxTurns = Math.min(Math.max(maxTurns, 2), MAX_CONVERSATION_TURNS);

  const now = new Date().toISOString();
  const record: DiscussionLoop = {
    discussionId,
    threadId,
    initiator,
    target,
    topic,
    maxTurns: clampedMaxTurns,
    humanCheckpointInterval: humanCheckpointInterval > 0 ? humanCheckpointInterval : 0,
    currentTurn: 0,
    currentSpeaker: initiator,
    status: "active",
    lastActivityAt: now,
    createdAt: now,
  };
  await saveDiscussion(ctx, record);

  // Track active discussion for this thread
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: `active_discussion_${threadId}`,
    },
    discussionId,
  );

  // Post discussion start embed
  await postEmbed(ctx, token, threadId, {
    embeds: [
      {
        title: `Discussion Started: ${initiator} <-> ${target}`,
        description: `**Topic:** ${topic}\n**Max turns:** ${clampedMaxTurns}${humanCheckpointInterval > 0 ? `\n**Human checkpoint every:** ${humanCheckpointInterval} turns` : ""}`,
        color: COLORS.PURPLE,
        footer: { text: `Discussion ${discussionId}` },
        timestamp: now,
      },
    ],
  });

  // Kick off the first message to the initiator
  ctx.events.emit("acp:message", {
    type: "message",
    sessionId: `discussion_${discussionId}`,
    threadId,
    text: `[Discussion with ${target}] Topic: ${topic}\n\nPlease share your thoughts. You have ${clampedMaxTurns} turns total.`,
    targetAgent: initiator,
  });

  ctx.logger.info("Discussion started", { discussionId, initiator, target, maxTurns: clampedMaxTurns });

  return { discussionId, status: "active" };
}

async function findActiveDiscussion(
  ctx: PluginContext,
  threadId: string,
): Promise<string | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: "default",
    stateKey: `active_discussion_${threadId}`,
  });
  return (raw as string) ?? null;
}

async function advanceDiscussion(
  ctx: PluginContext,
  token: string,
  threadId: string,
  discussionId: string,
  lastSpeaker: string,
): Promise<void> {
  const discussion = await getDiscussion(ctx, discussionId);
  if (!discussion || discussion.status !== "active") return;

  // Check staleness
  const elapsed = Date.now() - new Date(discussion.lastActivityAt).getTime();
  if (elapsed > DISCUSSION_STALE_MS) {
    discussion.status = "stale";
    await saveDiscussion(ctx, discussion);
    await clearActiveDiscussion(ctx, threadId);

    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: "Discussion Stale",
          description: `Discussion between **${discussion.initiator}** and **${discussion.target}** went stale after ${Math.round(elapsed / 60000)} minutes of inactivity.`,
          color: COLORS.GRAY,
          footer: { text: `Discussion ${discussionId}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  discussion.currentTurn++;
  discussion.lastActivityAt = new Date().toISOString();

  // Check max turns
  if (discussion.currentTurn >= discussion.maxTurns) {
    discussion.status = "completed";
    await saveDiscussion(ctx, discussion);
    await clearActiveDiscussion(ctx, threadId);

    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: "Discussion Complete",
          description: `Discussion between **${discussion.initiator}** and **${discussion.target}** ended after ${discussion.currentTurn} turns.`,
          color: COLORS.GREEN,
          footer: { text: `Discussion ${discussionId}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  // Check human checkpoint
  if (
    discussion.humanCheckpointInterval > 0 &&
    discussion.currentTurn > 0 &&
    discussion.currentTurn % discussion.humanCheckpointInterval === 0
  ) {
    discussion.status = "paused_checkpoint";
    await saveDiscussion(ctx, discussion);

    await postEmbed(ctx, token, threadId, {
      embeds: [
        {
          title: "Discussion Paused - Human Checkpoint",
          description: `Turn ${discussion.currentTurn}/${discussion.maxTurns}. Send a message to continue or use the buttons.`,
          color: COLORS.YELLOW,
          footer: { text: `Discussion ${discussionId}` },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3, // SUCCESS
              label: "Continue Discussion",
              custom_id: `disc_continue_${discussionId}`,
            },
            {
              type: 2,
              style: 4, // DANGER
              label: "End Discussion",
              custom_id: `disc_end_${discussionId}`,
            },
          ],
        },
      ],
    });
    return;
  }

  // Route to next speaker
  const nextSpeaker = lastSpeaker === discussion.initiator
    ? discussion.target
    : discussion.initiator;
  discussion.currentSpeaker = nextSpeaker;
  await saveDiscussion(ctx, discussion);

  // Emit message to next speaker
  ctx.events.emit("acp:message", {
    type: "message",
    sessionId: `discussion_${discussionId}`,
    threadId,
    text: `[Discussion turn ${discussion.currentTurn}/${discussion.maxTurns} with ${lastSpeaker === discussion.initiator ? discussion.target : discussion.initiator}] Please respond to the previous message.`,
    targetAgent: nextSpeaker,
  });
}

async function clearActiveDiscussion(
  ctx: PluginContext,
  threadId: string,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: "default",
      stateKey: `active_discussion_${threadId}`,
    },
    null,
  );
}

// --- Discussion button handler ---

export async function handleDiscussionButton(
  ctx: PluginContext,
  token: string,
  customId: string,
  actor: string,
): Promise<unknown> {
  const parts = customId.split("_");
  const action = parts[1]; // continue or end
  const discussionId = parts.slice(2).join("_");

  const discussion = await getDiscussion(ctx, discussionId);
  if (!discussion) {
    return respondToInteraction({
      type: 4,
      content: `Discussion \`${discussionId}\` not found.`,
      ephemeral: true,
    });
  }

  if (action === "continue") {
    if (discussion.status !== "paused_checkpoint") {
      return respondToInteraction({
        type: 4,
        content: `Discussion is not paused (current status: ${discussion.status}).`,
        ephemeral: true,
      });
    }

    discussion.status = "active";
    discussion.lastActivityAt = new Date().toISOString();
    await saveDiscussion(ctx, discussion);

    // Route to current speaker
    ctx.events.emit("acp:message", {
      type: "message",
      sessionId: `discussion_${discussionId}`,
      threadId: discussion.threadId,
      text: `[Discussion resumed by ${actor} - turn ${discussion.currentTurn}/${discussion.maxTurns}] Continue the discussion.`,
      targetAgent: discussion.currentSpeaker,
    });

    return {
      type: 7,
      data: {
        embeds: [
          {
            title: "Discussion Resumed",
            description: `Resumed by ${actor}. Turn ${discussion.currentTurn}/${discussion.maxTurns}.`,
            color: COLORS.PURPLE,
            footer: { text: `Discussion ${discussionId}` },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [],
      },
    };
  }

  if (action === "end") {
    discussion.status = "cancelled";
    await saveDiscussion(ctx, discussion);
    await clearActiveDiscussion(ctx, discussion.threadId);

    return {
      type: 7,
      data: {
        embeds: [
          {
            title: "Discussion Ended",
            description: `Ended by ${actor} after ${discussion.currentTurn} turns.`,
            color: COLORS.GRAY,
            footer: { text: `Discussion ${discussionId}` },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [],
      },
    };
  }

  return respondToInteraction({
    type: 4,
    content: `Unknown discussion action: ${action}`,
    ephemeral: true,
  });
}
