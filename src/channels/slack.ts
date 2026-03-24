import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile, readEnvFileByPrefix } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  SendMessageOptions,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

/** A Slack App identity — one per agent (or one default shared by all). */
interface SlackIdentity {
  key: string; // 'default' | 'RESEARCHER' | 'OPS' etc.
  app: App;
  botUserId: string;
  botToken: string;
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  allAgents?: () => RegisteredGroup[];
}

export class SlackChannel implements Channel {
  name = 'slack';

  // Multi-identity: key → identity. 'default' always exists.
  private identities = new Map<string, SlackIdentity>();
  private defaultIdentity!: SlackIdentity;
  // Maps agentFolder → identity key (built from registeredGroups + slackIdentity field)
  private folderToIdentityKey = new Map<string, string>();
  // Maps botUserId → identity key (for mention detection)
  private botUserIdToIdentityKey = new Map<string, string>();
  // Dedup messages across identities (each App in the same channel receives the same message)
  private seenMessages = new Set<string>();
  private seenMessagesTrimTimer: ReturnType<typeof setInterval> | null = null;

  private connected = false;
  private outgoingQueue: Array<{
    jid: string;
    text: string;
    thread_ts?: string;
    agentFolder?: string;
  }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private lastMessageTs = new Map<string, string[]>(); // jid → queue of user message ts (for reactions)

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read default tokens
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const defaultBotToken = env.SLACK_BOT_TOKEN;
    const defaultAppToken = env.SLACK_APP_TOKEN;

    if (!defaultBotToken || !defaultAppToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    // Create default identity
    const defaultApp = new App({
      token: defaultBotToken,
      appToken: defaultAppToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });
    this.identities.set('default', {
      key: 'default',
      app: defaultApp,
      botUserId: '',
      botToken: defaultBotToken,
    });

    // Discover per-agent identities (SLACK_BOT_TOKEN_RESEARCHER, etc.)
    const suffixedBotTokens = readEnvFileByPrefix('SLACK_BOT_TOKEN');
    const suffixedAppTokens = readEnvFileByPrefix('SLACK_APP_TOKEN');

    for (const [suffix, botToken] of Object.entries(suffixedBotTokens)) {
      const appToken = suffixedAppTokens[suffix];
      if (!appToken) {
        logger.warn(
          { suffix },
          `SLACK_BOT_TOKEN_${suffix} found but no matching SLACK_APP_TOKEN_${suffix}, skipping`,
        );
        continue;
      }

      const app = new App({
        token: botToken,
        appToken,
        socketMode: true,
        logLevel: LogLevel.ERROR,
      });
      this.identities.set(suffix, {
        key: suffix,
        app,
        botUserId: '',
        botToken: botToken,
      });
      logger.info({ suffix }, 'Slack identity discovered');
    }

    // Set up event handlers on all identities
    for (const identity of this.identities.values()) {
      this.setupEventHandlers(identity);
    }

    this.defaultIdentity = this.identities.get('default')!;

    // Periodically trim the seenMessages set to prevent unbounded growth
    this.seenMessagesTrimTimer = setInterval(
      () => {
        this.seenMessages.clear();
      },
      5 * 60 * 1000,
    ); // Every 5 minutes
  }

  private setupEventHandlers(identity: SlackIdentity): void {
    identity.app.event('message', async ({ event }) => {
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      const msg = event as HandledMessageEvent;
      if (!msg.text) return;

      // Dedup across identities: each App in the same channel gets the same event
      if (this.seenMessages.has(msg.ts)) return;
      this.seenMessages.add(msg.ts);

      const jid = `slack:${msg.channel}`;
      const threadTs = (msg as GenericMessageEvent).thread_ts || msg.ts;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      // Check if this message is from ANY of our bot identities
      const isBotMessage =
        !!msg.bot_id || this.botUserIdToIdentityKey.has(msg.user || '');

      // Track user message ts queue for reaction-based typing indicator
      if (!isBotMessage) {
        const tsQueue = this.lastMessageTs.get(jid) || [];
        tsQueue.push(msg.ts);
        this.lastMessageTs.set(jid, tsQueue);
      }

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Check all bot identities for mentions.
      let content = msg.text;
      if (!isBotMessage) {
        for (const [botUserId, identityKey] of this.botUserIdToIdentityKey) {
          const mentionPattern = `<@${botUserId}>`;
          if (content.includes(mentionPattern)) {
            // Find the agent name for this identity
            const ident = this.identities.get(identityKey);
            const agentName = this.resolveAgentNameForIdentity(identityKey);
            if (agentName && !TRIGGER_PATTERN.test(content)) {
              content = `@${agentName} ${content}`;
            }
            break; // Only prepend one trigger
          }
        }
        // Fallback: check default bot mention (backwards compat)
        if (
          this.defaultIdentity.botUserId &&
          content === msg.text && // No mention was handled above
          content.includes(`<@${this.defaultIdentity.botUserId}>`) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
        thread_ts: threadTs,
      });
    });
  }

  async connect(): Promise<void> {
    // Connect all identities in parallel
    const connectPromises = [...this.identities.values()].map(
      async (identity) => {
        await identity.app.start();
        try {
          const auth = await identity.app.client.auth.test();
          identity.botUserId = auth.user_id as string;
          this.botUserIdToIdentityKey.set(identity.botUserId, identity.key);
          logger.info(
            {
              identity: identity.key,
              botUserId: identity.botUserId,
            },
            'Slack identity connected',
          );
        } catch (err) {
          logger.warn(
            { identity: identity.key, err },
            'Connected to Slack but failed to get bot user ID',
          );
        }
      },
    );
    await Promise.all(connectPromises);

    this.connected = true;

    // Build folder → identity mapping from registered groups
    this.rebuildFolderMapping();

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup (using default identity)
    await this.syncChannelMetadata();
  }

  /**
   * Returns botUserId → agentFolder mapping for triage @mention detection.
   * Maps each identity's bot user ID to the agent folder that uses it.
   */
  getBotUserMappings(): Map<string, string> {
    const result = new Map<string, string>();
    const agents = this.getAllAgents();
    for (const agent of agents) {
      if (agent.slackIdentity) {
        const identity = this.identities.get(agent.slackIdentity);
        if (identity?.botUserId) {
          result.set(identity.botUserId, agent.folder);
        }
      }
    }
    // Default identity maps to any agent without a specific slackIdentity
    if (this.defaultIdentity.botUserId) {
      for (const agent of agents) {
        if (!agent.slackIdentity) {
          result.set(this.defaultIdentity.botUserId, agent.folder);
        }
      }
    }
    return result;
  }

  /** Get all agents from allAgents() or fall back to registeredGroups(). */
  private getAllAgents(): RegisteredGroup[] {
    return this.opts.allAgents?.() || Object.values(this.opts.registeredGroups());
  }

  /**
   * Rebuild the agentFolder → identityKey mapping from registered groups.
   * Called at startup and should be called when groups change.
   */
  private rebuildFolderMapping(): void {
    this.folderToIdentityKey.clear();
    for (const agent of this.getAllAgents()) {
      if (agent.slackIdentity && this.identities.has(agent.slackIdentity)) {
        this.folderToIdentityKey.set(agent.folder, agent.slackIdentity);
      }
    }
  }

  /** Resolve the agent name for a given identity key by searching registered groups. */
  private resolveAgentNameForIdentity(identityKey: string): string | undefined {
    for (const agent of this.getAllAgents()) {
      if (agent.slackIdentity === identityKey && agent.assistantName) {
        return agent.assistantName;
      }
    }
    return undefined;
  }

  /** Get the App client for a given agent folder, falling back to default. */
  private getClientForAgent(agentFolder?: string): App {
    if (agentFolder) {
      const identityKey = this.folderToIdentityKey.get(agentFolder);
      if (identityKey) {
        const identity = this.identities.get(identityKey);
        if (identity) return identity.app;
      }
    }
    return this.defaultIdentity.app;
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = options?.thread_ts;
    const client = this.getClientForAgent(options?.agentFolder);

    if (!this.connected) {
      this.outgoingQueue.push({
        jid,
        text,
        thread_ts: threadTs,
        agentFolder: options?.agentFolder,
      });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await client.client.chat.postMessage({
          channel: channelId,
          text,
          thread_ts: threadTs,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await client.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            thread_ts: threadTs,
          });
        }
      }
      logger.info(
        {
          jid,
          length: text.length,
          threadTs,
          agentFolder: options?.agentFolder,
        },
        'Slack message sent',
      );
    } catch (err) {
      this.outgoingQueue.push({
        jid,
        text,
        thread_ts: threadTs,
        agentFolder: options?.agentFolder,
      });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.seenMessagesTrimTimer) {
      clearInterval(this.seenMessagesTrimTimer);
      this.seenMessagesTrimTimer = null;
    }
    // Stop all identities
    await Promise.all([...this.identities.values()].map((i) => i.app.stop()));
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const tsQueue = this.lastMessageTs.get(jid);
    const messageTs = tsQueue?.[0];
    if (!messageTs) {
      logger.debug({ jid, isTyping }, 'setTyping: no lastMessageTs, skipping');
      return;
    }

    // Use default identity for reactions (reactions show the app name regardless)
    try {
      if (isTyping) {
        await this.defaultIdentity.app.client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: 'ai-loading',
        });
      } else {
        await this.defaultIdentity.app.client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name: 'ai-loading',
        });
        tsQueue?.shift(); // Advance to next message's reaction target
      }
    } catch (err) {
      logger.warn(
        { jid, isTyping, messageTs, err },
        'setTyping reaction failed',
      );
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.defaultIdentity.app.client.conversations.list(
          {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
          },
        );

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.defaultIdentity.app.client.users.info({
        user: userId,
      });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        const client = this.getClientForAgent(item.agentFolder);
        await client.client.chat.postMessage({
          channel: channelId,
          text: item.text,
          thread_ts: item.thread_ts,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
