# RawTrace MCP

RawTrace MCP is a local MCP server that wraps Playwright and Chrome DevTools Protocol to record raw DOM mutation and network event streams while an AI coding agent interacts with a web page.

It is designed for building and debugging complex Playwright automations where post-click snapshots are not enough.

## Warning

RawTrace MCP records raw browser data by design. It may capture cookies, authorization headers, request bodies, response bodies, tokens, personal information, WebSocket messages, hidden form values, and DOM text. Treat every trace as sensitive. Do not commit traces to GitHub. Use only on systems and accounts you are authorized to inspect.

RawTrace does not silently mask, redact, or omit sensitive fields by default. Every `monitor_start` call must include:

```json
{
  "acknowledgeRawCapture": true
}
```

## Install

```sh
npm install -g rawtrace-mcp
```

For local development:

```sh
npm install
npm run build
node dist/cli.js
```

## MCP Configuration

Stdio is the default transport:

```toml
[mcp_servers.rawtrace]
type = "stdio"
command = "npx"
args = ["-y", "rawtrace-mcp"]
startup_timeout_sec = 120
```

Codex example:

```toml
[mcp_servers.rawtrace]
type = "stdio"
command = "npx"
args = ["-y", "rawtrace-mcp"]
startup_timeout_sec = 120
```

Claude Code example:

```sh
claude mcp add rawtrace -- npx -y rawtrace-mcp
```

Local development:

```toml
[mcp_servers.rawtrace]
type = "stdio"
command = "node"
args = ["C:\\path\\to\\rawtrace-mcp\\dist\\cli.js"]
startup_timeout_sec = 120
```

Streamable HTTP:

```sh
rawtrace-mcp --transport http --host 127.0.0.1 --port 3757
```

HTTP binds to `127.0.0.1` by default. Binding to a non-loopback host requires `--unsafe-remote` and `--auth-token`.

After changing MCP client configuration, restart the client or start a new session. The tools should appear with the server name you configured, for example `rawtrace.browser_get_elements`, `rawtrace.monitor_start`, and `rawtrace.monitor_search_events`. If tools do not appear, verify that Node.js is at least 22, `npx -y rawtrace-mcp` starts successfully, and the MCP client can read its configuration file.

## Tools

RawTrace MCP currently exposes 42 MCP tools:

- Browser lifecycle and tabs: `browser_launch`, `browser_close`, `browser_list_tabs`, `browser_new_tab`, `browser_switch_tab`, `browser_close_tab`.
- Navigation: `browser_navigate`, `browser_reload`, `browser_go_back`, `browser_go_forward`.
- Page observation: `browser_get_state`, `browser_get_dom`, `browser_get_elements`, `browser_optimize_selector`, `browser_get_accessibility`, `browser_screenshot`, `browser_get_network`.
- Browser actions: `browser_click`, `browser_type`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_select_option`, `browser_check`, `browser_wait`, `browser_wait_for_response`, `browser_handle_dialog`.
- Raw trace tools: `monitor_start`, `monitor_stop`, `monitor_get_summary`, `monitor_read_events`, `monitor_search_events`, `monitor_search_bodies`, `monitor_export`.
- Dangerous page execution: `browser_eval`.
- Credential and browser state tools: `browser_get_cookies`, `browser_set_cookies`, `browser_clear_cookies`, `browser_get_storage`, `browser_set_storage`, `browser_export_storage_state`, `browser_import_storage_state`.

Inspection tools that read raw page content or body files require `acknowledgeRawCapture: true`, the same safety acknowledgment used by `monitor_start`. `browser_eval` also requires `acknowledgeDangerousEval: true`. If `browser_eval` times out, RawTrace closes the timed-out page and switches to another or new page, because browser-side JavaScript evaluation cannot be safely canceled in place.

Credential/state tools require both `acknowledgeRawCapture: true` and `acknowledgeCredentialAccess: true`; `browser_launch` requires the same acknowledgments when using `storageStatePath`. Applying Playwright `storageState` clears existing cookies, localStorage, and IndexedDB before importing the new state. For CDP-connected browsers or explicit `userDataDir` profiles, `browser_launch({ storageStatePath })` and `browser_import_storage_state` also require `acknowledgeStorageStateOverwrite: true`.

When no monitor is running, large DOM/text, screenshots, eval results, and storageState artifacts are written under `rawtrace-traces/inspections/`. When a monitor is active, large raw values are written under the trace `bodies/` directory and returned by reference.

## Trace Output

Trace bundles are written under `rawtrace-traces/` by default:

```text
trace_2026-06-14T064500Z_ab12cd34/
  manifest.json
  actions.ndjson
  dom.ndjson
  network.ndjson
  cookies.ndjson
  websocket.ndjson
  console.ndjson
  frames.ndjson
  bodies/
  snapshots/
```

The stable v1 trace schema is documented in [docs/trace-schema-v1.md](docs/trace-schema-v1.md).

`monitor_read_events` returns at most 1000 events per call. Use `offset`/`limit` pagination for browsing or `monitor_search_events` when looking for a specific endpoint, DOM text, or event type. Search includes inline event fields and DOM `htmlRef`/`textRef` artifacts; it does not expand network request or response body files by default. Use `monitor_search_bodies` only when you explicitly want to search raw request or response body files.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
```

Integration tests launch Chromium. If your environment does not already have Playwright browsers installed, run:

```sh
npx playwright install chromium
```

## Scope

RawTrace MCP is a raw event recorder for automation development. It is not an AI decision-making agent, selector-healing system, CAPTCHA solver, anti-bot bypass tool, cloud browser service, or cross-browser recorder.

The public open-source surface for v1 is the `rawtrace-mcp` CLI, MCP tools, and documented trace schema. Internal TypeScript modules are not a stable library API and are not covered by SemVer compatibility promises yet.
