## 概要

`vocalIsolation=true` かつDemucs利用可能な環境で、selection採譜でもDemucsが**元音源全体を分離**していました。
#229 の「10分音源の30秒選択ならML/解析も30秒だけ処理する」性能契約が、vocal isolationを有効にした瞬間に崩れていました。

## 変更点

- `_stage_span_wav()` を追加：selection範囲をステレオでdecodeし、temp WAVとしてstage。
- `isolate_demucs_vocals()`：range指定時（`start_sec>0` or `end_sec is not None`）はstageされたspanを
  demucsへ渡す。full-range jobは従来どおり元ファイルを直接渡す。
- stage済みspanはselection-relativeなので、分離後のslice処理をconditionalに変更。
- staging失敗時はcenter extractionへdegrade（既存のfallback契約を維持）。
- cache keyは既にspanを含むため変更なし。

## 検証

- 新規 `TestDemucsSpanStaging`：
  - selection(60〜90秒)で `_stage_span_wav` が呼ばれ、demucsへSTAGED.wavが渡る
  - full-rangeでstagingせずsrc.wavを直接渡す
- `pytest tests\python\test_vocal.py`：5件パス（librosa依存3件はdev venvでskip）。
- `ruff` / `mypy`：クリーン。

Closes #320
