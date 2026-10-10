## Summary

Closes #383.

The キャンセル button during `phase === "running"` only closed the
dialog — the transactional `export_run` kept staging, kept rendering
through MuseScore, and committed artifacts to the destination seconds
later. Cancel meant 'hide the UI', not 'stop the work'.

### Design

- `ExportPort.export(request, signal?)` — an optional `AbortSignal`
  rides the request through the port seam.
- `TauriExportPort` mints a per-attempt `exportId`, passes it to
  `export_run`, and on abort calls the new `export_cancel` command.
  `EXPORT_CANCELLED` maps to the quiet abort path, never an error
  surface. Pre/post-invoke checkpoints cover the JS half.
- Rust keeps a `EXPORT_RUNS` registry (`exportId -> {cancelled flag,
  child slot}`). `export_run` checkpoints at every stage boundary —
  before staging writes, before each PDF render, and right before the
  commit loop. A cancel before commit returns `EXPORT_CANCELLED` and
  the staging dir is torn down with **zero** destination writes.
- The MuseScore child parks in the handle's slot: `export_cancel`
  takes + kills it, and `wait_render`'s 50 ms poll notices either the
  flag or the missing child. Once the commit loop starts it runs to
  completion — a half-committed set is worse than a finished one.
- `ExportDialog`: every submit gets a fresh `AbortController`; the
  キャンセル button, X and Esc all abort (unified semantics). A
  running-cancel lands back on the form; the collision prompt's
  cancel resolves the same way instead of silently closing.

### Tests

- `tauriPort.test.ts`: abort mid-run invokes `export_cancel` with the
  same `exportId` passed to `export_run`; pre-aborted signal rejects
  `EXPORT_CANCELLED` without touching the bridge.
- `export.rs`: pre-cancelled handle commits nothing;
  `export_cancel` on an unknown id is a no-op.
- `mockPort` honours the signal for browser dev.

29 export vitest / tsc / eslint green. Rust side is not locally
compile-verified (toolchain lacks the VC linker) — the code follows
the file's existing Mutex/command patterns.