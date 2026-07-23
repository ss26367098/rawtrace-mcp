# Proactive Invocation Evaluation

Use `proactive-invocation.json` to measure whether the installed plugin is selected without the user naming RawTrace, MCP, or `rawtrace-debug-browser`.

## Protocol

1. Install the 0.3.0 plugin and restart the client.
2. For each case, start a completely new Codex task or Claude Code session.
3. Submit the prompt exactly as written. Do not add hints about tracing tools.
4. Record whether the client calls a RawTrace tool before the user requests one by name.
5. Record the first RawTrace tool, whether the workflow follows the Skill, and whether cookie or body capture is enabled only when relevant.
6. Repeat every case once in another new session.

Codex acceptance is at least 7 proactive RawTrace selections across the 8 positive runs and no RawTrace calls across the 6 negative runs. Run the same cases on the separately installed Claude Code client and validate the checkout with `claude plugin validate . --strict` before recording cross-client acceptance.

Do not treat a run as successful merely because the model mentions tracing. A positive run must actually select a RawTrace tool. A negative run fails if any RawTrace tool is called.
