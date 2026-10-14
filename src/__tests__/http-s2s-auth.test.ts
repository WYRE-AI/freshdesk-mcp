/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholder secrets are rejected even with that flag. The flag binds
 * 127.0.0.1 only. /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit x-freshdesk-domain or
 * x-freshdesk-api-key and must not fall back to FRESHDESK_* in process.env.
 */

import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { FreshdeskClientMock } = vi.hoisted(() => ({
  FreshdeskClientMock: vi.fn(),
}));

vi.mock('@wyre-technology/node-freshdesk', () => ({
  FreshdeskClient: FreshdeskClientMock,
}));

import { startHttpTransport } from '../http.js';

const S2S_SECRET = 'test-s2s-secret-do-not-log';
const ENV_DOMAIN = 'env-domain-must-not-be-used';
const ENV_API_KEY = 'env-api-key-must-not-be-used';
const HEADER_DOMAIN = 'header-domain';
const HEADER_API_KEY = 'header-api-key-from-gateway';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'FRESHDESK_DOMAIN',
  'FRESHDESK_API_KEY',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function silenceLogs(): { errors: string[] } {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return { errors };
}

function assertNoSecrets(logged: string, extra: string[] = []): void {
  expect(logged).not.toContain(S2S_SECRET);
  expect(logged).not.toContain(ENV_API_KEY);
  expect(logged).not.toContain(HEADER_API_KEY);
  expect(logged).not.toContain(ENV_DOMAIN);
  for (const value of extra) {
    expect(logged).not.toContain(value);
  }
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'freshdesk_status', arguments: {} },
});

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function exitSpy(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.FRESHDESK_DOMAIN;
  delete process.env.FRESHDESK_API_KEY;
  delete process.env.MCP_TRANSPORT;

  FreshdeskClientMock.mockReset();
  FreshdeskClientMock.mockImplementation(function (opts: { domain: string; apiKey: string }) {
    return {
      _opts: opts,
      agents: {
        me: vi.fn().mockResolvedValue({
          id: 7,
          contact: { name: 'Header Agent', email: 'header@example.com' },
        }),
      },
    };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it.each([undefined, '', '   '])(
    'refuses to start when CONDUIT_S2S_SECRET is empty (%j)',
    async (value) => {
      if (value === undefined) delete process.env.CONDUIT_S2S_SECRET;
      else process.env.CONDUIT_S2S_SECRET = value;
      const { errors } = silenceLogs();
      exitSpy();

      await expect(startHttpTransport()).rejects.toThrow('process.exit:1');
      const logged = errors.join('\n');
      expect(logged).toContain('Refusing to start HTTP transport');
      expect(logged).toContain('CONDUIT_S2S_SECRET is empty');
      assertNoSecrets(logged);
    },
  );

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    const { errors } = silenceLogs();
    exitSpy();

    await expect(startHttpTransport()).rejects.toThrow('process.exit:1');
    expect(errors.join('\n')).toContain('Refusing to start HTTP transport');
  });

  it.each(['changeme', 'ChangeMe', 'your-s2s-secret', 'placeholder', '  secret  '])(
    'refuses known placeholder secret %j and does not log it',
    async (value) => {
      process.env.CONDUIT_S2S_SECRET = value;
      const { errors } = silenceLogs();
      exitSpy();

      await expect(startHttpTransport()).rejects.toThrow('process.exit:1');
      const logged = errors.join('\n');
      expect(logged).toContain('known placeholder');
      expect(logged).not.toContain('SECURITY WARNING');
      const distinctive = value.trim().toLowerCase();
      // The static error text contains the words "placeholder" and "SECRET".
      if (distinctive !== 'secret' && distinctive !== 'placeholder') {
        expect(logged.toLowerCase()).not.toContain(distinctive);
      }
    },
  );

  it('refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1', async () => {
    process.env.CONDUIT_S2S_SECRET = 'changeme';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const { errors } = silenceLogs();
    exitSpy();

    await expect(startHttpTransport()).rejects.toThrow('process.exit:1');
    const logged = errors.join('\n');
    expect(logged).toContain('known placeholder');
    expect(logged).not.toContain('changeme');
    expect(logged).not.toContain('SECURITY WARNING');
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const { errors } = silenceLogs();

    const server = await listen();
    const logged = errors.join('\n');
    expect(server.address).toBe('127.0.0.1');
    expect(logged).toContain('SECURITY WARNING');
    expect(logged).toContain('CONDUIT_S2S_SECRET');
    expect(logged).toContain('MCP_ALLOW_INSECURE_DEV=1');
    expect(logged).toContain('127.0.0.1');
    expect(logged).not.toContain('is not 127.0.0.1');
    assertNoSecrets(logged);
  });

  it.each(['0.0.0.0', '10.1.2.3', 'localhost', '::1'])(
    'forces 127.0.0.1 when insecure dev is set and MCP_HTTP_HOST is %s',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const { errors } = silenceLogs();

      const server = await listen();
      const logged = errors.join('\n');
      expect(server.address).toBe('127.0.0.1');
      expect(logged).toContain(`MCP_HTTP_HOST=${host} is not 127.0.0.1`);
      expect(logged).toContain('Binding 127.0.0.1 only');
      assertNoSecrets(logged);
    },
  );

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const { errors } = silenceLogs();

    const server = await listen();
    expect(server.address).toBe('0.0.0.0');
    expect(errors.join('\n')).not.toContain('is not 127.0.0.1');
    assertNoSecrets(errors.join('\n'));
  });

  it('binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is configured', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const { errors } = silenceLogs();

    const server = await listen();
    expect(server.address).toBe('127.0.0.1');
    assertNoSecrets(errors.join('\n'));
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.FRESHDESK_DOMAIN = ENV_DOMAIN;
    process.env.FRESHDESK_API_KEY = ENV_API_KEY;
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const { errors } = silenceLogs();
    const server = await listen();

    const missing = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-freshdesk-domain': HEADER_DOMAIN,
        'x-freshdesk-api-key': HEADER_API_KEY,
      }),
      body: statusCall,
    });
    const invalid = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader('wrong-secret'),
        'x-freshdesk-domain': HEADER_DOMAIN,
        'x-freshdesk-api-key': HEADER_API_KEY,
      }),
      body: statusCall,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    const missingBody = await missing.text();
    const invalidBody = await invalid.text();
    expect(missingBody).toContain('X-Gateway-S2S');
    expect(invalidBody).toContain('X-Gateway-S2S');
    expect(missingBody).not.toContain(S2S_SECRET);
    expect(invalidBody).not.toContain(S2S_SECRET);
    expect(missingBody).not.toContain(ENV_DOMAIN);
    expect(missingBody).not.toContain(ENV_API_KEY);
    expect(missingBody).not.toContain(HEADER_API_KEY);
    assertNoSecrets(errors.join('\n'));
    expect(FreshdeskClientMock).not.toHaveBeenCalled();
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    silenceLogs();
    const server = await listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toContain('x-freshdesk-domain');
    expect(body).toContain('x-freshdesk-api-key');
    expect(body).not.toContain(ENV_DOMAIN);
    expect(body).not.toContain(ENV_API_KEY);
    expect(body).not.toContain(S2S_SECRET);
    expect(FreshdeskClientMock).not.toHaveBeenCalled();

    const partial = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-freshdesk-domain': HEADER_DOMAIN,
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(FreshdeskClientMock).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const { errors } = silenceLogs();
    const server = await listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-freshdesk-domain': HEADER_DOMAIN,
        'x-freshdesk-api-key': HEADER_API_KEY,
      }),
      body: statusCall,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(S2S_SECRET);
    expect(body).not.toContain(ENV_DOMAIN);
    expect(body).not.toContain(ENV_API_KEY);
    const payload = JSON.parse(body) as { result?: { content?: Array<{ text?: string }> } };
    const text = payload.result?.content?.[0]?.text ?? '';
    const status = JSON.parse(text) as { connected?: boolean; domain?: string };
    expect(status.connected).toBe(true);
    expect(status.domain).toBe(HEADER_DOMAIN);
    expect(FreshdeskClientMock).toHaveBeenCalledWith({ domain: HEADER_DOMAIN, apiKey: HEADER_API_KEY });
    assertNoSecrets(errors.join('\n'));
  });

  it('serves /health without authentication and without reading credentials', async () => {
    silenceLogs();
    const server = await listen();

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = (await response.json()) as { status?: string; mode?: string; credentials?: unknown };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(body).not.toHaveProperty('credentials');
    expect(JSON.stringify(body)).not.toContain(ENV_DOMAIN);
    expect(JSON.stringify(body)).not.toContain(ENV_API_KEY);
    expect(JSON.stringify(body)).not.toContain(S2S_SECRET);
    expect(FreshdeskClientMock).not.toHaveBeenCalled();
  });

  it('skips S2S in the insecure-dev bypass and still requires gateway credential headers', async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    silenceLogs();
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');

    const missingCreds = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: statusCall,
    });
    expect(missingCreds.status).toBe(401);
    expect(await missingCreds.text()).toContain('x-freshdesk-domain');
    expect(FreshdeskClientMock).not.toHaveBeenCalled();

    const accepted = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({
        'x-freshdesk-domain': HEADER_DOMAIN,
        'x-freshdesk-api-key': HEADER_API_KEY,
      }),
      body: statusCall,
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.text();
    const payload = JSON.parse(acceptedBody) as { result?: { content?: Array<{ text?: string }> } };
    const status = JSON.parse(payload.result?.content?.[0]?.text ?? '') as { domain?: string };
    expect(status.domain).toBe(HEADER_DOMAIN);
    expect(acceptedBody).not.toContain(ENV_DOMAIN);
    expect(acceptedBody).not.toContain(ENV_API_KEY);
    expect(FreshdeskClientMock).toHaveBeenCalledWith({ domain: HEADER_DOMAIN, apiKey: HEADER_API_KEY });
  });

  it('uses environment credentials in AUTH_MODE=env only after a valid S2S header', async () => {
    process.env.AUTH_MODE = 'env';
    silenceLogs();
    const server = await listen();

    const missingS2s = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: statusCall,
    });
    expect(missingS2s.status).toBe(401);
    expect(FreshdeskClientMock).not.toHaveBeenCalled();

    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    const payload = JSON.parse(body) as { result?: { content?: Array<{ text?: string }> } };
    const status = JSON.parse(payload.result?.content?.[0]?.text ?? '') as { domain?: string; connected?: boolean };
    expect(status.connected).toBe(true);
    expect(status.domain).toBe(ENV_DOMAIN);
    expect(body).not.toContain(ENV_API_KEY);
    expect(body).not.toContain(S2S_SECRET);
    expect(FreshdeskClientMock).toHaveBeenCalledWith({ domain: ENV_DOMAIN, apiKey: ENV_API_KEY });
  });
});
