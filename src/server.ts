import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorRequestHandler } from 'express';
import { Catalog } from './catalog.js';

export interface Options {
  profile: string;
  host: string;
  allowedHosts: string[];
  token?: string;
  fetcher?: typeof fetch;
}

export function createApp(options: Options) {
  const catalog = new Catalog(options.profile, options.fetcher);
  const app = createMcpExpressApp({ host: options.host, allowedHosts: options.allowedHosts });
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.use('/mcp', (req, res, next) => {
    if (options.token) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    // There is no browser-facing API. Prevent cross-origin use of an unauthenticated bridge.
    if (req.headers.origin) {
      res.status(403).json({ error: 'Browser origins are not supported; connect through your MCP backend' });
      return;
    }
    next();
  });
  app.post('/mcp', async (req, res) => {
    const server = new Server({ name: 'shopify-catalog-mcp-bridge', version: '0.1.0' },
      { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) =>
      ({ tools: await catalog.listTools(extra.signal) }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      catalog.callTool(request.params.name, request.params.arguments ?? {}, extra.signal));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void Promise.all([transport.close(), server.close()]).catch(() => {
        console.error('MCP transport cleanup failed');
      });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error('MCP request handling failed');
      if (!res.headersSent) res.status(500).json({
        jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' },
      });
      else res.end();
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed; this MCP server is stateless' });
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : 500;
    console.error('HTTP request rejected', status === 400 || status === 413 ? status : 500);
    res.status(status === 400 || status === 413 ? status : 500).json({ error: 'Invalid HTTP request' });
  };
  app.use(errors);
  return app;
}
