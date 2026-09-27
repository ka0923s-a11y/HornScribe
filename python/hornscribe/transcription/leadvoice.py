"""Lead-voice (monophonic) f0 -> note segmentation (#421).

The frames_to_note_events run-grouping heuristic decodes continuous
f0 by rounding each frame to a semitone and grouping equal pitches. That
splits a J-POP vocal line exactly where it hurts: strong vibrato
(+-0.6 st) flips the rounded pitch at the excursion peaks, and a
portamento between real notes becomes a staircase of micro-notes.

This module decodes the same frame triples with a Viterbi/DP pitch
track instead: the optimal piecewise-constant MIDI path minimizing

    sum over frames: prob_weight * (f0_midi - state)^2
    + jump_cost * (number of state changes)

so a state switch must *pay* for itself through sustained quantization
error — a two-frame vibrato dip can never beat riding the centre pitch,
while a genuine step to a new note wins immediately.

The decoder returns frame-index runs (same shape as the run-grouper's
output) so onset splits, minimum-length filtering and note emission stay
shared with the heuristic path — one emit stage, two segmenters.
"""

from __future__ import annotations

import math
from typing import Any

#: Default barrier a state change must overcome, in semitones^2 of
#: accumulated quantization error. ~2.5 means a half-semitone-wrong
#: state must hold for 10+ frames before switching wins; a full wrong
#: semitone wins in 3 frames. Tuned against synthetic vibrato/glide
#: fixtures in tests/python/test_backend.py.
DEFAULT_JUMP_COST = 2.5

#: Probability floor — very-low-confidence frames still vote a little so
#: the track does not freeze mid-phrase, but their error counts less.
MIN_PROB_WEIGHT = 0.25


def _viterbi_pitch_path(
    midis: list[float],
    probs: list[float],
    *,
    jump_cost: float,
) -> list[int]:
    """Optimal piecewise-constant integer-MIDI track over one voiced block.

    O(N * S) with the constant-jump trick: for state s the best
    predecessor is min(dp[s], min(dp) + jump_cost) — stay, or jump from
    wherever the global best is. Equal-cost ties prefer staying (the
    <= on the stay branch), which keeps vibrato glued.
    """
    n = len(midis)
    if n == 0:
        return []
    lo = math.floor(min(midis)) - 1
    hi = math.ceil(max(midis)) + 1
    states = list(range(lo, hi + 1))
    size = len(states)

    def emission(i: int, s: int) -> float:
        w = probs[i]
        if math.isnan(w):
            w = 1.0
        w = max(MIN_PROB_WEIGHT, w)
        d = midis[i] - s
        return w * d * d

    dp = [emission(0, s) for s in states]
    backptr: list[list[int]] = []
    for i in range(1, n):
        emit = [emission(i, s) for s in states]
        best_any = min(dp)
        best_idx = dp.index(best_any)
        jump_val = best_any + jump_cost
        next_dp = [0.0] * size
        ptr = [0] * size
        for si in range(size):
            if dp[si] <= jump_val:
                next_dp[si] = dp[si] + emit[si]
                ptr[si] = si
            else:
                next_dp[si] = jump_val + emit[si]
                ptr[si] = best_idx
        dp = next_dp
        backptr.append(ptr)
    # Traceback from the cheapest terminal state.
    cur = dp.index(min(dp))
    path = [cur]
    for ptr in reversed(backptr):
        cur = ptr[cur]
        path.append(cur)
    path.reverse()
    return [states[p] for p in path]


def decode_lead_voice(
    f0_hz: Any,
    times_sec: Any,
    voiced_flag: Any,
    voiced_prob: Any,
    *,
    jump_cost: float = DEFAULT_JUMP_COST,
) -> list[tuple[list[int], int]]:
    """Continuous f0 frames -> (frame-index run, decoded MIDI state) pairs.

    Mirrors the heuristic path's contract: returns runs of frame indices
    covering voiced frames (single-frame dropouts bridged inside the
    block), each run paired with the decoded integer-MIDI state so the
    emit stage voices the DP's chosen pitch — re-quantizing the median
    would re-decide a borderline the DP already resolved (a symmetric
    +-0.6 st vibrato around 60 has median 60.6 -> would round UP to the
    wrong note). Unvoiced gaps longer than one frame are hard phrase
    boundaries — a vocal breath is never bridged by the pitch track.
    """
    f0 = [float(x) for x in f0_hz]
    voiced = [bool(x) for x in voiced_flag]
    prob = [float(x) for x in voiced_prob]
    n = len(f0)

    def to_midi(hz: float) -> float:
        return 69.0 + 12.0 * math.log2(hz / 440.0)

    # Voiced blocks separated by >1 unvoiced/NaN frame. Blocks keep
    # GLOBAL frame indices so the emit stage can read times/f0 directly.
    blocks: list[list[int]] = []
    cur: list[int] = []
    gap = 0
    for i in range(n):
        ok = voiced[i] and not math.isnan(f0[i]) and f0[i] > 0
        if ok:
            if gap > 1:
                # A real break — close the block at the last voiced frame.
                if cur:
                    blocks.append(cur)
                cur = []
            gap = 0
            cur.append(i)
        else:
            gap += 1
            if gap == 1:
                # Single dropout: reserve the slot — a same-state
                # continuation may bridge it in the emit stage.
                cur.append(i)
    if cur:
        blocks.append(cur)

    runs: list[tuple[list[int], int]] = []
    for block in blocks:
        # Drop trailing unvoiced frames (block ended on a dropout slot).
        while block and (not voiced[block[-1]] or math.isnan(f0[block[-1]])):
            block.pop()
        if not block:
            continue
        # Decode over the voiced frames only; dropout slots ride along.
        voiced_idx = [i for i in block if voiced[i] and f0[i] > 0]
        midis = [to_midi(f0[i]) for i in voiced_idx]
        probs = [prob[i] for i in voiced_idx]
        path = _viterbi_pitch_path(midis, probs, jump_cost=jump_cost)
        # Constant-state runs, mapped back to global frame indices.
        seg: list[int] = [voiced_idx[0]]
        prev_state = path[0]
        for k in range(1, len(voiced_idx)):
            gi = voiced_idx[k]
            if path[k] == prev_state:
                # Same state — absorb any dropout slot between the last
                # voiced frame and this one (gi - seg[-1] - 1 in {0,1}).
                for g in range(seg[-1] + 1, gi):
                    seg.append(g)
                seg.append(gi)
            else:
                runs.append((seg, prev_state))
                seg = [gi]
                prev_state = path[k]
        runs.append((seg, prev_state))
    return runs
