/**
 * Review-audition A-B loop lifecycle (UI-050 follow-up).
 *
 * 元音源を再生 arms a loop on the issue's source range across every
 * loop-capable clock (score cursor clock + media transport). That loop is
 * REVIEW-OWNED: it must not leak into the user's own loop state, and it
 * must not survive issue navigation or review exit.
 *
 * The state object below tracks, per port:
 *   - saved:    the loop the user had before the review loop first armed
 *               (restored on release, so a pre-existing user loop comes
 *               back instead of being silently overwritten);
 *   - lastSet:  the range this module last wrote (read back after the
 *               port's own clamping, so comparisons stay honest);
 *   - released: ports the user took over mid-review (toggleLoop, a fresh
 *               waveform selection, ...). Once a port's loop no longer
 *               matches lastSet the user owns it - retarget/release leave
 *               it alone.
 *
 * Everything is plain functions over an immutable-ish state record so the
 * lifecycle is unit-testable without mounting the workspace.
 */

/** A loop range in seconds (media-transport units). */
export interface LoopRangeSec {
  readonly start: number;
  readonly end: number;
}

/** Anything that can hold an A-B loop, normalized to seconds. */
export interface LoopPort {
  loopRange(): LoopRangeSec | null;
  setLoop(range: LoopRangeSec | null): void;
}

export interface ReviewLoopState {
  readonly armed: boolean;
  readonly saved: ReadonlyArray<LoopRangeSec | null>;
  readonly lastSet: ReadonlyArray<LoopRangeSec | null>;
  readonly released: ReadonlySet<number>;
}

export function emptyReviewLoopState(): ReviewLoopState {
  return { armed: false, saved: [], lastSet: [], released: new Set() };
}

const EPS = 1e-6;

function sameRange(
  a: LoopRangeSec | null,
  b: LoopRangeSec | null,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a.start - b.start) < EPS && Math.abs(a.end - b.end) < EPS;
}

/** Indices of ports still managed by the review loop: not user-released
 *  and still showing the range we last wrote. Ports the user changed are
 *  marked released in the returned set so the caller can persist it. */
function managedPorts(
  state: ReviewLoopState,
  ports: readonly LoopPort[],
): { managed: number[]; released: Set<number> } {
  const managed: number[] = [];
  const released = new Set(state.released);
  for (let i = 0; i < ports.length; i += 1) {
    if (released.has(i)) continue;
    if (sameRange(ports[i].loopRange(), state.lastSet[i] ?? null)) {
      managed.push(i);
    } else {
      // The port no longer shows what we wrote - the user (or a load)
      // owns it now. Never touch it again this review.
      released.add(i);
    }
  }
  return { managed, released };
}

/** Arm (or re-arm) the review loop on 'range'. The first arm captures the
 *  user's existing loop per port; re-arms keep that original snapshot for
 *  ports we still manage, and re-capture it for ports the user took over
 *  (their latest own loop is what release should restore).
 *
 *  A port counts as managed only when the write actually took: read-back
 *  equals the requested range, or differs from what was there before
 *  (accepted with clamping). A rejected write leaves the user's loop
 *  showing - that port is released immediately so retarget/release never
 *  mistake the user's range for ours. */
export function armReviewLoop(
  state: ReviewLoopState,
  ports: readonly LoopPort[],
  range: LoopRangeSec,
): ReviewLoopState {
  const saved = ports.map((p, i) => {
    if (!state.armed) return p.loopRange();
    const userOwned =
      state.released.has(i) ||
      !sameRange(p.loopRange(), state.lastSet[i] ?? null);
    return userOwned ? p.loopRange() : (state.saved[i] ?? null);
  });
  const released = new Set<number>();
  const lastSet = ports.map((p, i) => {
    const before = p.loopRange();
    p.setLoop(range);
    const after = p.loopRange();
    if (after == null || (!sameRange(after, range) && sameRange(after, before))) {
      released.add(i);
    }
    return after;
  });
  return { armed: true, saved, lastSet, released };
}

/** Move the armed review loop to a new issue's range (issue navigation
 *  while auditioning). 'null' clears the loop for issues without a
 *  range - the state stays armed so the next ranged issue re-arms.
 *  Ports the user took over are left exactly as they are. */
export function retargetReviewLoop(
  state: ReviewLoopState,
  ports: readonly LoopPort[],
  range: LoopRangeSec | null,
): ReviewLoopState {
  if (!state.armed) return state;
  const { managed, released } = managedPorts(state, ports);
  const lastSet = state.lastSet.slice();
  for (const i of managed) {
    const before = ports[i].loopRange();
    ports[i].setLoop(range);
    const after = ports[i].loopRange();
    // The port stays managed while it shows our write (accepted, possibly
    // clamped) or our previous write (this one rejected). Only a drift to
    // 'nothing' mid-range hands ownership back to the user.
    if (after == null && range != null && before != null) {
      released.add(i);
    }
    lastSet[i] = after;
  }
  return { ...state, lastSet, released };
}

/** Review exit / unmount: restore each managed port to the loop the user
 *  had before the review loop armed (usually null, i.e. cleared). Ports
 *  the user took over keep their current loop. */
export function releaseReviewLoop(
  state: ReviewLoopState,
  ports: readonly LoopPort[],
): ReviewLoopState {
  if (!state.armed) return state;
  const { managed } = managedPorts(state, ports);
  for (const i of managed) {
    ports[i].setLoop(state.saved[i] ?? null);
  }
  return emptyReviewLoopState();
}
