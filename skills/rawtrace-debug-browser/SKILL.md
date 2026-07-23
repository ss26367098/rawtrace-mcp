---
name: rawtrace-debug-browser
description: Use RawTrace proactively to debug flaky or timing-sensitive browser behavior, including intermittent Playwright or Cypress failures, clicks with no request or unclear result, transient or asynchronous DOM changes, API timing, WebSocket ordering, downloads, authentication redirects, or cases where snapshots are insufficient. Do not use for static CSS edits, ordinary source summaries, or simple web fact lookup.
---

# Debug Browser with RawTrace

Use RawTrace to capture evidence that a normal post-action snapshot misses. Follow the workflow below regardless of the client-added MCP namespace; match tools by their final RawTrace tool name.

## Decide whether RawTrace applies

Use this skill when the problem depends on browser event ordering or a state transition that is intermittent, transient, or unexplained. Typical signals include:

- A Playwright or Cypress action sometimes fails, passes only with sleeps, or produces different results across runs.
- A click appears to do nothing, sends no expected request, navigates unexpectedly, or has an unclear result.
- DOM content appears and disappears between snapshots, or asynchronous rendering changes the target.
- API requests, redirects, WebSocket messages, downloads, authentication callbacks, or response bodies occur in the wrong order.
- A regular browser snapshot cannot show why the behavior happened.

Do not invoke RawTrace for static styling changes, ordinary code reading or summarization, deterministic unit-test failures with no browser timing component, or simple webpage fact lookup.

## Confirm authorization and sensitivity

RawTrace can record raw DOM text, form values, headers, cookies, request and response bodies, WebSocket frames, screenshots, and tokens.

- For an explicitly authorized development or test environment, pass `acknowledgeRawCapture: true` directly when a RawTrace tool requires it. Do not ask for an additional RawTrace-specific confirmation.
- If the target system, account, environment, or data authorization is unclear, ask before capturing raw data.
- Client approval prompts still apply. Never bypass client security settings.
- Do not print whole traces, paste raw secrets into the answer, or commit trace directories or ZIP bundles.

## Choose the smallest useful workflow

### One uncertain interaction

Prefer `browser_observe_action_result` for one click, type, press, check, select, hover, scroll, reload, or navigation whose result is unclear. It combines before and after state, DOM, network, and optional screenshot evidence. In an explicitly authorized development or test environment, include `acknowledgeRawCapture: true` in this call.

Use `browser_wait_for_response` when only response timing or metadata matters. Use `browser_wait_for_response_body` only when the body of one expected response is directly relevant.

### Multi-step or intermittent behavior

1. Launch or attach to the authorized browser and navigate to the reproduction start state.
2. Call `monitor_start` before the first meaningful step. For ordinary DOM and network tracing, explicitly use:

   ```json
   {
     "acknowledgeRawCapture": true,
     "captureCookies": false,
     "captureBodies": false
   }
   ```

3. Enable `captureCookies` only for a cookie-specific authentication problem. Enable `captureBodies` only when request or response content is needed. Keep both disabled otherwise.
4. Reproduce the complete issue using RawTrace browser actions so action, DOM, network, console, frame, download, and WebSocket timing stays correlated.
5. Call `monitor_stop` immediately after the relevant outcome to flush the trace and avoid unrelated noise.
6. Read `monitor_get_summary` first.
7. Use `monitor_search_events` for a targeted endpoint, DOM text, event type, redirect, sequence, or WebSocket question. Use `monitor_search_bodies` only when body capture was necessary.
8. Use `monitor_read_artifact` only for one artifact already identified by the summary or search. In a full tool profile, do not start by bulk-reading raw events or manifests.
9. Use `monitor_export` only when an authorized handoff explicitly needs a trace bundle.

## Report the diagnosis

State the observed sequence and the smallest evidence that supports it: the action, DOM transition, request or response, redirect, WebSocket message, console event, or download boundary. Distinguish direct evidence from inference. Mention which capture options were enabled when that affects confidence, but omit raw credentials and unrelated private data.

If RawTrace cannot reproduce the problem, report what was exercised, which event streams were observed, and the remaining uncertainty instead of dumping the trace.
