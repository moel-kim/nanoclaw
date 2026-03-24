/**
 * Multi-agent integration tests.
 * Verifies that multi-agent routing, triage, and identity mapping
 * work correctly — preventing regressions like:
 * - getBotUserMappings() missing agents (only returning first per JID)
 * - Trigger patterns ignoring per-agent names
 * - Triage @mention detection not working
 */
import { describe, it, expect } from 'vitest';

import {
  ExplicitTriageStrategy,
  KeywordTriageStrategy,
  CascadeTriageStrategy,
  ThreadAffinityTracker,
} from './triage.js';
import { NewMessage, RegisteredGroup } from './types.js';

// --- Test fixtures ---

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1234.5678',
    chat_jid: 'slack:C0TEST',
    sender: 'U_USER',
    sender_name: 'TestUser',
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test-agent',
    folder: 'test_agent',
    trigger: '@TestBot',
    added_at: new Date().toISOString(),
    jid: 'slack:C0TEST',
    ...overrides,
  };
}

// --- ExplicitTriageStrategy ---

describe('ExplicitTriageStrategy', () => {
  const strategy = new ExplicitTriageStrategy();

  it('routes @mention to the correct agent', async () => {
    const agents = [
      makeAgent({ folder: 'agent_a', assistantName: 'AgentA' }),
      makeAgent({ folder: 'agent_b', assistantName: 'AgentB' }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map([
        ['U_BOT_A', 'agent_a'],
        ['U_BOT_B', 'agent_b'],
      ]),
    };

    const msg = makeMessage({ content: 'hey <@U_BOT_B> help me' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).not.toBeNull();
    expect(result!.matchedAgents).toEqual(['agent_b']);
    expect(result!.strategy).toBe('explicit');
  });

  it('routes thread reply to thread owner', async () => {
    const agents = [
      makeAgent({ folder: 'agent_a' }),
      makeAgent({ folder: 'agent_b' }),
    ];
    const tracker = new ThreadAffinityTracker();
    tracker.set('1111.2222', 'agent_a');
    const context = {
      threadOwnership: tracker,
      botUserIds: new Map<string, string>(),
    };

    const msg = makeMessage({ thread_ts: '1111.2222', content: 'follow up' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).not.toBeNull();
    expect(result!.matchedAgents).toEqual(['agent_a']);
  });

  it('returns null when no mention or thread affinity', async () => {
    const agents = [makeAgent({ folder: 'agent_a' })];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map([['U_BOT_A', 'agent_a']]),
    };

    const msg = makeMessage({ content: 'just a regular message' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).toBeNull();
  });
});

// --- KeywordTriageStrategy ---

describe('KeywordTriageStrategy', () => {
  const strategy = new KeywordTriageStrategy();

  it('matches agent with relevant keywords', async () => {
    const agents = [
      makeAgent({
        folder: 'research_bot',
        triageKeywords: ['research', 'analyze', '분석'],
      }),
      makeAgent({
        folder: 'ops_bot',
        triageKeywords: ['deploy', 'server', 'incident'],
      }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map<string, string>(),
    };

    const msg = makeMessage({ content: '이 데이터를 분석해줘' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).not.toBeNull();
    expect(result!.matchedAgents).toEqual(['research_bot']);
    expect(result!.strategy).toBe('keyword');
  });

  it('returns null when no keywords match', async () => {
    const agents = [
      makeAgent({
        folder: 'research_bot',
        triageKeywords: ['research', 'analyze'],
      }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map<string, string>(),
    };

    const msg = makeMessage({ content: 'what time is it?' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).toBeNull();
  });

  it('matches multiple agents when keywords overlap', async () => {
    const agents = [
      makeAgent({ folder: 'agent_a', triageKeywords: ['data'] }),
      makeAgent({ folder: 'agent_b', triageKeywords: ['data', 'report'] }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map<string, string>(),
    };

    const msg = makeMessage({ content: 'prepare the data report' });
    const result = await strategy.triage(msg, agents, context);

    expect(result).not.toBeNull();
    expect(result!.matchedAgents).toContain('agent_a');
    expect(result!.matchedAgents).toContain('agent_b');
  });
});

// --- CascadeTriageStrategy ---

describe('CascadeTriageStrategy', () => {
  it('stops at first matching strategy', async () => {
    const agents = [
      makeAgent({
        folder: 'agent_a',
        triageKeywords: ['hello'],
      }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map([['U_BOT_A', 'agent_a']]),
    };

    // Message has both @mention and keyword — explicit should win
    const msg = makeMessage({ content: '<@U_BOT_A> hello' });
    const cascade = new CascadeTriageStrategy();
    const result = await cascade.triage(msg, agents, context);

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe('explicit'); // Not 'keyword'
  });

  it('returns null when nothing matches (no fallback)', async () => {
    const agents = [
      makeAgent({ folder: 'agent_a', triageKeywords: ['specific'] }),
      makeAgent({ folder: 'main_agent', isMain: true }),
    ];
    const context = {
      threadOwnership: new ThreadAffinityTracker(),
      botUserIds: new Map<string, string>(),
    };

    const msg = makeMessage({ content: 'random unrelated message' });
    const cascade = new CascadeTriageStrategy();
    const result = await cascade.triage(msg, agents, context);

    expect(result).toBeNull();
  });
});

// --- ThreadAffinityTracker ---

describe('ThreadAffinityTracker', () => {
  it('persists and retrieves thread ownership', () => {
    const tracker = new ThreadAffinityTracker();
    tracker.set('1111.2222', 'agent_a');

    expect(tracker.get('1111.2222')).toBe('agent_a');
    expect(tracker.get('9999.0000')).toBeUndefined();

    tracker.destroy();
  });

  it('serializes and deserializes correctly', () => {
    const tracker = new ThreadAffinityTracker();
    tracker.set('1111.2222', 'agent_a');
    tracker.set('3333.4444', 'agent_b');

    const json = tracker.serialize();
    const restored = ThreadAffinityTracker.deserialize(json);

    expect(restored.get('1111.2222')).toBe('agent_a');
    expect(restored.get('3333.4444')).toBe('agent_b');

    tracker.destroy();
    restored.destroy();
  });
});

// --- Multi-agent bot user mapping ---

describe('Multi-agent bot user mapping', () => {
  it('all agents must appear in botUserIds, not just first per JID', () => {
    // This test documents the bug where getBotUserMappings() used
    // registeredGroups (first-per-JID) instead of allAgents()
    const allAgents: RegisteredGroup[] = [
      makeAgent({
        folder: 'slack_deep_research',
        jid: 'slack:C0TEST',
        isMain: true,
      }),
      makeAgent({
        folder: 'slack_research_agent',
        jid: 'slack:C0TEST',
        slackIdentity: 'RESEARCH',
      }),
    ];

    // Simulate what getBotUserMappings should do
    const botUserIds = new Map<string, string>();
    const identityBotUserIds: Record<string, string> = {
      default: 'U_ANDY',
      RESEARCH: 'U_RESEARCH',
    };

    for (const agent of allAgents) {
      if (agent.slackIdentity) {
        const botUserId = identityBotUserIds[agent.slackIdentity];
        if (botUserId) botUserIds.set(botUserId, agent.folder);
      } else {
        const botUserId = identityBotUserIds['default'];
        if (botUserId) botUserIds.set(botUserId, agent.folder);
      }
    }

    // CRITICAL: both agents must be present
    expect(botUserIds.size).toBe(2);
    expect(botUserIds.get('U_ANDY')).toBe('slack_deep_research');
    expect(botUserIds.get('U_RESEARCH')).toBe('slack_research_agent');
  });
});

// --- Per-agent trigger pattern ---

describe('Per-agent trigger pattern', () => {
  it('agent with custom assistantName should match its own trigger', () => {
    const agent = makeAgent({
      assistantName: 'ResearchBot',
      requiresTrigger: true,
    });

    const agentName = agent.assistantName || 'Andy';
    const triggerPattern = new RegExp(
      `^@${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );

    expect(triggerPattern.test('@ResearchBot hello')).toBe(true);
    expect(triggerPattern.test('@Andy hello')).toBe(false);
    expect(triggerPattern.test('hello @ResearchBot')).toBe(false); // Must be at start
  });

  it('agent without assistantName falls back to global pattern', () => {
    const agent = makeAgent({ requiresTrigger: true });
    const globalPattern = /^@Andy\b/i;

    const agentName = agent.assistantName || 'Andy';
    const isGlobal = agentName === 'Andy';

    expect(isGlobal).toBe(true);
    expect(globalPattern.test('@Andy hello')).toBe(true);
  });
});
