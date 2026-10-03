# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 3/4 (True) | 10.9 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 143.0 (1.0) | 6/8 (True) | 11.1 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 12.5 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.1 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.6 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.5 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.8 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 12.1 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 19.0 | 120.0 (1.0) | 4/4 (True) | 11.6 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.6 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 12.6 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 11.7 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 12.1 | same mix + vocalIsolation — center-extraction payoff |
| jpop-mix-hard-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 10.8 | hard mix without separation — contrast row |
| jpop-mix-hard-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 11.9 | vibrato lead + same-octave strum — the hard JPOP case |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 36.8 | 96.25 (1.003) | 4/4 (True) | 11.1 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 21.7 | 132.19 (1.001) | 3/4 (True) | 11.4 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 27.2 | 142.87 (0.999) | 6/8 (True) | 13.0 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 1.0 | 13.2 | 130.78 (None) | 4/4 (True) | 11.0 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
| rubato-4-4 | 1.0 | 0 | 0/0 | 1.0 | 15.4 | 104.51 (None) | 4/4 (True) | 14.6 | continuous 120->90 ritardando — drift tracking (auto tempo) |
| reverb-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 12.6 | 350ms reverb tails — onset detection under ringing sustain |
| trill-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 12.7 | sixteenth-note M2 trill — ornament-rate pitch tracking |
| quiet-lead-mix | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 13.8 | lead under backing level — low-SNR vocal isolation |
| boundary-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 13.3 | first onset at t=0, last note clipped by EOF |
| noisy-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 14.0 | broadband hiss bed — SNR robustness |
