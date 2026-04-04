/**
 * Proxy API types for OpenClaw → NanoClaw specialist execution.
 * Contract: docs/proxy-contract.md v1
 */

// --- Request types (inbound from OpenClaw) ---

export interface ProxyExecuteRequest {
  /** Target group folder name (must match a registered group) */
  group: string;
  /** The specialist question / task */
  prompt: string;
  /** Slack thread context for traceability */
  context?: ProxyRequestContext;
  /** Unique ID for request tracing and loop prevention */
  correlationId: string;
  /** Execution constraints */
  constraints?: ProxyConstraints;
}

export interface ProxyRequestContext {
  threadTs?: string;
  channelId?: string;
  userId?: string;
  userName?: string;
}

export interface ProxyConstraints {
  maxTokens?: number;
}

// --- Response types (outbound to OpenClaw) ---

export type ProxyExecuteStatus = 'success' | 'timeout' | 'error';

export interface ProxyExecuteResponse {
  status: ProxyExecuteStatus;
  result: string | null;
  group: string;
  correlationId: string;
  executionMs: number;
  sessionId?: string;
  fallbackText?: string;
  error?: string;
}

// --- Group discovery ---

export interface ProxyGroupSummary {
  name: string;
  folder: string;
  jid?: string;
  triageKeywords?: string[];
  triageDescription?: string;
}

export interface ProxyGroupsResponse {
  groups: ProxyGroupSummary[];
  timestamp: string;
}

// --- Auth ---

export interface ProxyAuthHeaders {
  'x-nanoclaw-key-id': string;
  'x-nanoclaw-timestamp': string;
  'x-nanoclaw-signature': string;
  'x-correlation-id'?: string;
  'x-nanoclaw-contract-version'?: string;
}

export interface ProxyAuthConfig {
  keyId: string;
  sharedSecret: string;
  maxSkewMs: number;
}

// --- Error responses ---

export interface ProxyErrorResponse {
  error: string;
  message: string;
}

// --- Config ---

export interface ProxyServerConfig {
  host: string;
  port: number;
  auth: ProxyAuthConfig;
  execTimeoutMs: number;
}

export const CONTRACT_VERSION = 'v1';
