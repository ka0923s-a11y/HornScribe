## playback.mid drops mid-piece tempo/meter changes (and can merge ties across parts)

The desktop MusicXML -> SMF builder (apps/desktop/src/export/midi.ts)
reads only the FIRST sound tempo element and the FIRST time signature:

- A tracked-tempo transcription emits one TempoSegment per changed
  measure boundary (rit./accel. survive in the score), but the MIDI
  export plays the whole piece at the head tempo — the exported
  playback.mid disagrees with the printed metronome marks.
- Mid-piece time-signature changes (meter_changes exist in the model
  and export as <time> attributes) are likewise dropped: only the head
  meter reaches the SMF meta track.
- openTies is keyed by pitch and shared across ALL parts; with
  multi-voice (texture=voices) scores a tied note in part 1 can merge
  with a same-pitch note in part 2 if their ticks line up. The map
  should reset per part.

### Fix

- Collect (tick, bpm) tempo marks during the measure walk — direction
  elements carry sound tempo children at their cursor position — and
  emit a set_tempo event per mark instead of a single tick-0 event.
- Collect (tick, n/d) meter changes from <attributes><time> and emit
  time_signature events at their ticks.
- Reset openTies per part.

### Tests

- Two-tempo fixture: set_tempo events at tick 0 and the change tick.
- Meter-change fixture: two time_signature events.
- Two-part fixture where part 1's tied pitch reappears untied in
  part 2: both notes present, no merge.
