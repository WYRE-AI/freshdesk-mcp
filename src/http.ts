import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials } from './utils/client.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

// Public example values. A copied placeholder must not verify as a real secret
// and must not boot the HTTP listener, even with MCP_ALLOW_INSECURE_DEV=1.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. ' +
  'MCP_ALLOW_INSECURE_DEV=1 does not accept a placeholder.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. ' +
  'Local development only; do not expose this port.';

const LOOPBACK_HOST = '127.0.0.1';

const S2S_UNAUTHORIZED = {
  error:
    'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error:
    'Unauthorized: missing required gateway credential headers x-freshdesk-domain and x-freshdesk-api-key',
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed: the process exits unless MCP_ALLOW_INSECURE_DEV=1,
 * which forces the listener onto 127.0.0.1. A known placeholder is never a
 * secret and never enables that bypass. The secret value is never logged.
 */
function resolveS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return { secret: '', insecureDev: true };
  }
  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (insecure-dev bypass only): always 127.0.0.1, ignoring a wider
 * MCP_HTTP_HOST. A configured secret honors MCP_HTTP_HOST. An unset host
 * defaults to 127.0.0.1.
 */
function resolveBindHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (!insecureDev) {
    return configured === '' ? LOOPBACK_HOST : configured;
  }
  if (configured !== '' && configured !== LOOPBACK_HOST) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not 127.0.0.1. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

export async function startHttpTransport(): Promise<Server> {
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveBindHost(insecureDev);
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // /health is container liveness, not credential readiness. In gateway
    // mode, credentials arrive per request on x-freshdesk-* headers, not at
    // startup. This route stays unauthenticated and must not read credentials
    // (doing so logs a missing-credential warning on every probe and would
    // report process-environment state on an open endpoint).
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          mode: isGatewayMode ? 'gateway' : 'standalone',
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise. A configured secret is always enforced, before any
    // credential header is read.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    const handle = async () => {
      const server = createServer();
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true). Per-request
      // tenant credentials are carried in an AsyncLocalStorage context opened by
      // runWithCredentials() below. A stateless request->single-response flow
      // keeps the tool call inside that context. Switching to a stateful/SSE
      // transport (sessionIdGenerator set, persistent stream) would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context — re-review tenant isolation before changing this.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    };

    if (isGatewayMode) {
      // Gateway mode: domain and API key must arrive on every request. Do not
      // fall through to FRESHDESK_DOMAIN / FRESHDESK_API_KEY in the process
      // environment — that fallback is not request-scoped.
      const domain = headerValue(req.headers['x-freshdesk-domain']);
      const apiKey = headerValue(req.headers['x-freshdesk-api-key']);
      if (!domain || !apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(GATEWAY_CREDENTIALS_UNAUTHORIZED));
        return;
      }
      await runWithCredentials({ domain, apiKey }, handle);
      return;
    }

    await handle();
  });

  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      logger.info(`HTTP streaming server listening on ${host}:${port}`);
      resolve(httpServer);
    });
  });
}

if (process.env.VITEST !== 'true') {
  const transport = process.env.MCP_TRANSPORT;
  if (transport === 'http') {
    startHttpTransport().catch((error: unknown) => {
      logger.error('Fatal startup error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  } else {
    import('./index.js');
  }
}
