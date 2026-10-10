## Summary

- `docs/RELEASE.md`: local-only release runbook (prereqs, verification gate, engine bundling, tauri NSIS build, portable-zip staging, tag + gh release upload, post-release checks).
- `DEVELOPMENT_PLAN.md` section 19 rewritten to record the no-GitHub-Actions policy; old CI-workflow line struck through and annotated.

## Why

GitHub Actions is banned for this project, so verification and packaging must run on a local maintainer machine. This runbook makes that flow explicit and repeatable.

## Test plan

- Docs-only; verified referenced paths exist (scripts/build_engine.py, src-tauri/tauri.bundled.json).

Ref #2
