# Prepared Shopify compatibility report

**Status:** Prepared for manual submission; not yet submitted to Shopify.

Shopify's AI Toolkit contribution guidance directs feedback to the
[Shopify Developer Community](https://community.shopify.dev/).
Suggested category: **Agentic Commerce**.

## Suggested title

Global Catalog MCP tools/call omits required content field, breaking MCP clients

## Report body

The Global Catalog MCP endpoint successfully initializes and lists tools, but
`search_catalog` returns a `CallToolResult` containing `structuredContent` without
the `content` field. This breaks clients that validate against the MCP result
schema, including the Python MCP SDK used by Open WebUI v0.12.3.

Observed on October 23, 2026, against
`https://catalog.shopify.com/api/ucp/mcp`.

### Minimal reproduction

No credentials, private profiles, or customer data are needed:

```sh
curl --fail-with-body https://catalog.shopify.com/api/ucp/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_catalog",
      "arguments": {
        "meta": {
          "ucp-agent": {
            "profile": "https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json"
          }
        },
        "catalog": {
          "query": "wireless headphones",
          "context": {"address_country": "CA"}
        }
      }
    }
  }' | jq '{
    jsonrpc,
    id,
    result_keys: (.result | keys),
    has_content: (.result | has("content")),
    has_structured_content: (.result | has("structuredContent"))
  }'
```

Observed shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result_keys": ["structuredContent"],
  "has_content": false,
  "has_structured_content": true
}
```

The Python MCP client fails before Open WebUI can process the product results:

```text
pydantic_core._pydantic_core.ValidationError: 1 validation error for CallToolResult
content
  Field required [type=missing, input_value={'structuredContent': ...}, input_type=dict]
```

### Expected behavior

Please return a spec-compatible `CallToolResult`, retaining `structuredContent`
and supplying `content`. For broad client compatibility, include the serialized
structured result in a text content block:

```json
{
  "content": [
    {"type": "text", "text": "<serialized structured result>"}
  ],
  "structuredContent": {}
}
```

MCP specifies structured tool content and recommends also returning serialized
JSON in a text content block for backwards compatibility:
https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content

Providing an empty `content` array would address strict validation, but returning
the text block also supports clients that only consume textual tool results.

### Additional context

Tool discovery alone does not detect this; a real `tools/call` is required.
The reproduction supplies Shopify's hosted UCP example profile, so it is
separate from the expected missing-profile discovery error.

An unofficial compatibility bridge with regression tests is available at
https://github.com/gregcar/shopify-catalog-mcp-bridge.
An upstream fix would let clients connect directly without response adaptation.
