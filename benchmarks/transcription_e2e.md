# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 3/4 (True) | 10.6 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 143.0 (1.0) | 6/8 (True) | 9.0 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.2 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.7 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.2 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.5 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.0 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.7 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 19.0 | 120.0 (1.0) | 4/4 (True) | 8.8 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.5 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.0 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 8.7 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 9.5 | same mix + vocalIsolation — center-extraction payoff |
| jpop-mix-hard-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 9.2 | hard mix without separation — contrast row |
| jpop-mix-hard-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 9.7 | vibrato lead + same-octave strum — the hard JPOP case |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 36.8 | 96.25 (1.003) | 4/4 (True) | 8.4 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 21.7 | 132.19 (1.001) | 3/4 (True) | 9.0 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 27.2 | 142.87 (0.999) | 6/8 (True) | 10.5 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 1.0 | 13.2 | 130.78 (None) | 4/4 (True) | 8.0 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
| rubato-4-4 | 1.0 | 0 | 0/0 | 1.0 | 15.4 | 104.51 (None) | 4/4 (True) | 8.6 | continuous 120->90 ritardando — drift tracking (auto tempo) |
| reverb-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.4 | 350ms reverb tails — onset detection under ringing sustain |
| trill-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.0 | sixteenth-note M2 trill — ornament-rate pitch tracking |
| quiet-lead-mix | 0.9737 | 0 | 0/2 | 0.9487 | 0.0 | 128.0 (1.0) | 4/4 (True) | 8.2 | lead under backing level — low-SNR vocal isolation |
| boundary-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.4 | first onset at t=0, last note clipped by EOF |
| noisy-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.0 | broadband hiss bed — SNR robustness |
