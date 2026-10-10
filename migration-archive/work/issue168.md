## 自動演奏(オーディション)がノート velocity を無視して一定音量で鳴らす

### 現状
score/playbackSynth.ts は各音符を固定のエンベロープ
(linearRampToValueAtTime(0.9, ...))で鳴らしており、canonical ノートや
raw event が持つ velocity(Basic Pitch の amplitude 由来)を一切参照
していない。

MIDI export (export/midi.py) は velocity を正しく note_on に載せている
ので、**MIDI では強弱が出るのにアプリ内オーディションでは全部同じ音量**
という不整合になっている。

### 期待
オーディションのゲインを velocity に比例させる(例: velocity/127 を
エンベロープのピークに掛ける)。完全な表現(ビブラート等)は pitch bend
の取得(#169)が前提だが、velocity だけでも強弱の実感が大きく変わる。

### 精度との関係
「生成した楽譜の自動演奏」が実際の演奏ニュアンスに近づく。
