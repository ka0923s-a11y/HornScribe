/**
 * #12: 区間ラベルバー — 波形直下のラベル一覧。
 *
 * Aメロ/サビ/ソロのような構造単位を区間に名付けて残す。チップを
 * クリックするとその区間が波形バンドに選択され(ループ/再生は既存の
 * 選択操作がそのまま効く)、↻ でその区間だけを再採譜できる。
 */
import { useState } from "react";
import {
  Add24Regular,
  ArrowClockwise24Regular,
  Dismiss24Regular,
} from "@fluentui/react-icons";
import { HsButton, HsIconButton } from "./primitives";
import { ja } from "../strings/ja";
import { formatTimecode } from "../import/format";
import type { SelectionRange } from "../import/selection";
import type { RegionLabel } from "../workspace/regionLabels";

export function RegionLabelsBar({
  labels,
  selection,
  onAdd,
  onPick,
  onRetranscribe,
  onRemove,
}: {
  labels: readonly RegionLabel[];
  /** 現在の波形選択バンド — これに名前を付けてラベル化する。 */
  selection: SelectionRange | null;
  onAdd(range: SelectionRange, name: string): void;
  onPick(label: RegionLabel): void;
  onRetranscribe(label: RegionLabel): void;
  onRemove(id: string): void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const commit = () => {
    if (!selection) return;
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd(selection, trimmed);
    setName("");
    setAdding(false);
  };

  return (
    <div className="hs-labels" aria-label={ja.regionLabels.title}>
      {labels.map((l) => (
        <span key={l.id} className="hs-labels__chip">
          <button
            type="button"
            className="hs-labels__pick"
            title={`${l.label} ${formatTimecode(l.startSec)}–${formatTimecode(l.endSec)}`}
            onClick={() => onPick(l)}
          >
            {l.label}
          </button>
          <HsIconButton
            label={ja.regionLabels.retranscribe}
            icon={<ArrowClockwise24Regular />}
            size="small"
            onClick={() => onRetranscribe(l)}
          />
          <HsIconButton
            label={ja.regionLabels.remove}
            icon={<Dismiss24Regular />}
            size="small"
            onClick={() => onRemove(l.id)}
          />
        </span>
      ))}
      {adding ? (
        <span className="hs-labels__editor">
          <input
            className="hs-labels__input"
            value={name}
            maxLength={24}
            placeholder={ja.regionLabels.namePlaceholder}
            aria-label={ja.regionLabels.nameAria}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setAdding(false);
                setName("");
              }
            }}
          />
          <HsButton size="small" variant="primary" onClick={commit}>
            {ja.regionLabels.addConfirm}
          </HsButton>
        </span>
      ) : (
        <HsButton
          size="small"
          variant="subtle"
          icon={<Add24Regular />}
          disabled={!selection}
          ariaLabel={
            selection ? ja.regionLabels.add : ja.regionLabels.needSelection
          }
          onClick={() => setAdding(true)}
        >
          {ja.regionLabels.add}
        </HsButton>
      )}
    </div>
  );
}
