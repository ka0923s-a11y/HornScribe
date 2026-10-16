## リポジトリ移行の記録

旧リポジトリ `ka0923s-a11y/HornScribe`（およびその前身 `bolph71656-ai/HornScribe`）は所有者アカウント停止により完全に消失しました。このリポジトリ (aaw123m/horn) へローカル clone とローカル保存のダンプから復元しました。

### 復元されたもの

- **コード**: main + 全ブランチ (~100) + 全タグ (v0.1.0〜v0.2.14) を完全 push（履歴同一 SHA）
- **リリース**: v0.1.0〜v0.2.14 の全16件をアセット付きで再作成（ポータブル zip + demucs アドオン。NSIS インストーラーはローカル残存なしのため未同梱）
- **issue**: タイトル・状態・ラベルが残存していた全 issue を下表の通り再作成。本文/コメントはローカル残存ドラフトから可能な限り復元

### 復元できなかったもの

- ダンプ未保存の issue 本文・コメント大半（タイトル一覧のみ残った issue は本文欄に注記）
- PR ページの本文・レビューコメント（マージコミットのタイトルに (`#NNN`) 形式で記録が残ります）
- `*-setup.exe`（NSIS インストーラー）— **v0.2.14 はタグから再ビルドして同梱済み**（gnu ツールチェーン + WebView2Loader.dll 含有を 7z で検証）。他バージョンはローカル残存なし — `scripts/release.py` で再生成可能

- **ドラフト原本アーカイブ**: ブランチ `archive/issue-drafts` の `migration-archive/` にローカル残存の全 issue/PR ドラフト・コメント・移行ツールを原本コミット
- **継続中の PR**: PR #95（旧リポジトリの PR #267 相当 — octave 監査・triplet severity 分離・meter runner-up）
- ローカルに `HornScribe-full.bundle`（全 ref・全履歴のバンドル）と issue ドラフト原本を保存

### 新旧 issue 番号対応表

| 旧 # | 新 # | タイトル |
|---|---|---|
| 2 | #1 | docs: GitHub Actions を使わないローカルリリース手順/runbook の整備 |
| 21 | #2 | [orig #351] 録音・再生機能の残件整理（device/pause/保護） |
| 42 | #3 | 録音開始前の入力モニター(プリレコ・レベルメーター) |
| 44 | #4 | export: MusicXML コードシンボル (<harmony>) エクスポート |
| 63 | #5 | 録音中もコマンド未経由の採譜・キュー追加経路が発火できる |
| 69 | #6 | 録音開始待ちの間 UI が実体のない「録音中」になる (phantom recording state) |
| 97 | #7 | fix: 録音開始時に元音源の再生が止まらず録音に混入する |
| 99 | #8 | feat: 録音開始カウントイン(ループバック切替・楽器準備の猶予) |
| 100 | #9 | feat: ループバック録音は全ミックス対象 — 対象アプリ限定キャプチャの検討 + 注意喚起 |
| 102 | #10 | ux: ほぼ無音の録音も確認なく音源として取り込まれる |
| 104 | #11 | feat: 参照音源を聴きながら録音するプレイアロングモード(マイク) |
| 105 | #12 | feat: 録音中のライブ波形表示 |
| 118 | #13 | feat: 録音開始のキーボードショートカット(Ctrl+R — 前回と同じソース) |
| 120 | #14 | fix: ダークテーマでスコア紙面上のUIテキストが不可視 — 空/採譜中/エラー状態が読めない |
| 123 | #15 | feat: スコア編集 単旋律にまとめる (voices/chords → ソロF管パート) |
| 125 | #16 | fix: ScoreReadyWorkspace の状態ミラー effect が無限再レンダー (onStateChange 不安定 dep) |
| 127 | #17 | fix: melody テクスチャで持続音の分割断片を同ピッチマージで修復 (JPOP ミックス) |
| 129 | #18 | review候補: mono テクスチャでも持続音の分割断片が起こり得るか (実録音で要観測) |
| 130 | #19 | 精度: 同音域ピッチド伴奏が旋律枠を掠める (jpop-mix-hard 実測 pitch 89-92%) |
| 131 | #20 | bench: swing-4-4 の onset F1 は straight 記譜と swung 真値の計測モデル不整合 |
| 137 | #21 | リリース手順が存在しない GitHub Actions ワークフロー前提 — ローカル完結の正式リリース経路が必要 |
| 138 | #22 | fix: process loopback crashes on activation (0xC0000374) + GetMixFormat E_NOTIMPL + session list always empty |
| 141 | #23 | release: v0.2.0 が起動不能 — WebView2Loader.dll 未同梱 (インストーラ/ポータブル両方) |
| 143 | #24 | engine: prefer=top が伴奏ストラムの高音を旋律として採用する (jpop-mix-hard pitch 0.9474) |
| 147 | #25 | release: v0.2.0 の起動不能バイナリがダウンロード可能なまま残っている (v0.2.1 アセットは実機検証で正常) |
| 148 | #26 | dev: #/dev/state/* と #/dev/transcribing で採譜が動かない — dev state が音源スロットを seed しない (#219 ゲート以降) |
| 149 | #27 | fix(audio): sha256_file の 1MiB スタックバッファで録音/取り込み時に 0xC00000FD クラッシュ |
| 153 | #28 | ux(errors): NO_PITCHED_CONTENT に専用コピーと回復導線を出す |
| 155 | #29 | fix(engine): job.start がウォームアップ import で 10s タイムアウトし初回採譜が必ず失敗する |
| 156 | #30 | feat(instruments): B♭ 管（トランペット/クラリネット等）対応 |
| 163 | #31 | 白抜きUI: ダークテーマで楽譜紙面上のテキスト・ボタンが不可視 |
| 165 | #32 | 採譜精度の限界: -9.5dB 級の埋もれた主旋律で残り約10%が取れない（SNR下限） |
| 166 | #33 | 録音停止後すぐ採譜へ進める導線（record → transcribe のワンクリック化） |
| 167 | #34 | レビュー改善: 同じ要確認理由が連続する場合のまとめ処理 |
| 169 | #35 | demucs が非ボーカル入力で無音 stem を返し vocalIsolation が壊滅する |
| 172 | #36 | copyDrift: noPitchedContent がコピーデッキ未登録で main が赤い |
| 177 | #37 | パッケージ版でアプリを閉じれない(X・Alt+F4・終了確認が全て無反応) — allow-destroy 未付与 |
| 179 | #38 | エンジン系コマンドのブロッキング I/O が UI(メインスレッド)を凍らせ得る — writer スレッド化と終了時の上限付き待機 |
| 181 | #39 | ボーカル分離の品質ティア — htdemucs_ft + shift 平均の「高精度」オプションを追加 |
| 184 | #40 | エンジン起動: onefile 解凍 (~40-50s) が handshake タイムアウト (30s) を超え、正常起動中を誤「応答していません」にする |
| 185 | #41 | engine kill が PyInstaller 孫プロセスを孤児化 — ハング採譜が裏で走り続ける |
| 186 | #42 | frozen engine を onefile → onedir 化してコールドスタートを大幅短縮 |
| 189 | #43 | 分離品質セレクトが demucs 未導入環境で無効なのに有効に見える — capabilities で制御 |
| 190 | #44 | demucs のオンデマンド導入経路 — 任意DLのアドオン zip で無料分離強化を実現 |
| 191 | #45 | 低 SNR 音源で採譜抜けの可能性をユーザーに伝える表示 |
| 192 | #46 | アプリを閉じられない — JS ハングとメインスレッドブロックの2経路で X が完全に無反応になる |
| 193 | #47 | v0.2.8 NSIS インストーラーにエンジン未同梱（63MB・採譜不可）— onedir 化で resources glob がディレクトリをスキップ |
| 199 | #48 | 採譜実行中に「エンジンを再起動」を押せるとジョブが黙って中断される |
| 201 | #49 | テンポ記号の音符グリフが☒化する（CSP font-src が Verovio 埋め込みフォントをブロック） |
| 202 | #50 | 定速曲でも小節ごとにテンポマークが乱立し ±15% ばらつく（ビートトラッカージッターの増幅） |
| 203 | #51 | 主旋律と伴奏を自動で別パートに分けて採譜する（分離ステムの 2 段譜化） |
| 204 | #52 | texture=auto でミックス検出時にボーカル分離を自動適用する（JPOP の既定精度を上げる） |
| 210 | #53 | パート単位の表示切替と抜粋エクスポート（Horn in F 単体譜） |
| 211 | #54 | 伴奏パートの再生音色を主旋律と区別する |
| 212 | #55 | 伴奏パートの出典バッジ（自動分離由来である旨の表示） |
| 213 | #56 | 伴奏パートの和声保持採譜（コードボイシング/ピアノ型/コードトラック） |
| 218 | #57 | requantize がマージされたポリフォニックパート（chords/伴奏）の和音を単旋律化する |
| 220 | #58 | レビューマーカーの密度が高すぎて譜面が読めない（同一理由の集約表示が欲しい） |
| 222 | #59 | low_lead_level の案内が到達不能な「高精度再採譲」を勧める（demucs未導入時/既に高精度実行時） |
| 227 | #60 | レビュー案内の画面名・方式名が実装とずれている箇所の修正（accompaniment_part / vocal_isolation_applied） |
| 229 | #61 | demucs 初回モデルダウンロード中、採譜画面が無言で数分間停止して見える |
| 230 | #62 | perf: path-backed source が WebView IPC に全バイト転送する (probe/hash/peaks の native 化) |
| 231 | #63 | 実音源で auto テンポが小節単位 ±15% で揺れテンポ記号が乱立する（持続偏差フィルタ） |
| 233 | #64 | 実ミックスで meter 推定の confidence が実質ゼロになる（meter_conflict 乱発） |
| 234 | #65 | 主旋律パートの重なり解消が機械的すぎる（和音/ハモリ混入） |
| 236 | #66 | 主旋律トラックに伴奏ステム由来のサブベース音が混入する（音域外・低音部記号化） |
| 237 | #67 | 要確認バッジが小節単位で散る — システム単位に集約して譜面の視認性を改善 |
| 238 | #68 | Leipzig SMuFL フォントをアプリアセットとして同梱する（テンポ記号豆腐化の恒久対策） |
| 242 | #69 | fix(tempo): autocorr の散在ブリップがテンポリージョン折り畳みを破壊し、定テンポ曲が誤った拍格子で採譜される |
| 244 | #70 | feat(score): 伴奏パートの低信頼度イベントをフィルタして過密譜面を解消する |
| 245 | #71 | feat(score): 伴奏パートを大譜表（ト音+ヘ音）でレンダリングし低音域の加線氾濫を解消する |
| 247 | #72 | fix(export): 往復検証で連続休符スパンを併合し structural_measure_conflict の誤報連鎖を解消する |
| 249 | #73 | 伴奏パート由来の per-note レビュー issue が lead の指摘を埋没させている (音域チェック等は transposing パートのみに適用すべき) |
| 252 | #74 | リード旋律のオクターブ外れ値（register excursion）が残存 — スペクトル仲裁の修復と verdict 対象バッファの修正 |
| 254 | #75 | 極短イベント（<120ms）のオクターブ外れ値はスペクトル仲裁不能で残存する |
| 256 | #76 | 音声証拠（boundary/seam/event accents）が検出元ステムではなくソースミックスを読んでいる |
| 259 | #77 | chord: Viterbi smoother is too sticky — real progressions collapse into a single chord (e.g. whole intro reads A7) |
| 260 | #78 | meter: 'variable' detection misfires on outlier beat intervals; redundant-period rule can pop the true 4/4 |
| 262 | #79 | quantizer: triplet run-membership ignores local cost — noise-chained regions mass-enable triplets (26% atoms on a binary-dominant song) |
| 264 | #80 | 採譜精度の残存課題（実曲リファレンス検証 v0.2.14 時点） |
| 305 | #81 | fix(score): kind:file ドロップのスコアタイトルが staged 一時ファイル名になる |
| 308 | #82 | docs(protocol): transcription params 表が実装と乖離 (vocalIsolation/displayName/texture:chords 欠落) |
| 314 | #83 | feat(review): ミックス検出時の remedy にボーカル分離での再採譲提案がない |
| 316 | #84 | feat(backend): vocalIsolation 済みの単音入力を pYIN バックエンドへ解決する |
| 318 | #85 | feat(ui): キーボードショートカット一覧ヘルプオーバーレイ (F1) |
| (番号不明) | #86 | パッケージ版アプリでエンジン(Python)ランタイムを同梱する |
| (番号不明) | #87 | 拍子(meter)の自動推定 — 現状はauto=4/4固定 |
| (番号不明) | #88 | 複音(polyphonic)音源のトランスクリプション対応 |
| (番号不明) | #89 | ブラウザdev環境で kind:file の音源を実エンジンに渡せない |
| (番号不明) | #90 | 録音の自動削除ポリシーとアプリ同梱(エクスポート連携) |
| (番号不明) | #91 | 波形/時間範囲を選択して部分トランスクリプション |
| (番号不明) | #92 | vocal 分離ステムキャッシュ (%TEMP%\hornscribe-vocal-cache) に保持ポリシーがなく無制限に増える |
| (番号不明) | #93 | 未保存状態の表示が TitleBar の * のみで気づかれにくい |