import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import {
  ArrowLeft24Regular,
  ArrowRight24Regular,
  ArrowUndo24Regular,
  Delete24Regular,
  Play24Regular,
} from "@fluentui/react-icons";
import { ja } from "../../strings/ja";
import {
  NOTES,
  buildIssues,
  type IssueStatus,
  type MockIssue,
  type MockNote,
  type PitchView,
} from "../mockData";
import { useMockPlayer } from "../useMockPlayer";
import { useProtoKeys } from "../useProtoKeys";
import { ProtoScore, SCORE_METRICS } from "../ProtoScore";
import { ProtoShell, type ProtoCommand } from "../ProtoChrome";

interface Edit {
  issueId: string;
  prevStatus: IssueStatus;
  noteId: string;
  prevMidi: number;
}

/**
 * P4 — 要確認 flow, keyboard-only (issue #31 + UX_VALIDATION Task F).
 * Five deterministic issues; every action is a real button (Tab/Enter) AND
 * has a dedicated shortcut shown in tooltips:
 *   ← → 前へ/次へ, R 元音源を再生, O 問題なし, Alt+↑↓ 半音,
 *   Delete 削除, Ctrl+Z 元に戻す, Esc 終了.
 */
export function ReviewPage() {
  const [pitch, setPitch] = useState<PitchView>("concert");
  const [notes, setNotes] = useState<MockNote[]>(() => NOTES.map((n) => ({ ...n })));
  const [issues, setIssues] = useState<MockIssue[]>(() => buildIssues());
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<string>(ja.status.ready);
  const [undoStack, setUndoStack] = useState<Edit[]>([]);
  const scoreRef = useRef<HTMLDivElement>(null);
  const player = useMockPlayer();
  const r = ja.prototype.review;
  const ps = ja.prototype.status;

  const issue = issues[cursor] ?? null;
  const issueNote = notes.find((n) => n.id === issue?.noteId) ?? null;
  const pendingCount = issues.filter((i) => i.status === "pending").length;
  const allDone = pendingCount === 0;
  const selectedId = issueNote?.id ?? null;

  /* Keep the focused issue's measure visible. */
  useEffect(() => {
    const el = scoreRef.current;
    if (!el || !issueNote) return;
    el.scrollTo({ top: SCORE_METRICS.systemTop(issueNote.measure) - 20 });
  }, [issueNote]);

  const goTo = useCallback(
    (delta: number) => {
      setCursor((c) => Math.min(issues.length - 1, Math.max(0, c + delta)));
    },
    [issues.length],
  );

  const mutateNote = useCallback((id: string, fn: (n: MockNote) => Partial<MockNote>) => {
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, ...fn(n) } : n)));
  }, []);

  const markIssue = useCallback(
    (next: IssueStatus, midiDelta = 0) => {
      if (!issue || !issueNote) return;
      setUndoStack((s) => [
        ...s,
        {
          issueId: issue.id,
          prevStatus: issue.status,
          noteId: issueNote.id,
          prevMidi: issueNote.midiConcert,
        },
      ]);
      setIssues((list) =>
        list.map((i) => (i.id === issue.id ? { ...i, status: next } : i)),
      );
      if (midiDelta !== 0) {
        mutateNote(issueNote.id, (n) => ({ midiConcert: n.midiConcert + midiDelta }));
        setStatus(ps.pitchFixed);
      } else if (next === "accepted") {
        setStatus(ps.issueResolved);
      } else if (next === "deleted") {
        mutateNote(issueNote.id, () => ({ deleted: true }));
        setStatus(ps.noteDeleted);
      }
    },
    [issue, issueNote, mutateNote, ps],
  );

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const last = stack[stack.length - 1];
      if (!last) {
        setStatus(ps.nothingToUndo);
        return stack;
      }
      setIssues((list) =>
        list.map((i) => (i.id === last.issueId ? { ...i, status: last.prevStatus } : i)),
      );
      mutateNote(last.noteId, () => ({ midiConcert: last.prevMidi, deleted: last.prevStatus === "deleted" }));
      setStatus(ps.undone);
      return stack.slice(0, -1);
    });
  }, [mutateNote, ps]);

  const playSource = useCallback(() => {
    if (!issueNote) return;
    player.seekTo(issueNote.onsetSec);
    player.play();
    setStatus(r.playingSource);
  }, [issueNote, player, r.playingSource]);

  const exit = useCallback(() => {
    window.location.hash = "#/prototype/score";
  }, []);

  const onCommand = useCallback(
    (id: ProtoCommand) => {
      if (id === "export") window.location.hash = "#/prototype/export";
      else if (id === "review") return;
      else if (id === "open") window.location.hash = "#/prototype/shell";
      else setStatus("プロトタイプではこの操作は省略しています");
    },
    [],
  );

  useProtoKeys(
    useMemo(
      () => [
        { combo: "ArrowLeft", run: () => goTo(-1) },
        { combo: "ArrowRight", run: () => goTo(1) },
        { combo: "r", run: playSource },
        { combo: "o", run: () => markIssue("accepted") },
        { combo: "Alt+ArrowUp", run: () => markIssue("fixed", 1) },
        { combo: "Alt+ArrowDown", run: () => markIssue("fixed", -1) },
        { combo: "Delete", run: () => markIssue("deleted") },
        { combo: "Backspace", run: () => markIssue("deleted") },
        { combo: "Ctrl+z", run: undo },
        { combo: "Escape", run: exit },
        { combo: "Space", run: player.togglePlay },
        { combo: "Ctrl+1", run: () => setPitch("concert") },
        { combo: "Ctrl+2", run: () => setPitch("hornF") },
      ],
      [goTo, playSource, markIssue, undo, exit, player.togglePlay],
    ),
  );

  const reason = issue ? r.reasons[issue.reason] : null;
  const statusLabel = issue ? r.status[issue.status] : null;

  return (
    <ProtoShell
      documentTitle={ja.prototype.shell.docTitle}
      state={{ hasAudio: true, hasScore: true, reviewCount: pendingCount }}
      pitch={pitch}
      onPitch={setPitch}
      onCommand={onCommand}
      player={player}
      transportEnabled
      status={status}
      banner={
        <div className="hs-proto-reviewbar" role="region" aria-label={r.title}>
          <div className="hs-proto-reviewbar__row">
            <span className="hs-proto-reviewbar__position">
              {allDone ? r.allDone : r.position(cursor + 1, issues.length)}
            </span>
            {!allDone && (
              <span className="hs-proto-reviewbar__confidence">
                {r.remaining(pendingCount)}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <Button size="small" onClick={exit}>
              {r.exit}
            </Button>
          </div>
          {!allDone && issue && reason && (
            <>
              <div className="hs-proto-reviewbar__row">
                <span className="hs-proto-reviewbar__reason">{reason.title}</span>
                <span className="hs-proto-reviewbar__detail">{reason.detail}</span>
                <span className="hs-proto-reviewbar__confidence">
                  {r.confidence(issue.confidence)}
                </span>
                <span className="hs-proto-reviewbar__status">{statusLabel}</span>
              </div>
              <div className="hs-proto-reviewbar__row">
                <Tooltip content={`${ja.prototype.common.prev}（←）`} relationship="label">
                  <Button
                    icon={<ArrowLeft24Regular />}
                    disabled={cursor === 0}
                    onClick={() => goTo(-1)}
                  >
                    {ja.prototype.common.prev}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.playSource}（R）`} relationship="label">
                  <Button icon={<Play24Regular />} onClick={playSource}>
                    {r.playSource}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.markOk}（O）`} relationship="label">
                  <Button appearance="primary" onClick={() => markIssue("accepted")}>
                    {r.markOk}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.fixPitch}（Alt+↑↓）`} relationship="label">
                  <Button onClick={() => markIssue("fixed", 1)}>
                    {ja.prototype.properties.actions.pitchUp}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.fixPitch}（Alt+↑↓）`} relationship="label">
                  <Button onClick={() => markIssue("fixed", -1)}>
                    {ja.prototype.properties.actions.pitchDown}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.deleteNote}（Delete）`} relationship="label">
                  <Button icon={<Delete24Regular />} onClick={() => markIssue("deleted")}>
                    {r.deleteNote}
                  </Button>
                </Tooltip>
                <Tooltip content={`${r.undo}（Ctrl+Z）`} relationship="label">
                  <Button
                    icon={<ArrowUndo24Regular />}
                    disabled={undoStack.length === 0}
                    onClick={undo}
                  >
                    {r.undo}
                  </Button>
                </Tooltip>
                <Tooltip content={`${ja.prototype.common.next}（→）`} relationship="label">
                  <Button
                    icon={<ArrowRight24Regular />}
                    iconPosition="after"
                    disabled={cursor >= issues.length - 1}
                    onClick={() => goTo(1)}
                  >
                    {ja.prototype.common.next}
                  </Button>
                </Tooltip>
              </div>
            </>
          )}
          <div className="hs-proto-reviewbar__row">
            <span className="hs-proto-reviewbar__hint">{r.hint}</span>
          </div>
        </div>
      }
    >
      <ProtoScore
        ref={scoreRef}
        notes={notes}
        pitch={pitch}
        selectedId={selectedId}
        onSelect={() => undefined /* review mode pins selection to the issue */}
        positionSec={player.playing ? player.positionSec : null}
        issues={issues.filter((i) => i.status === "pending")}
        focusedIssueId={issue?.id ?? null}
      />
    </ProtoShell>
  );
}
