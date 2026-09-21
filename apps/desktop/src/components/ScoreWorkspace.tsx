import { Button } from "@fluentui/react-components";
import { FolderOpen24Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";

/**
 * Score workspace — EMPTY state (GUI_UX_SPEC §3, §27).
 * No transcription settings, backend names, FFmpeg/quantizer details, or
 * score tools are surfaced here; just the drop target copy + one CTA.
 */
export function ScoreWorkspace({
  onOpenAudio,
}: {
  onOpenAudio(): void;
}) {
  return (
    <main
      className="hs-score"
      role="region"
      aria-label={ja.score.regionLabel}
      tabIndex={0}
    >
      <div className="hs-empty">
        <p className="hs-empty__title">{ja.emptyState.title}</p>
        <p className="hs-empty__or">{ja.emptyState.or}</p>
        <Button
          appearance="primary"
          size="large"
          icon={<FolderOpen24Regular />}
          onClick={onOpenAudio}
        >
          {ja.emptyState.open}
        </Button>
        <p className="hs-empty__formats">{ja.emptyState.formats}</p>
        <p className="hs-empty__privacy">{ja.emptyState.privacy}</p>
      </div>
    </main>
  );
}
