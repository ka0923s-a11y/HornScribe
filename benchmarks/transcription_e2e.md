# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 3/4 (True) | 6.5 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 143.0 (1.0) | 6/8 (True) | 7.5 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 9.0 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 7.2 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 41.7 | 120.0 (1.0) | 4/4 (True) | 6.6 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 6.8 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 6.8 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 6.8 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 41.7 | 120.0 (1.0) | 4/4 (True) | 6.4 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 120.0 (1.0) | 4/4 (True) | 6.8 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | - | - | - | - | - | - | - | 7.5 | **job failed**: job failed: {'code': 'JOB_FAILED', 'message': 'canonical rests do not tile measure 2: gap/overlap at beat 2 (next element at 3/2)'} |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 13.7 | 95.7 (0.997) | 4/4 (True) | 6.4 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 0.375 | 123.4 | 129.2 (0.979) | 4/4 (False) | 6.5 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 0.9722 | 41.8 | 143.55 (1.004) | 4/4 (False) | 6.4 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 0.9375 | 56.2 | 99.38 (None) | 4/4 (True) | 6.7 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
