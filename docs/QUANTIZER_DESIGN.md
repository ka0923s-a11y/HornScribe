# HornScribe Quantizer Design

> Status: Proposed implementation design  
> Codename: HSQ-v1 (HornScribe Score Quantizer v1)  
> Scope: monophonic / single-line transcription first  
> Roadmap authority: [MASTER_PLAN.md](MASTER_PLAN.md)  
> Related: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)

---

# 0. Decision summary

HornScribeの量子化は、単純な「最も近い16分音符へ丸める」処理にはしない。

HSQ-v1は次の構成とする。

```text
RawNoteEvent
  ↓
Beat/tempo mapで seconds → musical time へ正規化
  ↓
metrical grid / meter treeを生成
  ↓
各note onsetの候補位置を生成
  ↓
k-best dynamic programming
  ├─ timing fidelity
  ├─ IOI fidelity
  ├─ notation complexity
  ├─ note/rest realization
  ├─ tie cost
  ├─ tuplet cost
  └─ metrical readability
  ↓
best + alternative rhythm hypotheses
  ↓
canonical QuantizedNote / Rest / Tie
  ↓
ReviewIssue
  ↓
music21でMusicXML notation realization
```

最重要原則:

1. **量子化 = 推論問題**であり単純丸めではない。
2. **beat/tempo推定とquantizationを分離**する。
3. secondsを直接gridへ丸めず、まずmusical timeへ写像する。
4. onset誤差だけでなく、**人間が読む楽譜の簡潔さ**を目的関数へ入れる。
5. note offsetを絶対視しない。特にホルンでは、息・タンギング・staccato・AMT offset誤差を小休符へ変換しすぎない。
6. binary / triplet等の複数候補を比較する。
7. 1-bestだけでなくk-bestを保持し、曖昧な箇所をReviewIssueへ変換する。
8. raw timingは永久に保持し、quantizationは再実行可能にする。
9. MVPではmonophonicを最適化し、polyphonic/voice separationは後段にする。
10. learned quantizerは将来backendとして比較するが、HSQ-v1の決定論的baselineを先に完成させる。

---

# 1. なぜ専用Quantizerが必要か

Automatic Music Transcriptionで得られるnote eventは通常、

```text
pitch
onset seconds
offset seconds
confidence
```

である。

楽譜に必要なのは、

```text
measure
metrical position
written onset
notated duration
rest
tie
tuplet
pickup
meter context
```

であり、両者は同一ではない。

例えば120 BPMで演奏された四分音符が、

```text
0.00 s
0.51 s
0.98 s
1.52 s
```

に発音されたからといって、各onsetを個別に0.5秒刻みへ丸めるだけでは不十分。

実際には、

- tempo fluctuation
- rubato
- articulation
- delayed attack
- AMT model latency
- breath
- swing
- pickup
- triplet
- staccato
- expressive length
- false short notes

等がある。

さらに、時間的には近い2つの候補でも、

```text
16分休符 + 8分音符 + 16分休符
```

より

```text
4分音符
```

の方が楽譜として合理的な場合がある。

したがってHornScribeでは、

> performance timingへの近さ

と

> notation readability

を同時に最適化する。

---

# 2. 既存研究・OSSから採用する考え方

## 2.1 music21 Stream.quantize — baselineとして利用

music21の `Stream.quantize()` はoffsetとdurationを候補分割へ丸め、quantization errorも保持できる。

current docsではdefault MIDI quantizationが16分音符・8分三連系の候補を扱う。

参考:

- https://music21.org/music21docs/moduleReference/moduleStreamBase.html
- https://music21.org/music21docs/moduleReference/moduleMidiTranslate.html

利用方針:

- **HSQ-v1本体にはしない**
- regression baselineとして使う
- final notation construction / duration validation / ties / measuresには利用する

理由:

nearest-grid型として有用だが、HornScribeが必要とする

- k-best
- explicit readability cost
- meter tree
- ambiguous rhythm review
- offset-vs-rest model
- phrase/global consistency

をproduct-specificに制御しづらい。

---

## 2.2 Magenta note-seq — reference baselineのみ

note-seqにはNoteSequenceのquantization utilitiesがある。

ただしrepositoryは2026-05-06にarchivedされた。

参考:

- https://github.com/magenta/note-seq

方針:

- product dependencyにはしない
- algorithm/reference baselineとしてのみ参照

---

## 2.3 Cemgil / Desain / Kappen — timingを確率的に扱う

重要な古典:

- Cemgil, Desain, Kappen, “Rhythm Quantization for Transcription”, Computer Music Journal, 2000
- Cemgil & Kappen, “Monte Carlo Methods for Tempo Tracking and Rhythm Quantization”, JAIR, 2003

参考:

- https://doi.org/10.1162/014892600559218
- https://www.cmpe.boun.edu.tr/~cemgil/cemgil-tempo-quant_bib.html

重要な示唆:

- expressive timingを単なるnoiseではなくperformance modelとして扱う
- tempoとscore locationは別latent variableとして考える
- local onsetだけでなくneighboring onset patternを見る
- priorによりnotation complexityを制御できる

HSQ-v1では完全なparticle filteringを実装せず、

- continuous performance time
- latent quantized score position
- robust timing loss
- notation prior

という考え方をdynamic programmingへ落とす。

---

## 2.4 qparse — hierarchical notation grammar

qparseはsymbolic performanceからscoreを作るquantizerで、

- weighted tree automata
- hierarchical rhythm structure
- dynamic programming
- preferred rhythm language
- notation structure

を利用する。

参考:

- https://qparse.gitlabpages.inria.fr/
- https://qparse.gitlabpages.inria.fr/docs/scientific/
- https://qparse.gitlabpages.inria.fr/docs/about/

重要な示唆:

> 楽譜のリズムはflat gridではなくhierarchical structureである。

qparse自体はCeCILL 2.1、C++ build、MEI中心でありHornScribeへ直接組み込まない。

ただし、

- measure
- beat group
- subdivision
- tuplet

をmetrical treeとして扱う思想を採用する。

---

## 2.5 RQ / OpenMusic — distance + complexity + k-best

OpenMusic RQではrecursive segmentation / dynamic programmingを使い、候補を

- input timingとのdistance
- output rhythm treeのcomplexity

でrankingする。

さらにk-best transcriptionを提示する。

参考:

- https://github.com/openmusic-project/RQ

これはHornScribe Review UXと非常に相性がよい。

HSQ-v1では、

```text
best rhythm
2nd rhythm
3rd rhythm
```

を内部保持し、1位と2位が近い場合だけユーザーへ「要確認」を出す。

RQはGPL/OpenMusic依存のため直接dependencyにはしない。

---

## 2.6 PM2S — neural beat-aware quantization

Liu et al. ISMIR 2022はperformance MIDIから、

- beat prediction
- quantized note time
- key/time signature
- parts

等をneural modelで推定する。

コードはMITだが、公式READMEのtested environmentはPython 3.8 / PyTorch 1.12。

参考:

- https://github.com/cheriell/PM2S
- https://doi.org/10.5281/zenodo.7316682

HornScribeでの位置づけ:

- experimental benchmark
- product coreにはしない

理由:

- piano中心
- old runtime
- model dependencyが重い
- HSQ-v1ではまず説明可能なdeterministic baselineが必要

---

## 2.7 MIDI2ScoreTransformer — end-to-end research baseline

ISMIR 2024:

- Tim Felix Beyer & Akira Dai
- End-to-end Piano Performance-MIDI to Score Conversion with Transformers

コード:

- https://github.com/TimFelixBeyer/MIDI2ScoreTransformer

score-level notationまで直接predictする有力研究。

HornScribeでは将来experimental backend候補とするが、piano-centric learned priorをホルン単旋律へそのまま適用しない。

---

## 2.8 2025–2026 Beat-Based Transformer Quantization

Wachter, Murgul, Heizmann:

- Beat-Based Rhythm Quantization of MIDI Performances (2025)
- Transformer-Based Rhythm Quantization of Performance MIDI Using Beat Annotations (2026)

参考:

- https://arxiv.org/abs/2508.19262
- https://arxiv.org/abs/2604.22290

2026 workはbeat annotationを与えた条件でASAP上、

- onset F1 97.3%
- note value accuracy 83.3%

を報告している。

重要な示唆:

- beat/downbeat情報を先に与える構成が強い
- quantizerとbeat detectionを分ける設計は妥当
- instrument-specific fine-tuningが有効

HornScribeでは今すぐTransformerを採用せず、まずHSQ-v1をbaselineとする。

将来、Horn録音/演奏データが十分に集まった場合にlearned re-rankerとして利用可能。

---

## 2.9 MUSTER — score-level evaluation

MUSTERはMusicXML score同士を比較するedit-distance based metrics。

参考:

- https://amtevaluation.github.io/

HornScribeでは、

- onset
- offset/note value

のscore-level比較に利用可能。

ただしMVPでは独自のmonophonic quantizer unit testsとuser correction costを主指標にし、MUSTERはbenchmark layerとして使用する。

---

# 3. HornScribeで採用しない方法

## 3.1 単純nearest-gridのみ

例:

```python
round(onset * 4) / 4
```

問題:

- tempo driftに弱い
- rest fragmentation
- triplet誤判定
- meterを無視
- note durationを独立に丸めてgapを作る
- readable notationを評価しない

baselineとしてのみ残す。

---

## 3.2 music21.quantizeをそのまま製品ロジックにする

便利だが、

- product-specific cost
- alternative hypothesis
- horn articulation treatment
- review reason

を十分制御できない。

notation backendとして利用する。

---

## 3.3 最初からTransformer quantizer

MVPでは不採用。

理由:

- model size
- training data
- runtime packaging
- domain mismatch
- debug difficulty
- quantization failure reasonを説明しづらい

HSQ-v1をgrounded baselineとして先に完成させる。

---

# 4. Architectural boundary

Quantizerはaudioを直接解析しない。

Input:

```text
RawNoteEvent[]
BeatMap
MeterMap
QuantizationProfile
```

Output:

```text
QuantizedRhythmRevision
ReviewIssue[]
QuantizationDiagnostics
```

BeatMap作成は別module。

```text
audio
 ↓
beat tracker / manual BPM / manual anchors
 ↓
BeatMap
 ↓
HSQ
```

---

# 5. Core data structures

## 5.1 RawNoteEvent

既存domain modelを利用。

```python
@dataclass(frozen=True)
class RawNoteEvent:
    id: str
    pitch_midi: float
    onset_sec: float
    offset_sec: float
    confidence: float | None
```

---

## 5.2 BeatAnchor

Quantizerへ渡すanchorは単なる「beat number」ではなく、score-space位置を持つ。

```python
@dataclass(frozen=True)
class BeatAnchor:
    time_sec: float
    score_pos_ql: Fraction
    confidence: float | None
    source: BeatSource
```

`score_pos_ql` はquarterLength単位。

これにより4/4と6/8をquantizer内で曖昧にしない。

例:

4/4 quarter pulse:

```text
0.0, 1.0, 2.0, 3.0 ...
```

6/8 dotted-quarter pulse:

```text
0.0, 1.5, 3.0 ...
```

---

## 5.3 MeterSegment

```python
@dataclass(frozen=True)
class MeterSegment:
    start_ql: Fraction
    numerator: int
    denominator: int
    measure_phase_ql: Fraction
```

MVP:

- 4/4
- 3/4
- 2/4
- 6/8

を優先。

拍子自動推定はquantizerの責務にしない。

---

## 5.4 NormalizedNote

```python
@dataclass(frozen=True)
class NormalizedNote:
    source_id: str
    pitch_midi: int
    onset_ql: float
    offset_ql: float
    confidence: float | None
```

まだfloat。

quantization後に初めてFractionへする。

---

## 5.5 QuantizedRhythmNote

```python
@dataclass(frozen=True)
class QuantizedRhythmNote:
    canonical_note_id: str
    source_event_ids: tuple[str, ...]
    onset_ql: Fraction
    duration_ql: Fraction
    notation: NotationRealization
```

---

## 5.6 QuantizationAlternative

```python
@dataclass(frozen=True)
class QuantizationAlternative:
    rank: int
    total_cost: float
    notes: tuple[QuantizedRhythmNote, ...]
    diagnostics: QuantizationDiagnostics
```

default:

```text
K = 3
```

---

# 6. Time normalization — seconds → musical time

## 6.1 TimeWarp

BeatMapからmonotonic function

```text
W(seconds) -> quarterLength
```

を作る。

HSQ-v1は**piecewise linear interpolation**を使用する。

理由:

- anchorを必ず通る
- monotonic
- overshootしない
- debug可能
- tempo変化へ対応
- cubic interpolationより予測不能なwarpが少ない

Beat anchor間:

```text
(t0, q0)
(t1, q1)
```

なら

```text
W(t) = q0 + (t-t0)/(t1-t0) * (q1-q0)
```

範囲外は最寄りsegment slopeでextrapolateする。

---

## 6.2 Fixed BPM mode

BeatMapがない場合:

```text
ql = (time_sec - zero_sec) * BPM / 60
```

4分音符 = 1 ql。

MVPで最も信頼できるfallback。

---

## 6.3 Global latency / alignment shift

AMT onsetとbeat trackerには系統的latency差があり得る。

量子化前にglobal shift

```text
delta_sec
```

を推定可能にする。

探索:

```text
-120 ms ～ +120 ms
```

程度をcoarse searchし、高confidence onsetのmetrical distanceが最小になるshiftを選ぶ。

ただし、

- shiftが大きすぎる
- cost surfaceがflat
- 複数peak

の場合は自動適用せずReviewIssue。

内部reason:

```text
beat_alignment_uncertain
```

UI:

```text
拍位置を確認してください
```

### #78 拍節情報による解消 (meter-aware alignment)

上記のresidualスコアだけでは、系統的な検出バイアスに2つの敗北モードがある。

1. **offbeat-16th alias**: Basic Pitch 等の onset が一貫して早め/遅めに
   出ると、真の拍位相より「裏16分位相」の方が fine grid に少しだけ
   良くfitし、全音符が16分1個ずれて記譜される（実測6/8で発生）。
2. **swing/triplet 補正の歪み**: 3連位置の onset は fine grid のみで
   測ると常に residual を持つ。Huber コストは誤差を均す方を好むので、
   「全 onset を僅かにずらして 3連を16分に寄せる」妥協位相が勝ち、
   swing census が 2/3 を読めなくなる。

対策は2段階（`estimate_alignment_shift(events, warp, profile,
meter_map=…)`；meter_map 未指定なら旧来の meter-agnostic 挙動）。

#### notatable lattice residual

meter_map がある場合、residual は fine grid 単体ではなく
**記譜可能ラティス**（fine grid ∪ セグメントの拍/3＝3連位置）への
距離で測る。3連位置に正しく乗る onset は「記譜上正しい位置」なので
residual を持たず、swing の裏拍が矯正されない（#134 の swingFeel が
2/3 を保つ）。複合拍子では拍/3=8分＝fine grid に既に含まれるので
無害な no-op。

#### metrical tie-break

残る競合極小（coarse grid 上の local minimum）は**拍節強度カーネル**
で順位付けする:

```text
hits(δ) = Σ_i w_i · max_level[ level_w · max(0, 1 − d_level/ε) ]
```

- ε = 0.06 ql（三角カーネル — ヒューマナイズされた timing が部分点を
  持つ。hit 計数は距離和ではないので「全体に少しずれる」位相は
  「半数が拍に一致」に負ける）
- level_w: beat=1.0, eighth=0.65, triplet-third=0.45（simple）;
  beat=1.0, eighth=0.6（compound）—「全部が拍」は「全部が3連位置」
  に明確に勝つ

候補の収集は uncertainty 許容（best_score の 5%）より**広い**
（`ALIGNMENT_TIEBREAK_PER_WEIGHT = 0.02 × Σw` を併用）:
系統バイアスは offbeat 位相を真位相より *僅かに* 良く fit させるので、
正直な競合は 5% 帯のすぐ外に落ちる。

勝者は

- リード: `hits(lead) − hits(second) ≥ 0.15 × Σw`
- 証拠量: `hits(lead) ≥ 0.30 × Σw`

を両方満たすとき適用し、`AlignmentEstimate.meter_resolved` /
`QuantizationDiagnostics.alignment_meter_resolved` / job meta
`alignmentMeterResolved` に記録する。差がつかない場合は従来通り
`beat_alignment_uncertain`（8分グリッド同士の index alias のような
真の曖昧さはここに残る）。band edge の勝者はタイブレークしない
（真の shift が帯域外の可能性があるため）。

---

# 7. Meter tree

Flat gridではなくmeter hierarchyを作る。

## 7.1 4/4

```text
measure 4ql
├── half-measure 2ql
│   ├── beat 1ql
│   │   ├── eighth
│   │   └── eighth
│   └── beat 1ql
└── half-measure 2ql
    └── ...
```

16thまで必要ならさらにbinary split。

---

## 7.2 3/4

```text
measure 3ql
├── beat 1ql
├── beat 1ql
└── beat 1ql
```

各beatをbinary subdivision。

---

## 7.3 6/8

```text
measure 3ql
├── compound beat 1.5ql
│   ├── eighth 0.5ql
│   ├── eighth 0.5ql
│   └── eighth 0.5ql
└── compound beat 1.5ql
```

重要:

6/8の3分割はtripletではなくnative meter structure。

tuplet penaltyを付けない。

---

# 8. Candidate onset generation

各NormalizedNote `i` に対して、

```text
C_i = possible quantized onset positions
```

を生成する。

## 8.1 Binary grid

default minimum:

```text
16分音符 = 1/4 ql
```

候補:

- nearest grid point
- previous grid point
- next grid point

ただしcandidate window外は除外。

---

## 8.2 Triplet grid

simple meterで三連符を許可した場合:

- 8分三連: 1/3 ql
- 16分三連: 1/6 ql — Advanced / later

MVP primary:

```text
8分三連まで
```

を推奨。

常にtriplet候補を大量投入しない。

region evidenceに基づいてgateする。

---

## 8.3 Candidate window

固定msだけではtempo依存になるため、musical time単位で決める。

starting heuristic:

```text
nearest 2–3 points per enabled grid family
max distance ≈ 0.35 ql
```

正確な値はbenchmarkでtuneする。

---

# 9. Robust timing loss

squared errorのみだとoutlierに弱い。

HSQ-v1ではHuber lossを使う。

```text
rho(r) =
  0.5 r²                    if |r| <= k
  k(|r| - 0.5k)            otherwise
```

利用:

- onset distance
- IOI difference
- offset distance

expressive deviationやAMT outlierが全体のpathを壊しにくい。

---

# 10. Quantization objective

Observed normalized onset:

```text
x_i
```

quantized onset candidate:

```text
q_i
```

observed offset:

```text
z_i
```

全体cost:

```text
J =
  C_onset
+ C_ioi
+ C_offset
+ C_notation
+ C_rest
+ C_tie
+ C_tuplet
+ C_mode_switch
+ C_meter
+ C_invalid
```

---

## 10.1 Onset fidelity

```text
C_onset =
Σ w_i * Huber((q_i - x_i) / sigma_onset)
```

confidenceはprobabilityとして使わない。

せいぜいtiming evidence weightを狭い範囲でmodulateする。

例:

```text
0.8 <= w_i <= 1.2
```

---

## 10.2 IOI fidelity

個別onsetだけでなくinter-onset intervalを見る。

```text
C_ioi =
Σ Huber(
 ((q_i-q_{i-1}) - (x_i-x_{i-1}))
 / sigma_ioi
)
```

これによりneighbor rhythm patternを保持しやすい。

Cemgil系の「local onset groupを見る」という考え方を簡略化して導入する。

---

# 11. Dynamic programming

monophonicではイベント順序が既知。

各note onset candidateをnodeとしたlayered DAGを作る。

```text
note 1     note 2       note 3
 q1a  ──→  q2a  ──→    q3a
  │  ╲      │ ╲
 q1b  ──→  q2b  ──→    q3b
```

transition `p -> q` のcostで、

- IOI
- previous note duration
- following rest
- meter structure

まで評価する。

つまりdurationはonset path決定後に別々に丸めるのではなく、**隣接onset transitionの中でjointly評価**する。

---

# 12. Joint note-duration / rest realization

これはHornScribe専用Quantizerの重要部分。

note i:

```text
quantized onset = p
next onset      = q
raw offset      = z
```

区間

```text
[p, q)
```

を

```text
note + optional rest
```

へ分解する。

候補end:

1. `q` — 次のnoteまで保持
2. raw offsetに近いgrid point
3. raw offset前後の隣接grid point

各候補end `e` について:

```text
note span = [p,e)
rest span = [e,q)
```

のnotation costを計算。

最小costをtransition realizationとする。

---

# 13. ホルン向けoffset処理

ホルン等の管楽器ではraw offsetをそのまま休符化すると、

- tongue separation
- breath
- staccato
- AMT offset jitter

によって小さな休符が大量発生しやすい。

したがってHSQ-v1では、

```text
onset evidence > offset evidence
```

とする。

特に、

```text
note off → 次note onset
```

のgapが小さい場合、

```text
8分音符 + 16分休符
```

より

```text
付点8分 / 4分音符等
```

の単純な表記を優先できる。

原則:

- tiny restにはcomplexity penalty
- raw offsetはsoft evidence
- repeated pitchのnext onsetは必ずnote boundaryとして保持
- raw overlapはmonophonicではnext onsetへclipしてwarning
- articulation marksはv1では自動推定しない

---

# 14. Notation realization cost

## 14.1 Atom

1つのnotated symbolで表せるspanをRhythmAtomとする。

例:

```text
whole
dotted half
half
dotted quarter
quarter
dotted eighth
eighth
dotted sixteenth
sixteenth
triplet eighth
```

double dotは対応可能だがhigher complexity。

triple dotはMVPでは原則候補から外す。

music21 `duration.quarterConversion()` をvalidationに使える。

---

## 14.2 Symbol cost

initial conceptual weights:

| feature | relative cost |
|---|---:|
| symbol | 1.00 |
| first dot | +0.08 |
| second dot | +0.35 |
| tie | +0.45 |
| tuplet group | +1.20 |
| each tuplet atom | +0.12 |
| tiny rest | +0.75 |
| weak-start span hiding strong beat | +0.6〜1.5 |

数値は**製品仕様ではなくstarting values**。

benchmarkで調整し、通常UIには出さない。

---

# 15. Metrical readability cost

同じdurationでもstart位置で読みやすさが違う。

例: 4/4で

```text
& of beat 1
→ beat 2をまたぐ
```

長いnoteはtieでbeat構造を見せる方が読みやすい場合がある。

HSQ-v1ではmeter tree内の

- measure boundary
- primary beat boundary
- subdivision boundary

にsalience levelを持たせる。

spanが内部のstrong boundaryを隠す場合、

```text
obscured_boundary_penalty
```

を加える。

ただし、

- strong beatから始まるhalf note
- dotted quarter in compound meter

等の通常notationはpenaltyを付けない。

---

# 16. Span decomposition

任意span

```text
[start,end)
```

をnotatable atomsへ分解する。

これは別のshortest-path DPで実装可能。

nodes:

```text
allowed metrical positions
```

edges:

```text
one notatable duration atom
```

edge cost:

```text
symbol
+ dot
+ tuplet
+ metrical boundary
```

note spanの場合、複数edgeならtieを追加。

rest spanではtieではなく複数rests。

これにより、

```text
5/8相当のspan
```

などを読みやすい組み合わせへ分解できる。

---

# 17. Tuplet model

## 17.1 MVP

対応:

- native compound subdivision
- 8分三連符

後回し:

- 16分三連符
- quintuplet
- septuplet
- nested tuplet

---

## 17.2 Triplet gate

triplet candidateを全noteへ常時許可すると、human timing jitterを三連符に誤解しやすい。

beat-regionごとに、

```text
binary model cost
triplet model cost
```

を比較する。

tripletを有効にする条件例:

1. ユーザー設定が「三連符を使用しない」ではない
2. region内に2個以上のrelevant onsetがある
3. triplet gridでtiming errorが有意に改善
4. tuplet complexity penaltyを含めてもtotal costが改善

設定:

```text
三連符:
- 自動
- 使用しない
- 候補に含める
```

通常は「自動」。

---

# 18. Grid mode consistency

1 noteだけtriplet gridへ飛ぶ等を防ぐ。

DP stateへlocal grid modeを持たせ、

```text
binary → triplet
triplet → binary
```

へmode-switch penaltyを与える。

region単位のまとまりを優先する。

---

# 19. k-best quantization

各DP stateでtop-K pathを保持する。

default:

```text
K = 3
```

出力:

```text
Alternative 1 cost = 24.1
Alternative 2 cost = 24.4
Alternative 3 cost = 28.8
```

1位と2位が近く、結果が異なる場合:

```text
ReviewIssue(reason="quantization_ambiguous")
```

を生成。

UI:

```text
リズムの解釈を確認してください
```

将来Review画面で候補A/B比較可能。

---

# 20. Ambiguity score

単純なraw cost differenceでは曲長依存になる。

```text
margin =
(J2 - J1) / max(number_of_affected_notes, 1)
```

または局所region costで比較。

thresholdはbenchmarkでtune。

重要:

alternativeが同じ楽譜になる場合はReviewを出さない。

---

# 21. Phrase segmentation

長い曲を1つの巨大DPにしない。

raw eventからphrase boundary candidate:

- 長いsilence
- double bar / section marker（将来）
- several beats without note

MVP heuristic:

```text
raw gap >= 2 beats
```

等をstarting pointにする。

ただしmeasure boundary付近でoverlap contextを持たせる。

例:

```text
segment A
measure 1–8 + lookahead 1 beat

segment B
measure 9–16 ...
```

---

# 22. Pickup / anacrusis

Quantizer内部では

```text
measure_phase_ql
```

として扱う。

MVP:

- manual first-downbeat / pickup setting
- beat/downbeat trackerから提供されたphase

将来auto:

複数phase候補を比較し、

- quantization cost
- incomplete first measure penalty
- downbeat confidence

から選択。

曖昧なら:

```text
pickup_ambiguous
```

UI:

```text
弱起を確認してください
```

---

# 23. Tempo changes / rubato

HSQはtempoそのものを推定しない。

BeatMapのTimeWarpで吸収する。

```text
seconds → ql
```

が正しければ、quantizer側はrubatoを意識しなくてよい。

BeatMapが不安定な場合:

```text
beat_map_uncertain
```

としてReview。

将来UI:

- beat anchorをドラッグ
- BPM/拍位置を修正
- quantizationだけ再実行

---

# 24. Swing

MVPでauto swing notationはしない。

理由:

2:1付近のperformance eighthを、

- actual triplet
- swing feel
- timing expression

から確実に区別しづらい。

将来:

```text
スウィング:
- なし
- 自動
- 8分スウィング
```

を追加。

swing modeではperformanceのlate offbeatをstraight eighth notationへnormalizeし、必要ならscore textでswing indicationを付与する。

---

# 25. Grace notes / ornaments

非常に短いeventを32分/64分へ自動量子化すると読みにくい。

possible grace heuristic:

- very short duration
- next strong note直前
- small onset gap
- melodic relation

該当した場合、

```text
possible_grace_note
```

としてReviewIssue。

UI:

```text
装飾音の可能性があります
```

MVPでは自動grace変換を必須としない。

raw eventは消さない。

---

# 26. Same-pitch repeated notes

ホルンではtongued repeated notesが多い。

重要:

```text
C4 onset
C4 onset
```

をdurationが接近しているだけで1 noteへmergeしない。

mergeはquantizerではなくcleanup stageの明示rule。

quantizerに入った別event IDは原則別noteとして保持する。

---

# 27. Overlap handling

monophonic modeでは、

```text
offset_i > onset_{i+1}
```

があり得る。

原因:

- Basic Pitch overlap
- legato
- detection noise

MVP:

- notated end <= next onset
- raw overlap amountはdiagnosticsへ保持
- extreme overlapならReviewIssue

```text
overlapping_candidates
```

---

# 28. Meter support strategy

## Polished MVP

優先:

- 4/4
- 3/4
- 2/4
- 6/8

## v1+

- 9/8
- 12/8
- 2/2
- 3/8
- 5/4 / 7/8 custom grouping

odd meterではgrouping definitionを必須にする。

例:

```text
7/8 = 2+2+3
```

meter treeがgroupingを保持する。

---

# 29. Beat tracker strategy

Quantizerと独立。

## baseline

librosa `beat_track`。

librosaはEllis 2007のdynamic programming beat trackerを実装している。

参考:

- https://librosa.org/doc/latest/beat.html
- https://librosa.org/doc/latest/generated/librosa.beat.beat_track.html

利用:

- automatic BPM/beat suggestion
- fixed/manual overrideを必ず残す

## experimental

madmom系DBN/RNN beat/downbeat。

original madmomはruntime compatibility上の負債があるためproduct dependencyへ即採用しない。

modern fork等は別spikeで評価する。

参考:

- https://github.com/CPJKU/madmom

---

# 30. Quantization profiles

UIにはweight値を直接出さない。

## 標準

```text
最小音価: 16分
三連符: 自動
楽譜の簡潔さ: 標準
```

## 原演奏に近く

timing fidelity weight↑  
complexity penalty↓

## 簡潔

timing tolerance↑  
complexity penalty↑  
tiny rest penalty↑

通常ユーザーには必要になるまで「楽譜の簡潔さ」を隠してよい。

---

# 31. Cost configuration — weights v1 (frozen, QNT-007)

~~これは初期値であり、benchmark後にfreezeする。~~ → **QNT-007でfreeze済み。
以下の値が `weights_version=1` として `QuantizerWeights` のdefaultである。**

```python
QuantizerWeights(
    onset=4.0,
    ioi=2.0,
    offset=1.0,
    symbol=0.55,
    tie=0.45,
    first_dot=0.08,
    second_dot=0.35,
    tuplet_group=1.20,
    tuplet_atom=0.12,
    mode_switch=0.70,
    tiny_rest=0.75,
    weak_boundary_crossing=0.90,
    strong_boundary_crossing=1.40,
    weights_version=1,
)
```

freeze根拠(`benchmarks/quantizer_benchmark.json`, 33 fixture corpus):

- B4 exact-onset率 **1.000** vs B0/B1/B2 **0.919**、B3 **0.970**
- B4 exact-duration率 **1.000** vs baselines ≤ **0.87**
- B4 rest exact **32/32**(+1 extra)、tiny-rest **1**(real 16th restのみ)
- triplet false positive/missed: **0/0**
- ablation: `B4-no-ioi`は±80 ms jitterでonset率0.917に低下(IOI項の寄与)、
  `B4-no-tiny-rest`は+8 extra rests(tiny-rest項の寄与)、
  `B4-no-mode-switch`はcorpus全体で出力差0(効果未実測 — 正直な記録として残す)
- 詳細と既知の失敗クラスは `docs/QUANTIZER_WEIGHTS_V1.md`

重要:

- parameterをmagic constantとして各functionへ散らさない
- immutable configへ集約
- benchmark resultとversionを紐づける

---

# 32. Algorithm detail

## Step 1 — normalize

```python
notes = normalize_to_score_time(raw_notes, beat_map, alignment_shift)
```

---

## Step 2 — build meter tree

```python
meter_tree = build_meter_tree(meter_map, min_note_value)
```

---

## Step 3 — segment

```python
phrases = segment_phrases(notes, meter_tree)
```

---

## Step 4 — candidates

```python
for note in phrase:
    onset_candidates[note.id] = generate_onset_candidates(
        note,
        meter_tree,
        triplet_policy,
    )
```

---

## Step 5 — DP

Pseudo code:

```python
for candidate in C[0]:
    dp[0][candidate] = PathState(
        cost=onset_cost(candidate, note0),
        history=...
    )

for i in range(1, len(notes)):
    for curr in C[i]:
        for prev in C[i - 1]:
            if curr.position <= prev.position:
                continue

            realization = realize_interval(
                start=prev.position,
                next_onset=curr.position,
                observed_offset=notes[i - 1].offset_ql,
                meter_tree=meter_tree,
            )

            cost = (
                dp[i - 1][prev].cost
                + onset_cost(curr, notes[i])
                + ioi_cost(prev, curr, notes[i - 1], notes[i])
                + realization.cost
                + mode_transition_cost(prev, curr)
            )

            keep_top_k(dp[i][curr], cost, K=3)
```

last noteはphrase end候補を使ってrealizeする。

---

# 33. Why transition-level duration is important

悪い設計:

```text
1. onset全部丸める
2. duration全部丸める
3. gapをrestにする
```

この方法は、

```text
note end = 0.74
next note = 1.01
```

のようなケースで、

```text
8分音符 + 16分休符 + ...
```

を作りやすい。

HSQでは、

```text
previous onset
next onset
raw offset
meter
notation complexity
```

を同時に見てintervalを実現する。

---

# 34. Notation backend boundary

HSQが決める:

- onset
- musical duration
- rest spans
- ties needed by rhythmic representation
- tuplet grouping intent

music21が担当:

- Duration object
- measure creation
- final tie object realization
- beaming
- MusicXML serialization support

music21のnotation機能:

- `makeMeasures`
- `makeRests`
- `makeTies`
- duration conversion

を利用する。

ただしmusic21による後処理でHSQのcanonical rhythmが勝手に変化しないことをround-trip testする。

---

# 35. Optional Partitura usage

PartituraはApache-2.0のactive symbolic music packageで、

- MusicXML
- MIDI
- score/performance representation
- beat maps
- note arrays

を扱える。

2026年にもreleaseが継続している。

参考:

- https://github.com/CPJKU/partitura

MVP core dependencyには必須としない。

候補用途:

- benchmark dataset loader
- score/performance alignment inspection
- independent MusicXML verification

つまり**dev/benchmark optional dependency**として検討する。

---

# 36. Evaluation layers

## 36.1 Timing-space metrics

ground truth scoreからperformance-like jitterを生成したsynthetic test。

計測:

- exact onset accuracy
- onset absolute error in ql
- exact duration accuracy
- duration absolute error
- triplet classification
- rest correctness

---

## 36.2 Notation complexity metrics

HornScribe独自:

```text
symbol_count
tie_count
rest_count
tiny_rest_count
tuplet_group_count
second_dot_count
strong_boundary_obscured_count
```

同じtiming accuracyならcomplexityが低い方を優先。

---

## 36.3 MUSTER

MusicXML referenceがあるdatasetでscore-level評価。

特に:

- onset error
- offset/note-value error

を見る。

---

## 36.4 AMT metricsとは分ける

mir_eval note onset F1等は、

```text
Audio → RawNoteEvent
```

評価用。

Quantizerは、

```text
RawNoteEvent → Score rhythm
```

評価。

両方を混ぜない。

---

## 36.5 User correction metric

HornScribeで最重要。

記録:

- rhythm correction count
- correction time
- changed notes
- rejected ReviewIssues
- BPM/meter manual correctionの有無

最終的な目的:

> 正しい譜面に直すための人間の作業量を減らす。

---

# 37. Baselines

同じfixtureで最低限比較する。

## B0 — Nearest 16th

単純丸め。

## B1 — Nearest 16th + triplet

fixed candidate grid。

## B2 — music21 Stream.quantize

music21 baseline。

## B3 — HSQ without notation complexity

timing-only ablation。

## B4 — HSQ full

timing + notation + meter + rest/tie。

これで「専用アルゴリズムのcomplexity costが本当に意味を持つか」を証明する。

---

# 38. Synthetic fixture matrix

必須:

### Straight

- quarter notes @ 120 BPM
- eighth notes
- sixteenth notes
- dotted quarter/eighth patterns

### Timing variation

- ±20 ms jitter
- ±50 ms jitter
- ±80 ms jitter
- global latency offset
- gradual rubato with correct beat anchors

### Rests

- quarter rest
- eighth rest
- short articulation gap that should **not** become rest
- real 16th rest

### Meter

- 4/4
- 3/4
- 2/4
- 6/8

### Triplet

- eighth triplets
- near-triplet but binary jitter
- one isolated off-grid note that should not flip whole region to triplet

### Boundary

- syncopation across beat
- note across barline
- dotted note aligned to beat
- weak-start note crossing strong beat

### Horn-like

- repeated tongued same pitch
- long sustained note
- breath-size small gaps
- phrase-end long gap
- legato overlapping AMT offsets

### Problem

- duplicate event
- reversed/invalid offset
- overlapping notes
- very short possible grace note
- final note with no following onset

---

# 39. Real-world local benchmark

gitignored:

```text
benchmarks/local/
```

最低:

- solo horn clean recording
- horn with piano accompaniment after melody isolation if available
- lyrical slow passage
- articulated fast passage
- 6/8 passage
- triplet passage

著作権音源をrepositoryへcommitしない。

reference scoreは自分で入力した短いexcerptを使う。

---

# 40. ReviewIssue mapping

Quantizer-specific reasons:

| internal | 日本語UI |
|---|---|
| quantization_ambiguous | リズムの解釈を確認してください |
| beat_alignment_uncertain | 拍位置を確認してください |
| beat_map_uncertain | テンポと拍位置を確認してください |
| possible_triplet | 三連符の可能性があります |
| possible_grace_note | 装飾音の可能性があります |
| offset_ambiguous | 音の長さを確認してください |
| pickup_ambiguous | 弱起を確認してください |
| meter_conflict | 拍子を確認してください |
| overlapping_candidates | 音の重なりを確認してください |

raw costやalgorithm名は通常UIに出さない。

---

# 41. Diagnostics

開発/診断情報では表示可能:

```text
Quantizer: HSQ-v1
Revision: ...
Meter: 4/4
Min value: 1/16
Triplet: auto
Alignment shift: +34 ms
Path cost: 24.12
Alternative cost: 24.37
Ambiguous regions: 2
Symbols: 32
Ties: 3
Tiny rests: 0
```

---

# 42. Performance target

monophonic melodyならDP candidate数は小さい。

仮に:

```text
N = 500 notes
K_candidates = 6
```

transition:

```text
O(N * K²)
≈ 18,000
```

程度。

span realizationをmemoizeすれば十分高速。

target:

```text
3–5分のmonophonic score quantization
< 200 ms typical
```

まず正しさを優先し、その後profileする。

---

# 43. Caching

memoize:

```text
span_realization(
  start Fraction,
  end Fraction,
  meter_segment,
  profile
)
```

同じmetrical spanのnotation decompositionは再利用できる。

---

# 44. Determinism

同一:

- input events
- BeatMap
- MeterMap
- QuantizationProfile
- HSQ version

なら同一outputを保証する。

tie-breakingは明示する。

推奨順:

1. lower total cost
2. fewer symbols
3. fewer tuplets
4. fewer ties
5. earlier/simpler grid family
6. lexical Fraction order

randomness禁止。

---

# 45. Versioning

quantizer behaviorはproject reproducibilityに影響する。

projectへ保存:

```text
quantizer:
  id: HSQ
  version: 1
  profile: ...
  weightsVersion: ...
```

weight tuning変更で結果が変わる場合はversionを更新。

既存projectを開いた時に勝手に再量子化しない。

---

# 46. Implementation phases

# Q0 — Domain contract

- TimeWarp
- BeatAnchor
- MeterSegment
- MetricalTree
- QuantizationProfile
- QuantizationAlternative
- diagnostics

No DP yet.

---

# Q1 — Straight fixed-BPM baseline

- 4/4
- manual BPM
- 16th binary grid
- nearest-grid baseline
- test fixtures

Goal:

simple examplesを100% deterministicに通す。

---

# Q2 — k-best onset DP

- candidate generation
- Huber onset cost
- IOI cost
- monotonic path
- top-K path
- global alignment shift

No complex duration yet.

---

# Q3 — Joint duration/rest realization

- transition interval realization
- note offset soft evidence
- rest generation
- tiny-rest penalty
- notation span DP
- ties
- meter boundary cost

ここがHSQ-v1の中核。

---

# Q4 — Meter tree expansion

- 3/4
- 2/4
- 6/8
- compound grouping
- measure boundary handling
- pickup manual phase

---

# Q5 — Triplet

- triplet grid
- region gate
- mode-switch cost
- possible_triplet ReviewIssue
- k-best ambiguity

---

# Q6 — MusicXML integration

- QuantizedRhythmRevision → ScoreDocument
- music21 measure/rest/tie realization
- Verovio render fixture
- MuseScore round trip
- no rhythm mutation

---

# Q7 — Benchmark & tuning

- B0–B4 comparisons
- synthetic jitter corpus
- local horn corpus
- tune weights
- freeze weightsVersion=1
- performance profile

---

# Q8 — Review UX

- ambiguity ranges
- A/B candidate representation
- Japanese ReviewIssue strings
- BPM/meter correction → requantize
- undo/revision integration

---

# Q9 — Later research

- swing
- grace-note decision
- automatic pickup
- odd meters
- 16th triplet
- learned re-ranker
- PM2S/MIDI2Score/Transformer comparison
- polyphonic/voice-aware quantization

---

# 47. Acceptance criteria — HSQ-v1

HSQ-v1を完成とする条件:

- [ ] raw secondsを直接丸めずTimeWarpを通す
- [ ] manual fixed-BPM modeがある
- [ ] BeatMap modeがある
- [ ] 4/4, 3/4, 2/4, 6/8にmeter treeがある
- [ ] onset候補はFractionへquantizeされる
- [ ] onset pathをglobal DPで選ぶ
- [ ] IOI fidelityを評価する
- [ ] note durationとrestをjointly評価する
- [ ] tiny articulation gapが不要なrestになりにくい
- [ ] repeated same-pitch noteを保持する
- [ ] barline crossingをtieで表現できる
- [ ] 8分三連符をauto candidateにできる
- [ ] 6/8 native ternaryをtriplet扱いしない
- [ ] top-3 alternativesを生成できる
- [ ] ambiguous pathからReviewIssueを作れる
- [ ] deterministicである
- [ ] quantizer version/weights versionをprojectに保存できる
- [ ] music21 baselineよりnotation complexityが改善するfixtureがある
- [ ] timing-only ablationよりhuman-readable scoreが改善するfixtureがある
- [ ] MusicXML round-tripでrhythmが変わらない
- [ ] 3–5分monophonic melodyで実用的速度
- [ ] quantization変更だけならAMT再実行不要

---

# 48. Main implementation recommendation

今のHornScribeでは以下を採用する。

```text
Beat / tempo
  librosa baseline or manual anchors
          ↓
piecewise-linear TimeWarp
          ↓
MetricalTree
          ↓
HSQ-v1 custom k-best DP
  timing fidelity
  + notation complexity
  + joint note/rest realization
          ↓
QuantizedRhythmRevision
          ↓
music21 notation realization
          ↓
MusicXML
```

重要:

**music21はnotation engineとして使い、HornScribe固有のquantization decisionはHSQ-v1が持つ。**

---

# 49. Future learned architecture

将来learned modelを導入してもHSQを捨てない。

候補:

```text
performance notes
+ BeatMap
      ↓
Transformer
      ↓
candidate rhythm probability
      ↓
HSQ notation-cost re-ranker
      ↓
score
```

または逆:

```text
HSQ k-best candidates
      ↓
small learned re-ranker
      ↓
best candidate
```

後者は、

- model sizeが小さい
- explainabilityを保てる
- Horn-specific dataが少なくても学習しやすい

ためHornScribeには特に適する可能性がある。

---

# 50. References

## Rhythm quantization

- Cemgil, Desain, Kappen — Rhythm Quantization for Transcription  
  https://doi.org/10.1162/014892600559218

- Cemgil & Kappen — Monte Carlo Methods for Tempo Tracking and Rhythm Quantization  
  https://www.cmpe.boun.edu.tr/~cemgil/cemgil-tempo-quant_bib.html

- qparse  
  https://qparse.gitlabpages.inria.fr/  
  https://qparse.gitlabpages.inria.fr/docs/scientific/

- RQ / OpenMusic  
  https://github.com/openmusic-project/RQ

## Modern learned quantization

- Liu et al. — Performance MIDI-to-score conversion by neural beat tracking, ISMIR 2022  
  https://doi.org/10.5281/zenodo.7316682  
  https://github.com/cheriell/PM2S

- Beyer & Dai — End-to-end Piano Performance-MIDI to Score Conversion with Transformers, ISMIR 2024  
  https://github.com/TimFelixBeyer/MIDI2ScoreTransformer

- Wachter, Murgul, Heizmann — Beat-Based Rhythm Quantization of MIDI Performances, 2025  
  https://arxiv.org/abs/2508.19262

- Wachter, Murgul, Heizmann — Transformer-Based Rhythm Quantization of Performance MIDI Using Beat Annotations, 2026  
  https://arxiv.org/abs/2604.22290

## Beat tracking

- Ellis — Beat Tracking by Dynamic Programming  
  https://labrosa.ee.columbia.edu/projects/beattrack/

- librosa beat tracking  
  https://librosa.org/doc/latest/beat.html

- madmom  
  https://github.com/CPJKU/madmom

## Symbolic / notation libraries

- music21 Stream.quantize  
  https://music21.org/music21docs/moduleReference/moduleStreamBase.html

- music21 Duration  
  https://music21.org/music21docs/moduleReference/moduleDuration.html

- Partitura  
  https://github.com/CPJKU/partitura

- note-seq (archived 2026)  
  https://github.com/magenta/note-seq

## Evaluation

- MUSTER  
  https://amtevaluation.github.io/

- mir_eval transcription  
  https://mir-eval.readthedocs.io/stable/api/transcription.html
