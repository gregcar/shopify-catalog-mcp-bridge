import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Catalog, EXAMPLE_PROFILE, normalizeResult, TOOL_NAMES, UPSTREAM_URL, validateProfile } from '../src/catalog.js';
import { createApp } from '../src/server.js';

const tools = [...TOOL_NAMES].map((name) => ({
  name, description: name,
  inputSchema: {
    type: 'object', properties: { catalog: { type: 'object' }, meta: { type: 'object' } },
    required: ['meta', 'catalog'],
  },
}));
const products = { ucp: { capabilities: { search: [{}] } }, products: [{ id: 'example', title: 'Headphones' }] };
type Rpc = { id: number; method: string; params: Record<string, unknown> };

function mockFetch(handler: (rpc: Rpc, init: RequestInit) => Response): typeof fetch {
  return async (input, init) => {
    assert.equal(input, UPSTREAM_URL);
    assert.ok(init);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    });
    return handler(JSON.parse(String(init.body)) as Rpc, init);
  };
}
function json(id: number, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result });
}

test('profile configuration requires HTTPS without credentials or fragments', () => {
  assert.equal(validateProfile(EXAMPLE_PROFILE), EXAMPLE_PROFILE);
  for (const profile of ['http://example.com', 'https://u:p@example.com', 'https://example.com/#x', 'not a URL']) {
    assert.throws(() => validateProfile(profile));
  }
});

test('structured-only Shopify results gain required content and retain structured payload', () => {
  assert.deepEqual(normalizeResult({ structuredContent: products }), {
    content: [{ type: 'text', text: JSON.stringify(products) }], structuredContent: products,
  });
});

test('valid existing text is not duplicated; other content, errors and metadata are preserved', () => {
  const value = {
    content: [{ type: 'text', text: JSON.stringify(products) }],
    structuredContent: products, isError: true, _meta: { trace: 'example' },
  };
  assert.deepEqual(normalizeResult(value), value);
  const result = normalizeResult({ ...value, content: [{ type: 'text', text: 'Explanation' }] });
  assert.equal(result.content.length, 2);
  assert.equal(result.isError, true);
  assert.deepEqual(result._meta, value._meta);
});

test('malformed results are rejected instead of replaced by success-shaped fallbacks', () => {
  for (const value of [null, {}, { content: null }, { content: 'invalid' }]) {
    assert.throws(() => normalizeResult(value));
  }
});

test('discovery removes profile input and excludes non-catalog tools without mutating upstream schemas', async () => {
  let requests = 0;
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch((rpc) => {
    requests++;
    return json(rpc.id, { tools: [...tools, { ...tools[0], name: 'create_checkout' }] });
  }));
  for (let i = 0; i < 2; i++) {
    const advertised = await catalog.listTools();
    assert.deepEqual(advertised.map((tool) => tool.name), [...TOOL_NAMES]);
    for (const tool of advertised) {
      assert.deepEqual(tool.inputSchema.required, ['catalog']);
      assert.equal(tool.inputSchema.properties?.meta, undefined);
      assert.match(tool.description ?? '', /bridge supplies the UCP agent profile/);
    }
  }
  assert.equal(requests, 2, 'tool discovery must not be cached');
  assert.deepEqual(tools[0]?.inputSchema.required, ['meta', 'catalog']);
});

test('missing catalog tools fail explicitly', async () => {
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch((rpc) => json(rpc.id, { tools: [] })));
  await assert.rejects(catalog.listTools(), /all three/);
});

test('all catalog calls inject the configured profile, override caller metadata, and are never cached', async () => {
  let requests = 0;
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch((rpc) => {
    requests++;
    assert.equal(rpc.method, 'tools/call');
    const args = rpc.params.arguments as Record<string, unknown>;
    assert.deepEqual(args.meta, { 'ucp-agent': { profile: EXAMPLE_PROFILE } });
    assert.deepEqual(args.catalog, { query: 'headphones' });
    return json(rpc.id, { structuredContent: products });
  }));
  for (const name of TOOL_NAMES) {
    await catalog.callTool(name, { catalog: { query: 'headphones' }, meta: { profile: 'untrusted' } });
  }
  assert.equal(requests, 3);
  await assert.rejects(catalog.callTool('create_checkout', {}), /Unknown catalog tool/);
  assert.equal(requests, 3);
});

test('Shopify JSON-RPC errors preserve code, message and data', async () => {
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch((rpc) => Response.json({
    jsonrpc: '2.0', id: rpc.id,
    error: { code: -32001, message: 'UCP discovery failed', data: { code: 'invalid_profile_url' } },
  })));
  await assert.rejects(catalog.callTool('search_catalog', {}), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, -32001);
    assert.deepEqual(error.data, { code: 'invalid_profile_url' });
    return true;
  });
});

test('rate limits retain HTTP status and Retry-After without retrying', async () => {
  let requests = 0;
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch(() => {
    requests++;
    return new Response('too many requests', { status: 429, headers: { 'Retry-After': '60' } });
  }));
  await assert.rejects(catalog.listTools(), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.equal(error.code, -32029);
    assert.deepEqual(error.data, { status: 429, retryAfter: '60' });
    return true;
  });
  assert.equal(requests, 1);
});

test('network errors do not leak diagnostics containing request data', async () => {
  const catalog = new Catalog(EXAMPLE_PROFILE, async () => { throw new Error('private request data'); });
  await assert.rejects(catalog.listTools(), (error: unknown) => {
    assert.ok(error instanceof McpError);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test('upstream event streams are decoded, including multiline data and notifications', async () => {
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch((rpc) => new Response(
    `: heartbeat\n\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n`
    + `event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":${rpc.id},"result":{"tools":${JSON.stringify(tools)}}}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  )));
  assert.equal((await catalog.listTools()).length, 3);
});

test('invalid content type, envelopes, JSON and missing SSE responses fail explicitly', async () => {
  const responses = [
    () => new Response('html', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ jsonrpc: '2.0', id: -1, result: { tools } }),
    () => Response.json({ jsonrpc: '2.0', id: 1 }),
    () => new Response(': heartbeat\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
  ];
  for (const response of responses) {
    await assert.rejects(new Catalog(EXAMPLE_PROFILE, mockFetch(response)).listTools(), /Invalid Shopify/);
  }
});

test('oversized upstream responses are rejected', async () => {
  const catalog = new Catalog(EXAMPLE_PROFILE, mockFetch(() =>
    new Response(' '.repeat(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })));
  await assert.rejects(catalog.listTools(), /exceeds 8 MiB/);
});

test('official MCP client can initialize, discover, and call without a profile; HTTP protections hold', async () => {
  const app = createApp({
    profile: EXAMPLE_PROFILE, host: '127.0.0.1', allowedHosts: ['127.0.0.1', 'localhost'],
    token: 'test-secret',
    fetcher: mockFetch((rpc) => rpc.method === 'tools/list'
      ? json(rpc.id, { tools }) : json(rpc.id, { structuredContent: products })),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  try {
    assert.equal((await fetch(new URL('/healthz', url))).status, 200);
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, {
      method: 'POST', headers: { Authorization: 'Bearer test-secret', Origin: 'https://evil.example' },
    })).status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer test-secret' } })).status, 405);
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { method: 'POST', headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(invalidHostStatus, 403);
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: 'Bearer test-secret' } },
    }));
    const advertised = await client.listTools();
    assert.equal(advertised.tools.length, 3);
    const result = await client.callTool({ name: 'search_catalog', arguments: { catalog: { query: 'headphones' } } });
    assert.deepEqual(result.structuredContent, products);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(products) }]);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
