import crypto from 'crypto';

import type { ProxyAuthConfig } from './proxy-types.js';

/**
 * Build the HMAC-SHA256 signing string per proxy contract:
 *   signing_string = `${timestamp}\n${body}`
 *
 * Returns lowercase hex-encoded digest.
 */
export function signRequest(
  timestamp: string,
  body: string,
  secret: string,
): string {
  const signingString = `${timestamp}\n${body}`;
  return crypto.createHmac('sha256', secret).update(signingString).digest('hex');
}

/**
 * Verify an incoming request's HMAC signature and timestamp freshness.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, reason }` on
 * any verification failure. Uses timing-safe comparison to prevent timing
 * side-channels.
 */
export function verifyRequest(
  timestamp: string,
  body: string,
  signature: string,
  config: ProxyAuthConfig,
): { valid: boolean; reason?: string } {
  // 1. Check timestamp skew
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec = parseInt(timestamp, 10);

  if (Number.isNaN(tsSec)) {
    return { valid: false, reason: 'invalid timestamp' };
  }

  const skewMs = Math.abs(nowSec - tsSec) * 1000;
  if (skewMs > config.maxSkewMs) {
    return {
      valid: false,
      reason: `timestamp skew ${skewMs}ms exceeds max ${config.maxSkewMs}ms`,
    };
  }

  // 2. Recompute expected signature and compare timing-safely
  const expected = signRequest(timestamp, body, config.sharedSecret);
  if (!timingSafeEqual(expected, signature)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}

/**
 * Constant-time string equality check. Wraps Node's `crypto.timingSafeEqual`
 * with Buffer conversion and length pre-check.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}
