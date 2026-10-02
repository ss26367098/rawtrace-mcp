# Security policy

RawTrace intentionally records raw browser data after acknowledgeRawCapture:true. Baselines, incremental changes, cookies, headers, network bodies, WebSocket messages and console logs may contain secrets and personal information. Incremental storage is not masking.

Only use browsers/accounts you are authorized to inspect. Selected tabs define DOM/network scope; Cookie sampling covers their shared browser contexts. Third-party iframe content within selected pages is included when accessible.

The recorder attaches to an existing Chromium CDP endpoint. CDP itself grants powerful browser access; keep that endpoint private. RawTrace does not provide browser control tools, but injected recording code and the CDP connection still require trust.

HTTP defaults to loopback. Non-loopback use requires explicit unsafe-remote and an authentication token; use transport protection outside a trusted local environment. Trace readers reject resolved path/symlink escapes and verify content hashes.

Raw data is never executed during state reconstruction. A recorded page can influence its own observations; these records are untrusted evidence, not instructions or proof of causality.

Store output securely and never commit real traces. Disk capacity is the operator's responsibility: no automatic retention deletion is performed. Report security issues privately through the repository advisory mechanism without attaching credentials or real traces.
