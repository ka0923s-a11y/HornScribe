# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 3/4 (True) | 9.7 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 143.0 (1.0) | 6/8 (True) | 8.7 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.4 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 10.5 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.0 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.8 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.0 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 8.2 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 0.9375 | 41.7 | 120.0 (1.0) | 4/4 (True) | 9.4 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.1 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.8 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 9.6 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 128.0 (1.0) | 4/4 (True) | 10.6 | same mix + vocalIsolation — center-extraction payoff |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 36.8 | 96.25 (1.003) | 4/4 (True) | 8.7 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 21.7 | 132.19 (1.001) | 3/4 (True) | 8.2 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 22.2 | 142.87 (0.999) | 6/8 (True) | 9.2 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 1.0 | 13.2 | 130.78 (None) | 4/4 (True) | 8.8 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
