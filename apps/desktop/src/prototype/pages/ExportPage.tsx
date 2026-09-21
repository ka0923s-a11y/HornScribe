import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Tooltip } from "@fluentui/react-components";
import {
  CheckmarkCircle24Regular,
  Dismiss24Regular,
  ErrorCircle24Regular,
  Warning24Regular,
} from "@fluentui/react-icons";
import { ja } from "../../strings/ja";
import { NOTES, type PitchView } from "../mockData";
import { useMockPlayer } from "../useMockPlayer";
import { useProtoKeys } from "../useProtoKeys";
import { ProtoScore } from "../ProtoScore";
import { ProtoShell, type ProtoCommand } from "../ProtoChrome";

type Scenario =
  | "normal"
  | "musescoreMissing"
  | "permissionDenied"
  | "workerCrashed"
  | "sourceMoved";

type Phase = "form" | "running" | "done" | "error";

const ERROR_SCENARIOS: Scenario[] = ["workerCrashed", "sourceMoved"];

/**
 * P5 — export + error recovery (GUI_UX_SPEC §17, §20).
 * Every error surface carries a recovery action; the dialog never leaves the
 * user without a next step. Scenarios are switched from the dev strip.
 */
const PARAM_TO_SCENARIO: Record<string, Scenario> = {
  normal: "normal",
  musescore: "musescoreMissing",
  permission: "permissionDenied",
  worker: "workerCrashed",
  source: "sourceMoved",
};

const SCENARIO_TO_PARAM: Record<Scenario, string> = {
  normal: "normal",
  musescoreMissing: "musescore",
  permissionDenied: "permission",
  workerCrashed: "worker",
  sourceMoved: "source",
};

export function ExportPage({ initial, phase: phaseParam }: { initial?: string; phase?: string }) {
  const [pitch, setPitch] = useState<PitchView>("concert");
  // Remounted per hash change (key prop) → params map straight to constants.
  const scenario: Scenario = PARAM_TO_SCENARIO[initial ?? ""] ?? "normal";
  const [phase, setPhase] = useState<Phase>(() =>
    phaseParam === "done" || phaseParam === "error" ? phaseParam : "form",
  );
  const [dialogOpen, setDialogOpen] = useState(true);
  const [status, setStatus] = useState<string>(ja.status.ready);
  const [checks, setChecks] = useState({
    concertMusicxml: true,
    hornMusicxml: true,
    concertPdf: true,
    hornPdf: true,
    playbackMidi: true,
  });
  const closeRef = useRef<HTMLButtonElement>(null);
  const player = useMockPlayer();
  const e = ja.prototype.exportSheet;
  const errs = ja.prototype.errors;
  const sc = ja.prototype.exportScenarios;

  const musescoreMissing = scenario === "musescoreMissing";
  const isAppError = ERROR_SCENARIOS.includes(scenario);

  // Focus the dialog when it (re)opens or when the phase changes.
  useEffect(() => {
    if (dialogOpen) closeRef.current?.focus();
  }, [dialogOpen, phase, scenario]);

  const submit = useCallback(() => {
    setPhase("running");
    // Deterministic mock: fixed short delay, then done/error per scenario.
    window.setTimeout(() => {
      setPhase(scenario === "permissionDenied" ? "error" : "done");
      setStatus(
        scenario === "permissionDenied"
          ? errs.exportPermissionDenied.title
          : ja.prototype.status.exportDone,
      );
    }, 700);
    // errs/ja are module constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario]);

  const close = useCallback(() => {
    setDialogOpen(false);
    setStatus(ja.status.ready);
  }, []);

  const onCommand = useCallback((id: ProtoCommand) => {
    if (id === "export") {
      setPhase("form");
      setDialogOpen(true);
    } else if (id === "review") {
      window.location.hash = "#/prototype/review";
    } else if (id === "open") {
      window.location.hash = "#/prototype/shell";
    } else {
      setStatus("プロトタイプではこの操作は省略しています");
    }
  }, []);

  useProtoKeys(
    useMemo(
      () => [
        { combo: "Escape", run: close, enabled: () => dialogOpen },
        { combo: "Ctrl+1", run: () => setPitch("concert") },
        { combo: "Ctrl+2", run: () => setPitch("hornF") },
      ],
      [close, dialogOpen],
    ),
  );

  const toggle = (key: keyof typeof checks) => (_: unknown, d: { checked: boolean | "mixed" }) =>
    setChecks((c) => ({ ...c, [key]: d.checked === true }));

  const anyChecked = Object.values(checks).some(Boolean);

  const devBar = (
    <div className="hs-proto-dev" role="group" aria-label={ja.prototype.dev.controlsLabel}>
      <span className="hs-proto-dev__label">{ja.prototype.dev.controlsLabel}</span>
      <span>{ja.prototype.dev.stateLabel}:</span>
      {(Object.keys(SCENARIO_TO_PARAM) as Scenario[]).map((key) => (
        <Button
          key={key}
          size="small"
          appearance={scenario === key ? "primary" : "secondary"}
          onClick={() => {
            window.location.hash = `#/prototype/export/${SCENARIO_TO_PARAM[key]}`;
          }}
        >
          {sc[key]}
        </Button>
      ))}
    </div>
  );

  return (
    <>
      {devBar}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ProtoShell
          documentTitle={ja.prototype.shell.docTitle}
          state={{ hasAudio: true, hasScore: true, reviewCount: 5 }}
          pitch={pitch}
          onPitch={setPitch}
          onCommand={onCommand}
          player={player}
          transportEnabled
          status={status}
        >
          <ProtoScore
            notes={NOTES}
            pitch={pitch}
            selectedId={null}
            onSelect={() => undefined}
            positionSec={player.playing ? player.positionSec : null}
          />
        </ProtoShell>

        {dialogOpen && !isAppError && (
          <div className="hs-proto-dialog-backdrop">
            <div
              className="hs-proto-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={e.title}
            >
              {phase === "form" || phase === "running" ? (
                <>
                  <div className="hs-proto-dialog__row">
                    <h2 className="hs-proto-dialog__title">{e.title}</h2>
                    <Tooltip content={ja.prototype.common.close} relationship="label">
                      <Button
                        ref={closeRef}
                        appearance="subtle"
                        icon={<Dismiss24Regular />}
                        aria-label={ja.prototype.common.close}
                        onClick={close}
                      />
                    </Tooltip>
                  </div>

                  <h3 className="hs-proto-dialog__section">{e.scoreSection}</h3>
                  <div className="hs-proto-dialog__group">
                    <Checkbox
                      checked={checks.concertMusicxml}
                      onChange={toggle("concertMusicxml")}
                      label={e.options.concertMusicxml}
                    />
                    <Checkbox
                      checked={checks.hornMusicxml}
                      onChange={toggle("hornMusicxml")}
                      label={e.options.hornMusicxml}
                    />
                  </div>

                  <h3 className="hs-proto-dialog__section">{e.pdfSection}</h3>
                  <div className="hs-proto-dialog__group">
                    <Tooltip
                      content={musescoreMissing ? e.pdfDisabledTooltip : ""}
                      relationship="label"
                    >
                      <Checkbox
                        checked={checks.concertPdf}
                        onChange={toggle("concertPdf")}
                        label={e.options.concertPdf}
                        disabled={musescoreMissing}
                      />
                    </Tooltip>
                    <Tooltip
                      content={musescoreMissing ? e.pdfDisabledTooltip : ""}
                      relationship="label"
                    >
                      <Checkbox
                        checked={checks.hornPdf}
                        onChange={toggle("hornPdf")}
                        label={e.options.hornPdf}
                        disabled={musescoreMissing}
                      />
                    </Tooltip>
                  </div>
                  {musescoreMissing && (
                    <p className="hs-proto-note-inline" role="note">
                      <Warning24Regular aria-hidden="true" />
                      <span>{e.museScoreMissingNote}</span>
                    </p>
                  )}

                  <h3 className="hs-proto-dialog__section">{e.midiSection}</h3>
                  <div className="hs-proto-dialog__group">
                    <Checkbox
                      checked={checks.playbackMidi}
                      onChange={toggle("playbackMidi")}
                      label={e.options.playbackMidi}
                    />
                  </div>

                  <div className="hs-proto-dialog__row">
                    <span>{e.destination}</span>
                    <span className="hs-proto-dialog__path">{e.sampleDestination}</span>
                  </div>

                  <div className="hs-proto-dialog__actions">
                    <Button onClick={close}>{ja.prototype.common.cancel}</Button>
                    <Button
                      appearance="primary"
                      disabled={!anyChecked || phase === "running"}
                      onClick={submit}
                    >
                      {phase === "running" ? e.running : e.submit}
                    </Button>
                  </div>
                </>
              ) : phase === "done" ? (
                <>
                  <div className="hs-proto-dialog__row">
                    <h2 className="hs-proto-dialog__title">{e.completeTitle}</h2>
                    <CheckmarkCircle24Regular
                      aria-hidden="true"
                      style={{ color: "var(--hs-status-success)", fontSize: 24 }}
                    />
                  </div>
                  <div className="hs-proto-dialog__actions">
                    <Button
                      ref={closeRef}
                      onClick={() => setStatus("エクスプローラー表示はモックです")}
                    >
                      {e.revealInExplorer}
                    </Button>
                    <Button appearance="primary" onClick={close}>
                      {ja.prototype.common.close}
                    </Button>
                  </div>
                </>
              ) : (
                /* permission denied — title → body → recovery action (§20) */
                <>
                  <div className="hs-proto-dialog__row">
                    <ErrorCircle24Regular className="hs-proto-error__icon" aria-hidden="true" />
                    <h2 className="hs-proto-dialog__title">
                      {errs.exportPermissionDenied.title}
                    </h2>
                    <span style={{ flex: 1 }} />
                    <Tooltip content={ja.prototype.common.close} relationship="label">
                      <Button
                        appearance="subtle"
                        icon={<Dismiss24Regular />}
                        aria-label={ja.prototype.common.close}
                        onClick={close}
                      />
                    </Tooltip>
                  </div>
                  <p className="hs-proto-error__body">{errs.exportPermissionDenied.body}</p>
                  <div className="hs-proto-dialog__actions">
                    <Button
                      ref={closeRef}
                      appearance="primary"
                      onClick={() => {
                        setPhase("form");
                        setStatus(e.chooseAnotherDestination);
                      }}
                    >
                      {errs.exportPermissionDenied.chooseDestination}
                    </Button>
                    <Button onClick={close}>{ja.prototype.common.close}</Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {dialogOpen && scenario === "workerCrashed" && (
          <AppErrorDialog
            ref={closeRef}
            icon="error"
            title={errs.workerCrashed.title}
            body={errs.workerCrashed.body}
            actions={[
              {
                label: errs.workerCrashed.restartEngine,
                primary: true,
                run: () => {
                  setDialogOpen(false);
                  setStatus(ja.prototype.status.engineRestarted);
                },
              },
              {
                label: ja.prototype.common.diagnostics,
                run: () => setStatus("診断情報はこのプロトタイプでは省略しています"),
              },
            ]}
          />
        )}

        {dialogOpen && scenario === "sourceMoved" && (
          <AppErrorDialog
            ref={closeRef}
            icon="warning"
            title={errs.sourceMoved.title}
            body={errs.sourceMoved.body}
            actions={[
              {
                label: errs.sourceMoved.specifySource,
                primary: true,
                run: () => {
                  setDialogOpen(false);
                  setStatus(ja.prototype.status.sourceSpecified);
                },
              },
              { label: ja.prototype.common.close, run: close },
            ]}
          />
        )}
      </div>
    </>
  );
}

/** App-level error surface (worker crash / source moved). */
const AppErrorDialog = forwardRef<
  HTMLButtonElement,
  {
    icon: "error" | "warning";
    title: string;
    body: string;
    actions: { label: string; primary?: boolean; run(): void }[];
  }
>(function AppErrorDialog({ icon, title, body, actions }, ref) {
  return (
    <div className="hs-proto-dialog-backdrop">
      <div className="hs-proto-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="hs-proto-dialog__row">
          {icon === "error" ? (
            <ErrorCircle24Regular className="hs-proto-error__icon" aria-hidden="true" />
          ) : (
            <Warning24Regular
              aria-hidden="true"
              style={{ color: "var(--hs-status-warning)", fontSize: 28 }}
            />
          )}
          <h2 className="hs-proto-dialog__title">{title}</h2>
        </div>
        <p className="hs-proto-error__body">{body}</p>
        <div className="hs-proto-dialog__actions">
          {actions.map((a, i) => (
            <Button
              key={a.label}
              ref={i === 0 ? ref : undefined}
              appearance={a.primary ? "primary" : "secondary"}
              onClick={a.run}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
});
