import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the Freshdesk SDK and logger so tests never make network calls.
// vitest 5's mock-as-constructor path calls the implementation with `new`,
// which arrow functions can never support — use a regular function so the
// mock still works when invoked as `new FreshdeskClient(...)`.
vi.mock('@wyre-technology/node-freshdesk', () => ({
  FreshdeskClient: vi.fn().mockImplementation(function (opts: { domain: string; apiKey: string }) {
    return { _opts: opts };
  }),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getCredentials, getClient, runWithCredentials } from '../utils/client.js';

describe('getCredentials', () => {
  beforeEach(() => {
    delete process.env.FRESHDESK_DOMAIN;
    delete process.env.FRESHDESK_API_KEY;
  });

  it('returns null when both env vars are absent', () => {
    expect(getCredentials()).toBeNull();
  });

  it('returns null when only domain is set (partial credentials)', () => {
    process.env.FRESHDESK_DOMAIN = 'acme';
    expect(getCredentials()).toBeNull();
  });

  it('returns null when only apiKey is set (partial credentials)', () => {
    process.env.FRESHDESK_API_KEY = 'key';
    expect(getCredentials()).toBeNull();
  });

  it('reads both fields from process.env when no ALS context is active', () => {
    process.env.FRESHDESK_DOMAIN = 'acme';
    process.env.FRESHDESK_API_KEY = 'key123';
    expect(getCredentials()).toEqual({ domain: 'acme', apiKey: 'key123' });
  });

  it('ALS context takes precedence over process.env', () => {
    process.env.FRESHDESK_DOMAIN = 'env-domain';
    process.env.FRESHDESK_API_KEY = 'env-key';
    let seen: ReturnType<typeof getCredentials> = null;
    runWithCredentials({ domain: 'als-domain', apiKey: 'als-key' }, () => {
      seen = getCredentials();
    });
    expect(seen).toEqual({ domain: 'als-domain', apiKey: 'als-key' });
    // After the ALS scope ends, env credentials are visible again.
    expect(getCredentials()).toEqual({ domain: 'env-domain', apiKey: 'env-key' });
  });
});

describe('getClient', () => {
  beforeEach(() => {
    delete process.env.FRESHDESK_DOMAIN;
    delete process.env.FRESHDESK_API_KEY;
  });

  it('throws when no credentials are available', () => {
    expect(() => getClient()).toThrow(/FRESHDESK_DOMAIN and FRESHDESK_API_KEY/);
  });

  it('builds a client with env credentials', () => {
    process.env.FRESHDESK_DOMAIN = 'acme';
    process.env.FRESHDESK_API_KEY = 'key';
    const client = getClient() as any;
    expect(client._opts).toEqual({ domain: 'acme', apiKey: 'key' });
  });

  it('builds a fresh client per call (stateless — no singleton)', () => {
    process.env.FRESHDESK_DOMAIN = 'acme';
    process.env.FRESHDESK_API_KEY = 'key';
    const a = getClient();
    const b = getClient();
    expect(a).not.toBe(b);
  });

  it('ALS credentials flow through to the built client', () => {
    let client: any;
    runWithCredentials({ domain: 'als-domain', apiKey: 'als-key' }, () => {
      client = getClient();
    });
    expect(client._opts).toEqual({ domain: 'als-domain', apiKey: 'als-key' });
  });
});

describe('runWithCredentials — concurrent no-contamination', () => {
  it('two concurrent ALS scopes do not bleed into each other', async () => {
    const results: { domain: string; apiKey: string }[] = [];

    // Simulate two overlapping async scopes by staggering them with a tick delay.
    await Promise.all([
      new Promise<void>(resolve =>
        runWithCredentials({ domain: 'tenant-A', apiKey: 'key-A' }, async () => {
          await Promise.resolve(); // yield to the event loop
          const creds = getCredentials();
          results.push(creds!);
          resolve();
        })
      ),
      new Promise<void>(resolve =>
        runWithCredentials({ domain: 'tenant-B', apiKey: 'key-B' }, async () => {
          const creds = getCredentials();
          results.push(creds!);
          resolve();
        })
      ),
    ]);

    // Each scope must have seen only its own credentials.
    const domains = results.map(r => r.domain);
    expect(domains).toContain('tenant-A');
    expect(domains).toContain('tenant-B');
    expect(results.find(r => r.domain === 'tenant-A')?.apiKey).toBe('key-A');
    expect(results.find(r => r.domain === 'tenant-B')?.apiKey).toBe('key-B');
  });
});
