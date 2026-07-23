# Security Policy

RawTrace MCP intentionally captures raw browser data. Trace output may include cookies, bearer tokens, CSRF tokens, request bodies, response bodies, personal data, hidden form values, WebSocket frames, and local application secrets exposed to the browser.

Use RawTrace only on systems, accounts, and data you are authorized to inspect. Do not use it for credential theft, session hijacking, bypassing access controls, or monitoring third-party users without permission.

`browser_eval` executes arbitrary JavaScript in the target page with full page privileges. If eval times out, RawTrace closes the affected page to recover because browser-side JavaScript cannot be safely canceled in place.

Snapshot and observation aggregation tools such as `browser_snapshot`, `browser_poll_until`, `browser_observe_action_result`, and `browser_screenshot_annotated` can return or save raw page text, visible input values, element metadata, screenshots, and before/after page diffs. Treat their MCP responses and generated artifacts with the same sensitivity as trace bundles.

Credential/state tools can read or modify cookies, localStorage, sessionStorage, and Playwright storageState files. Applying storageState clears existing cookies, localStorage, and IndexedDB before setting the new state. CDP-connected browsers and explicit `userDataDir` profiles require `acknowledgeStorageStateOverwrite: true` before storageState import. These tools require explicit per-call acknowledgments, but the returned data and artifacts are still raw secrets.

`monitor_read_artifact` can read raw trace body, DOM, screenshot, eval, and storageState artifacts from a trace session directory. It rejects paths outside the trace directory, but anything it returns should still be treated as sensitive. `browser_wait_for_response_body`, `browser_get_forms`, and download tools may return or save raw application data.

`browser_upload_file` can provide local files to the active page and requires `acknowledgeFileAccess: true`. `browser_grant_permissions` changes browser permissions and requires `acknowledgePermissionChange: true`. `browser_set_geolocation` exposes caller-provided coordinates to pages and requires `acknowledgeLocationAccess: true`.

Do not commit trace bundles to GitHub. The default `.gitignore` excludes common RawTrace output directories, but users are responsible for handling trace artifacts safely.

## Dependency Advisory Exception

RawTrace 0.3.0 uses `@modelcontextprotocol/sdk` 1.29.0. As of July 23, 2026, `npm audit` reports one upstream moderate advisory through the SDK's `@hono/node-server` dependency: [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9), a Windows path traversal issue in Hono's `serve-static` implementation.

RawTrace does not import Hono, `@hono/node-server`, or `serve-static`. Its optional HTTP transport uses Node's `node:http` server and the MCP SDK's `StreamableHTTPServerTransport`, and it serves only the `/mcp` protocol endpoint. The vulnerable static-file path is therefore not reachable through RawTrace's implementation. The audit currently proposes downgrading the MCP SDK to 1.24.3 rather than a compatible patched release, so RawTrace retains SDK 1.29.0 and tracks the upstream fix. Production dependencies have no known high or critical advisories at this release.

## Reporting Security Issues

Please report security issues privately through the repository security advisory flow when available. Do not include raw trace bundles, tokens, cookies, or credentials in public issues.
