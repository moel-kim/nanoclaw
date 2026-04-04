import http from 'http';

import { getAllAgents } from './db.js';
import { logger } from './logger.js';
import { verifyRequest } from './proxy-auth.js';
import { executeSpecialist } from './proxy-executor.js';
import type {
  ProxyAuthConfig,
  ProxyErrorResponse,
  ProxyExecuteRequest,
  ProxyGroupSummary,
  ProxyGroupsResponse,
} from './proxy-types.js';
import { CONTRACT_VERSION } from './proxy-types.js';
import type { RegisteredGroup } from './types.js';

export interface ServerDeps {
  verifyAuth: (
    timestamp: string,
    body: string,
    signature: string,
  ) => { valid: boolean; reason?: string };
  listGroups: () => RegisteredGroup[];
  execute: (
    request: ProxyExecuteRequest,
    timeoutMs: number,
  ) => Promise<import('./proxy-types.js').ProxyExecuteResponse>;
}

function defaultDeps(): ServerDeps {
  const authConfig: ProxyAuthConfig = {
    keyId: process.env['NANOCLAW_PROXY_KEY_ID'] ?? 'openclaw-prod',
    sharedSecret: process.env['NANOCLAW_PROXY_SECRET'] ?? '',
    maxSkewMs: 300_000,
  };

  return {
    verifyAuth(timestamp, body, signature) {
      return verifyRequest(timestamp, body, signature, authConfig);
    },
    listGroups() {
      return getAllAgents();
    },
    execute(request, timeoutMs) {
      return executeSpecialist(request, timeoutMs);
    },
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-NanoClaw-Contract-Version': CONTRACT_VERSION,
  });
  res.end(payload);
}

function sendError(
  res: http.ServerResponse,
  statusCode: number,
  error: string,
  message: string,
): void {
  const body: ProxyErrorResponse = { error, message };
  sendJson(res, statusCode, body);
}

function authenticateRequest(
  req: http.IncomingMessage,
  body: string,
  deps: ServerDeps,
): { ok: true } | { ok: false; status: number; error: string; message: string } {
  const keyId = req.headers['x-nanoclaw-key-id'] as string | undefined;
  const timestamp = req.headers['x-nanoclaw-timestamp'] as string | undefined;
  const signature = req.headers['x-nanoclaw-signature'] as string | undefined;

  if (!keyId || !timestamp || !signature) {
    return {
      ok: false,
      status: 401,
      error: 'auth_missing',
      message: 'Missing required auth headers',
    };
  }

  const result = deps.verifyAuth(timestamp, body, signature);
  if (!result.valid) {
    return {
      ok: false,
      status: 401,
      error: 'auth_failed',
      message: result.reason ?? 'Authentication failed',
    };
  }

  return { ok: true };
}

async function handleGetGroups(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const agents = deps.listGroups();

  const groups: ProxyGroupSummary[] = agents.map((g) => ({
    name: g.name,
    folder: g.folder,
    jid: g.jid,
    triageKeywords: g.triageKeywords,
    triageDescription: g.triageDescription,
  }));

  const response: ProxyGroupsResponse = {
    groups,
    timestamp: new Date().toISOString(),
  };

  sendJson(res, 200, response);
}

const DEFAULT_EXEC_TIMEOUT_MS = 90_000;

async function handlePostExecute(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  deps: ServerDeps,
): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'parse_error', 'Invalid JSON body');
    return;
  }

  const { group, prompt, correlationId } = parsed as {
    group?: string;
    prompt?: string;
    correlationId?: string;
  };

  if (!group || !prompt) {
    sendError(
      res,
      400,
      'validation_error',
      'Missing required fields: group, prompt',
    );
    return;
  }

  const agents = deps.listGroups();
  const found = agents.find((g) => g.folder === group);
  if (!found) {
    sendError(res, 404, 'group_not_found', `Group "${group}" not found`);
    return;
  }

  const request: ProxyExecuteRequest = {
    group,
    prompt,
    correlationId: correlationId ?? `auto_${Date.now()}`,
    context: parsed.context as ProxyExecuteRequest['context'],
    constraints: parsed.constraints as ProxyExecuteRequest['constraints'],
  };

  logger.info(
    { correlationId: request.correlationId, group },
    'Proxy execute request',
  );

  const result = await deps.execute(request, DEFAULT_EXEC_TIMEOUT_MS);
  sendJson(res, 200, result);
}

export async function startProxyServer(
  port: number,
  host: string,
  deps: ServerDeps = defaultDeps(),
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    const body = await readBody(req);

    if (url !== '/api/groups' && url !== '/api/execute') {
      sendError(res, 404, 'not_found', `Unknown route: ${method} ${url}`);
      return;
    }

    const auth = authenticateRequest(req, body, deps);
    if (!auth.ok) {
      sendError(res, auth.status, auth.error, auth.message);
      return;
    }

    try {
      if (method === 'GET' && url === '/api/groups') {
        await handleGetGroups(req, res, deps);
      } else if (method === 'POST' && url === '/api/execute') {
        await handlePostExecute(req, res, body, deps);
      } else {
        sendError(res, 405, 'method_not_allowed', `${method} ${url}`);
      }
    } catch (err) {
      logger.error({ err, url, method }, 'Proxy server error');
      sendError(res, 500, 'internal_error', 'Internal server error');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      logger.info({ addr }, 'Proxy server listening');
      resolve(server);
    });
  });
}
