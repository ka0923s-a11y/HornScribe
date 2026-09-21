# apps/desktop — HornScribe desktop shell (UI-001 spike)

Tauri 2 + React 18 + TypeScript + Vite + Fluent UI v9.
UI言語は日本語のみ（`src/strings/ja.ts` に集約）。

## Frontend

```bash
npm install
npm run dev         # vite on :1420
npm run build       # → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

## Tauri shell

Requires a working native toolchain. On this spike machine the MSVC toolchain
cannot link (no VS C++ tools), so the GNU toolchain + llvm-mingw were used —
see `docs/UI_001_SPIKE_RESULTS.md` §3–4 for the exact environment and the
required `dlltool`/`libgcc` workaround before running:

```bash
npx tauri dev     # vite + cargo run + window
npx tauri build   # release exe + NSIS installer
```

Security baseline lives in `src-tauri/tauri.conf.json` (CSP) and
`src-tauri/capabilities/default.json` (narrow ACL — no fs/dialog/asset grants).
Do not widen either without a matching entry in the spike doc / ADR-0001 gate A.
