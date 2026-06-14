# Contributing

RawTrace MCP is raw-capture-first. Changes must preserve raw observability unless an option explicitly says otherwise.

Before opening a pull request:

```sh
npm run typecheck
npm run lint
npm test
```

Guidelines:

- Do not add default redaction, masking, or silent omission of cookies, headers, bodies, DOM text, or tokens.
- Keep MCP tool responses compact. Raw streams belong on disk and should be read through chunked APIs.
- Treat trace schema changes as public interface changes. Breaking schema changes require a major schema version bump.
- Keep HTTP defaults local-first and safe by default.
- Never include real trace bundles, credentials, or session data in tests or fixtures.
