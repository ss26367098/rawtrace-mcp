---
name: rawtrace-debug-browser
description: Use RawTrace for continuous evidence capture when browser failures depend on transient DOM, network timing, WebSocket ordering, or authentication transitions. Requires an existing authorized Chromium CDP browser. Do not use for static edits, ordinary code reading, or simple web facts.
---

# Diagnose browser transitions with RawTrace

RawTrace 0.4 is a passive recorder with nine capture/query tools. Browser operation belongs to the user's existing controller; no browser action, screenshot, eval, credential-editing or tool-profile interface exists here.

## Capture an authorized reproduction

Use the CDP endpoint supplied by the user or established by their authorized development workflow. If it is unknown, obtain it from the controller setup; do not invent an endpoint or attach an unrelated browser.

1. Call capture_targets with cdpUrl and acknowledgeRawCapture:true; select the relevant real target IDs.
2. Call capture_start with the endpoint, targetIds and acknowledgeRawCapture:true before reproducing the issue. Retain sessionId and selected target IDs.
3. Reproduce through the existing browser controller or let the user reproduce manually. RawTrace does not capture that controller's action log; correlate only evidence actually recorded.
4. Stop with capture_stop when the intended observation is complete, unless the user requested continued recording.
5. Read trace_info and narrowly filtered trace_events. Use afterSeq/nextAfterSeq for pagination and searchBodies:true only when network body text is relevant.
6. Use trace_state with pageId equal to a selected targetId and either atSeq or atTime to compare recorded states. Inspect complete/gaps before drawing conclusions.
7. Read referenced large results with trace_artifact, following nextOffset until hasMore is false. Use base64 for byte-exact assembly.

For already authorized development/test capture, supply the required acknowledgment without asking for duplicate consent. Ask only when the actual target/account/data authorization is unclear. This workflow does not expand the authorization of other browser tools.

All capture categories default to enabled. Disable categories the user excludes; Cookie scope is the selected pages' shared browser contexts, not individual tabs. Incremental storage does not redact passwords, cookies, tokens or personal data.

## Read existing history and report evidence

trace_list discovers sessions under the configured output root after restart. Legacy v1 sessions are identifiable but cannot be queried through v2.

Report relevant event sequence IDs, state changes and uncertainty. A source timestamp is an estimate, not proof of causality. Frame baselines can be temporarily incomplete; cookies are sampled every second. Do not paste raw credentials, whole traces or unrelated private data into the response.

Do not change client approvals, publish traces, or use RawTrace for unrelated static tasks.
