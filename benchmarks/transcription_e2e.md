# E2E transcription accuracy benchmark

| fixture | pitch acc | octaveOff | miss/extra | onset F1@150ms | med err ms | axis err ms | accomp F1 (tp/fp/fn) | accomp npF1 (P/R) | tempo (ratio) | meter (ok) | s | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| waltz-3-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 3/4 (True) | 5.3 |  |
| eighths-6-8 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 143.0 (1.0) | 6/8 (True) | 5.5 |  |
| sustained-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.9 |  |
| legato-scale-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | hard case: legato transitions without silence gaps |
| triplets-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.4 | eighth-note triplets — triplet-region detection |
| sixteenths-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.2 | 16th-note run — min-duration boundary |
| pickup-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.3 | anacrusis — pickup-beat detection |
| rests-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.6 | note/rest alternation — merge discipline |
| swing-4-4 | 1.0 | 0 | 0/0 | 1.0 | 19.0 | 19.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.9 | swung eighths — swingFeel vs triplet grid |
| mixed-divisions-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.5 | q + 8th + triplets + 16ths mixed — realistic rhythm |
| dyads-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.7 | third dyads — chord texture voice tracking |
| jpop-mix-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.6774 (63/3/57) | 0.7049 (0.652/0.768) | 128.0 (1.0) | 4/4 (True) | 9.3 | 4-layer mix, no separation — lead survival baseline |
| jpop-mix-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.6774 (63/3/57) | 0.7049 (0.652/0.768) | 128.0 (1.0) | 4/4 (True) | 7.1 | same mix + vocalIsolation — center-extraction payoff |
| jpop-mix-hard-raw | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.8052 (124/0/60) | 0.8689 (0.855/0.883) | 128.0 (1.0) | 4/4 (True) | 11.4 | hard mix without separation — contrast row |
| jpop-mix-hard-vocal | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.8052 (124/0/60) | 0.8689 (0.855/0.883) | 128.0 (1.0) | 4/4 (True) | 7.5 | vibrato lead + same-octave strum — the hard JPOP case |
| auto-4-4-96 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 96.25 (1.003) | 4/4 (True) | 6.1 | unhinted: meter + tempo estimated |
| auto-3-4-132 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 132.19 (1.001) | 3/4 (True) | 5.2 | unhinted waltz — triple-meter estimation |
| auto-6-8-143 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 142.87 (0.999) | 6/8 (True) | 5.6 | unhinted compound meter |
| tempo-step-4-4 | 1.0 | 0 | 0/0 | 1.0 | 21.5 | 21.5 | - | - | 130.78 (None) | 4/4 (True) | 5.2 | 100->140 mid-piece — tempo-map tracking (auto tempo) |
| rubato-4-4 | 1.0 | 0 | 0/0 | 0.5938 | 36.8 | 132.7 | - | - | 104.51 (None) | 4/4 (True) | 6.1 | continuous 120->90 ritardando — drift tracking (auto tempo) |
| reverb-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.6 | 350ms reverb tails — onset detection under ringing sustain |
| trill-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 6.2 | sixteenth-note M2 trill — ornament-rate pitch tracking |
| quiet-lead-mix | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.8091 (125/0/59) | 0.8816 (0.864/0.9) | 128.0 (1.0) | 4/4 (True) | 7.0 | lead under backing level — low-SNR vocal isolation |
| boundary-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.6 | first onset at t=0, last note clipped by EOF |
| noisy-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | 0.0 (0/0/1) | 0.0 (0.0/0.0) | 120.0 (1.0) | 4/4 (True) | 5.6 | broadband hiss bed — SNR robustness |
| octave-leaps-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.1 | real octave jumps — octave-repair regression guard |
| very-quiet-lead | 0.8947 | 1 | 3/3 | 0.8947 | 0.0 | 468.8 ! | 0.8129 (126/0/58) | 0.8537 (0.833/0.875) | 128.0 (1.0) | 4/4 (True) | 7.0 | ~-9.5 dB lead — free-stack SNR floor probe |
| detuned-horn-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 5.1 | +20c tuning drift — semitone assignment under detune |
| ornaments-4-4 | 1.0 | 0 | 0/0 | 1.0 | 0.0 | 0.0 | - | - | 120.0 (1.0) | 4/4 (True) | 4.8 | ~70 ms grace notes at the min-duration boundary |

axis err marked [ ! ] has a median index-aligned onset error above the 150 ms F1 window: the onset F1 on this row absorbed a systematic score-axis drift, so the axis fidelity is worse than the F1 suggests (#133).
