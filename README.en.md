# remnawave-mcp

**English** | [Русский](README.md)

MCP server for the [Remnawave](https://github.com/remnawave) **3.x** panel. It lets Claude Desktop (and Cursor, Windsurf or any other MCP client) look into your panel — users, nodes, traffic, devices, connections, GeoCheck — through plain questions in the chat.

**Highlights:**

- **Read-only by default.** Nothing in the panel changes unless you explicitly enable write tools.
- **Always matches your panel version.** Tools are not hand-written: they are generated at startup from the official [`@remnawave/backend-contract`](https://www.npmjs.com/package/@remnawave/backend-contract) package. Panel updated → bump the package → rebuild.
- **Secrets are never exposed:** panel login, passkeys, node SECRET_KEY, API tokens.
- **A leaked chat leaks neither keys nor clients.** Reality private keys, passwords, UUIDs and connection links are hidden; client personal data (username, email, Telegram ID, IP, HWID) is replaced with pseudonyms. See [Privacy](#privacy).
- **Convenience tools on top:** `find_user` (by Telegram ID, email, username, shortUuid, ID, tag), `geocheck_node`, `node_connections`, `user_connections` — they start the job on the node and wait for the result.

## Compatibility

| Panel version | Status |
|---|---|
| **3.4.x** | ✅ tested on production panels (3.4.4) |
| other **3.x** | ✅ should work: install the contract for your version — `npm i @remnawave/backend-contract@<version> --save-exact` and `npm run build` |
| **2.8.x** | ⚠️ not officially supported: core tools build, but not tested against a live panel; some extra tools are unavailable |
| **2.7 and older** | ❌ use [TrackLine/mcp-remnawave](https://github.com/TrackLine/mcp-remnawave) |

The contract version should match your panel version (at least the first two numbers). The server adapts to the installed contract: routes, parameters and the tool list all come from it.

---

## Installation

Requires [Node.js](https://nodejs.org) 22+ and Git.

Windows:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Restart PowerShell after installing, then:

```powershell
cd C:\Tools
git clone https://github.com/3APA3A-3AHO3A/remnawave-mcp.git
cd remnawave-mcp
npm ci
npm run build
npm run list-tools
```

The last line should look like `79 API tools + 4 extra (contract 3.4.4)`.

macOS / Linux: same commands, any path.

## API token

**Panel → Settings → API tokens → Create.** Grant `read` only:

users, nodes, hosts, hwid, connections, bandwidth-stats, system, subscriptions, subscription-request-history, internal-squads, external-squads, config-profiles, node-plugins (other sections on `read` are optional).

Do not grant `write`, `*`, api-tokens, passkeys, auth or keygen.

> Remnawave scopes are "read/write", not GET/POST. GeoCheck, connection requests and user lookup work with `read` even though they are POST requests.

## Claude Desktop

**Claude → Settings → Developer → Edit Config.** Fully quit Claude (tray → Quit), then add this right after the first `{` in `claude_desktop_config.json`:

```json
  "mcpServers": {
    "remnawave": {
      "command": "node",
      "args": ["C:\\Tools\\remnawave-mcp\\dist\\index.js"],
      "env": {
        "REMNAWAVE_BASE_URL": "https://panel.example.com",
        "REMNAWAVE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  },
```

- Backslashes in Windows paths must be doubled: `\\`.
- Keep the trailing comma if the file has other settings.
- Several panels → several blocks with different names (`remnawave-main`, `remnawave-2`, …).

Start Claude. In **Settings → Developer** the server should be **running**. Try: "How many users are online in the panel?"

Full example: [`examples/claude_desktop_config.example.json`](examples/claude_desktop_config.example.json).

## Configuration (environment variables)

| Variable | Required | Description |
|---|---|---|
| `REMNAWAVE_BASE_URL` | yes | Panel URL: `https://panel.example.com` (no `/api`) |
| `REMNAWAVE_API_TOKEN` | yes | API token |
| `REMNAWAVE_READONLY` | no | `true` by default. `false` enables write tools (the token needs `write` too) |
| `REMNAWAVE_PRIVACY` | no | `strict` by default, `basic` or `off` — see [Privacy](#privacy) |
| `REMNAWAVE_PRIVACY_SALT` | no | Any long string — keeps pseudonyms stable across restarts |
| `REMNAWAVE_API_KEY` | no | `X-Api-Key` header — panel behind Caddy with a secret path |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | no | Panel behind Cloudflare Access |
| `REMNAWAVE_TOOLS_EXCLUDE` | no | Hide tools (comma-separated) |
| `REMNAWAVE_TOOLS_INCLUDE` | no | Expose only these tools |
| `REMNAWAVE_MAX_RESPONSE_CHARS` | no | Truncate long responses, default 60000 |
| `REMNAWAVE_TIMEOUT_MS` | no | Request timeout, default 30000 |

## What to ask

- "How many active and online users?"
- "Find the client with Telegram ID 123456789, show devices and expiry date"
- "Which nodes are offline?" / "Traffic per node for last week"
- "Run GeoCheck on node NL-1"
- "Who is on node DE-1 right now and from how many IPs?"
- "Top users by device count" / "Torrent report for the last day"

GeoCheck and connection requests put a small load on the node — don't overuse them on nodes with a traffic cap.

## Troubleshooting

| Symptom | Fix |
|---|---|
| **failed** in Settings → Developer | Check the config JSON (commas, braces, `\\` in the path); run `npm run build` |
| `Remnawave API 401` | Token expired or deleted — create a new one |
| `Remnawave API 403` | Token lacks `read` on a section — recreate it with the right scopes |
| `fetch failed` / `ENOTFOUND` / timeout | Panel unreachable or wrong `REMNAWAVE_BASE_URL` |
| Tools don't show up | Fully restart Claude (tray → Quit) |

Logs (Windows): `%APPDATA%\Claude\logs\mcp-server-<name>.log`, macOS: `~/Library/Logs/Claude/`.

## Updating

```powershell
cd C:\Tools\remnawave-mcp
git pull
npm ci
npm run build
```

Panel updated but this repo not yet — install the contract for your version:

```powershell
npm i @remnawave/backend-contract@<panel_version> --save-exact
npm run build
```

Fully restart Claude after any update.

Once a day GitHub Actions compares the latest **stable** Remnawave panel release with the contract version in the project and, if a new one is out, opens a Pull Request with the updated and built project. Intermediate contract builds between releases are skipped.

## How it works

In `@remnawave/backend-contract` every API endpoint is described as a "command": URL, method, zod schemas and a read/write mark. At startup the server walks through all commands and turns each into an MCP tool, validating arguments with the same schemas the panel uses. That is why the code barely depends on the Remnawave version.

```
src/
  index.ts     — MCP server, tool selection, calls
  registry.ts  — tools generated from the contract, block lists
  extras.ts    — convenience tools (find_user, geocheck_node, …)
  redact.ts    — privacy filter: secrets and pseudonyms
  client.ts    — HTTP requests to the panel
  config.ts    — environment variables
```

## Privacy

Everything the server returns ends up in the chat history, so panel responses are filtered **on your machine**, before they reach the model.

| Data | `strict` (default) | `basic` | `off` |
|---|---|---|---|
| Reality private keys & shortIds, SECRET_KEY, passwords, API keys | hidden | hidden | visible |
| VLESS UUID, `vless://`, `ss://`… links, subscription shortUuid & URL | hidden | hidden | visible |
| "Connection keys" and "raw subscription" tools | unavailable | unavailable | available |
| username, email, Telegram ID, client notes | pseudonym | visible | visible |
| client IP addresses, HWID (incl. device IDs in User-Agent) | pseudonym | visible | visible |
| panel user ID, status, traffic, dates, nodes, statistics | visible | visible | visible |

**Pseudonyms.** Instead of `ivan_petrov` the model sees `user~dca596`, instead of an IP — `ip~f055f3`. Equal values get equal pseudonyms, so the model can still notice "two clients share an IP" without learning it. A pseudonym can be passed back as a tool argument — the server resolves it locally.

Need the real data? Open the client in the panel by their ID.

**Limits:** whatever you type into the chat yourself (e.g. "find Telegram ID 123…") stays in the chat. Prefer panel user IDs or pseudonyms.

Also:
- The token lives only in your MCP client config and never gets into the repository.
- Use a dedicated read-only token so it can be revoked without touching bots or monitoring.

## Credits

Inspired by [TrackLine/mcp-remnawave](https://github.com/TrackLine/mcp-remnawave) (Remnawave 2.x).

## License

[MIT](LICENSE)
