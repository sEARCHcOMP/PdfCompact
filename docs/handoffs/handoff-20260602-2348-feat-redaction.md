# [Handoff] 黒塗り(墨消し)機能 Phase1完了・Phase2が次 — 2026-06-02 23:48 (branch: feat/redaction)

## Goal / Scope
PDF Compact に「黒塗り(墨消し)」機能を新6モードとして追加する。
契約書・施主情報・図面の一部を**本物の不可逆消去**(黒矩形+ページ画像化)で隠す。
偽リダクション(黒を被せただけで下のテキストがコピペで抜ける)を構造的に防ぐのが要件。

## Done (今セッション完了)
- [x] 次機能ブレストworkflow → top3 (重複検出/出力フッター/写真台帳)。ユーザーは黒塗り+電子印鑑を選択、黒塗りから着手
- [x] 黒塗り実装設計workflow (6エージェント) → `docs/plans/redaction.md` に全プラン保存
- [x] コアスパイク実証: ページラスタ化で getTextContent textLen=0 (文字物理消滅) を確認
- [x] **黒塗り Phase1 実装** (feat/redaction branch、a7f77d4):
  - mode-tab「黒塗り」+ #modeRedact パネル + panelIdMap エントリ
  - 独自 .redact-* CSS (既存 .imgplace-* 非干渉)
  - redactModule IIFE: PDF読込→pdf.jsレンダ→ドラッグ矩形描画(比率0..1保持)→×削除→ページ全消去→ページ送り
  - 矩形は半透明プレビュー+赤警告、出力ボタンは disabled
- [x] preview検証: 6モード全切替OK・既存5モード回帰なし・エラーゼロ・描画/削除/クリア全動作
- [x] feat/redaction を origin に push 済み

## In Progress
なし (Phase1 はキリよく完了。Phase2 は未着手の新規)

## Pending (= Phase2 = 次にやる本体)
- [ ] 影響ページの高DPIラスタ化エンジン (canvas に fillRect黒焼き→toDataURL JPEG→pdf-lib embedJpg→addPage)。**黒は必ず canvas fillRect で。pdf-lib drawRectangle で黒を被せるのは絶対禁止(偽リダクション)**
- [ ] 非影響ページはベクター温存 (copyPages)。create()+全ページ積み直し方式に統一
- [ ] 付随情報の明示削除 (前例ゼロ・最重要): 全ページの /Annots、Outlines(しおり)、AcroForm、Names/Dests、Info8項目+XMP。黒塗り対象が注釈/しおり/フォーム値に残る漏洩を塞ぐ
- [ ] **出力前ブロッキング検証 (fail-safe)**: 出力bytesを pdf.js で再読込し、影響ページ getTextContent().items===0 + getOperatorList に Tj/TJ無し + 全ページに対象語が残らない、を確認。1つでも違反したらDL中止
- [ ] 安全UX: 出力時「Nページが画像化され文字選択不可・解像度低下」モーダル(理解したチェック必須) + 出力後プレビュー全ページ表示
- [ ] 回転PDF(/Rotate 90/180/270)・CropBox付きCAD PDF・注釈付きPDF で実機テスト
- [ ] 全部通ったら main マージ → APP_VERSION 3.8.0 → version.json/README/ZIP更新 → push (= 配布開始)
- [ ] その後 rank2: 電子印鑑(ハンコ画像配置)= imgPlace配置エンジン流用、黒塗りと配置基盤共有

## Key files
- `pdf_compact_bundle.html` — 本体(17,186行)。redactModule IIFE は「設定モーダル wiring」コメントの直前。#modeRedact パネルは footer 直前。.redact-* CSS は FILENAME INPUT セクション直前
- `docs/plans/redaction.md` — Phase2 の完全実装プラン(設計判定/アーキ/11ステップ/証明テストコード/安全UX/adversarial critical)。**Phase2 はまずこれを読む**
- `C:\tmp\redact_*.{css,html,js}` — Phase1で挿入した3部品の元(参考、消えてる可能性あり)

## Gotchas / 注意点
- **main を絶対汚さない**: 黒塗り未完成のまま main に push すると auto-update で全同僚に半端なタブが配られる。完成(Phase2全通過)まで feat/redaction で作業
- 現在 APP_VERSION=3.7.0 据置・version.json=3.7.0・ZIP=3.7.0 のまま(配布は透かしまで)
- preview の preview_eval/screenshot は重いpdf.jsレンダで30s頻繁にタイムアウト → 軽い単発evalに分割、または node で検証
- ファイル編集は Edit が「file modified since read」で弾かれがち(node スクリプトで一括 splice してるため)→ node で編集 or 都度 Read
- 偽リダクションの2大抜け道(adversarial指摘): (A)回転ページで黒がズレる→canvas直描きで回避済だが回転PDF実機確認必須 (B)copyPagesで非影響ページの注釈/しおりに残る→付随情報削除で塞ぐ(前例ゼロの新規実装)
- ZIPは `[System.IO.Compression.ZipFile]::CreateFromDirectory(...UTF8)` で作る(Compress-Archive は日本語名cp932化け)

## 次の最初の一手
家(or 次回)で `git pull && git checkout feat/redaction` → `docs/plans/redaction.md` を読む → Phase2 の「影響ページ高DPIラスタ化エンジン + 出力前 getTextContent=0 検証」から着手。まず軽量化の写真モード(compressPdfBlobPhotoMode 周辺)を Grep して消去エンジンを写経する。

## 関連リンク
- 設計プラン: docs/plans/redaction.md
- Phase1 コミット: a7f77d4 (feat/redaction)
- 直近リリース: v3.7.0 (main, 透かし)
