/**
 * #12: 区間ラベル(Aメロ/サビ/ソロ等) — 波形の選択範囲に名前を付けて
 * プロジェクトに残す仕組み。
 *
 * ラベルはオーディオ時間軸の区間(startSec–endSec)に付く。保持先は
 * プロジェクト JSON のトップレベル extra `regionLabels` — v1 バリデータ
 * は extras を無視し、Python 側 HornScribeProject.extras も未知キーを
 * そのまま往復させる(model.py の _SCHEMA_KEYS 外は保存される)。
 *
 * ここにあるのは純粋な変換だけ — UI 状態は App が持ち、dirty 判定は
 * dirtyFingerprint の labels 入力が担う。
 */

export interface RegionLabel {
  /** 安定キー(id はファイルに残さず、復元時に再採番してもよい)。 */
  readonly id: string;
  readonly label: string;
  readonly startSec: number;
  readonly endSec: number;
}

/** UI 表示用に絞ったラベル名の上限。 */
export const REGION_LABEL_MAX_LEN = 24;

let nextLabelId = 1;

/** 新規ラベルを組み立てる — 範囲は秒、名前は trim + 上限で正規化。 */
export function makeRegionLabel(
  label: string,
  startSec: number,
  endSec: number,
): RegionLabel | null {
  const name = label.trim().slice(0, REGION_LABEL_MAX_LEN);
  const start = Math.min(startSec, endSec);
  const end = Math.max(startSec, endSec);
  if (name === "" || !(end > start) || !(start >= 0)) return null;
  return {
    id: `rl-${nextLabelId++}`,
    label: name,
    startSec: start,
    endSec: end,
  };
}

/** プロジェクト extras → RegionLabel[](壊れた行は捨てる — 読めない
 *  extra で開く操作全体を落とさない)。 */
export function parseRegionLabels(raw: unknown): readonly RegionLabel[] {
  if (!Array.isArray(raw)) return [];
  const out: RegionLabel[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const label =
      typeof o.label === "string" ? o.label.trim().slice(0, REGION_LABEL_MAX_LEN) : "";
    const startSec = typeof o.startSec === "number" ? o.startSec : NaN;
    const endSec = typeof o.endSec === "number" ? o.endSec : NaN;
    if (label === "" || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      continue;
    }
    const made = makeRegionLabel(label, startSec, endSec);
    if (made) out.push(made);
  }
  // 時間順で安定させる — 表示と書き出しが毎回同じ並びになる。
  return out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

/** RegionLabel[] → プロジェクト extras 用のプレーン配列(id は除く)。 */
export function serializeRegionLabels(
  labels: readonly RegionLabel[],
): Record<string, unknown>[] {
  return labels.map((l) => ({
    label: l.label,
    startSec: l.startSec,
    endSec: l.endSec,
  }));
}

/** dirtyFingerprint 用の正準文字列 — 並び順は時間順で固定。 */
export function regionLabelsFingerprint(labels: readonly RegionLabel[]): string {
  const sorted = [...labels].sort(
    (a, b) => a.startSec - b.startSec || a.endSec - b.endSec || (a.label < b.label ? -1 : 1),
  );
  return JSON.stringify(sorted.map((l) => [l.label, l.startSec, l.endSec]));
}
