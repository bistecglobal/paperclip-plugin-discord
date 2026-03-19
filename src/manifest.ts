import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Discord Bot",
  description:
    "Bidirectional Discord integration: push notifications on agent events, receive slash commands, and gather community intelligence for agent context.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    // "instance.settings.register",  // no UI in this repo
    "activity.log.write",
    "metrics.write",
    "agent.tools.register",
    "jobs.schedule",
    "events.emit",
    "escalations.read",
    "escalations.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      discordBotTokenRef: {
        type: "string",
        title: "Discord Bot Token (secret reference)",
        description:
          "Reference to the Discord Bot token stored in your secret provider.",
        default: DEFAULT_CONFIG.discordBotTokenRef,
      },
      defaultGuildId: {
        type: "string",
        title: "Default Guild (Server) ID",
        description: "The Discord server ID to post notifications to.",
        default: DEFAULT_CONFIG.defaultGuildId,
      },
      defaultChannelId: {
        type: "string",
        title: "Default Channel ID",
        description: "Channel ID to post notifications to.",
        default: DEFAULT_CONFIG.defaultChannelId,
      },
      approvalsChannelId: {
        type: "string",
        title: "Approvals Channel ID",
        description: "Channel ID for approval requests. Falls back to default channel.",
        default: DEFAULT_CONFIG.approvalsChannelId,
      },
      errorsChannelId: {
        type: "string",
        title: "Errors Channel ID",
        description: "Channel ID for agent error notifications. Falls back to default channel.",
        default: DEFAULT_CONFIG.errorsChannelId,
      },
      bdPipelineChannelId: {
        type: "string",
        title: "BD Pipeline Channel ID",
        description: "Channel ID for agent run lifecycle events. Falls back to default channel.",
        default: DEFAULT_CONFIG.bdPipelineChannelId,
      },
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },
      enableIntelligence: {
        type: "boolean",
        title: "Enable community intelligence",
        description:
          "Periodically scan Discord channels for community signals (feature requests, pain points). Results are queryable by agents.",
        default: DEFAULT_CONFIG.enableIntelligence,
      },
      intelligenceChannelIds: {
        type: "array",
        items: { type: "string" },
        title: "Intelligence channels",
        description: "Channel IDs to scan for community signals.",
        default: DEFAULT_CONFIG.intelligenceChannelIds,
      },
      backfillDays: {
        type: "number",
        title: "Backfill history (days)",
        description:
          "How many days of Discord message history to scan on first install. Set to 0 to skip backfill.",
        default: 90,
        minimum: 0,
        maximum: 365,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description: "Base URL for Paperclip dashboard links and API calls",
        default: "http://localhost:3100",
      },
      intelligenceRetentionDays: {
        type: "number",
        title: "Intelligence retention (days)",
        description: "How many days to retain intelligence signals before expiry.",
        default: 30,
        minimum: 1,
        maximum: 365,
      },
      escalationChannelId: {
        type: "string",
        title: "Escalation Channel ID",
        description:
          "Channel ID for human-in-the-loop escalation messages. Falls back to default channel.",
        default: "",
      },
      enableEscalations: {
        type: "boolean",
        title: "Enable escalation support",
        description:
          "Allow agents to escalate conversations to humans via Discord with actionable buttons.",
        default: true,
      },
      escalationTimeoutMinutes: {
        type: "number",
        title: "Escalation timeout (minutes)",
        description:
          "How long to wait for a human response before marking an escalation as timed out.",
        default: 30,
        minimum: 5,
        maximum: 1440,
      },
      maxAgentsPerThread: {
        type: "number",
        title: "Max agents per thread",
        description:
          "Maximum number of concurrent agent sessions allowed in a single Discord thread.",
        default: 5,
        minimum: 1,
        maximum: 10,
      },
    },
    required: ["discordBotTokenRef", "defaultChannelId"],
  },
  jobs: [
    {
      jobKey: "discord-intelligence-scan",
      displayName: "Discord Intelligence Scan",
      description:
        "Periodically scan configured Discord channels for community signals (feature requests, pain points, maintainer directives).",
      schedule: "0 */6 * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Escalation Timeout Check",
      description:
        "Periodically check for escalations that have exceeded the configured timeout and mark them as timed out.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [
    {
      name: "discord_signals",
      displayName: "Discord Signals",
      description:
        "Query recent community signals from Discord (feature requests, pain points, maintainer directives).",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: {
            type: "string",
            description: "Company ID to query signals for",
          },
          category: {
            type: "string",
            enum: [
              "feature_wish",
              "pain_point",
              "maintainer_directive",
              "sentiment",
            ],
            description: "Filter signals by category (optional)",
          },
        },
        required: ["companyId"],
      },
    },
    {
      name: "escalate_to_human",
      displayName: "Escalate to Human",
      description:
        "Escalate a conversation to a human operator via Discord. Posts an interactive embed with action buttons for human review.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: {
            type: "string",
            description: "Company ID for the escalation",
          },
          agentName: {
            type: "string",
            description: "Name of the agent requesting escalation",
          },
          reason: {
            type: "string",
            description: "Why the agent is escalating (shown to the human)",
          },
          confidenceScore: {
            type: "number",
            description:
              "Agent's confidence score (0-1) for its last response before escalation",
          },
          agentReasoning: {
            type: "string",
            description:
              "The agent's internal reasoning for why it cannot handle this autonomously",
          },
          conversationHistory: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                content: { type: "string" },
              },
            },
            description:
              "Last N messages of conversation history for context (max 5 shown)",
          },
          suggestedReply: {
            type: "string",
            description:
              "Optional suggested reply the agent thinks might work but wants human approval for",
          },
        },
        required: ["companyId", "agentName", "reason"],
      },
    },
    {
      name: "handoff_to_agent",
      displayName: "Handoff to Agent",
      description:
        "Hand off a conversation to another agent in the same Discord thread. Requires human approval via button click before the handoff executes.",
      parametersSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Discord thread ID where both agents reside",
          },
          fromAgent: {
            type: "string",
            description: "Name of the agent initiating the handoff",
          },
          toAgent: {
            type: "string",
            description: "Name of the target agent to hand off to",
          },
          reason: {
            type: "string",
            description: "Why this handoff is being requested",
          },
          context: {
            type: "string",
            description: "Context or summary to pass to the target agent",
          },
        },
        required: ["threadId", "fromAgent", "toAgent", "reason"],
      },
    },
    {
      name: "discuss_with_agent",
      displayName: "Discuss with Agent",
      description:
        "Start a multi-turn conversation loop between two agents in a Discord thread. Includes human checkpoints and max turn enforcement.",
      parametersSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Discord thread ID where both agents reside",
          },
          initiator: {
            type: "string",
            description: "Name of the agent starting the discussion",
          },
          target: {
            type: "string",
            description: "Name of the agent to discuss with",
          },
          topic: {
            type: "string",
            description: "Topic or question to discuss",
          },
          maxTurns: {
            type: "number",
            description: "Maximum number of turns (default: 10, max: 50)",
          },
          humanCheckpointInterval: {
            type: "number",
            description: "Pause for human approval every N turns (0 = no checkpoints)",
          },
        },
        required: ["threadId", "initiator", "target", "topic"],
      },
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.discordInteractions,
      displayName: "Discord Interactions",
      description:
        "Receives Discord slash command and button interaction payloads.",
    },
  ],
  // UI disabled — no settings page source in this repo
  // ui: {
  //   slots: [
  //     {
  //       type: "settingsPage",
  //       id: SLOT_IDS.settingsPage,
  //       displayName: "Discord Settings",
  //       exportName: EXPORT_NAMES.settingsPage,
  //     },
  //   ],
  // },
};

export default manifest;
