# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 3/4 (True) | 7.8 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 143.0 (1.0) | 6/8 (True) | 7.7 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.4 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.4 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.4 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.2 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 6.8 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.6 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 19.0 | 120.0 (1.0) | 4/4 (True) | 8.0 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.8 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.8 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 8.3 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 8.1 | same mix + vocalIsolation — center-extraction payoff |
| jpop-mix-hard-raw | 0.9474 | 0 | 0/0 | 0.9737 | 0.0 | 128.0 (1.0) | 4/4 (True) | 8.3 | hard mix without separation — contrast row |
| jpop-mix-hard-vocal | 0.9474 | 0 | 0/0 | 0.9737 | 0.0 | 128.0 (1.0) | 4/4 (True) | 7.5 | vibrato lead + same-octave strum — the hard JPOP case |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 36.8 | 96.25 (1.003) | 4/4 (True) | 6.9 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 21.7 | 132.19 (1.001) | 3/4 (True) | 8.4 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 22.2 | 142.87 (0.999) | 6/8 (True) | 6.7 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 1.0 | 13.2 | 130.78 (None) | 4/4 (True) | 7.1 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
