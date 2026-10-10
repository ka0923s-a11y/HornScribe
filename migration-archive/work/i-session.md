GUI_UX_SPEC §26 の保存対象のうち、現在未実装のもの:

- **last project** — 起動時に前回開いていたプロジェクトを復元しない（最近のプロジェクト一覧からの手動復元のみ）
- **selected view** — 楽譜の連続/ページ表示は設定の「初期表示」が毎回適用され、前回セッションの選択は復元されない
- **waveform zoom** — 波形のズーム倍率は永続化されない
- **score zoom** — 楽譜のズーム倍率（%）は永続化されない

実装済み: パネル表示/幅、波形高さ（hornscribe.layout.v1）、設定全般（hornscribe.settings）、最近のプロジェクト、ウィンドウジオメトリ。

## 提案

- レイアウト永続化（hornscribe.layout.v1）を拡張し scoreZoomPct / waveformZoom / scoreViewMode / lastProjectPath を追加するか、別キー hornscribe.session.v1 を新設
- 「初期表示」設定との関係を整理: セッション復元が優先、設定は初回のみ適用、という二層にするのが自然
- §26 の「保存しない状態」（一時ツールチップ、transient error、stale selection）は現状通り除外でよい

