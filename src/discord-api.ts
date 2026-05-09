import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";
import { withRetry } from "./retry.js";

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordComponent[];
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  position: number;
  permissions: string;
}

export interface DiscordChannelMessage {
  id: string;
  content: string;
  author: { id: string; username: string };
  timestamp: string;
  member?: { roles: string[] };
}

async function discordFetch(
  ctx: PluginContext,
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const url = `${DISCORD_API_BASE}${path}`;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (options.body) {
    init.body = JSON.stringify(options.body);
  }
  return ctx.http.fetch(url, init);
}

function normalizeDiscordPathId(id: string | number): string {
  return String(id);
}

export async function postEmbed(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  message: DiscordMessage,
): Promise<boolean> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    await withRetry(async () => {
      const response = await discordFetch(
        ctx,
        token,
        `/channels/${safeChannelId}/messages`,
        {
          method: "POST",
          body: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Discord API error: ${response.status}`);
        (err as any).status = response.status;
        (err as any).headers = response.headers;
        ctx.logger.warn("Discord API error", {
          status: response.status,
          body: text,
          channelId: safeChannelId,
        });
        throw err;
      }
    });

    await ctx.metrics.write(METRIC_NAMES.sent, 1);
    return true;
  } catch (error) {
    ctx.logger.error("Discord notification delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.metrics.write(METRIC_NAMES.failed, 1);
    return false;
  }
}

export async function postEmbedWithId(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  message: DiscordMessage,
): Promise<string | null> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    let messageId: string | null = null;
    await withRetry(async () => {
      const response = await discordFetch(
        ctx,
        token,
        `/channels/${safeChannelId}/messages`,
        {
          method: "POST",
          body: {
            content: message.content,
            embeds: message.embeds,
            components: message.components,
          },
        },
      );

      if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Discord API error: ${response.status}`);
        (err as any).status = response.status;
        (err as any).headers = response.headers;
        ctx.logger.warn("Discord API error", {
          status: response.status,
          body: text,
          channelId: safeChannelId,
        });
        throw err;
      }

      const data = (await response.json()) as { id: string };
      messageId = data.id;
    });

    await ctx.metrics.write(METRIC_NAMES.sent, 1);
    return messageId;
  } catch (error) {
    ctx.logger.error("Discord notification delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.metrics.write(METRIC_NAMES.failed, 1);
    return null;
  }
}

export async function registerSlashCommands(
  ctx: PluginContext,
  token: string,
  applicationId: string,
  guildId: string | number,
  commands: Array<{
    name: string;
    description: string;
    options?: unknown[];
  }>,
): Promise<boolean> {
  const safeGuildId = normalizeDiscordPathId(guildId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/applications/${applicationId}/guilds/${safeGuildId}/commands`,
      { method: "PUT", body: commands },
    );
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Failed to register slash commands", {
        status: response.status,
        body: text,
      });
      return false;
    }
    return true;
  } catch (error) {
    ctx.logger.error("Slash command registration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function getChannelMessages(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  limit: number = 100,
): Promise<DiscordChannelMessage[]> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/channels/${safeChannelId}/messages?limit=${limit}`,
    );
    if (!response.ok) return [];
    return (await response.json()) as DiscordChannelMessage[];
  } catch {
    return [];
  }
}

export async function getChannelMessagesAll(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  opts: {
    maxMessages?: number;
    maxAgeDays?: number;
    pageDelayMs?: number;
    onProgress?: (fetched: number) => void;
  } = {},
): Promise<DiscordChannelMessage[]> {
  const safeChannelId = normalizeDiscordPathId(channelId);
  const maxMessages = opts.maxMessages ?? 5000;
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const pageDelayMs = opts.pageDelayMs ?? 500;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const allMessages: DiscordChannelMessage[] = [];
  let before: string | undefined;

  while (allMessages.length < maxMessages) {
    const query = before
      ? `/channels/${safeChannelId}/messages?limit=100&before=${before}`
      : `/channels/${safeChannelId}/messages?limit=100`;

    try {
      const response = await discordFetch(ctx, token, query);
      if (!response.ok) break;

      const page = (await response.json()) as DiscordChannelMessage[];
      if (page.length === 0) break;

      for (const msg of page) {
        if (msg.timestamp < cutoff) {
          // Reached max age cutoff
          return allMessages;
        }
        allMessages.push(msg);
      }

      before = page[page.length - 1]!.id;
      opts.onProgress?.(allMessages.length);

      // Rate limit delay between pages
      if (pageDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
      }
    } catch {
      break;
    }
  }

  return allMessages;
}

export async function getGuildRoles(
  ctx: PluginContext,
  token: string,
  guildId: string | number,
): Promise<DiscordGuildRole[]> {
  const safeGuildId = normalizeDiscordPathId(guildId);
  try {
    const response = await discordFetch(
      ctx,
      token,
      `/guilds/${safeGuildId}/roles`,
    );
    if (!response.ok) return [];
    return (await response.json()) as DiscordGuildRole[];
  } catch {
    return [];
  }
}

export async function getApplicationId(
  ctx: PluginContext,
  token: string,
): Promise<string | null> {
  try {
    const response = await discordFetch(ctx, token, "/oauth2/applications/@me");
    if (!response.ok) return null;
    const data = (await response.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

export function respondToInteraction(data: {
  type: number;
  content?: string;
  embeds?: DiscordEmbed[];
  ephemeral?: boolean;
}): unknown {
  return {
    type: data.type,
    data: {
      content: data.content,
      embeds: data.embeds,
      flags: data.ephemeral ? 64 : 0,
    },
  };
}

export interface DiscordChannelCreated {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  topic?: string | null;
}

/**
 * Create a Discord channel in a guild.
 * Requires the bot to have the MANAGE_CHANNELS permission.
 *
 * @param type 0 = GUILD_TEXT (default), 5 = GUILD_ANNOUNCEMENT
 */
export async function createChannel(
  ctx: PluginContext,
  token: string,
  guildId: string | number,
  name: string,
  options: {
    type?: 0 | 5;
    parentId?: string;
    topic?: string;
    rateLimitPerUser?: number;
  } = {},
): Promise<DiscordChannelCreated | null> {
  const safeGuildId = normalizeDiscordPathId(guildId);
  try {
    const response = await withRetry(async () => {
      const res = await discordFetch(ctx, token, `/guilds/${safeGuildId}/channels`, {
        method: "POST",
        body: {
          name,
          type: options.type ?? 0,
          parent_id: options.parentId,
          topic: options.topic,
          rate_limit_per_user: options.rateLimitPerUser,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Discord API error: ${res.status}`) as Error & {
          status?: number;
          headers?: Headers;
        };
        err.status = res.status;
        err.headers = res.headers;
        ctx.logger.warn("createChannel failed", {
          status: res.status,
          body: text,
          guildId: safeGuildId,
          name,
        });
        throw err;
      }
      return res;
    });
    return (await response.json()) as DiscordChannelCreated;
  } catch (error) {
    ctx.logger.error("createChannel delivery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Post a plain or markdown message to a channel by ID. Thin wrapper over postEmbed
 * for callers that just need text content. Used by agent tools that need to push
 * structured updates (status digests, brainstorm summaries, etc.) outside the
 * issue-lifecycle auto-emit path.
 */
export async function postPlainMessage(
  ctx: PluginContext,
  token: string,
  channelId: string | number,
  content: string,
): Promise<boolean> {
  return postEmbed(ctx, token, channelId, { content });
}
