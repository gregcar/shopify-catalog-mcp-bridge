import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EXAMPLE_PROFILE, TOOL_NAMES } from '../src/catalog.js';
import { createApp } from '../src/server.js';

const server = createApp({
  profile: process.env.UCP_PROFILE_URL ?? EXAMPLE_PROFILE,
  host: '127.0.0.1', allowedHosts: ['127.0.0.1'],
}).listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const client = new Client({ name: 'shopify-bridge-live-smoke', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(new Set(tools.map((tool) => tool.name)), TOOL_NAMES);
  const result = await client.callTool({
    name: 'search_catalog',
    arguments: { catalog: { query: 'wireless headphones', context: { address_country: 'CA' } } },
  });
  assert.ok(!result.isError);
  assert.ok(result.structuredContent);
  assert.ok(Array.isArray(result.content) && result.content.length > 0);
  console.log('PASS: official MCP client initialized, discovered three tools, and received live catalog results');
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
