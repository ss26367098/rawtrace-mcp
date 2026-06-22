# RawTrace Trace Schema v1.0.0

Trace schema `1.0.0` is a stable public interface for RawTrace MCP v1.

## Layout

```text
trace_<timestamp>_<suffix>/
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

## Manifest

`manifest.json` contains:

- `traceSchemaVersion`: always `"1.0.0"` for this schema.
- `sessionId`: trace session identifier.
- `createdAt` and `stoppedAt`.
- `captureOptions`: requested capture flags.
- `eventCounts`: counts by stream.
- `streams`: fixed stream list.

## Common Event Fields

Every event includes:

```json
{
  "sessionId": "trace_...",
  "seq": 42,
  "source": "dom",
  "type": "childList",
  "timeOrigin": 1718340000000,
  "t": 93.42,
  "wallTime": "2026-06-14T06:45:00.093Z",
  "pageUrl": "https://example.com/path"
}
```

`seq` is globally increasing within one trace. `t` is monotonic milliseconds since `monitor_start`.

Recorder payloads are not allowed to overwrite common event fields. If a raw payload contains reserved keys such as `t`, `source`, `type`, or `pageUrl`, RawTrace preserves them under `payloadReservedFields`.

## Streams

- `actions`: MCP/browser actions and timing.
- `dom`: DOM mutations, input/change events, scroll, hash/history changes. Large DOM text or HTML fields may be stored by reference.
- `network`: CDP request, response, header, loading, body-reference, and body-skip metadata events.
- `cookies`: initial/final cookie snapshots and action-time diffs.
- `websocket`: WebSocket creation, frames, and close events.
- `console`: console and page error events.
- `frames`: frame attach, detach, and navigation events.

## Body References

Request and response bodies are written to `bodies/`. Events reference them as:

```json
{
  "bodyRef": {
    "path": "bodies/res_000001.bin",
    "byteLength": 1234,
    "sha256": "hex...",
    "encoding": "utf8"
  }
}
```

Raw payloads are not redacted by default.

Large DOM payloads use the same reference shape. For example, a DOM node summary may contain `htmlRef` or `textRef` instead of inline `outerHTML` or `text` when the field is large:

```json
{
  "source": "dom",
  "type": "childList",
  "addedNodes": [
    {
      "tagName": "DIV",
      "path": "html > body > div",
      "htmlRef": {
        "path": "bodies/dom_html_000001.bin",
        "byteLength": 9000,
        "sha256": "hex...",
        "encoding": "utf8"
      }
    }
  ]
}
```

If `maxBodyBytes` prevents a request or response body from being captured, RawTrace records explicit `bodySkipped`, `bodySkippedReason`, and size metadata on the network event. This is a resource protection setting, not a redaction mechanism.

## Inspection Artifacts

Current-page inspection and raw body tools such as `browser_get_dom`, `browser_snapshot`, `browser_screenshot`, `browser_screenshot_annotated`, `browser_eval`, `browser_observe_action_result`, `browser_wait_for_response_body`, downloads, and storageState export may also write raw artifacts to `bodies/` when a monitor is running. They use the same reference shape as `bodyRef`, for example:

```json
{
  "ref": {
    "path": "bodies/dom_html_000004.html",
    "byteLength": 42000,
    "sha256": "hex...",
    "encoding": "utf8"
  }
}
```

When no monitor is running, inspection artifacts are stored under `rawtrace-traces/inspections/` and are not part of a trace schema bundle.

`monitor_read_artifact` reads only files inside a trace session directory. It does not add new event stream fields; it exposes already-written `bodyRef`, `htmlRef`, `textRef`, snapshot, or artifact content through MCP.

Inspection, snapshot, polling, before/after observation, eval, tab, dialog, credential, file, permission, geolocation, form, and browser action tools only write compact `actions` metadata while monitoring is active, such as tool start/end/error, selector, pageId, condition counts, byte length, and artifact references. They do not put full page HTML/text, screenshot bytes, large eval results, full response bodies, local file contents, or full storageState JSON into `actions.ndjson`.
