# Security Policy

RawTrace MCP intentionally captures raw browser data. Trace output may include cookies, bearer tokens, CSRF tokens, request bodies, response bodies, personal data, hidden form values, WebSocket frames, and local application secrets exposed to the browser.

Use RawTrace only on systems, accounts, and data you are authorized to inspect. Do not use it for credential theft, session hijacking, bypassing access controls, or monitoring third-party users without permission.

`browser_eval` executes arbitrary JavaScript in the target page with full page privileges. If eval times out, RawTrace closes the affected page to recover because browser-side JavaScript cannot be safely canceled in place.

Credential/state tools can read or modify cookies, localStorage, sessionStorage, and Playwright storageState files. Applying storageState clears existing cookies, localStorage, and IndexedDB before setting the new state. CDP-connected browsers and explicit `userDataDir` profiles require `acknowledgeStorageStateOverwrite: true` before storageState import. These tools require explicit per-call acknowledgments, but the returned data and artifacts are still raw secrets.

Do not commit trace bundles to GitHub. The default `.gitignore` excludes common RawTrace output directories, but users are responsible for handling trace artifacts safely.

## Reporting Security Issues

Please report security issues privately through the repository security advisory flow when available. Do not include raw trace bundles, tokens, cookies, or credentials in public issues.
