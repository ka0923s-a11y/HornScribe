import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox, Tooltip } from "@fluentui/react-components";
import {
  CheckmarkCircle24Regular,
  ErrorCircle24Regular,
  Warning24Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import { HsDialog } from "../components/primitives/Dialog";
import { HsProgress } from "../components/primitives/Progress";
import type { ToolPathOverrides } from "../diagnostics/types";
import type { ExportPort } from "./port";
import {
  exportErrorCode,
  pdfBlocked,
  EXPORT_FORMAT_GROUPS,
  type ExportCapabilities,
  type ExportFormatId,
  type ExportResult,
} from "./types";

type Phase = "loading" | "form" | "running" | "done" | "error";
type ErrorKind = "permission" | "unavailable" | "musescore" | "failed";

const ERROR_TITLE: Record<ErrorKind, string> = {
  permission: ja.errors.exportPermissionDenied.title,
  unavailable: ja.errors.engineUnavailable.title,
  musescore: ja.errors.musescoreMissing.title,
  failed: ja.errors.exportFailed.title,
};

const ERROR_BODY: Record<ErrorKind, string> = {
  permission: ja.errors.exportPermissionDenied.body,
  unavailable: ja.errors.engineUnavailable.body,
  musescore: ja.errors.musescoreMissing.body,
  failed: ja.errors.exportFailed.body,
};

/**
 * 書き出し dialog (GUI_UX_SPEC §17, §20; issue UI-060).
 *
 * Formats (all checked by default):
 *   楽譜: コンサートピッチ / F管ホルン MusicXML
 *   PDF:  コンサートピッチ / F管ホルン PDF  — disabled when MuseScore is
 *         missing, with the spec'd note + 場所を指定 recovery; MusicXML and
 *         MIDI stay available (acceptance: "missing MuseScore does not
 *         block other formats").
 *   MIDI: 再生用MIDI（実音） — sounding pitch only (ENG-001).
 *
 * Phases: loading → form → running → done | error. Errors keep the §20
 * shape (何が失敗したか → 影響 → 次にできること) and never render engine
 * output — only stable ExportError codes map to Japanese recovery copy.
 */
export function ExportDialog({
  open,
  onOpenChange,
  port,
  defaultDestination,
  toolOverrides,
  onOpenSettings,
  onOpenDiagnostics,
  onAnnounce,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  port: ExportPort;
  /** 設定 → 書き出し → 既定の保存先 ("" = ask the port). */
  defaultDestination: string;
  /** 設定 → ツール user paths — non-empty paths override probing. */
  toolOverrides?: ToolPathOverrides;
  /** Recovery: opens 設定 focused on the 書き出し category. */
  onOpenSettings(category: "export"): void;
  onOpenDiagnostics(): void;
  onAnnounce(message: string): void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [destination, setDestination] = useState("");
  const [selected, setSelected] = useState<Record<ExportFormatId, boolean>>({
    concertMusicxml: true,
    hornMusicxml: true,
    concertPdf: true,
    hornPdf: true,
    playbackMidi: true,
    sourceAudio: true,
  });
  const [result, setResult] = useState<ExportResult | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>("failed");
  // Stale-response guard: a probe/export finishing after close or a newer
  // attempt must not overwrite the current phase.
  const generation = useRef(0);

  const e = ja.exportSheet;
  const errs = ja.errors;

  // Probe capabilities + destination when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const gen = ++generation.current;
    setPhase("loading");
    setCaps(null);
    setResult(null);
    setSelected({
      concertMusicxml: true,
      hornMusicxml: true,
      concertPdf: true,
      hornPdf: true,
      playbackMidi: true,
      sourceAudio: true,
    });
    let cancelled = false;
    void (async () => {
      try {
        const [capabilities, fallbackDir] = await Promise.all([
          port.capabilities(toolOverrides),
          defaultDestination
            ? Promise.resolve(defaultDestination)
            : port.defaultDestination(),
        ]);
        if (cancelled || generation.current !== gen) return;
        setCaps(capabilities);
        setDestination(defaultDestination || fallbackDir);
        setPhase("form");
      } catch (err) {
        if (cancelled || generation.current !== gen) return;
        setErrorKind(
          exportErrorCode(err) === "ENGINE_UNAVAILABLE"
            ? "unavailable"
            : "failed",
        );
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, port, defaultDestination, toolOverrides]);

  const close = useCallback(() => {
    generation.current += 1;
    onOpenChange(false);
  }, [onOpenChange]);

  const blocked = caps ? pdfBlocked(caps) : false;
  // #87: the audio bundle needs a real path — browser-held bytes and
  // pathless recordings keep the checkbox off with an honest tooltip.
  const audioBlocked = caps != null && !caps.audioAvailable;
  const running = phase === "running";
  // Formats that will actually export — checked AND not blocked.
  // anyChecked alone let submit run with an empty list when every
  // checked format was blocked (e.g. PDF-only selection + no MuseScore).
  const effectiveFormats = (
    Object.keys(selected) as ExportFormatId[]
  ).filter(
    (f) =>
      selected[f] &&
      !(blocked && EXPORT_FORMAT_GROUPS[f] === "pdf") &&
      !(audioBlocked && f === "sourceAudio"),
  );

  const submit = useCallback(async () => {
    const gen = ++generation.current;
    setPhase("running");
    try {
      const res = await port.export({
        formats: effectiveFormats,
        destination,
      });
      if (generation.current !== gen) return;
      setResult(res);
      setPhase("done");
      onAnnounce(ja.notifications.exportDone);
    } catch (err) {
      if (generation.current !== gen) return;
      const code = exportErrorCode(err);
      setErrorKind(
        code === "PERMISSION_DENIED"
          ? "permission"
          : code === "ENGINE_UNAVAILABLE"
            ? "unavailable"
            : code === "MUSESCORE_UNAVAILABLE"
              ? "musescore"
              : "failed",
      );
      setPhase("error");
    }
  }, [effectiveFormats, port, destination, onAnnounce]);

  const pickDestination = useCallback(async () => {
    try {
      const dir = await port.chooseDestination(destination);
      if (dir) setDestination(dir);
    } catch {
      /* unsupported picker — the path row stays editable nowhere else,
         so surface the honest failure instead of dying silently */
      onAnnounce(ja.exportSheet.destinationPickFailed);
    }
  }, [port, destination, onAnnounce]);

  const reveal = useCallback(async () => {
    const dir = result?.destination ?? destination;
    const ok = await port.revealInExplorer(dir).catch(() => false);
    if (!ok) onAnnounce(ja.exportSheet.revealFailed);
  }, [port, result, destination, onAnnounce]);

  const goToMuseScoreSettings = useCallback(() => {
    close();
    onOpenSettings("export");
  }, [close, onOpenSettings]);

  const toggle =
    (key: ExportFormatId) =>
    (_: unknown, d: { checked: boolean | "mixed" }) =>
      setSelected((s) => ({ ...s, [key]: d.checked === true }));

  const title =
    phase === "done"
      ? e.completeTitle
      : phase === "error"
        ? ERROR_TITLE[errorKind]
        : e.title;

  const formatRow = (id: ExportFormatId) => {
    const pdfOff = blocked && EXPORT_FORMAT_GROUPS[id] === "pdf";
    const audioOff = audioBlocked && id === "sourceAudio";
    const disabled = running || pdfOff || audioOff;
    const checkbox = (
      <Checkbox
        checked={selected[id]}
        onChange={toggle(id)}
        label={e.options[id]}
        disabled={disabled}
      />
    );
    // Disabled checkboxes can't announce *why* — the spec'd tooltip does.
    if (audioOff) {
      return (
        <Tooltip
          key={id}
          content={e.audioDisabledTooltip}
          relationship="label"
        >
          <span className="hs-export__option">{checkbox}</span>
        </Tooltip>
      );
    }
    return pdfOff ? (
      <Tooltip
        key={id}
        content={e.pdfDisabledTooltip}
        relationship="label"
      >
        <span className="hs-export__option">{checkbox}</span>
      </Tooltip>
    ) : (
      <span key={id} className="hs-export__option">
        {checkbox}
      </span>
    );
  };

  return (
    <HsDialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={title}
      actions={
        phase === "form" || running ? (
          <>
            <HsButton onClick={close}>{ja.common.cancel}</HsButton>
            <HsButton
              variant="primary"
              disabled={effectiveFormats.length === 0 || running || !destination}
              loading={running}
              onClick={() => void submit()}
            >
              {running ? e.running : e.submit}
            </HsButton>
          </>
        ) : phase === "done" ? (
          <>
            <HsButton onClick={() => void reveal()}>
              {e.revealInExplorer}
            </HsButton>
            <HsButton variant="primary" onClick={close}>
              {ja.common.close}
            </HsButton>
          </>
        ) : phase === "error" ? (
          <>
            {errorKind === "permission" || errorKind === "failed" ? (
              <HsButton onClick={() => setPhase("form")}>
                {errs.exportPermissionDenied.actions.chooseDestination}
              </HsButton>
            ) : null}
            {errorKind === "failed" ? (
              <HsButton onClick={() => void submit()}>
                {errs.exportFailed.actions.retry}
              </HsButton>
            ) : null}
            {errorKind === "musescore" ? (
              <HsButton
                variant="primary"
                onClick={goToMuseScoreSettings}
              >
                {errs.musescoreMissing.actions.specifyMusescore}
              </HsButton>
            ) : null}
            {errorKind === "unavailable" ? (
              <HsButton
                variant="primary"
                onClick={() => {
                  close();
                  onOpenDiagnostics();
                }}
              >
                {errs.engineUnavailable.actions.diagnostics}
              </HsButton>
            ) : null}
            <HsButton onClick={close}>{ja.common.close}</HsButton>
          </>
        ) : undefined
      }
    >
      {phase === "loading" ? (
        <HsProgress label={e.loading} />
      ) : phase === "form" || running ? (
        <div className="hs-export">
          <h3 className="hs-export__section">{e.scoreSection}</h3>
          <div className="hs-export__group">
            {formatRow("concertMusicxml")}
            {formatRow("hornMusicxml")}
          </div>

          <h3 className="hs-export__section">{e.pdfSection}</h3>
          <div className="hs-export__group">
            {formatRow("concertPdf")}
            {formatRow("hornPdf")}
          </div>
          {blocked ? (
            <p className="hs-export__note" role="note">
              <Warning24Regular aria-hidden="true" />
              <span>{e.museScoreMissingNote}</span>
              <HsButton
                variant="subtle"
                size="small"
                onClick={goToMuseScoreSettings}
              >
                {e.specifyMuseScore}
              </HsButton>
            </p>
          ) : null}

          <h3 className="hs-export__section">{e.midiSection}</h3>
          <div className="hs-export__group">{formatRow("playbackMidi")}</div>

          <h3 className="hs-export__section">{e.audioSection}</h3>
          <div className="hs-export__group">{formatRow("sourceAudio")}</div>

          <div className="hs-export__dest">
            <span className="hs-export__dest-label">{e.destination}</span>
            <span className="hs-export__dest-path" title={destination}>
              {destination}
            </span>
            <HsButton
              variant="secondary"
              size="small"
              disabled={running}
              onClick={() => void pickDestination()}
            >
              {ja.common.browse}
            </HsButton>
          </div>

          {running ? (
            <HsProgress label={e.running} className="hs-export__progress" />
          ) : null}
        </div>
      ) : phase === "done" ? (
        <div className="hs-export">
          <p className="hs-export__done">
            <CheckmarkCircle24Regular
              aria-hidden="true"
              className="hs-export__done-icon"
            />
            <span>
              {e.completeCount.replace(
                "{count}",
                String(result?.files.length ?? 0),
              )}
            </span>
          </p>
          <ul className="hs-export__files">
            {result?.files.map((f) => (
              <li key={f.format} title={f.path}>
                {f.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="hs-export">
          <p className="hs-export__error">
            <ErrorCircle24Regular
              aria-hidden="true"
              className="hs-export__error-icon"
            />
            <span>{ERROR_BODY[errorKind]}</span>
          </p>
        </div>
      )}
    </HsDialog>
  );
}
