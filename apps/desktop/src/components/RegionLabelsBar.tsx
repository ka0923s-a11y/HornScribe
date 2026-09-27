/**
 * #12: 区間ラベルバー — 波形直下のラベル一覧。
 *
 * Aメロ/サビ/ソロのような構造単位を区間に名付けて残す。チップを
 * クリックするとその区間が波形バンドに選択され(ループ/再生は既存の
 * 選択操作がそのまま効く)、↻ でその区間だけを再採譜できる。
 * #51: ✎ で名前の変更と「現在の選択を範囲に適用」の付け直しができる。
 */
import { useState } from "react";
import {
  Add24Regular,
  ArrowClockwise24Regular,
  Dismiss24Regular,
  Edit24Regular,
  TableSelectRange24Regular,
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
  onRename,
  onApplySelection,
}: {
  labels: readonly RegionLabel[];
  /** 現在の波形選択バンド — これに名前を付けてラベル化する。 */
  selection: SelectionRange | null;
  onAdd(range: SelectionRange, name: string): void;
  onPick(label: RegionLabel): void;
  onRetranscribe(label: RegionLabel): void;
  onRemove(id: string): void;
  /** #51: 名前の変更 — 空文字は正規化側で握りつぶされる。 */
  onRename(id: string, name: string): void;
  /** #51: 現在の選択範囲をこのラベルの区間として適用する。 */
  onApplySelection(id: string, range: SelectionRange): void;
}) {
  const [editor, setEditor] = useState<
    { kind: "add" } | { kind: "edit"; id: string } | null
  >(null);
  const [name, setName] = useState("");

  const close = () => {
    setEditor(null);
    setName("");
  };

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      // 空は「変更なし」として閉じる — add では無効、edit では取消。
      close();
      return;
    }
    if (editor?.kind === "add") {
      if (selection) onAdd(selection, trimmed);
    } else if (editor?.kind === "edit") {
      onRename(editor.id, trimmed);
    }
    close();
  };

  const editorField = (
    <>
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
          if (e.key === "Escape") close();
        }}
      />
      <HsButton size="small" variant="primary" onClick={commit}>
        {editor?.kind === "edit"
          ? ja.regionLabels.editConfirm
          : ja.regionLabels.addConfirm}
      </HsButton>
    </>
  );

  return (
    <div className="hs-labels" aria-label={ja.regionLabels.title}>
      {labels.map((l) =>
        editor?.kind === "edit" && editor.id === l.id ? (
          <span key={l.id} className="hs-labels__editor">
            {editorField}
            {/* #51: 波形選択をそのまま新しい範囲として適用 */}
            <HsIconButton
              label={ja.regionLabels.applySelection}
              icon={<TableSelectRange24Regular />}
              size="small"
              disabled={!selection}
              onClick={() => {
                if (selection) onApplySelection(l.id, selection);
              }}
            />
          </span>
        ) : (
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
              label={ja.regionLabels.edit}
              icon={<Edit24Regular />}
              size="small"
              onClick={() => {
                setName(l.label);
                setEditor({ kind: "edit", id: l.id });
              }}
            />
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
        ),
      )}
      {editor?.kind === "add" ? (
        <span className="hs-labels__editor">{editorField}</span>
      ) : (
        <HsButton
          size="small"
          variant="subtle"
          icon={<Add24Regular />}
          disabled={!selection}
          ariaLabel={
            selection ? ja.regionLabels.add : ja.regionLabels.needSelection
          }
          onClick={() => {
            setName("");
            setEditor({ kind: "add" });
          }}
        >
          {ja.regionLabels.add}
        </HsButton>
      )}
    </div>
  );
}
