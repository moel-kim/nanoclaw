import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

// --- Interfaces ---

export interface TriageContext {
  /** thread_ts → agentFolder: tracks which agent "owns" a thread */
  threadOwnership: ThreadAffinityTracker;
  /** botUserId → agentFolder: maps Slack bot user IDs to agents */
  botUserIds: Map<string, string>;
}

export interface TriageResult {
  matchedAgents: string[]; // agent folders
  reason: string;
  strategy: string;
}

export interface TriageStrategy {
  name: string;
  /**
   * Evaluate whether any agents should handle this message.
   * Return null to let the cascade continue to the next strategy.
   */
  triage(
    message: NewMessage,
    agents: RegisteredGroup[],
    context: TriageContext,
  ): Promise<TriageResult | null>;
}

// --- Thread Affinity Tracker ---

const THREAD_AFFINITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const THREAD_AFFINITY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class ThreadAffinityTracker {
  private ownership = new Map<string, string>(); // thread_ts → agentFolder
  private timestamps = new Map<string, number>(); // thread_ts → set time
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      THREAD_AFFINITY_CLEANUP_INTERVAL_MS,
    );
  }

  set(threadTs: string, agentFolder: string): void {
    this.ownership.set(threadTs, agentFolder);
    this.timestamps.set(threadTs, Date.now());
  }

  get(threadTs: string): string | undefined {
    return this.ownership.get(threadTs);
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [threadTs, ts] of this.timestamps) {
      if (now - ts > THREAD_AFFINITY_MAX_AGE_MS) {
        this.ownership.delete(threadTs);
        this.timestamps.delete(threadTs);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'Thread affinity cleanup');
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Serialize for persistence via router_state DB. */
  serialize(): string {
    const entries: Record<string, { folder: string; ts: number }> = {};
    for (const [threadTs, folder] of this.ownership) {
      entries[threadTs] = {
        folder,
        ts: this.timestamps.get(threadTs) || Date.now(),
      };
    }
    return JSON.stringify(entries);
  }

  /** Restore from serialized state. */
  static deserialize(json: string): ThreadAffinityTracker {
    const tracker = new ThreadAffinityTracker();
    try {
      const entries = JSON.parse(json) as Record<
        string,
        { folder: string; ts: number }
      >;
      const now = Date.now();
      for (const [threadTs, { folder, ts }] of Object.entries(entries)) {
        // Skip expired entries
        if (now - ts > THREAD_AFFINITY_MAX_AGE_MS) continue;
        tracker.ownership.set(threadTs, folder);
        tracker.timestamps.set(threadTs, ts);
      }
    } catch {
      logger.warn('Failed to deserialize thread affinity data');
    }
    return tracker;
  }
}

// --- Triage Strategies ---

/**
 * Explicit routing: @mention match + thread affinity.
 * This is free, instant, and definitive — if it matches, the cascade stops.
 */
export class ExplicitTriageStrategy implements TriageStrategy {
  name = 'explicit';

  async triage(
    message: NewMessage,
    agents: RegisteredGroup[],
    context: TriageContext,
  ): Promise<TriageResult | null> {
    // 1. Thread affinity: if this message is in a thread owned by an agent, route there
    if (message.thread_ts) {
      const owner = context.threadOwnership.get(message.thread_ts);
      if (owner && agents.some((a) => a.folder === owner)) {
        return {
          matchedAgents: [owner],
          reason: `Thread affinity: ${owner}`,
          strategy: this.name,
        };
      }
    }

    // 2. @mention: check if any agent's bot user ID is mentioned
    if (message.content && context.botUserIds.size > 0) {
      const matched: string[] = [];
      for (const [botUserId, agentFolder] of context.botUserIds) {
        if (message.content.includes(`<@${botUserId}>`)) {
          if (agents.some((a) => a.folder === agentFolder)) {
            matched.push(agentFolder);
          }
        }
      }
      if (matched.length > 0) {
        return {
          matchedAgents: matched,
          reason: `@mention: ${matched.join(', ')}`,
          strategy: this.name,
        };
      }
    }

    return null; // No explicit match, cascade continues
  }
}

/**
 * Keyword-based routing: matches agent triageKeywords against message content.
 * Free, instant, but less precise than explicit routing.
 */
export class KeywordTriageStrategy implements TriageStrategy {
  name = 'keyword';

  async triage(
    message: NewMessage,
    agents: RegisteredGroup[],
    _context: TriageContext,
  ): Promise<TriageResult | null> {
    if (!message.content) return null;

    const contentLower = message.content.toLowerCase();
    const matched: string[] = [];

    for (const agent of agents) {
      if (!agent.triageKeywords || agent.triageKeywords.length === 0) continue;
      const hasMatch = agent.triageKeywords.some((kw) =>
        contentLower.includes(kw.toLowerCase()),
      );
      if (hasMatch) {
        matched.push(agent.folder);
      }
    }

    if (matched.length > 0) {
      return {
        matchedAgents: matched,
        reason: `Keyword match: ${matched.join(', ')}`,
        strategy: this.name,
      };
    }

    return null;
  }
}

/**
 * LLM-based triage: sends message + agent descriptions to a fast model.
 * Stub implementation — returns null (passes through to fallback).
 * To activate: implement the API call to Haiku/Ollama.
 */
export class LlmTriageStrategy implements TriageStrategy {
  name = 'llm';

  async triage(
    _message: NewMessage,
    _agents: RegisteredGroup[],
    _context: TriageContext,
  ): Promise<TriageResult | null> {
    // TODO: Implement LLM-based triage (Haiku or Ollama)
    return null;
  }
}

/**
 * Cascade: chains strategies in order. Returns first non-null result.
 * If all return null, falls back to isMain agent or returns empty.
 */
export class CascadeTriageStrategy implements TriageStrategy {
  name = 'cascade';
  private strategies: TriageStrategy[];

  constructor(strategies?: TriageStrategy[]) {
    this.strategies = strategies || [
      new ExplicitTriageStrategy(),
      new KeywordTriageStrategy(),
      new LlmTriageStrategy(),
    ];
  }

  async triage(
    message: NewMessage,
    agents: RegisteredGroup[],
    context: TriageContext,
  ): Promise<TriageResult | null> {
    for (const strategy of this.strategies) {
      const result = await strategy.triage(message, agents, context);
      if (result && result.matchedAgents.length > 0) {
        return result;
      }
    }

    // Fallback: route to isMain agent if one exists
    const mainAgent = agents.find((a) => a.isMain);
    if (mainAgent) {
      return {
        matchedAgents: [mainAgent.folder],
        reason: 'Fallback to main agent',
        strategy: 'fallback',
      };
    }

    return null; // No match
  }
}

// --- Persistence helpers ---

export function loadThreadAffinity(): ThreadAffinityTracker {
  const data = getRouterState('thread_ownership');
  if (data) {
    return ThreadAffinityTracker.deserialize(data);
  }
  return new ThreadAffinityTracker();
}

export function saveThreadAffinity(tracker: ThreadAffinityTracker): void {
  setRouterState('thread_ownership', tracker.serialize());
}
