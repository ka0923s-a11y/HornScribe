import { useEffect, useState, type ReactNode } from "react";
import { Checkbox, FluentProvider } from "@fluentui/react-components";
import {
  CheckmarkCircle16Regular,
  ErrorCircle16Regular,
  Info16Regular,
  Play24Regular,
  Warning16Regular,
} from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import {
  hsDarkTheme,
  hsLightTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "../theme/fluentTheme";
import {
  HsButton,
  HsDialog,
  HsIconButton,
  HsMenu,
  HsNumericField,
  HsPanel,
  HsPopover,
  HsProgress,
  HsSelect,
  HsSheet,
  HsSlider,
  HsTooltip,
  ReviewBadge,
  SegmentedControl,
  StatusBadge,
  type HsButtonVariant,
} from "../components/primitives";
import { ImportScreenBody, type ImportView } from "../import/ImportStates";
import {
  DEFAULT_TRANSCRIPTION_OPTIONS,
  type LoadedAudio,
} from "../import/types";
import "./gallery.css";

/**
 * Internal component gallery — dev-only route (#/dev/gallery, UI-010).
 *
 * Every interactive primitive is rendered across the §22 state matrix
 * (default / hover / pressed / focus-visible / selected / disabled /
 * loading / error where applicable) in BOTH light and dark theme sections:
 * each section carries data-hs-theme so the --hs-* tokens rebind, plus its
 * own FluentProvider so Fluent internals follow the same theme.
 *
 * Transient states are painted statically through .hs-sim-* classes that
 * reuse the same tokens as the real interaction styles — screenshots of
 * data-hs-fixture cells are the visual-regression fixtures.
 */

type Sim = "hover" | "pressed" | "focus";

const S = ja.gallery.states;

const VARIANT_LABEL: Record<HsButtonVariant, string> = {
  primary: ja.gallery.variants.primary,
  secondary: ja.gallery.variants.secondary,
  subtle: ja.gallery.variants.subtle,
  danger: ja.gallery.variants.danger,
};

/** One fixture cell: stable id + Japanese state caption. */
function Fixture({
  id,
  caption,
  sim,
  stageClass,
  children,
}: {
  id: string;
  caption: string;
  sim?: Sim;
  stageClass?: string;
  children: ReactNode;
}) {
  return (
    <figure className="hs-fixture" data-hs-fixture={id}>
      <div
        className={[
          "hs-fixture__stage",
          sim ? `hs-sim-${sim}` : undefined,
          stageClass,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
      <figcaption className="hs-fixture__caption">{caption}</figcaption>
    </figure>
  );
}

/**
 * Overlay fixture: overlays mount their surface into the stage box
 * (mountNode) so they render contained inside the cell — visible in
 * screenshots without pointer interaction, and inside the section's
 * data-hs-theme scope so tokens resolve to this theme.
 */
function OverlayFixture({
  id,
  caption,
  tall,
  children,
}: {
  id: string;
  caption: string;
  tall?: boolean;
  children: (mountNode: HTMLElement | null) => ReactNode;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <figure className="hs-fixture" data-hs-fixture={id}>
      <div
        ref={setNode}
        className={[
          "hs-fixture__stage",
          "hs-overlay-stage",
          tall ? "hs-overlay-stage--tall" : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Delay until the mount node exists: a null mountNode would portal
            to document.body and flash a full-viewport overlay on load. */}
        {node ? children(node) : null}
      </div>
      <figcaption className="hs-fixture__caption">{caption}</figcaption>
    </figure>
  );
}

function Section({
  title,
  wide,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="hs-gallery__section">
      <h3 className="hs-gallery__section-title">{title}</h3>
      <div
        className={
          wide ? "hs-fixture-grid hs-fixture-grid--wide" : "hs-fixture-grid"
        }
      >
        {children}
      </div>
    </section>
  );
}

/* ------------------------- per-primitive sections ------------------------- */

function ButtonSection() {
  const variants: readonly [HsButtonVariant, string][] = [
    ["primary", ja.gallery.samples.primaryAction],
    ["secondary", ja.gallery.samples.secondaryAction],
    ["subtle", ja.gallery.samples.subtleAction],
    ["danger", ja.gallery.samples.dangerAction],
  ];
  return (
    <Section title={ja.gallery.sections.button}>
      {variants.map(([variant, label]) => (
        <span key={variant} style={{ display: "contents" }}>
          <Fixture
            id={`button-${variant}-default`}
            caption={`${VARIANT_LABEL[variant]} / ${S.default}`}
          >
            <HsButton variant={variant}>{label}</HsButton>
          </Fixture>
          <Fixture
            id={`button-${variant}-hover`}
            caption={`${VARIANT_LABEL[variant]} / ${S.hover}`}
            sim="hover"
          >
            <HsButton variant={variant}>{label}</HsButton>
          </Fixture>
          <Fixture
            id={`button-${variant}-pressed`}
            caption={`${VARIANT_LABEL[variant]} / ${S.pressed}`}
            sim="pressed"
          >
            <HsButton variant={variant}>{label}</HsButton>
          </Fixture>
          <Fixture
            id={`button-${variant}-focus`}
            caption={`${VARIANT_LABEL[variant]} / ${S.focus}`}
            sim="focus"
          >
            <HsButton variant={variant}>{label}</HsButton>
          </Fixture>
          <Fixture
            id={`button-${variant}-disabled`}
            caption={`${VARIANT_LABEL[variant]} / ${S.disabled}`}
          >
            <HsButton variant={variant} disabled>
              {label}
            </HsButton>
          </Fixture>
          <Fixture
            id={`button-${variant}-loading`}
            caption={`${VARIANT_LABEL[variant]} / ${S.loading}`}
          >
            <HsButton variant={variant} loading>
              {label}
            </HsButton>
          </Fixture>
        </span>
      ))}
    </Section>
  );
}

function IconButtonSection() {
  const label = ja.transport.play;
  return (
    <Section title={ja.gallery.sections.iconButton}>
      <Fixture id="iconbutton-default" caption={S.default}>
        <HsIconButton label={label} icon={<Play24Regular />} />
      </Fixture>
      <Fixture id="iconbutton-hover" caption={S.hover} sim="hover">
        <HsIconButton label={label} icon={<Play24Regular />} />
      </Fixture>
      <Fixture id="iconbutton-pressed" caption={S.pressed} sim="pressed">
        <HsIconButton label={label} icon={<Play24Regular />} />
      </Fixture>
      <Fixture id="iconbutton-focus" caption={S.focus} sim="focus">
        <HsIconButton label={label} icon={<Play24Regular />} />
      </Fixture>
      <Fixture id="iconbutton-selected" caption={S.selected}>
        <HsIconButton label={label} icon={<Play24Regular />} selected />
      </Fixture>
      <Fixture id="iconbutton-disabled" caption={S.disabled}>
        <HsIconButton label={label} icon={<Play24Regular />} disabled />
      </Fixture>
      <Fixture id="iconbutton-loading" caption={S.loading}>
        <HsIconButton label={label} icon={<Play24Regular />} loading />
      </Fixture>
    </Section>
  );
}

const SEGMENT_OPTIONS = [
  { value: "concert", label: ja.pitch.concert },
  { value: "hornF", label: ja.pitch.hornF },
] as const;

function SegmentedFixture({
  value,
  disabled,
}: {
  value: "concert" | "hornF";
  disabled?: boolean;
}) {
  const [v, setV] = useState<"concert" | "hornF">(value);
  return (
    <SegmentedControl
      options={SEGMENT_OPTIONS}
      value={v}
      onChange={setV}
      ariaLabel={ja.pitch.regionLabel}
      disabled={disabled}
    />
  );
}

function SegmentedSection() {
  return (
    <Section title={ja.gallery.sections.segmented}>
      <Fixture id="segmented-default" caption={S.default}>
        <SegmentedFixture value="concert" />
      </Fixture>
      <Fixture id="segmented-hover" caption={S.hover} sim="hover">
        <SegmentedFixture value="concert" />
      </Fixture>
      <Fixture id="segmented-focus" caption={S.focus} sim="focus">
        <SegmentedFixture value="concert" />
      </Fixture>
      <Fixture id="segmented-selected" caption={S.selected}>
        <SegmentedFixture value="hornF" />
      </Fixture>
      <Fixture id="segmented-disabled" caption={S.disabled}>
        <SegmentedFixture value="concert" disabled />
      </Fixture>
    </Section>
  );
}

function OverlaySection() {
  return (
    <Section title={ja.gallery.sections.overlays} wide>
      {/* Tooltip pinned open into the stage (mountNode). */}
      <OverlayFixture id="tooltip-visible" caption={S.default}>
        {(node) => (
          <HsTooltip
            content={`${ja.transport.playPause}（Space）`}
            visible
            mountNode={node}
          >
            <HsIconButton label={ja.transport.play} icon={<Play24Regular />} />
          </HsTooltip>
        )}
      </OverlayFixture>

      {/* Popover pinned open, in-flow (inline) inside the stage. */}
      <OverlayFixture id="popover-open" caption={S.default}>
        {() => (
          <HsPopover
            open
            inline
            trigger={
              <HsButton variant="secondary">
                {ja.gallery.samples.transcribeOptions}
              </HsButton>
            }
          >
            <HsNumericField
              label={ja.gallery.samples.tempoLabel}
              value={120}
              unit="BPM"
            />
          </HsPopover>
        )}
      </OverlayFixture>

      {/* Menu pinned open into the stage (mountNode). */}
      <OverlayFixture id="menu-open" caption={S.default}>
        {(node) => (
          <MenuFixture node={node} />
        )}
      </OverlayFixture>

      {/* Sheet + Dialog open via their fixture buttons — opening either one
          grabs focus by design, so they stay closed until clicked and the
          page load position is never hijacked. */}
      <Fixture id="sheet-toggle" caption={S.default} stageClass="hs-fixture__stage--stretch">
        <SheetFixture />
      </Fixture>
      <Fixture id="dialog-toggle" caption={S.default}>
        <DialogFixture />
      </Fixture>
    </Section>
  );
}

function SheetFixture() {
  const [open, setOpen] = useState(false);
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <div ref={setNode} className="hs-overlay-stage hs-overlay-stage--tall">
      <HsButton variant="secondary" onClick={() => setOpen(true)}>
        {ja.gallery.samples.sheetOpen}
      </HsButton>
      {/* non-modal + mountNode: the drawer stays contained in the stage box
          instead of pinning to the viewport edge. */}
      <HsSheet
        open={open}
        onOpenChange={setOpen}
        modalType="non-modal"
        size="small"
        mountNode={node}
        title={ja.gallery.samples.sheetTitle}
        footer={
          <>
            <HsButton variant="secondary" onClick={() => setOpen(false)}>
              {ja.common.cancel}
            </HsButton>
            <HsButton variant="primary" onClick={() => setOpen(false)}>
              {ja.gallery.samples.sheetSubmit}
            </HsButton>
          </>
        }
      >
        <p className="hs-fixture-card__text">{ja.gallery.samples.sheetBody}</p>
      </HsSheet>
    </div>
  );
}

function MenuFixture({ node }: { node: HTMLElement | null }) {
  // A mounted-open menu autofocuses its first item (correct product
  // behavior); release that focus once so page load doesn't steal it.
  useEffect(() => {
    if (!node) return;
    const t = window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && node.contains(active)) {
        active.blur();
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [node]);
  return (
    <HsMenu
      open
      mountNode={node}
      trigger={
        <HsButton variant="secondary">{ja.gallery.samples.menuFile}</HsButton>
      }
      items={[
        { key: "open", label: ja.gallery.samples.menuOpenAudio },
        { key: "project", label: ja.gallery.samples.menuOpenProject },
        {
          key: "recent",
          label: ja.gallery.samples.menuRecent,
          disabled: true,
        },
        { key: "d1", divider: true },
        { key: "close", label: ja.gallery.samples.menuClose },
      ]}
    />
  );
}

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HsButton variant="secondary" onClick={() => setOpen(true)}>
        {ja.gallery.samples.dialogOpen}
      </HsButton>
      <HsDialog
        open={open}
        onOpenChange={setOpen}
        title={ja.gallery.samples.dialogTitle}
        actions={
          <>
            <HsButton variant="secondary" onClick={() => setOpen(false)}>
              {ja.common.cancel}
            </HsButton>
            <HsButton variant="primary" onClick={() => setOpen(false)}>
              {ja.gallery.samples.dialogConfirm}
            </HsButton>
          </>
        }
      >
        {ja.gallery.samples.dialogBody}
      </HsDialog>
    </>
  );
}

function SliderFixture({
  disabled,
  init = 70,
}: {
  disabled?: boolean;
  init?: number;
}) {
  const [v, setV] = useState(init);
  return (
    <HsSlider
      label={ja.gallery.samples.volumeLabel}
      value={v}
      min={0}
      max={100}
      unit="%"
      disabled={disabled}
      onChange={setV}
    />
  );
}

function FieldSection() {
  const [tempo, setTempo] = useState<number | null>(120);
  const [meter, setMeter] = useState("4/4");
  const meterOptions = ja.gallery.samples.meterOptions.map((m) => ({
    value: m,
    label: m,
  }));
  return (
    <>
      <Section title={ja.gallery.sections.slider} wide>
        <Fixture id="slider-default" caption={S.default}>
          <SliderFixture />
        </Fixture>
        <Fixture id="slider-hover" caption={S.hover} sim="hover">
          <SliderFixture />
        </Fixture>
        <Fixture id="slider-focus" caption={S.focus} sim="focus">
          <SliderFixture />
        </Fixture>
        <Fixture id="slider-disabled" caption={S.disabled}>
          <SliderFixture disabled />
        </Fixture>
      </Section>

      <Section title={ja.gallery.sections.numericField} wide>
        <Fixture id="numeric-default" caption={S.default}>
          <HsNumericField
            label={ja.gallery.samples.tempoLabel}
            value={tempo}
            min={30}
            max={300}
            unit="BPM"
            onChange={setTempo}
          />
        </Fixture>
        <Fixture id="numeric-focus" caption={S.focus} sim="focus">
          <HsNumericField
            label={ja.gallery.samples.tempoLabel}
            value={120}
            unit="BPM"
          />
        </Fixture>
        <Fixture id="numeric-error" caption={S.error}>
          <HsNumericField
            label={ja.gallery.samples.tempoLabel}
            value={999}
            unit="BPM"
            error={ja.gallery.samples.tempoError}
          />
        </Fixture>
        <Fixture id="numeric-disabled" caption={S.disabled}>
          <HsNumericField
            label={ja.gallery.samples.tempoLabel}
            value={120}
            unit="BPM"
            disabled
          />
        </Fixture>
      </Section>

      <Section title={ja.gallery.sections.select} wide>
        <Fixture id="select-default" caption={S.default}>
          <HsSelect
            label={ja.gallery.samples.meterLabel}
            options={meterOptions}
            value={meter}
            onChange={setMeter}
          />
        </Fixture>
        <Fixture id="select-focus" caption={S.focus} sim="focus">
          <HsSelect
            label={ja.gallery.samples.meterLabel}
            options={meterOptions}
            value="4/4"
          />
        </Fixture>
        <Fixture id="select-error" caption={S.error}>
          <HsSelect
            label={ja.gallery.samples.meterLabel}
            options={meterOptions}
            placeholder={ja.gallery.samples.meterLabel}
            error={ja.gallery.samples.meterError}
          />
        </Fixture>
        <Fixture id="select-disabled" caption={S.disabled}>
          <HsSelect
            label={ja.gallery.samples.meterLabel}
            options={meterOptions}
            value="4/4"
            disabled
          />
        </Fixture>
      </Section>
    </>
  );
}

function ProgressSection() {
  return (
    <Section title={ja.gallery.sections.progress} wide>
      <Fixture id="progress-determinate" caption={S.default}>
        <HsProgress label={ja.gallery.samples.progressLabel} value={0.62} />
      </Fixture>
      <Fixture id="progress-indeterminate" caption={S.loading}>
        <HsProgress
          label={ja.gallery.samples.progressLabel}
          description={ja.gallery.samples.progressStage}
        />
      </Fixture>
      <Fixture id="progress-done" caption={ja.gallery.samples.progressDone}>
        <HsProgress label={ja.gallery.samples.progressLabel} value={1} />
      </Fixture>
      <Fixture id="progress-error" caption={S.error}>
        <HsProgress
          label={ja.gallery.samples.progressLabel}
          value={0.4}
          error={ja.gallery.samples.progressError}
        />
      </Fixture>
    </Section>
  );
}

function BadgeSection() {
  return (
    <Section title={ja.gallery.sections.badge}>
      <Fixture id="badge-success" caption="success">
        <StatusBadge
          tone="success"
          icon={<CheckmarkCircle16Regular />}
          label={ja.gallery.samples.toolFound}
        />
      </Fixture>
      <Fixture id="badge-info" caption="info">
        <StatusBadge
          tone="info"
          icon={<Info16Regular />}
          label={ja.gallery.samples.toolChecking}
        />
      </Fixture>
      <Fixture id="badge-warning" caption="warning">
        <StatusBadge
          tone="warning"
          icon={<Warning16Regular />}
          label={ja.gallery.samples.infoNotice}
        />
      </Fixture>
      <Fixture id="badge-error" caption="error">
        <StatusBadge
          tone="error"
          icon={<ErrorCircle16Regular />}
          label={ja.gallery.samples.toolMissing}
        />
      </Fixture>
      <Fixture id="badge-neutral" caption="neutral">
        <StatusBadge tone="neutral" label={ja.app.name} />
      </Fixture>
      <Fixture id="badge-review-needs" caption={ja.reviewBadge.needsReview}>
        <ReviewBadge status="needsReview" count={12} />
      </Fixture>
      <Fixture id="badge-review-accepted" caption={ja.reviewBadge.accepted}>
        <ReviewBadge status="accepted" />
      </Fixture>
      <Fixture id="badge-review-dismissed" caption={ja.reviewBadge.dismissed}>
        <ReviewBadge status="dismissed" />
      </Fixture>
      <Fixture id="badge-review-fixed" caption={ja.reviewBadge.fixed}>
        <ReviewBadge status="fixed" />
      </Fixture>
    </Section>
  );
}

function PanelSection() {
  return (
    <Section title={ja.gallery.sections.panel} wide>
      <Fixture id="panel-default" caption={S.default} stageClass="hs-fixture__stage--stretch">
        <HsPanel
          title={ja.gallery.samples.panelTitle}
          onClose={() => undefined}
          className="hs-fixture-card"
        >
          <p className="hs-fixture-card__text">
            {ja.gallery.samples.panelBody}
          </p>
        </HsPanel>
      </Fixture>
      <Fixture id="panel-elevated" caption={ja.gallery.samples.floatingPanelTitle} stageClass="hs-fixture__stage--stretch">
        <HsPanel
          title={ja.gallery.samples.floatingPanelTitle}
          elevated
          className="hs-fixture-card"
        >
          <p className="hs-fixture-card__text">
            {ja.gallery.samples.panelBody}
          </p>
        </HsPanel>
      </Fixture>
    </Section>
  );
}

/* ----------------------- screen-state fixture cards ----------------------- */

function ScreenFixtures() {
  return (
    <Section title={ja.gallery.sections.fixtures} wide>
      <Fixture id="screen-empty" caption={ja.gallery.samples.fixtureEmpty} stageClass="hs-fixture__stage--stretch">
        <HsPanel className="hs-fixture-card">
          <p className="hs-fixture-card__title">{ja.emptyState.title}</p>
          <p className="hs-fixture-card__text">{ja.emptyState.formats}</p>
          <div className="hs-fixture-card__actions">
            <HsButton variant="primary">{ja.emptyState.open}</HsButton>
          </div>
        </HsPanel>
      </Fixture>

      <Fixture id="screen-transcribing" caption={ja.gallery.samples.fixtureTranscribing} stageClass="hs-fixture__stage--stretch">
        <HsPanel className="hs-fixture-card" title={ja.gallery.samples.fixtureTranscribing}>
          {/* Real production classes (UI-040 TranscriptionView):
              hs-stage-list__item + data-state drive glyph/weight/color. */}
          <ul className="hs-stage-list">
            <li className="hs-stage-list__item" data-state="done">
              <span className="hs-stage-list__icon" aria-hidden="true">✓</span>
              {ja.gallery.samples.stageDone}
            </li>
            <li className="hs-stage-list__item" data-state="active" aria-current="step">
              <span className="hs-stage-list__icon" aria-hidden="true">●</span>
              {ja.gallery.samples.stageActive}
            </li>
            <li className="hs-stage-list__item" data-state="pending">
              <span className="hs-stage-list__icon" aria-hidden="true">○</span>
              {ja.gallery.samples.stagePending1}
            </li>
            <li className="hs-stage-list__item" data-state="pending">
              <span className="hs-stage-list__icon" aria-hidden="true">○</span>
              {ja.gallery.samples.stagePending2}
            </li>
            <li className="hs-stage-list__item" data-state="pending">
              <span className="hs-stage-list__icon" aria-hidden="true">○</span>
              {ja.gallery.samples.stagePending3}
            </li>
          </ul>
          <HsProgress label={ja.gallery.samples.progressLabel} />
          <div className="hs-fixture-card__actions">
            <HsButton variant="secondary">{ja.common.cancel}</HsButton>
          </div>
        </HsPanel>
      </Fixture>

      <Fixture id="screen-review" caption={ja.gallery.samples.fixtureReview} stageClass="hs-fixture__stage--stretch">
        <HsPanel className="hs-fixture-card" title={ja.gallery.samples.reviewPosition}>
          <ReviewBadge status="needsReview" />
          <p className="hs-fixture-card__title">
            {ja.gallery.samples.reviewReason}
          </p>
          <p className="hs-fixture-card__text">
            {ja.gallery.samples.reviewBanner}
          </p>
          <div className="hs-fixture-card__actions">
            <HsButton variant="secondary">{ja.common.prev}</HsButton>
            <HsButton variant="secondary">
              {ja.gallery.samples.playSource}
            </HsButton>
            <HsButton variant="primary">{ja.gallery.samples.markOk}</HsButton>
            <HsButton variant="secondary">{ja.common.next}</HsButton>
          </div>
        </HsPanel>
      </Fixture>

      <Fixture id="screen-error" caption={ja.gallery.samples.fixtureError} stageClass="hs-fixture__stage--stretch">
        <HsPanel className="hs-fixture-card">
          <StatusBadge
            tone="error"
            icon={<ErrorCircle16Regular />}
            label={ja.gallery.samples.fixtureError}
          />
          <p className="hs-fixture-card__title">
            {ja.gallery.samples.errorTitle}
          </p>
          <p className="hs-fixture-card__text">
            {ja.gallery.samples.errorBody}
          </p>
          <div className="hs-fixture-card__actions">
            <HsButton variant="primary">
              {ja.gallery.samples.errorAction}
            </HsButton>
            <HsButton variant="secondary">{ja.common.close}</HsButton>
          </div>
        </HsPanel>
      </Fixture>

      <Fixture id="screen-export" caption={ja.gallery.samples.fixtureExport} stageClass="hs-fixture__stage--stretch">
        <HsPanel className="hs-fixture-card" title={ja.gallery.samples.sheetTitle}>
          <Checkbox label={ja.gallery.samples.exportScore} defaultChecked />
          <Checkbox label={ja.gallery.samples.exportHorn} defaultChecked />
          <Checkbox label={ja.gallery.samples.exportPdf} />
          <Checkbox label={ja.gallery.samples.exportMidi} defaultChecked />
          <div className="hs-fixture-card__actions">
            <HsButton variant="secondary">{ja.common.cancel}</HsButton>
            <HsButton variant="primary">
              {ja.gallery.samples.sheetSubmit}
            </HsButton>
          </div>
        </HsPanel>
      </Fixture>
    </Section>
  );
}

/* -------------------- import-state fixtures (UI-020) --------------------
 * The real ImportScreenBody driven by static ImportView fixtures — the
 * same component the workspace renders, so these cells are the visual
 * regression surface for EMPTY / OPENING_AUDIO / AUDIO_READY /
 * AUDIO_ERROR / SOURCE_MISSING (§3/§4/§20). */

const NOOP = () => undefined;

const FIXTURE_AUDIO: LoadedAudio = {
  ref: { kind: "path", path: "C:\\audio\\take-03.wav", name: "take-03.wav" },
  fileName: "take-03.wav",
  format: "wav",
  sizeBytes: 14_680_064,
  durationSeconds: 197.8,
  sampleRate: 44_100,
  peaks: [0.2, 0.5, 0.8, 0.4],
  mediaSource: { kind: "blob", blob: new Blob() },
};

const FIXTURE_PROJECT = {
  path: "C:\\music\\etude.hornscribe.json",
  projectId: "fixture-project",
  name: "etude",
  sourcePath: "C:\\audio\\etude-source.flac",
  sourceHash: "a1b2c3",
  scoreResult: null,
  transcriptionSettings: null,
};

function importFixtureView(overrides: Partial<ImportView>): ImportView {
  return {
    audio: null,
    openingLabel: null,
    openingKind: null,
    issue: null,
    sourceMissing: null,
    recentProjects: [],
    options: DEFAULT_TRANSCRIPTION_OPTIONS,
    onOpenAudio: NOOP,
    onOpenProject: NOOP,
    onRemoveRecent: NOOP,
    onPickRelink: NOOP,
    onDismissError: NOOP,
    onOptionsChange: NOOP,
    ...overrides,
  };
}

function ImportStateFixtures() {
  return (
    <Section title={ja.gallery.sections.importStates} wide>
      <Fixture id="import-empty" caption={ja.gallery.samples.fixtureEmpty} stageClass="hs-fixture__stage--stretch">
        <div className="hs-score hs-fixture-score">
          <ImportScreenBody
            screen="empty"
            view={importFixtureView({
              recentProjects: [
                { name: "etude", path: FIXTURE_PROJECT.path, openedAt: 0 },
                {
                  name: "scale-practice",
                  path: "C:\\music\\scale.hornscribe.json",
                  openedAt: 0,
                },
              ],
            })}
            onTranscribe={NOOP}
          />
        </div>
      </Fixture>

      <Fixture id="import-opening" caption={ja.gallery.samples.fixtureOpening} stageClass="hs-fixture__stage--stretch">
        <div className="hs-score hs-fixture-score">
          <ImportScreenBody
            screen="openingAudio"
            view={importFixtureView({
              openingKind: "audio",
              openingLabel: "take-03.wav",
            })}
            onTranscribe={NOOP}
          />
        </div>
      </Fixture>

      <Fixture id="import-audio-ready" caption={ja.gallery.samples.fixtureAudioReady} stageClass="hs-fixture__stage--stretch">
        <div className="hs-score hs-fixture-score">
          <ImportScreenBody
            screen="audioReady"
            view={importFixtureView({ audio: FIXTURE_AUDIO })}
            onTranscribe={NOOP}
          />
        </div>
      </Fixture>

      <Fixture id="import-audio-error" caption={ja.gallery.samples.fixtureError} stageClass="hs-fixture__stage--stretch">
        <div className="hs-score hs-fixture-score">
          <ImportScreenBody
            screen="audioError"
            view={importFixtureView({
              issue: { kind: "unsupported", fileName: "memo.txt" },
            })}
            onTranscribe={NOOP}
          />
        </div>
      </Fixture>

      <Fixture id="import-source-missing" caption={ja.gallery.samples.fixtureSourceMissing} stageClass="hs-fixture__stage--stretch">
        <div className="hs-score hs-fixture-score">
          <ImportScreenBody
            screen="sourceMissing"
            view={importFixtureView({
              sourceMissing: { project: FIXTURE_PROJECT, mismatch: false },
            })}
            onTranscribe={NOOP}
          />
        </div>
      </Fixture>
    </Section>
  );
}

/* ------------------------------ gallery page ------------------------------ */

const THEME_OPTIONS = [
  { value: "system", label: ja.settings.themeSystem },
  { value: "light", label: ja.settings.themeLight },
  { value: "dark", label: ja.settings.themeDark },
] as const;

function PrimitiveSections() {
  return (
    <>
      <ButtonSection />
      <IconButtonSection />
      <SegmentedSection />
      <FieldSection />
      <ProgressSection />
      <BadgeSection />
      <PanelSection />
      <OverlaySection />
      <ScreenFixtures />
      <ImportStateFixtures />
    </>
  );
}

export default function Gallery({
  themeMode,
  onThemeMode,
}: {
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
}) {
  const themes: readonly { id: ResolvedTheme; label: string }[] = [
    { id: "light", label: ja.gallery.themeLight },
    { id: "dark", label: ja.gallery.themeDark },
  ];

  // Open fixtures (menu popover) call scrollIntoView when Fluent autofocuses
  // the first item on mount; pin the gallery scroll to the top so the page
  // always opens at the light-theme section. The rAF covers any deferred
  // scroll scheduled after this effect runs.
  useEffect(() => {
    const pin = () => {
      const root = document.querySelector<HTMLElement>(".hs-gallery");
      if (root) root.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    pin();
    const raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="hs-gallery" role="main" aria-label={ja.gallery.title}>
      <header className="hs-gallery__header">
        <h1 className="hs-gallery__title">{ja.gallery.title}</h1>
        <StatusBadge tone="info" label={ja.gallery.devBadge} />
        <span className="hs-gallery__spacer" />
        <SegmentedControl
          options={THEME_OPTIONS}
          value={themeMode}
          onChange={onThemeMode}
          ariaLabel={ja.settings.themeLabel}
        />
        <HsButton
          variant="subtle"
          onClick={() => {
            window.location.hash = "";
          }}
        >
          {ja.common.back}
        </HsButton>
        <p className="hs-gallery__note">{ja.gallery.note}</p>
      </header>

      {themes.map((t) => (
        <section key={t.id} data-hs-theme={t.id} className="hs-gallery__theme">
          <FluentProvider
            theme={t.id === "dark" ? hsDarkTheme : hsLightTheme}
            style={{ display: "contents" }}
          >
            <h2 className="hs-gallery__theme-title">{t.label}</h2>
            <PrimitiveSections />
          </FluentProvider>
        </section>
      ))}
    </div>
  );
}
