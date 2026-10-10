## Summary

Vocal isolation (#187) produces a monophonic vocal estimate, but the backend resolution stayed `auto → basicPitch` — the polyphonic model ran on a single-voice input. pYIN (#175) is the tracker built for exactly this case (sung/single-line).

- `resolved_pyin` now also resolves pYIN when `vocalIsolation` produced an isolated WAV — for single-line textures (auto/mono/melody). voices/chords keep the polyphonic model (the user asked for every detected line); an explicit backend pin still wins.
- The isolated-vocal staging block moved ahead of backend resolution so `vocal_path` is known when `resolved_pyin` is decided.
- `monophonic_backend` review issue no longer fires when pYIN ran on an isolated vocal under a single-line texture (the one-line result is intentional); it still fires for voices/chords.

## Verification

- `pytest tests/python -q` — 825 passed (3 new backend-resolution tests)
- `ruff`, `mypy` — clean

Closes #316.
