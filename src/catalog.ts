import { createParser } from 'eventsource-parser';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export const UPSTREAM_URL = 'https://catalog.shopify.com/api/ucp/mcp';
export const EXAMPLE_PROFILE =
  'https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json';
export const TOOL_NAMES = new Set(['search_catalog', 'lookup_catalog', 'get_product']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProfile(profile: string): string {
  const url = new URL(profile);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('UCP_PROFILE_URL must be an HTTPS URL without credentials or a fragment');
  }
  return url.href;
}

export function normalizeResult(value: unknown): CallToolResult {
  if (!isObject(value)) throw new McpError(ErrorCode.InternalError, 'Invalid Shopify tool result');
  if (value.content === undefined && value.structuredContent === undefined) {
    throw new McpError(ErrorCode.InternalError, 'Shopify result has neither content nor structuredContent');
  }
  const result = CallToolResultSchema.parse({
    ...value,
    ...(value.content === undefined && value.structuredContent !== undefined ? { content: [] } : {}),
  });
  if (result.structuredContent !== undefined) {
    const text = JSON.stringify(result.structuredContent);
    const alreadyPresent = result.content.some((item) => {
      if (item.type !== 'text') return false;
      try {
        return JSON.stringify(JSON.parse(item.text)) === text;
      } catch {
        return false;
      }
    });
    if (!alreadyPresent) result.content.push({ type: 'text', text });
  }
  return result;
}

export class Catalog {
  readonly profile: string;
  private sequence = 0;

  constructor(profile: string, private readonly fetcher: typeof fetch = fetch) {
    this.profile = validateProfile(profile);
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.sequence;
    const timeout = AbortSignal.timeout(30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(UPSTREAM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new McpError(response.status === 429 ? -32029 : -32002,
          `Shopify HTTP ${response.status}`, {
            status: response.status,
            retryAfter: response.headers.get('retry-after'),
          });
      }
      if (!response.body) throw new McpError(ErrorCode.InternalError, 'Empty Shopify response');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new McpError(ErrorCode.InternalError, 'Shopify response exceeds 8 MiB');
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }
      body = chunks.join('');
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(-32002, 'Shopify request failed or timed out');
    }
    let envelope: unknown;
    try {
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType === 'text/event-stream') {
        const messages: unknown[] = [];
        const parser = createParser({
          onEvent: (event) => { messages.push(JSON.parse(event.data)); },
          onError: () => { throw new Error('Invalid Shopify event stream'); },
        });
        parser.feed(body);
        envelope = messages.find((message) => isObject(message) && message.id === id);
      } else if (contentType === 'application/json') {
        envelope = JSON.parse(body);
      } else {
        throw new Error('Unsupported Shopify content type');
      }
    } catch {
      throw new McpError(ErrorCode.InternalError, 'Invalid Shopify JSON-RPC response');
    }
    if (!isObject(envelope) || envelope.jsonrpc !== '2.0' || envelope.id !== id) {
      throw new McpError(ErrorCode.InternalError, 'Invalid Shopify JSON-RPC envelope');
    }
    if (isObject(envelope.error)) {
      const { code, message, data } = envelope.error;
      if (typeof code === 'number' && typeof message === 'string') {
        throw new McpError(code, message, data);
      }
    }
    if (!('result' in envelope) || 'error' in envelope) {
      throw new McpError(ErrorCode.InternalError, 'Invalid Shopify JSON-RPC result');
    }
    return envelope.result;
  }

  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    const result = ListToolsResultSchema.parse(await this.request('tools/list', {}, signal));
    const tools = result.tools.filter((tool) => TOOL_NAMES.has(tool.name));
    if (tools.length !== TOOL_NAMES.size || new Set(tools.map((tool) => tool.name)).size !== TOOL_NAMES.size) {
      throw new McpError(ErrorCode.InternalError, 'Shopify did not advertise all three catalog tools');
    }
    return tools.map((tool) => {
      const inputSchema = structuredClone(tool.inputSchema);
      if (inputSchema.properties) delete inputSchema.properties.meta;
      if (inputSchema.required) inputSchema.required = inputSchema.required.filter((name) => name !== 'meta');
      // The bridge owns the profile, so callers need only supply catalog arguments.
      return {
        ...tool,
        inputSchema,
        description: `${tool.description ?? tool.name}\nThe bridge supplies the UCP agent profile. Use live results; do not cache catalog results or download product images.`,
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (!TOOL_NAMES.has(name)) throw new McpError(ErrorCode.InvalidParams, 'Unknown catalog tool');
    return normalizeResult(await this.request('tools/call', {
      name,
      arguments: { ...args, meta: { 'ucp-agent': { profile: this.profile } } },
    }, signal));
  }
}
