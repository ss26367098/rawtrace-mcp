# Contributing

RawTrace 0.4 is a passive recorder. Do not reintroduce browser control, credential editing, arbitrary eval, visual replay, or default redaction.

Keep connection, capture, session storage, reconstruction and MCP interfaces separate. Browser scripts are bundled locally. Do not load recorder code from a CDN.

Keep raw payloads in trace artifacts, not oversized MCP responses. Treat trace schema changes as public interface changes. Keep v1 documentation for historical readers; never rewrite real trace data during migrations.

Before submitting changes run npm run typecheck, npm run lint, npm test and npm run test:real-run. Use local synthetic fixtures and an independently controlled browser. Never include real credentials or traces in tests.

Production code never starts, navigates or closes external pages. Cleanup must release only this recorder's hooks and CDP connection. Test iframe checkouts, sequence gaps, restart recovery and bounded queues when changing capture behavior.
