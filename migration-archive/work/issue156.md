## 背景
#134 で検出スウィングを MusicXML の <sound><swing> + Swing 表示として出力するようになった。しかしアプリ内の自動演奏（FEAT-001 audition）とカーソル追従は Verovio の renderToTimemap 由来で、Verovio 6.3 は <swing> を timemap に反映しない（実測: straight/swing で tstamp 完全一致）。結果、記譜はスウィング指定なのに再生は直八分という仕様不整合。

## やること
- canonical payload の swingFeel + tempoMap + meter map から「記譜時刻→発音時刻」の区分線形ワープを構築し、PlaybackTable の tstamp に適用する。
- 拍頭・小節境界・総尺は不動点にする（オフビートのみ移動）。
- swingFeel なし/不定形のドキュメントではワープなし（現行動作）。

## 効果
- 自動演奏がスウィング再生になる。元音源追従（source clock）でもスウィング楽曲のハイライト位置が実際の発音位置に合う。
