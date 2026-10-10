## Export dialog can submit an empty format list

The 書き出し button is gated on anyChecked (any checkbox on), but the
formats actually sent filter out blocked options — PDF when MuseScore
is missing, 音源 when the audio path is unavailable. Checking only
blocked formats leaves the button enabled; submit then calls
port.export with formats: [] which the Tauri port resolves as a
successful zero-file export — a confusing "done" state with nothing
written.

### Fix

Compute the effective (checked AND unblocked) format list once, share
it between the button's disabled state and submit, and disable the
button when the list is empty.
