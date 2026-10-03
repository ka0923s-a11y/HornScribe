/**
 * #59: 採譜キューエントリの params 要約 — buildTranscriptionParams は
 * 既定値を emit しない設計なので、params に存在するキーは全て
 * ユーザーがピンした設定。行のサブタイトルとして読める短い断片に
 * 分解し、全既定なら空文字を返す(行は静かなまま)。
 */
import type { TranscriptionJobParams } from "../import/transcriptionParams";
import { formatTimecode } from "../import/format";
import { ja } from "../strings/ja";

const MIN_DURATION_LABEL: Record<string, string> = {
  "8": ja.import.audioOptions.minDuration8,
  "16": ja.import.audioOptions.minDuration16,
  "32": ja.import.audioOptions.minDuration32,
};

export function queueParamSummary(params: TranscriptionJobParams): string {
  const f: string[] = [];
  if (params.range === "selection") {
    f.push(
      ja.queue.paramsRange(
        formatTimecode(params.selectionStartSec ?? 0),
        formatTimecode(params.selectionEndSec ?? 0),
      ),
    );
  }
  if (params.texture) {
    f.push(ja.queue.paramsTexture[params.texture] ?? params.texture);
  }
  if (params.maxVoices != null) {
    f.push(ja.queue.paramsMaxVoices(params.maxVoices));
  }
  if (params.backend) {
    f.push(params.backend === "pyin" ? "pYIN" : "Basic Pitch");
  }
  if (params.vocalIsolation) f.push(ja.queue.paramsVocalIsolation);
  /* #181: the tier tag only means something under isolation — a bare
   * vocalIsolationQuality param is ignored by the engine, so the
   * summary must not claim it either. */
  if (params.vocalIsolation && params.vocalIsolationQuality === "precision")
    f.push(ja.queue.paramsVocalIsolationPrecision);
  if (params.tempoBpm != null) f.push(ja.queue.paramsTempo(params.tempoBpm));
  if (params.meter) f.push(params.meter);
  if (params.keyHint) f.push(ja.queue.paramsKey(params.keyHint));
  if (params.minDuration) {
    f.push(MIN_DURATION_LABEL[params.minDuration] ?? params.minDuration);
  }
  if (params.triplets) {
    f.push(ja.queue.paramsTriplets[params.triplets] ?? params.triplets);
  }
  if (params.simplicity) {
    f.push(ja.queue.paramsSimplicity[params.simplicity] ?? params.simplicity);
  }
  return f.join(ja.queue.paramSep);
}
