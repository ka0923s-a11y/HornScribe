## 問題

`texture=auto` でミックスを検出したとき、OVERLAPPING_CANDIDATES の issue に `suggestVoicesTexture: true` が付き、UI は「voices で採譜し直す」ワンクリックを出す（#148）。

しかし `texture=mono` をユーザーが明示指定した場合、同じ量の重なりが検出されても `suggestVoicesTexture` は常に false（`auto_mix_detected` は auto 専用）。「単音のつもりで指定したが実は伴奏付きだった」という実用上ありがちなケースで、救済手段が提示されない。

## 方針

mono でも同じ閾値（AUTO_TEXTURE_MIN_OVERLAPS + 比率）を超えたら `suggestVoicesTexture: true` を付ける。melody は伴奏を畳み込むのが仕様なので対象外。

## 受け入れ条件

- texture=mono + 有意な重なり → issue の evidence に suggestVoicesTexture: true
- texture=auto の既存挙動不変
- texture=melody では付かない
