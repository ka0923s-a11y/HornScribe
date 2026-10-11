# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | axis err ms | accomp F1 (tp/fp/fn) | accomp npF1 (P/R) | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 3/4 (True) | 5.1 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 143.0 (1.0) | 6/8 (True) | 5.1 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.9 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.7 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.9 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.9 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 19.0 | 19.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.0 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 1.0 (56/0/0) | 1.0 (1.0/1.0) | 128.0 (1.0) | 4/4 (True) | 8.9 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 1.0 (56/0/0) | 1.0 (1.0/1.0) | 128.0 (1.0) | 4/4 (True) | 5.6 | same mix + vocalIsolation — center-extraction payoff |
| jpop-mix-hard-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.9873 (117/0/3) | 0.9789 (0.991/0.967) | 128.0 (1.0) | 4/4 (True) | 9.2 | hard mix without separation — contrast row |
| jpop-mix-hard-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.9873 (117/0/3) | 0.9789 (0.991/0.967) | 128.0 (1.0) | 4/4 (True) | 6.6 | vibrato lead + same-octave strum — the hard JPOP case |
| jpop-pad8th-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.9887 (219/0/5) | 0.9887 (1.0/0.978) | 128.0 (1.0) | 4/4 (True) | 6.1 | #171: eighth-note pad ostinato — every strike is truth |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 96.25 (1.003) | 4/4 (True) | 4.7 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 132.19 (1.001) | 3/4 (True) | 5.0 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 142.87 (0.999) | 6/8 (True) | 5.0 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 0.9375 | 41.6 | 47.5 | - | - | 130.78 (None) | 5/4 (False) | 5.0 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
| rubato-4-4 | 1.0 | 0 | 0/0 | 0.5938 | 36.8 | 132.7 | - | - | 104.51 (None) | 4/4 (True) | 6.1 | continuous 120->90 ritardando — drift tracking (auto tempo) |
| reverb-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.3 | 350ms reverb tails — onset detection under ringing sustain |
| trill-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | sixteenth-note M2 trill — ornament-rate pitch tracking |
| quiet-lead-mix | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.9528 (111/2/9) | 0.9528 (0.982/0.925) | 128.0 (1.0) | 4/4 (True) | 5.8 | lead under backing level — low-SNR vocal isolation |
| boundary-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.9 | first onset at t=0, last note clipped by EOF |
| noisy-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 1.0 (0/0/0) | 0.0 (0.0/0.0) | 120.0 (1.0) | 4/4 (True) | 4.7 | broadband hiss bed — SNR robustness |
| octave-leaps-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | real octave jumps — octave-repair regression guard |
| very-quiet-lead | 0.8947 | 1 | 3/3 | 0.8947 | 0.0 | 0.0 | 0.9487 (111/3/9) | 0.9487 (0.974/0.925) | 128.0 (1.0) | 4/4 (True) | 5.8 | ~-9.5 dB lead — free-stack SNR floor probe |
| detuned-horn-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.7 | +20c tuning drift — semitone assignment under detune |
| ornaments-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.6 | ~70 ms grace notes at the min-duration boundary |

axis err marked [ ! ] has a median index-aligned onset error above the 150 ms F1 window: the onset F1 on this row absorbed a systematic score-axis drift, so the axis fidelity is worse than the F1 suggests (#133).
accomp onset F1 scores pitched accompaniment only — unpitched timbres (drum hits, hiss beds) are excluded from the truth because they are not scoreable notes; detections on them count as fp (#154).
