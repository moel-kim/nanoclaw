import crypto from 'crypto';
import { describe, it, expect } from 'vitest';

import { signRequest, verifyRequest, timingSafeEqual } from './proxy-auth.js';
import type { ProxyAuthConfig } from './proxy-types.js';

const TEST_SECRET = 'a'.repeat(64);
const TEST_CONFIG: ProxyAuthConfig = {
  keyId: 'openclaw-prod',
  sharedSecret: TEST_SECRET,
  maxSkewMs: 30_000,
};

describe('proxy-auth', () => {
  describe('signRequest', () => {
    it('returns hex-encoded HMAC-SHA256', () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ group: 'test', prompt: 'hello' });
      const sig = signRequest(ts, body, TEST_SECRET);

      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different signatures for different bodies', () => {
      const ts = '1711234567';
      const sig1 = signRequest(ts, '{"a":1}', TEST_SECRET);
      const sig2 = signRequest(ts, '{"a":2}', TEST_SECRET);

      expect(sig1).not.toBe(sig2);
    });

    it('produces different signatures for different timestamps', () => {
      const body = '{"group":"test"}';
      const sig1 = signRequest('1000', body, TEST_SECRET);
      const sig2 = signRequest('2000', body, TEST_SECRET);

      expect(sig1).not.toBe(sig2);
    });

    // signing string = `${timestamp}\n${body}` per contract
    it('uses timestamp + newline + body as signing string', () => {
      const ts = '1711234567';
      const body = '{"prompt":"hi"}';
      const sig = signRequest(ts, body, TEST_SECRET);

      const expected = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(`${ts}\n${body}`)
        .digest('hex');

      expect(sig).toBe(expected);
    });
  });

  describe('verifyRequest', () => {
    it('accepts valid signature within time window', () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const body = '{"group":"test"}';
      const sig = signRequest(ts, body, TEST_SECRET);

      const result = verifyRequest(ts, body, sig, TEST_CONFIG);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects expired timestamp beyond maxSkewMs', () => {
      const staleTs = String(Math.floor(Date.now() / 1000) - 60);
      const body = '{"group":"test"}';
      const sig = signRequest(staleTs, body, TEST_SECRET);

      const result = verifyRequest(staleTs, body, sig, TEST_CONFIG);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('skew');
    });

    it('rejects tampered body', () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const body = '{"group":"test"}';
      const sig = signRequest(ts, body, TEST_SECRET);

      const result = verifyRequest(ts, '{"group":"tampered"}', sig, TEST_CONFIG);
      expect(result.valid).toBe(false);
    });

    it('rejects wrong secret', () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const body = '{"group":"test"}';
      const sig = signRequest(ts, body, 'wrong-secret');

      const result = verifyRequest(ts, body, sig, TEST_CONFIG);
      expect(result.valid).toBe(false);
    });
  });

  describe('timingSafeEqual', () => {
    it('returns true for identical strings', () => {
      expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    });

    it('returns false for different-length strings', () => {
      expect(timingSafeEqual('short', 'longer-string')).toBe(false);
    });
  });
});
