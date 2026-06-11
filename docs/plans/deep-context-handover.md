# PDF Compact 深層コンテキスト引継書 (2026-06-10, Fable 5 → 後続モデルへ)

このファイルは「コードを読んだだけでは復元できない判断・数学・地雷・検証技術」を後続セッション(モデル問わず)に引き継ぐためのもの。
**リファクタリング(refactoring-roadmap.md)や黒塗り v3.8.0 作業を再開する前に必読。**

---

## 0. 現在地 (2026-06-10 時点)

- **main = v3.7.6 (896f068)**: 監査27件+隠れバグ1件を3リリース(v3.7.4/5/6)で全修正済み。配布中。
- **feat/redaction (1fe8058)**: 黒塗り機能 Phase1+2+文字選択改善+バグ11件修正済み。**未マージ・未push分あり**。
  - 待ち: さっちゃんの実データテスト → OK後に main へリベース → v3.8.0 配布
  - ⚠ main が v3.7.0 相当から6リリース進んだため**リベース必須**。衝突予想領域は少ない(redact は独自CSS/HTML/IIFE)が、imgPlace 出力部(v3.7.4/3.7.6で改修)と CSS 末尾は要注意
- 監査の全貌: `docs/audits/bug-audit-v3.7.3-20260610.md` (feat/redaction にコミット済み。mainには未収録)
- lessons.md: **feat/redaction 側に 8〜10番(プレビュー検証の地雷)が追記済み**。main 側には無い。リベース時にそのまま採用すること(両方编集しないこと=衝突回避)

## 1. 座標系の数学 (一番深い知識。コードのコメントより詳しい導出)

### 前提
- **ページ座標系** (pdf-lib が描く世界): 原点=左下、y軸上向き、回転前の MediaBox 基準
- **viewport 座標系** (pdf.js が表示する世界 = ユーザーが見る世界): 原点=左上、y軸下向き、**/Rotate 適用後**、**CropBox 基準**
- /Rotate R は「表示時に時計回りに R 度回す」指示 (PDF仕様)
- pdf-lib の `drawImage({rotate: degrees(θ)})` は**反時計回り(CCW)に θ 度**、回転中心はアンカー(x,y)=画像の左下

### viewport→ページの逆写像 (W,H = CropBox の幅/高さ pt)
| /Rotate | page x | page y |
|---|---|---|
| 0   | vx        | H - vy |
| 90  | vy        | vx |
| 180 | W - vx    | vy |
| 270 | W - vy    | H - vx |

### 画像を「見た目どおり」に焼く手順 (imgPlace の viewportRectToDrawOpts)
1. 見た目の矩形: 左上(a,b)、幅w、高さh (viewport pt)
2. アンカー = **画像の見た目の左下** = viewport点 (a, b+h) を上の表で逆写像
3. `rotate: degrees(R)` を付ける (時計回り表示を打ち消すには同角のCCW描画が正解。θ-R=0 の理屈)
4. CropBox 原点 (crop.x, crop.y) を最後に加算 (CropBox=MediaBox なら +0 で従来一致)

### 検算済みケース (これを崩す変更はNG)
- R=90, A4縦(595×842), 見た目左上に 100×50 → アンカー page(50,0)、占有 x∈[0,50] y∈[0,100]、表示で正立 ✓
- 黒塗り(redact)側は**別実装**(canvas に直接 fillRect する方式なので回転は pdf.js viewport が吸収。比率0..1保存)。リファクタ Phase 2 で統一する時は「redact はラスタ化前提・imgPlace はベクタ上描画」という**前提の違い**に注意

## 2. 各モジュールの地雷 (触る前に知るべき不変条件)

### 黒塗り (feat/redaction)
- **出力エンジン (generateRedactedPdf / verifyRedaction / runExport) は完成品。1文字も触るな。**
  黒は必ず canvas fillRect で焼く (pdf-lib drawRectangle で被せるのは「偽リダクション」=下の文字が残る、構造的禁止)
- verifyRedaction は affected スナップショットのみ検査 → 出力中の編集が混ざらないよう **st.exporting ロックが命綱** (uniq-1)
- dedupeRects は `st.rects[pi] = rects` で**配列参照を差し替える** → 参照を捕捉して長時間使うコードを書いたら負け
- st.rendering は「最新世代だけが解除」する設計 (renderGen 後勝ち)。古い呼び出しに解除させると競合が再発する
- pageHasText は「非空白spanあり」基準。value=空のCID spanは幅0でクリック不能なので、空白のみ頁を no-text 扱いにしても click-to-redact は壊れない (検討済み)
- MIN_PX=2 は **canvas px 基準**。比率基準(旧MIN_PCT)に戻すと大判CADで小文字が無言死する (uniq-2 の再発)
- selectionchange 自動確定は 800ms デバウンス + **_mouseHeld ガード** (マウス押下中は確定しない=ドラッグ途中の勝手確定防止) + touchstart でフラグ掃除 (互換mouseupが来ないブラウザ対策)
- ×削除の confirm は「10pxはみ出しボタンがクリック横取り→無言削除」の遮断。幾何修正では根絶不能と検証済み (セル高19px < ボタン22px)

### PdfSanitize (基盤)
- process() の入口ゲートは `!isEnabled() && !isWatermarkEnabled()` の**OR構成**。isEnabled だけに戻すと「メタ除去OFF+透かしON」で透かしが無言で消える (v3.7.5 で発見した