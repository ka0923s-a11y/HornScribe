import json
from pathlib import Path
REPO = Path(r"C:\Users\ka092\Desktop\HornScribe")
m = json.loads((REPO/"_migrate_map.json").read_text(encoding="utf-8"))
rows = sorted(m.items(), key=lambda kv: (kv[1]["new"] or 9999))
lines = []
lines.append("## リポジトリ移行の記録")
lines.append("")
lines.append("旧リポジトリ `ka0923s-a11y/HornScribe`（およびその前身 `bolph71656-ai/HornScribe`）は所有者アカウント停止により完全に消失しました。このリポジトリ (aaw123m/horn) へローカル clone とローカル保存のダンプから復元しました。")
lines.append("")
lines.append("### 復元されたもの")
lines.append("")
lines.append("- **コード**: main + 全ブランチ (~100) + 全タグ (v0.1.0〜v0.2.14) を完全 push（履歴同一 SHA）")
lines.append("- **リリース**: v0.1.0〜v0.2.14 の全16件をアセット付きで再作成（ポータブル zip + demucs アドオン。NSIS インストーラーはローカル残存なしのため未同梱）")
lines.append("- **issue**: タイトル・状態・ラベルが残存していた全 issue を下表の通り再作成。本文/コメントはローカル残存ドラフトから可能な限り復元")
lines.append("")
lines.append("### 復元できなかったもの")
lines.append("")
lines.append("- ダンプ未保存の issue 本文・コメント大半（タイトル一覧のみ残った issue は本文欄に注記）")
lines.append("- PR ページの本文・レビューコメント（マージコミットのタイトルに (`#NNN`) 形式で記録が残ります）")
lines.append("- リリースの `*-setup.exe`（NSIS インストーラー）— リビルドは `scripts/release.py` で可能")
lines.append("- ローカルに `HornScribe-full.bundle`（全 ref・全履歴のバンドル）と issue ドラフト原本を保存")
lines.append("")
lines.append("### 新旧 issue 番号対応表")
lines.append("")
lines.append("| 旧 # | 新 # | タイトル |")
lines.append("|---|---|---|")
for k, v in rows:
    old = v["old"] if v["old"] is not None else "(番号不明)"
    lines.append("| " + str(old) + " | #" + str(v["new"]) + " | " + v["title"].replace("|", "\\|") + " |")
(REPO/"_migrate_index_body.md").write_text("\n".join(lines), encoding="utf-8")
print(len(rows), "rows")

