# RawTrace MCP 0.4

[中文快速开始](README.md) — includes browser setup, Codex configuration and complete query examples.

**Distribution note:** this source tree is 0.4.0, not yet published to npm. npm and marketplace pins currently point to legacy 0.3.0. Build this checkout and configure its absolute dist/cli.js path to use the nine-tool recorder below.

A local, passive Chromium recorder for coding agents. Another tool operates the browser; RawTrace attaches over CDP and records selected pages as **document baselines + incremental changes + checkpoints**.

## What changed

Version 0.4 is a breaking replacement of the 0.2/0.3 browser automation server. All `browser_*` and `monitor_*` tools were removed. There are exactly nine capture/query tools. No browser launching, clicking, navigation, eval, screenshots, credential editing, ZIP export, or visual player is provided.

DOM recording uses @rrweb/record 2.1.6. The query layer reconstructs serialized state without executing recorded scripts or fetching resources. Network, WebSocket and Console are event streams, not DOM diffs.

## Install and connect

Requires Node.js 22+ and an existing Chromium browser with a reachable CDP endpoint. A controller such as Playwright must launch/configure that browser; a built-in browser that does not expose CDP cannot be attached automatically. Do not expose a debug port publicly.

```sh
npm install
npm run build
node dist/cli.js --output-root ./rawtrace-traces
```

The recorder never creates a page or closes the external browser. Select pages explicitly with IDs from `capture_targets`. Their navigations and iframe documents are followed; unselected pages and popups are excluded. Cookie state is shared by each selected page's browser context and is therefore broader than the selected tabs.

MCP clients can run `node /absolute/path/to/dist/cli.js` over stdio. Optional HTTP:

```sh
node dist/cli.js --transport http --host 127.0.0.1 --port 3757
```

The endpoint is `/mcp`. Non-loopback binding requires `--unsafe-remote --auth-token TOKEN`.

## Workflow

1. `capture_targets({cdpUrl, acknowledgeRawCapture:true})`.
2. `capture_start({cdpUrl, targetIds:[...], acknowledgeRawCapture:true})`.
3. Operate the selected browser using your existing controller.
4. Query `capture_status`, `trace_events` or `trace_state` while recording.
5. `capture_stop({})` flushes and disconnects. Saved sessions remain queryable after restarting this server with the same output root.

| Tool | Purpose |
| --- | --- |
| capture_targets | Discover existing pages |
| capture_start | Start one session covering explicitly selected pages |
| capture_status | Counters, queue state, gaps, errors |
| capture_stop | Flush and disconnect |
| trace_list | Discover persisted sessions, including legacy v1 |
| trace_info | Manifest, checkpoint index, recovery diagnostics |
| trace_events | Filter and paginate recorded events |
| trace_state | Reconstruct tree or text at a sequence/time |
| trace_artifact | Read bounded byte ranges of an artifact |

All discovery/data-read tools and capture_start require `acknowledgeRawCapture:true`. capture_stop does not. All six capture categories default to enabled; disable them individually with captureDom, captureNetwork, captureWebSockets, captureCookies, captureConsole, captureFrames. maxBodyBytes defaults to 20,000,000 (MCP maximum 100,000,000).

Event queries accept sessionId, afterSeq, untilSeq, fromTime, toTime, source, type, pageId, documentId, nodeId, urlContains, text, searchBodies and limit. limit defaults to 100 and is capped at 1000. Body text search must be explicitly enabled. The URL filter matches serialized event payload URL content. Use nextAfterSeq when hasMore is true.

State queries require sessionId and pageId; optionally provide **either** atSeq **or** atTime, and format tree/text. Time values are epoch milliseconds. Text is concatenated recorded text nodes (excluding script/style), not a layout-aware innerText or accessibility snapshot.

Responses larger than 64 KB from session queries become JSON artifact references. Read them using trace_artifact with ref, offset and maxBytes (at most 32,000; UTF-8 reads are additionally capped at 8,000 bytes to bound JSON escaping). For byte-exact chunk assembly, request base64; independent UTF-8 chunks can split a multibyte character.

## Storage and limits

See [trace schema v2](docs/trace-schema-v2.md). Logs rotate at 64 MiB. Artifact bytes are SHA-256 addressed and deduplicated within each trace. Checkpoints occur after 60 seconds with changes or 5,000 incremental events. An unchanged page does not repeatedly snapshot.

There is no total session size limit and no automatic deletion. You manage disk capacity. Browser buffers are bounded at 8 MiB; writer queue at 32 MiB; pending collector work is capped. Overflow, disconnects and failed reads are reported rather than silently treated as complete recording.

Cookies are sampled every second, with an initial baseline and a final comparison. Changes between samples may be missed. Already completed network requests and earlier WebSocket messages cannot be recovered when capture starts.

Cross-origin iframe checkpoints are assembled asynchronously; a query between the parent checkpoint and child response reports the missing document. Closed shadow roots, canvas/WebGL and pure visual changes are outside reconstruction scope. CSSOM/media events are not reconstructed. DOM events represent observed mutation batches, not every intermediate synchronous state.

Source clocks and Node receive times are retained. Browser epoch clocks are calibrated at attachment; CDP clocks use request wallTime when available. These are estimates, not a globally causal clock or drift-compensated distributed tracing system.

Legacy v1 files are left untouched. trace_list labels them; v2 queries reject them. Use version 0.3.x if you need its old reader.

## Raw data

Incremental storage is **not redaction**. Initial snapshots and deltas can contain passwords, tokens, cookies, input values and personal information. Default rrweb masking/blocking conventions are disabled intentionally. Store traces locally and do not commit or share real captures.

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run test:real-run
```

Integration tests use a separate headless Chromium browser controlled by Playwright. The production recorder does not launch a browser. Build bundles the browser-side recorder locally; no CDN scripts are loaded.
