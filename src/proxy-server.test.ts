import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startProxyServer, type ServerDeps } from './proxy-server.js';
import type { ProxyExecuteResponse } from './proxy-types.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function authHeaders(): Record<string, string> {
  return {
    'x-nanoclaw-key-id': 'openclaw-prod',
    'x-nanoclaw-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-nanoclaw-signature': 'valid-sig',
    'x-nanoclaw-contract-version': 'v1',
  };
}

function makeDeps(overrides?: Partial<ServerDeps>): ServerDeps {
  return {
    verifyAuth: () => ({ valid: true }),
    listGroups: () => [
      {
        name: 'Deep Research',
        folder: 'slack_deep_research',
        trigger: '@deep-research',
        added_at: '2024-01-01',
        jid: 'test-jid',
        triageKeywords: ['research'],
        triageDescription: 'Deep research agent',
      },
    ],
    execute: async (request) =>
      ({
        status: 'success',
        result: 'test output',
        group: request.group,
        correlationId: request.correlationId,
        executionMs: 42,
      }) satisfies ProxyExecuteResponse,
    ...overrides,
  };
}

describe('proxy-server', () => {
  let server: http.Server;
  let port: number;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  describe('GET /api/groups', () => {
    it('returns 200 with groups array', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/groups',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('groups');
      expect(Array.isArray(body.groups)).toBe(true);
      expect(body).toHaveProperty('timestamp');
    });

    it('returns 401 when auth headers are missing', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/groups',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/execute', () => {
    it('returns 200 with execution result', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const body = JSON.stringify({
        group: 'slack_deep_research',
        prompt: 'What is edge computing?',
        correlationId: 'corr_test_123',
      });

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/execute',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(),
            'x-correlation-id': 'corr_test_123',
          },
        },
        body,
      );

      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('correlationId', 'corr_test_123');
      expect(parsed).toHaveProperty('group', 'slack_deep_research');
      expect(parsed).toHaveProperty('executionMs');
    });

    it('returns 400 when prompt is missing', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const body = JSON.stringify({
        group: 'slack_deep_research',
        correlationId: 'corr_test_456',
      });

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/execute',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(),
          },
        },
        body,
      );

      expect(res.statusCode).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toBe('validation_error');
    });

    it('returns 404 when group does not exist', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const body = JSON.stringify({
        group: 'nonexistent_group',
        prompt: 'test',
        correlationId: 'corr_test_789',
      });

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/execute',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(),
          },
        },
        body,
      );

      expect(res.statusCode).toBe(404);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toBe('group_not_found');
    });

    it('returns 401 with invalid signature', async () => {
      const deps = makeDeps({
        verifyAuth: () => ({
          valid: false,
          reason: 'signature mismatch',
        }),
      });
      server = await startProxyServer(0, '127.0.0.1', deps);
      port = (server.address() as AddressInfo).port;

      const body = JSON.stringify({
        group: 'slack_deep_research',
        prompt: 'test',
        correlationId: 'corr_test_bad',
      });

      const res = await makeRequest(
        port,
        {
          method: 'POST',
          path: '/api/execute',
          headers: {
            'content-type': 'application/json',
            'x-nanoclaw-key-id': 'openclaw-prod',
            'x-nanoclaw-timestamp': '0',
            'x-nanoclaw-signature': 'invalid-signature',
            'x-nanoclaw-contract-version': 'v1',
          },
        },
        body,
      );

      expect(res.statusCode).toBe(401);
    });
  });

  describe('contract version', () => {
    it('returns X-NanoClaw-Contract-Version header in response', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/groups',
        headers: authHeaders(),
      });

      expect(res.headers['x-nanoclaw-contract-version']).toBe('v1');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      server = await startProxyServer(0, '127.0.0.1', makeDeps());
      port = (server.address() as AddressInfo).port;

      const res = await makeRequest(port, {
        method: 'GET',
        path: '/api/unknown',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
