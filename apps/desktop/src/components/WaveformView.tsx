import { ja } from "../strings/ja";

/**
 * Waveform / timeline region placeholder (GUI_UX_SPEC §2, §8).
 * 96px standard height; keyboard-focusable because this region will become
 * interactive (click→seek, drag→select, Ctrl+wheel→zoom).
 */
export function WaveformView() {
  return (
    <div
      className="hs-waveform"
      role="region"
      aria-label={ja.waveform.regionLabel}
      data-hs-focus-zone="waveform"
      tabIndex={0}
    >
      {ja.waveform.placeholder}
    </div>
  );
}
