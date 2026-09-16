# Legacy MCP Proxy Route

For EmDash 0.38 and newer, use the native MCP endpoint at `https://your.site/_emdash/api/mcp`. Enable emdash-inbox's MCP tools under **Admin → Extensions**, then connect with OAuth or a personal access token that includes `mcp:tools:emdash-inbox`. The token owner's role must also satisfy the tools' required permissions. The native endpoint supports MCP authentication and transport directly; this proxy is optional for existing integrations.

## Keeping an existing proxy

EmDash wraps plugin-route responses in `{"data": ...}`. This example forwards requests to the private `messages/mcp` plugin route and unwraps its responses for clients using the legacy `/api/inbox-mcp` URL.

Each request must supply the caller's own `Authorization: Bearer <token>` header. The proxy forwards that credential to EmDash for validation. Session cookies do not authenticate the proxy and are not forwarded. In EmDash 0.38, this legacy plugin route requires a token with `admin` scope and a user with `plugins:manage` permission; the native endpoint's plugin-specific scope does not authorize this legacy route.

1. Copy `inbox-mcp.ts` to `src/pages/api/inbox-mcp.ts` in your EmDash site.

2. Remove `EMDASH_INBOX_MCP_TOKEN` from `.dev.vars`, deployment configuration, and production secrets. This route no longer reads a shared host token. For a Wrangler deployment:

   ```bash
   npx wrangler secret delete EMDASH_INBOX_MCP_TOKEN
   ```

   Revoke the old shared token in EmDash. Earlier versions of this example used it for every request, including anonymous requests.

3. Build and deploy the site:

   ```bash
   pnpm run build
   npx wrangler deploy
   ```

4. Update each existing MCP client to send its own Bearer token on requests to `https://your.site/api/inbox-mcp`. This legacy proxy does not implement OAuth discovery or consent; use the native endpoint for clients that rely on OAuth.

For example, after setting `EMDASH_CALLER_TOKEN` in your local shell:

```bash
curl https://your.site/api/inbox-mcp \
  -H "Authorization: Bearer $EMDASH_CALLER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Response behavior

Missing or malformed credentials return `401` without contacting EmDash. EmDash's `401` and `403` responses remain authentication and authorization errors. Other upstream failures return a sanitized `502` JSON-RPC error. Responses are marked `private, no-store`, and the proxy does not follow upstream redirects or forward cookies.
