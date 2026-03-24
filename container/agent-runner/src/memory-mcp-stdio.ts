/**
 * Memory MCP Server for NanoClaw
 * Provides long-term memory tools that proxy to an external memory service
 * (mem0.ai or custom second-brain SaaS).
 *
 * Reads config from environment variables set by the agent runner:
 *   NANOCLAW_MEMORY_TYPE     - 'mem0' | 'custom'
 *   NANOCLAW_MEMORY_API_URL  - API endpoint
 *   NANOCLAW_MEMORY_API_KEY  - API key
 *   NANOCLAW_MEMORY_AGENT_ID - Agent namespace in the memory service
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const memoryType = process.env.NANOCLAW_MEMORY_TYPE || 'custom';
const apiUrl = process.env.NANOCLAW_MEMORY_API_URL || '';
const apiKey = process.env.NANOCLAW_MEMORY_API_KEY || '';
const agentId = process.env.NANOCLAW_MEMORY_AGENT_ID || 'default';

function log(msg: string, data?: object): void {
  const entry = { ts: new Date().toISOString(), msg, ...data };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

async function memoryFetch(
  path: string,
  method: string,
  body?: object,
): Promise<any> {
  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (memoryType === 'mem0') {
    headers['Authorization'] = `Token ${apiKey}`;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Memory API ${method} ${path}: ${res.status} ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

const server = new McpServer({
  name: 'nanoclaw-memory',
  version: '1.0.0',
});

// --- Tools ---

server.tool(
  'memory_store',
  'Store a piece of information in long-term memory. Use this to save important facts, user preferences, decisions, or anything worth remembering across conversations.',
  {
    content: z.string().describe('The content to remember'),
    metadata: z
      .record(z.string())
      .optional()
      .describe('Optional key-value metadata tags'),
  },
  async ({ content, metadata }) => {
    try {
      let result: any;
      if (memoryType === 'mem0') {
        // mem0.ai API: POST /v1/memories/
        result = await memoryFetch('/memories/', 'POST', {
          messages: [{ role: 'user', content }],
          agent_id: agentId,
          metadata,
        });
      } else {
        // Custom API: POST /memories
        result = await memoryFetch('/memories', 'POST', {
          content,
          agent_id: agentId,
          metadata,
        });
      }

      log('memory_store', { agentId, contentLength: content.length });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory stored: ${JSON.stringify(result)}`,
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: `Error storing memory: ${err.message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_recall',
  'Recall relevant memories based on a query. Use this before responding to check for relevant context from previous conversations.',
  {
    query: z.string().describe('What to search for in memory'),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe('Maximum number of memories to return'),
  },
  async ({ query, limit }) => {
    try {
      let result: any;
      if (memoryType === 'mem0') {
        // mem0.ai API: POST /v1/memories/search/
        result = await memoryFetch('/memories/search/', 'POST', {
          query,
          agent_id: agentId,
          limit,
        });
      } else {
        // Custom API: POST /memories/search
        result = await memoryFetch('/memories/search', 'POST', {
          query,
          agent_id: agentId,
          limit,
        });
      }

      log('memory_recall', { agentId, query, resultCount: Array.isArray(result) ? result.length : 1 });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: `Error recalling memory: ${err.message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_forget',
  'Delete a specific memory by its ID.',
  {
    memory_id: z.string().describe('The ID of the memory to delete'),
  },
  async ({ memory_id }) => {
    try {
      if (memoryType === 'mem0') {
        await memoryFetch(`/memories/${memory_id}/`, 'DELETE');
      } else {
        await memoryFetch(`/memories/${memory_id}`, 'DELETE');
      }

      log('memory_forget', { agentId, memory_id });
      return {
        content: [
          { type: 'text' as const, text: `Memory ${memory_id} deleted` },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          { type: 'text' as const, text: `Error deleting memory: ${err.message}` },
        ],
        isError: true,
      };
    }
  },
);

// --- Start ---

async function main() {
  if (!apiUrl) {
    log('Memory MCP server: no NANOCLAW_MEMORY_API_URL configured, exiting');
    process.exit(1);
  }

  log('Memory MCP server starting', { memoryType, apiUrl, agentId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  log('Memory MCP server fatal error', { error: String(err) });
  process.exit(1);
});
