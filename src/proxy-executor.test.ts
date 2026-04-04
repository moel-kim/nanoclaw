import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { executeSpecialist, ExecutorDeps } from './proxy-executor.js';
import type { ProxyExecuteRequest } from './proxy-types.js';
import type { RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-runner.js';

const fakeGroup: RegisteredGroup = {
  name: 'Deep Research',
  folder: 'slack_deep_research',
  trigger: '@deep-research',
  added_at: new Date().toISOString(),
};

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    findGroup: vi.fn((folder: string) =>
      folder === 'slack_deep_research' ? fakeGroup : undefined,
    ),
    runContainer: vi.fn(async () => ({
      status: 'success' as const,
      result: 'Edge computing processes data closer to the source.',
      newSessionId: 'ses_abc123',
    })),
    ...overrides,
  };
}

describe('proxy-executor', () => {
  const baseRequest: ProxyExecuteRequest = {
    group: 'slack_deep_research',
    prompt: 'What is edge computing?',
    correlationId: 'corr_exec_001',
    context: {
      threadTs: '1711234567.000100',
      channelId: 'C0123ABCDEF',
      userId: 'U0123ABCDEF',
      userName: 'moel',
    },
  };

  describe('executeSpecialist', () => {
    it('returns success with result from container', async () => {
      const deps = makeDeps();
      const response = await executeSpecialist(baseRequest, 90_000, deps);

      expect(response.status).toBe('success');
      expect(typeof response.result).toBe('string');
      expect(response.result!.length).toBeGreaterThan(0);
      expect(response.group).toBe('slack_deep_research');
      expect(response.correlationId).toBe('corr_exec_001');
      expect(response.executionMs).toBeGreaterThanOrEqual(0);
    });

    it('returns timeout when container exceeds budget', async () => {
      const deps = makeDeps({
        runContainer: vi.fn(
          (): Promise<ContainerOutput> =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    status: 'success',
                    result: 'late',
                    newSessionId: undefined,
                  }),
                500,
              ),
            ),
        ),
      });
      const response = await executeSpecialist(baseRequest, 1, deps);

      expect(response.status).toBe('timeout');
      expect(response.result).toBeNull();
      expect(response.fallbackText).toBeDefined();
    });

    it('returns error when group does not exist', async () => {
      const badRequest: ProxyExecuteRequest = {
        ...baseRequest,
        group: 'nonexistent_group',
        correlationId: 'corr_exec_bad',
      };
      const deps = makeDeps();
      const response = await executeSpecialist(badRequest, 90_000, deps);

      expect(response.status).toBe('error');
      expect(response.error).toBeDefined();
    });

    it('includes correlationId in all response types', async () => {
      const deps = makeDeps();
      const response = await executeSpecialist(baseRequest, 90_000, deps);
      expect(response.correlationId).toBe('corr_exec_001');
    });

    it('returns executionMs as non-negative number', async () => {
      const deps = makeDeps();
      const response = await executeSpecialist(baseRequest, 90_000, deps);
      expect(response.executionMs).toBeGreaterThanOrEqual(0);
      expect(typeof response.executionMs).toBe('number');
    });

    it('maps container sessionId to response', async () => {
      const deps = makeDeps();
      const response = await executeSpecialist(baseRequest, 90_000, deps);

      if (response.status === 'success') {
        expect(typeof response.sessionId).toBe('string');
      }
    });
  });
});
