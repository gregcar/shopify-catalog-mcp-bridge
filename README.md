# Shopify Catalog MCP Bridge

A small, unofficial, MIT-licensed compatibility bridge between Shopify's global
Catalog MCP endpoint and standard MCP clients, including Open WebUI.
Not affiliated with or endorsed by Shopify.

## Why a bridge?

Shopify's endpoint advertises `search_catalog`, `lookup_catalog`, and `get_product`.
Every call requires a UCP agent profile, and observed catalog responses contain
`structuredContent` without `content`. Some MCP SDKs reject that response.

This bridge:

- Uses the official MCP TypeScript SDK and stateless Streamable HTTP at `/mcp`.
- Injects your configured profile into `arguments.meta.ucp-agent.profile`.
- Removes that metadata field from the model-facing input schema.
- Preserves structured results and adds a JSON text content block for clients.
- Exposes only the three read-only catalog tools, never cart or checkout tools.
- Preserves upstream JSON-RPC errors, tool errors, and HTTP rate-limit metadata.
- Does not retry, cache catalog responses, download images, or forward incoming
  credentials, cookies, request headers, or user information to Shopify.

The upstream response issue is documented in
[the prepared Shopify report](docs/shopify-report.md). This is a compatibility
adapter, not an Open WebUI plugin or a replacement catalog implementation.

## Quick start

Requires Node.js 24 or later:

```sh
npm ci
npm run build
export UCP_PROFILE_URL=https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json
npm start
```

The server binds to `127.0.0.1:8080` by default. Use a separate terminal:

```sh
curl --fail http://127.0.0.1:8080/healthz
```

`UCP_PROFILE_URL` is required deliberately: profile ownership is part of the
agent's identity. The URL above is Shopify's hosted **example profile**, useful
for evaluation; it is not a profile you own. For production, publish your own
[UCP profile](https://shopify.dev/docs/agents/profiles) with the catalog search
and lookup capabilities and appropriate Shopify extensions.

## Docker

Published multi-architecture images support `linux/amd64` and `linux/arm64`.

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -e UCP_PROFILE_URL=https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json \
  ghcr.io/gregcar/shopify-catalog-mcp-bridge:v0.1.0
```

Or build locally: `docker build -t shopify-catalog-mcp-bridge .`

## Open WebUI

In **Admin Settings > Integrations > External Tool Servers**, add:

| Setting | Value |
| --- | --- |
| Type | MCP (Streamable HTTP) |
| URL | `http://HOST-REACHABLE-FROM-WEBUI:8080/mcp` |
| Authentication | None on a trusted private network, or Bearer with `BRIDGE_TOKEN` |
| Name | Shopify Catalog |
| Access | Choose the intended users or groups |

The URL must be reachable **from the Open WebUI backend**. For separate Docker
containers, use a shared Docker network and the bridge's container/service name,
not `localhost`. Add that name to `ALLOWED_HOSTS`.

Select Shopify Catalog from a chat's tools menu and use a model that supports
tool calling. No profile instructions are needed in the prompt. For example:

> Find wireless headphones shipping to Canada and compare three options.

Prices are in currency minor units; follow Shopify's tool descriptions when
displaying them. Product discovery can return checkout links but does not
place orders.

## Configuration and boundaries

| Variable | Default | Meaning |
| --- | --- | --- |
| `UCP_PROFILE_URL` | Required | HTTPS profile URL supplied to Shopify on each call |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address |
| `PORT` | `8080` | HTTP port |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Exact HTTP Host names without ports; no wildcards |
| `BRIDGE_TOKEN` | Unset | Optional inbound bearer token; never forwarded to Shopify |

Deploy only on a trusted private network or behind authenticated TLS.
`BRIDGE_TOKEN` is a shared service credential, not per-user authorization.
The bridge does not implement OAuth or browser CORS access. Browser Origin
requests are rejected. `/healthz` is unauthenticated and reports process health,
not Shopify availability.

Kubernetes HTTP probes need an allowed Host header, such as `localhost`.
Allow only intended MCP clients with network policy. The image runs as the
unprivileged `node` user and supports a read-only root filesystem.

All catalog traffic goes to the fixed Shopify global endpoint; caller-controlled
upstream destinations and arbitrary proxying are not supported. Shopify fetches
the configured profile itself. Requests time out after 30 seconds, upstream
responses are limited to 8 MiB, and HTTP request bodies use the SDK's bounded
JSON parser. HTTP 429 becomes MCP error `-32029` with `data.status` and
`data.retryAfter`; callers should honor it rather than retrying immediately.

Search terms and tool arguments are sent to Shopify. No request bodies,
credentials, or product results are intentionally logged or persisted.
Client applications may independently retain chat/tool history. Follow
[Shopify's catalog usage guidelines](https://shopify.dev/docs/agents/catalog):
do not cache catalog results or download images to your servers; render images
live in connection with their merchant listing.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run test:live
```

Unit/integration tests use mocked Shopify responses and the official MCP client.
The opt-in live smoke test sends one public product search to Shopify using the
hosted example profile unless overridden. It does not place orders, cache
results, or print product payloads.

GitHub Actions runs tests for pushes and pull requests. Version tags matching
the package version publish GHCR images and smoke-test the resulting container.
Production deployments should pin the published image digest.

Contributions with tests and focused scope are welcome. Please do not include
private chat transcripts, API tokens, or customer data in issues.

## License

[MIT](LICENSE).
