## Summary

Closes #365.

Desktop `parseProjectFile` used to do its own `schemaVersion === 1` +
projectId check in the webview, bypassing Python `migrate_project_dict` /
`HornScribeProject.from_dict` — a validation/migration source-of-truth split
that would dead-end the day schema v2 lands.

- New worker method **`project.open`**: `{path}` (worker reads the file,
  no bytes cross the webview) or `{documentBase64}` (File drops, autosave
  snapshots). Runs `json.loads` → `migrate_project_dict` →
  `HornScribeProject.from_dict` → returns `{path, project: to_dict()}`.
  Root extras (scoreDocument/musicXml/reviewIssues/meta) survive via
  `extras`, so a full document round-trips back to the desktop.
- `ImportController.openProject` routes through the new optional
  `ImportPorts.inspectProject` → `ShellSession.inspectProject` →
  `client.call("project.open")`. The lighter local parser remains only as
  the browser-dev / no-engine fallback.
- Errors map to `projectOpenFailed` (now carrying `path` since #364);
  `SOURCE_MISSING` flow is untouched.
- `protocol/PROTOCOL.md` documents the method; mock port + dev bridge
  implement it for browser dev.

## Tests

- `test_worker.py`: path-open (extras preserved), `documentBase64` mode,
  fail-closed cases (schemaVersion 99/"1", malformed ids, corrupt JSON,
  wrong suffix, missing file, garbage base64, empty payload), handshake
  advertises the method.
- `session.test.ts`: happy-path inspect + worker `INVALID_PARAMS` mapping.
- `controller.test.ts`: path-open never reads bytes in the webview,
  byte-open rides `documentBase64`, worker rejection → `projectOpenFailed`
  with the path attached.

89 pytest / 68 vitest / tsc / eslint / ruff / mypy all green.