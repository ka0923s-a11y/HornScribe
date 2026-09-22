import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import { HsSheet } from "../components/primitives/Sheet";
import { StatusBadge, type StatusTone } from "../components/primitives/StatusBadge";
import { formatDiagnosticsText } from "./format";
import type { DiagnosticsPort } from "./port";
import type {
  DiagnosticsInfo,
  ToolInfo,
  ToolPathOverrides,
  WorkerStatus,
} from "./types";

function toolBadge(info: ToolInfo): { tone: StatusTone; label: string } {
  const s = ja.dependencies;
  return info.status === "found"
    ? { tone: "success", label: s.statusFound }
    : info.status === "missing"
      ? { tone: "error", label: s.statusMissing }
      : info.status === "checking"
        ? { tone: "info", label: s.statusChecking }
        : { tone: "neutral", label: ja.diagnostics.unknown };
}

function workerBadge(status: WorkerStatus): { tone: StatusTone; label: string } {
  const w = ja.diagnostics.workerStates;
  return status === "running"
    ? { tone: "success", label: w.running }
    : status === "stopped"
      ? { tone: "warning", label: w.stopped }
      : status === "unavailable"
        ? { tone: "error", label: w.unavailable }
        : { tone: "neutral", label: ja.diagnostics.unknown };
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="hs-diag__row">
      <span className="hs-diag__label">{label}</span>
      <span className="hs-diag__value">{children}</span>
    </div>
  );
}

function ToolRow({ label, info }: { label: string; info: ToolInfo }) {
  const badge = toolBadge(info);
  const detail = [info.version, info.path].filter(Boolean).join(" — ");
  return (
    <div className="hs-diag__row">
      <span className="hs-diag__label">{label}</span>
      <span className="hs-diag__value">
        <StatusBadge tone={badge.tone} label={badge.label} />
        {detail ? <span className="hs-diag__detail">{detail}</span> : null}
      </span>
    </div>
  );
}

/**
 * 診断情報 sheet (GUI_UX_SPEC §19) — separated from the normal UI, opened
 * from the command overflow menu or 設定 → 詳細設定. Shows versions, tool
 * status, cache/log paths and worker status, with the three spec actions:
 * 診断情報をコピー / ログフォルダを開く / エンジンを再起動.
 *
 * The sheet always renders: the port reports per-field null/"unknown"
 * when data is unavailable (no engine bridge), so diagnostics stays
 * honest instead of failing itself.
 */
export function DiagnosticsSheet({
  open,
  onOpenChange,
  port,
  toolOverrides,
  onAnnounce,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  port: DiagnosticsPort;
  toolOverrides?: ToolPathOverrides;
  onAnnounce(message: string): void;
}) {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [busy, setBusy] = useState<"copy" | "logs" | "restart" | null>(null);
  const generation = useRef(0);
  const d = ja.diagnostics;

  useEffect(() => {
    if (!open) return;
    const gen = ++generation.current;
    setInfo(null);
    let cancelled = false;
    void port
      .collect(toolOverrides)
      .then((data) => {
        if (cancelled || generation.current !== gen) return;
        setInfo(data);
      })
      .catch(() => {
        /* collect() is contractually non-rejecting; belt and braces */
      });
    return () => {
      cancelled = true;
    };
  }, [open, port, toolOverrides]);

  const copy = useCallback(async () => {
    if (!info) return;
    setBusy("copy");
    try {
      const ok = await port.copyText(formatDiagnosticsText(info));
      onAnnounce(ok ? d.copied : d.copyFailed);
    } finally {
      setBusy(null);
    }
  }, [info, port, onAnnounce, d]);

  const openLogs = useCallback(async () => {
    setBusy("logs");
    try {
      const ok = await port.openLogFolder();
      if (!ok) onAnnounce(d.openLogsFailed);
    } finally {
      setBusy(null);
    }
  }, [port, onAnnounce, d]);

  const restart = useCallback(async () => {
    setBusy("restart");
    try {
      const ok = await port.restartEngine();
      onAnnounce(ok ? d.restarted : d.restartFailed);
    } finally {
      setBusy(null);
    }
  }, [port, onAnnounce, d]);

  const f = d.fields;
  const wb = info ? workerBadge(info.workerStatus) : null;

  return (
    <HsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={d.title}
      size="medium"
      footer={
        <div className="hs-diag__actions">
          <HsButton
            variant="primary"
            disabled={!info || busy !== null}
            loading={busy === "copy"}
            onClick={() => void copy()}
          >
            {d.copy}
          </HsButton>
          <HsButton
            disabled={busy !== null}
            loading={busy === "logs"}
            onClick={() => void openLogs()}
          >
            {d.openLogs}
          </HsButton>
          <HsButton
            disabled={busy !== null}
            loading={busy === "restart"}
            onClick={() => void restart()}
          >
            {d.restartEngine}
          </HsButton>
        </div>
      }
    >
      {!info ? (
        <div className="hs-diag__loading" role="status">
          <Spinner size="small" />
          <span>{d.collecting}</span>
        </div>
      ) : (
        <div className="hs-diag">
          <section className="hs-diag__section" aria-label={d.groups.versions}>
            <Row label={f.appVersion}>
              {info.appVersion ?? d.notConnected}
            </Row>
            <Row label={f.engineVersion}>
              {info.engine
                ? `${info.engine.name} ${info.engine.version}`
                : d.notConnected}
            </Row>
            <Row label={f.protocolVersion}>
              {info.protocolVersion ?? d.notConnected}
            </Row>
            <Row label={f.backend}>{info.backend ?? d.notConnected}</Row>
          </section>

          <section className="hs-diag__section" aria-label={d.groups.tools}>
            <ToolRow label={f.ffmpeg} info={info.tools.ffmpeg} />
            <ToolRow label={f.musescore} info={info.tools.museScore} />
            <ToolRow label={f.verovio} info={info.tools.verovio} />
            <ToolRow label={f.wavesurfer} info={info.tools.wavesurfer} />
          </section>

          <section className="hs-diag__section" aria-label={d.groups.locations}>
            <Row label={f.cachePath}>{info.paths.cache ?? d.notConnected}</Row>
            <Row label={f.logPath}>{info.paths.logs ?? d.notConnected}</Row>
          </section>

          <section className="hs-diag__section" aria-label={f.workerStatus}>
            <div className="hs-diag__row">
              <span className="hs-diag__label">{f.workerStatus}</span>
              <span className="hs-diag__value">
                {wb ? (
                  <StatusBadge tone={wb.tone} label={wb.label} />
                ) : null}
              </span>
            </div>
          </section>
        </div>
      )}
    </HsSheet>
  );
}
