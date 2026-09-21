import { useCallback, useEffect, useRef, useState } from "react";
import { DURATION_SEC, LOOP_RANGE } from "./mockData";

export type FollowMode = "on" | "paused" | "off";

export interface MockPlayer {
  playing: boolean;
  positionSec: number;
  rate: number;
  loop: boolean;
  follow: FollowMode;
  play(): void;
  pause(): void;
  togglePlay(): void;
  stop(): void;
  seekTo(sec: number): void;
  seekBy(deltaSec: number): void;
  cycleRate(): void;
  toggleLoop(): void;
  /** Manual navigation while playing suspends follow (GUI_UX_SPEC §11). */
  suspendFollow(): void;
  resumeFollow(): void;
  setFollowOn(on: boolean): void;
}

const RATES = [0.75, 1, 1.25];
const TICK_MS = 100;

/**
 * Deterministic mock transport. Fixed tick, fixed rate steps, fixed loop
 * range — no audio backend. Follow state machine mirrors GUI_UX_SPEC §11:
 * ON → (manual scroll) → paused → [追従を再開] → ON.
 */
export function useMockPlayer(): MockPlayer {
  const [playing, setPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [follow, setFollow] = useState<FollowMode>("on");
  const posRef = useRef(positionSec);
  posRef.current = positionSec;

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setPositionSec((pos) => {
        let next = pos + (TICK_MS / 1000) * rate;
        if (loop && next >= LOOP_RANGE.endSec) next = LOOP_RANGE.startSec;
        if (next >= DURATION_SEC) {
          window.clearInterval(id);
          setPlaying(false);
          return DURATION_SEC;
        }
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, rate, loop]);

  const clamp = useCallback(
    (sec: number) => Math.min(DURATION_SEC, Math.max(0, sec)),
    [],
  );

  const play = useCallback(() => {
    setPositionSec((pos) => (pos >= DURATION_SEC ? 0 : pos));
    setPlaying(true);
  }, []);
  const pause = useCallback(() => setPlaying(false), []);
  const togglePlay = useCallback(
    () => (playing ? pause() : play()),
    [playing, pause, play],
  );
  const stop = useCallback(() => {
    setPlaying(false);
    setPositionSec(0);
  }, []);
  const seekTo = useCallback((sec: number) => setPositionSec(clamp(sec)), [clamp]);
  const seekBy = useCallback(
    (delta: number) => setPositionSec((pos) => clamp(pos + delta)),
    [clamp],
  );
  const cycleRate = useCallback(
    () => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length]),
    [],
  );
  const toggleLoop = useCallback(() => setLoop((v) => !v), []);
  const suspendFollow = useCallback(
    () => setFollow((f) => (f === "on" ? "paused" : f)),
    [],
  );
  const resumeFollow = useCallback(() => setFollow("on"), []);
  const setFollowOn = useCallback(
    (on: boolean) => setFollow(on ? "on" : "off"),
    [],
  );

  return {
    playing,
    positionSec,
    rate,
    loop,
    follow,
    play,
    pause,
    togglePlay,
    stop,
    seekTo,
    seekBy,
    cycleRate,
    toggleLoop,
    suspendFollow,
    resumeFollow,
    setFollowOn,
  };
}
