import { useMemo } from "react";
import { Button, FluentProvider } from "@fluentui/react-components";
import { ErrorCircle24Regular, Dismiss24Regular } from "@fluentui/react-icons";
import { ja } from "../../strings/ja";
import { hsDarkTheme, hsLightTheme } from "../../theme/fluentTheme";
import { NOTES, buildIssues } from "../mockData";
import { useMockPlayer } from "../useMockPlayer";
import { ProtoScore } from "../ProtoScore";
import { ProtoProperties, ProtoShell } from "../ProtoChrome";

type View = "shell" | "error";
type FrameTheme = "light" | "dark";

/**
 * P2 — Japanese density validation. Renders the full shell inside a fixed
 * 1366×768 frame with worst-case strings (long labels, long error body)
 * in light and dark. The frame carries its own data-hs-theme + FluentProvider
 * so it can be checked independently of the app theme.
 *
 * 150% check: documented on the page — Windows display scaling 150% or
 * browser zoom 150% must keep every primary control unclipped.
 */
export function DensityPage({ view: v, theme: th }: { view?: string; theme?: string }) {
  // Remounted per hash change (key prop) → params map straight to constants.
  const view: View = v === "error" ? "error" : "shell";
  const frameTheme: FrameTheme = th === "dark" ? "dark" : "light";
  const player = useMockPlayer();
  const issues = useMemo(() => buildIssues(), []);
  const d = ja.prototype.density;
  const errs = ja.prototype.errors;

  const onCommand = () => undefined;

  const frame = (
    <div
      className="hs-proto-frame"
      data-hs-theme={frameTheme}
      role="img"
      aria-label={ja.prototype.dev.frameCaption}
    >
      <FluentProvider theme={frameTheme === "dark" ? hsDarkTheme : hsLightTheme}>
        <ProtoShell
          documentTitle={ja.prototype.shell.docTitle}
          state={{ hasAudio: true, hasScore: true, reviewCount: 12 }}
          pitch="hornF"
          onPitch={() => undefined}
          onCommand={onCommand}
          longLabels
          player={player}
          transportEnabled
          status="再生位置の追従を一時停止しました — 手動スクロールを検出しました"
          properties={
            view === "shell" ? (
              <ProtoProperties
                note={NOTES.find((n) => n.measure === 4 && n.beat === 4) ?? null}
                pitch="hornF"
                open
                onClose={() => undefined}
                onReopen={() => undefined}
                onAction={() => undefined}
              />
            ) : undefined
          }
        >
          {view === "shell" ? (
            <ProtoScore
              notes={NOTES}
              pitch="hornF"
              selectedId={NOTES.find((n) => n.measure === 4 && n.beat === 4)?.id ?? null}
              onSelect={() => undefined}
              positionSec={null}
              issues={issues}
            />
          ) : (
            <main className="hs-score" role="region" aria-label={ja.score.regionLabel}>
              <div style={{ maxWidth: 520 }}>
                <div className="hs-proto-dialog" role="alertdialog" aria-label={errs.ffmpegMissing.title}>
                  <div className="hs-proto-dialog__row">
                    <ErrorCircle24Regular className="hs-proto-error__icon" aria-hidden="true" />
                    <h2 className="hs-proto-dialog__title">{errs.ffmpegMissing.title}</h2>
                    <span style={{ flex: 1 }} />
                    <Button
                      appearance="subtle"
                      icon={<Dismiss24Regular />}
                      aria-label={ja.prototype.common.close}
                    />
                  </div>
                  <p className="hs-proto-error__body">{errs.ffmpegMissing.body}</p>
                  <div className="hs-proto-dialog__actions">
                    <Button appearance="primary">{errs.ffmpegMissing.specifyFfmpeg}</Button>
                    <Button>{ja.prototype.common.close}</Button>
                  </div>
                </div>
              </div>
            </main>
          )}
        </ProtoShell>
      </FluentProvider>
    </div>
  );

  return (
    <div className="hs-proto-page">
      <div className="hs-proto-dev" role="group" aria-label={ja.prototype.dev.controlsLabel}>
        <span className="hs-proto-dev__label">{ja.prototype.dev.controlsLabel}</span>
        <span>{ja.prototype.dev.viewLabel}:</span>
        {(["shell", "error"] as const).map((v) => (
          <Button
            key={v}
            size="small"
            appearance={view === v ? "primary" : "secondary"}
            onClick={() => {
              window.location.hash = `#/prototype/density/${v}/${frameTheme}`;
            }}
          >
            {v === "shell" ? d.viewShell : d.viewError}
          </Button>
        ))}
        <span aria-hidden="true">|</span>
        <span>{ja.prototype.dev.themeLabel}:</span>
        {(["light", "dark"] as const).map((th) => (
          <Button
            key={th}
            size="small"
            appearance={frameTheme === th ? "primary" : "secondary"}
            onClick={() => {
              window.location.hash = `#/prototype/density/${view}/${th}`;
            }}
          >
            {th === "light" ? ja.prototype.dev.light : ja.prototype.dev.dark}
          </Button>
        ))}
        <span>{ja.prototype.dev.frameCaption}</span>
      </div>

      <div className="hs-proto-scrollable">
        {frame}

        <div className="hs-proto-doc">
          <h2>{d.scalingTitle}</h2>
          <ol>
            {d.scalingSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <h2 style={{ marginTop: "var(--hs-space-md)" }}>{d.checkTitle}</h2>
          <ul>
            {d.checks.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
