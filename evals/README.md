# Proactive invocation evaluation

Use proactive-invocation.json to evaluate the locally built 0.4.0 plugin/Skill. Current npm marketplace pins intentionally remain on the published legacy 0.3.0 release until 0.4.0 is published.

For each positive case, supply an authorized local browser already exposing CDP and a separate controller. Start each trial in a fresh client session without naming RawTrace or its Skill. Repeat twice. Record actual tool selection and whether capture_targets/capture_start precede the externally controlled reproduction, followed by capture_stop and focused trace queries.

Acceptance target: at least 7 of 8 positive runs select RawTrace; none of 6 negative runs call it. A missing CDP endpoint should produce a setup clarification, not a fabricated endpoint. Treat the thresholds as evaluation targets, not measured results.

Check that the agent uses only the nine current tools, checks completeness and does not claim to possess an action log from the external controller. Keep raw data out of reports. Run separately for each client being evaluated.
