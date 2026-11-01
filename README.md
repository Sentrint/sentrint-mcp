# @sentrint/mcp

Run Sentrint security scans from your coding agent. This package is a small local bridge: your agent talks to it over stdio, and it forwards each call to the hosted Sentrint MCP server at `https://sentrint.com/mcp`.

Zero runtime dependencies. Node 20 or newer.

## Set up

1. Sign in once, in a terminal:

   ```
   npx -y @sentrint/mcp login
   ```

   Your browser opens on sentrint.com. Approve access and close the tab.

2. Add the server to your agent's MCP settings:

   ```json
   {
     "mcpServers": {
       "sentrint": { "command": "npx", "args": ["-y", "@sentrint/mcp"] }
     }
   }
   ```

3. Ask your agent to scan a repository.

If your agent can connect to a remote MCP server by address, you can skip this package and add `https://sentrint.com/mcp` directly.

## Commands

| Command | What it does |
|-|-|
| `npx -y @sentrint/mcp` | Runs the bridge. Your agent starts it for you. |
| `npx -y @sentrint/mcp login` | Signs you in through your browser. |
| `npx -y @sentrint/mcp logout` | Revokes the sign-in and deletes it from this computer. |

## What it stores

One file per server in `~/.sentrint/` (readable only by you on macOS and Linux): the client registration and your access and refresh tokens. Nothing else, and nothing about your code. Set `SENTRINT_HOME` to keep it somewhere else.

## How sign-in works

OAuth 2.1 with PKCE, as a public client: there is no secret to leak. The browser returns to a one-time listener on `127.0.0.1`, which accepts a single matching response and then closes. Tokens refresh on their own; a refresh is done under a lock so two agent windows never use the same refresh token twice.

## Security

Report a vulnerability through this repository's **Security** tab (private reporting). Docs: https://sentrint.com/wiki/mcp

## License

MIT
