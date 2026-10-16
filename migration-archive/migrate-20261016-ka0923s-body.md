## リポジトリ移行の記録（第2回）

移行先だった `aaw123m/horn` が GitHub アカウント `aaw123m` の凍結（suspended）により完全にアクセス不能になりました（2026-10-16 確認）。このリポジトリ `ka0923s-a11y/HornScribe` は生存していたため、ローカル clone からの復旧先としてここへ戻りました。

前回の移行記録: 旧 `bolph71656-ai/HornScribe` → 本リポジトリ（2026-09-26 頃）。その後 `aaw123m/horn` へ移行（2026-10-10 頃、記録 issue は同リポジトリ #94）→ 本復旧（2026-10-16）。

### 復旧したもの

- **コード**: main を fast-forward（9e7d0e21 → 23eefb8e、+148 commits、SHA 同一）。全ローカルブランチ（codex/*, fix/* 等）を push。タグ v0.2.15〜v0.2.28 を push
- **リリース**: v0.2.15〜v0.2.28 をアセット付きで再作成（NSIS setup.exe + portable zip + v0.2.25 以降は demucs addon zip）。v0.2.14 以前は既存のまま
- **issue**: aaw123m 時代にコミットから参照されているネイティブ issue 56 件を下表の通り再作成（作成後にクローズ。本文はローカルドラフトまたはマージコミットから再構成）
- **バックアップ**: ローカルに `HornScribe-full-20261016.bundle`（全 ref・全履歴 2.9GB、verify 済み）を作成済み

### 復旧できなかったもの

- aaw123m/horn の issue 本文・コメント・PR レビュー本文（凍結のため取得不能。ローカルドラフト存分のみ再現）
- aaw123m/horn 側でコミット参照のない issue（凍結のため列挙不能 — 存在する場合は未復元）
- タグ v0.1.0（ツリー内の `.github/workflows/ci.yml` が OAuth トークンの workflow スコープ不足で push 拒否。ローカルと bundle には存在）
- v0.2.15 以降のリリースノートは各タグの `.github/RELEASE_NOTES.md` から復元

### issue 番号対応表（aaw123m/horn → 本リポジトリ）

| 旧 (aaw123m/horn) | 新 (ka0923s-a11y/HornScribe) |
|---|---|
| aaw123m/horn#155 | #268 |
| aaw123m/horn#165 | #269 |
| aaw123m/horn#167 | #270 |
| aaw123m/horn#169 | #271 |
| aaw123m/horn#171 | #272 |
| aaw123m/horn#172 | #273 |
| aaw123m/horn#177 | #274 |
| aaw123m/horn#179 | #275 |
| aaw123m/horn#181 | #276 |
| aaw123m/horn#183 | #277 |
| aaw123m/horn#185 | #278 |
| aaw123m/horn#187 | #279 |
| aaw123m/horn#189 | #280 |
| aaw123m/horn#191 | #281 |
| aaw123m/horn#193 | #282 |
| aaw123m/horn#195 | #283 |
| aaw123m/horn#197 | #284 |
| aaw123m/horn#199 | #285 |
| aaw123m/horn#200 | #286 |
| aaw123m/horn#204 | #287 |
| aaw123m/horn#205 | #288 |
| aaw123m/horn#207 | #289 |
| aaw123m/horn#209 | #290 |
| aaw123m/horn#212 | #291 |
| aaw123m/horn#214 | #292 |
| aaw123m/horn#215 | #293 |
| aaw123m/horn#217 | #294 |
| aaw123m/horn#219 | #295 |
| aaw123m/horn#221 | #296 |
| aaw123m/horn#223 | #297 |
| aaw123m/horn#225 | #298 |
| aaw123m/horn#227 | #299 |
| aaw123m/horn#228 | #300 |
| aaw123m/horn#230 | #301 |
| aaw123m/horn#232 | #302 |
| aaw123m/horn#234 | #303 |
| aaw123m/horn#236 | #304 |
| aaw123m/horn#238 | #305 |
| aaw123m/horn#241 | #306 |
| aaw123m/horn#243 | #307 |
| aaw123m/horn#246 | #308 |
| aaw123m/horn#247 | #309 |
| aaw123m/horn#249 | #310 |
| aaw123m/horn#254 | #311 |
| aaw123m/horn#256 | #312 |
| aaw123m/horn#258 | #313 |
| aaw123m/horn#260 | #314 |
| aaw123m/horn#262 | #315 |
| aaw123m/horn#263 | #316 |
| aaw123m/horn#266 | #317 |
| aaw123m/horn#268 | #318 |
| aaw123m/horn#270 | #319 |
| aaw123m/horn#272 | #320 |
| aaw123m/horn#274 | #321 |
| aaw123m/horn#276 | #322 |
| aaw123m/horn#278 | #323 |

### 補足

- 本リポジトリの既存 issue (#1〜#267) は移行前のオリジナル履歴であり、番号体系は aaw123m 側とは独立です。aaw123m 側 #1〜#93 は旧リポジトリからの復元コピーだったため、ここでは再作成していません（原本が本リポジトリに既存）
- コミットメッセージ内の `(#NNN)` 参照は aaw123m 側の番号です — 対応は上表を参照してください
- Codex アプリの GitHub コネクタは依然 `aaw123m` として認証済みのため要再接続（gh CLI は `ka0923s-a11y` に切替済み）
