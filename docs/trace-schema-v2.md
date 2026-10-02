# RawTrace trace schema 2.0.0

This is a breaking format replacing v1. Existing v1 bundles are never rewritten.

## Layout

```text
trace_<epoch>_<suffix>/
  manifest.json
  index.json
  events/00000001.ndjson
  events/00000002.ndjson
  artifacts/<sha256>
```

manifest contains version, status, start/stop times, reason, explicitly selected targets and context IDs, capture options, counters, gap count, recorder version and Cookie scope.

Each newline-terminated record has sessionId, seq, receivedAt, time, source, type and data. Where applicable it also has pageId, frameId, documentId, contextId, sourceSeq, sourceTime and clock. time is sourceTime + clock.offsetMs, or receivedAt when there is no source clock. seq is assigned by the writer, not a causal ordering across independent sources.

DOM documentId identifies the page recording chain. rrweb aggregates child documents into that chain: serialized Document/root node IDs identify nested documents. Frame lifecycle events additionally identify frames/documents independently; these IDs are not interchangeable with rrweb node IDs. Network frameId/loaderId values originate in CDP; connectionId namespaces CDP request IDs. Request hops distinguish redirects.

## DOM

baseline/checkpoint data contains a serialized node tree, URL, viewport and initial scroll offset. Nodes carry numeric IDs, node type, attributes, text, children and shadow-root metadata. The baseline payload is stored by artifact reference.

delta data uses the pinned recorder's mutation/input/scroll/viewport representation internally. Reconstruction provides the public tree/text interface; clients do not need to apply recorder events themselves. Adds contain newly serialized subtrees and parent/next sibling IDs; removes contain IDs; texts and attributes contain changes. Text changes store a whole replacement text node, not a character diff.

Checkpoints reset the replay mirror for their page chain. Cross-origin iframe snapshots follow asynchronously as document attachments. Missing iframe documents are reported by trace_state. A document navigation establishes a new baseline. Checkpoints and later deltas never recreate states preceding a recorded gap.

Input properties are exposed under node.state after updates; baseline attributes and state are preserved. Tree output is a serialized observation, not a live browser DOM. CSSOM, rendering, script execution and external resources are excluded.

## Other streams

- network: request/response/extra-info/finished/failed/unfinished events. CDP fields are preserved once; body bytes use content-addressed references. Body failures and limits are explicit.
- websocket: connection, handshake, message and close events. Every message event is retained even if its bytes deduplicate.
- cookies: initial context baseline, then removed cookie keys and upserted cookies. Identity includes name/domain/path/partitionKey. Sampling interval is 1000 ms.
- console: text, level, location and page errors.
- frames: attach/navigation/detach and parent association.
- system: collector, sequence, buffer and cleanup gaps.

## Artifacts and querying

Reference: {path: "artifacts/<sha256>", sha256, byteLength}. Baselines and large event payloads use {artifact: reference}; network bodies and WebSocket payloads also use references. Attachment publication precedes event publication.

trace_artifact validates path containment, resolved symlinks, byte size and SHA-256. It accepts only hashed artifact paths, not arbitrary filenames. Byte-range reads have a 32 KB maximum, reduced to 8 KB for UTF-8 to bound JSON escaping. Large query output can itself become a JSON artifact.

Filters use afterSeq as an exclusive cursor; untilSeq is inclusive. Time endpoints are inclusive. New live events can arrive with source times earlier than previous events, so pagination should use seq. DOM textual searches expand externalized DOM data. Network body expansion is opt-in.

trace_state starts at the most recent applicable DOM checkpoint and applies deltas without executing scripts. Cookie state is reconstructed independently from its context baseline. complete=false indicates observed gaps or missing iframe documents; it is not a guarantee that inaccessible browser internals were captured.

## Recovery and resource bounds

Event files rotate at 64 MiB. index.json is a bounded recent cache (128 segments, 512 checkpoints); readers derive a full index from event logs, so missing/stale/corrupt index caches do not invalidate history. Writer memory does not retain all historical events. Query-time index memory scales with segment/checkpoint count and reconstructed DOM size.

Atomic replacement is used for manifest/index/artifacts. NDJSON lines are appended serially. An incomplete final line is excluded with a diagnostic. An invalid complete line or broken sequence is corruption, not silently skipped. A persisted running manifest opened without its live writer is reported interrupted.

Browser queue budget: 8 MiB; writer queue: 32 MiB. More than 256 pending collector operations or 4096 pending requests terminates capture with a reason. No retention deletion or total size cap is implemented. Per-body limits still apply. A disk failure may prevent final metadata publication; recovery reports the unfinalized session.

Stop attempts to flush frame recorders, Cookie differences, in-flight work and files before releasing its CDP connection. The full cleanup deadline is 10 seconds; timed-out work marks the session failed and initiates best-effort disconnect/metadata publication. A blocked filesystem cannot guarantee final publication within that deadline. External browser ownership always remains with the controller.
