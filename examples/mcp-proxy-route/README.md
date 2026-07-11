# MCP Proxy Route

Unwraps EmDash's response envelope so MCP clients can reach emdash-inbox tools.

## Why a separate route?

EmDash wraps every plugin-route response in `{"data": ...}`, which MCP clients expect to parse as raw JSON-RPC responses. This route proxies requests to the plugin's `messages/mcp` endpoint and returns the unwrapped payload, unblocking tools like Claude desktop and claude.ai.

## Deploy

1. **Generate an EmDash API token** in the admin (Admin → Settings → API Tokens) with admin scope.

2. **Copy `inbox-mcp.ts`** to `src/pages/api/inbox-mcp.ts` in your EmDash site.

3. **Set the token in `.dev.vars`** (dev) or as a Wrangler secret (production):
   ```bash
   # .dev.vars (local development)
   EMDASH_INBOX_MCP_TOKEN=your_token_here
   
   # Production
   npx wrangler secret put EMDASH_INBOX_MCP_TOKEN
   ```

4. **Deploy** your site:
   ```bash
   pnpm run build
   npx wrangler deploy
   ```

5. **Connect an MCP client**:
   - **Claude Code**: Use the CLI command:
     ```bash
     claude mcp add --transport http emdash-inbox https://your.site/api/inbox-mcp
     ```
   - **Claude Desktop / claude.ai**: Add the deployed URL as a custom connector in Settings → Connectors → Add custom connector.

## Security

The endpoint has no per-request auth beyond the server-held token. If your site is public, put the route behind Cloudflare Access or an auth proxy, and rotate the token if exposed.
