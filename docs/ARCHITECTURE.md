# PDF Compact アーキテクチャ地図

> 新しく入る人(将来の自分・別モデル)が、コードを読む前に全体像を掴むための地図。
> 詳細な「なぜ」「地雷」は docs/plans/refactoring-handoff.md、過去の判断は git log に。

## これは何か
ブラウザだけで動く 100% ローカルの PDF ツールキット。`pdf_compact_bundle.html` 単体(約17,900行)を
ダブルクリックで開くだけで動く。サーバー・インストール・アップロード一切なし。建設会社の非エンジニアが
現場の書類・図面・写真を扱うために使う。配布は GitHub の `version.json` を見た auto-update で1ファイル差替。

## 物理法則(破ると製品が壊れる)
1. **成果物は単一HTML**。src/ に分割しても build で必ず1ファイルに連結し直す。
2. **ランタイム依存ゼロ追加**。pdf.js=CDN、pdf-lib/fontkit/jsPDF/JSZip/heic2any/UTIF/tesseract=CDN同梱。
   bundler/TypeScript/minify は不採用(ツールチェーンの寿命 < ツールの寿命)。
3. **黒塗りは本物の消去**。偽リダクション(黒を被せただけで下の文字が残る)は情報漏洩。構造的に作らない。
4. ワーキングコピーは **CRLF**。

## ビルド(src → bundle)
```
node build.js          # src/ を連結して pdf_compact_bundle.html を生成(連結のみ・CRLF維持)
node build.js --check  # 生成結果が現行 bundle と byte 一致するか SHA 検証
npm test               # pretest で build:check → Playwright スモーク(27本)
pwsh build/release.ps1 -Version x.y.z -Notes "..."  # テスト→版上げ→ZIP→整合チェック
```
build.js は `src/index.template.html`(骨格)の sentinel 3つに
`src/styles.css` / `src/guide.html` / `src/app/*.js`(連番ソート順で連結)を差し込むだけ。

## ファイル地図(src/)

### 骨格・スタイル・取説
| ファイル | 行 | 役割 |
|---|---|---|
| `index.template.html` | 1,169 | DOCTYPE / CDN script 8本 / タブ・6パネルのHTML / 閉じタグ。sentinel 3つ |
| `styles.css` | 3,905 | 全CSS(モード別スタイル混在。Phase 4 で死にスタイル掃除予定) |
| `guide.html` | 3,377 | 取説(`<script type="text/html" id="guideSource">` の中身)。**ここに `</script>` 厳禁**(外側が早期終了する。過去 v3.3.5 で破壊) |

### アプリJS(`src/app/*.js` — 連番ソート順 = bundle 内 `<script>` の連結順)
すべて同一 `<script>` 内のトップレベル(または各モードのIIFE)。**00-core-* が先に来て共有helperを定義 → 各モードがそれを使う。**

| ファイル | 行 | 役割 |
|---|---|---|
| `00-core-00-sanitize.js` | 434 | 更新ソース(`_decodeBase` 等)+ **`window.PdfSanitize` IIFE**(メタ除去/透かし) |
| `00-core-10-update-guide.js` | 424 | バージョンバナー(`checkForUpdate`/`showUpdateBanner`)+ 取説ドック管理 |
| `00-core-20-shared.js` | 578 | **共有helper**: `formatBytes` `escapeHtml` `triggerDownload` `makeOutputName` `showSuccess` `handleFiles`/`render`(軽量化のUI)`viewportRectToPageDrawOpts`(座標写像) `readExifOrientation`(EXIF) `setActionBarStatus`/`setModeStatus`(ステータス) |
| `00-core-30-compress.js` | 337 | **軽量化エンジン**: `detectBestMode` `compressPdfDocMode` `compressPdfPhotoMode*` `compressPdfPhotoModeOCR` `compressPdf` |
| `00-core-40-init.js` | 116 | timestamp helper / `restartWarpAnimations` / タブ切替 / 初期化 |
| `10-img2pdf.js` | 673 | モード「画像→PDF」(`imgToPdfModule` IIFE) |
| `20-convert.js` | 670 | モード「変換」(`converterModule` IIFE) |
| `30-pdfedit.js` | 700 | モード「PDF編集」(`pdfEditModule` IIFE。結合/分割/回転/並替) |
| `40-imgplace-00-head.js` | 396 | モード「画像配置」: IIFE開始 + 状態95個 + DOM参照 + `loadBasePdf`/`deletePage` |
| `40-imgplace-10-lines.js` | 811 | 罫線検出・スナップ・カスタムセル・整列ガイド |
| `40-imgplace-20-render.js` | 339 | `renderCurrentPage` / リサイズ / 移動スナップ |
| `40-imgplace-30-placement.js` | 854 | 配置の選択/削除/整列/プロパティ/`renderPlacements` |
| `40-imgplace-40-library.js` | 748 | サムネ / 画像ライブラリ |
| `40-imgplace-50-place.js` | 966 | 中央配置/`pushPlacement`/配置キュー/ラバーバンド/ドラッグ |
| `40-imgplace-60-export.js` | 657 | 出力/autosave(IndexedDB)/プロジェクト保存復元/`generatePdfOutput` + init + IIFE閉じ |
| `50-redact.js` | 526 | モード「黒塗り」(`redactModule` IIFE)。**本物の不可逆消去** |
| `90-settings.js` | 254 | ⚙️設定モーダル wiring(透かし/メタ除去トグル・絵文字除去・storage同期) |

> imgPlace は状態95個を全関数で共有する密結合のため、ファイルは7分割したが **closure は1つ**
> (真の分離は高リスクなので未実施)。00-core も script トップレベルを byte 順序保存で5分割。

## データフロー(共通)
1. ファイル投入(D&D / input change)→ 各モードの状態へ
2. プレビュー描画(pdf.js でレンダ、オーバーレイは viewport 比率%)
3. 生成(pdf-lib / jsPDF で出力 blob)→ `window.PdfSanitize.process(blob)`(メタ除去/透かし)→ `triggerDownload`

## 共通helperの所在(重複統合済み = ここだけ直せば全モードに効く)
- **座標写像** viewport→ページ: `viewportRectToPageDrawOpts`(00-core-20)。imgPlace が薄いmmラッパーで使用。
  黒塗りは viewport 空間で完結するため写像不要。透かしは別primitive(行列方式 `buildPageOrientationMatrix`)。
- **EXIF orientation**: `readExifOrientation`(00-core-20)。img2pdf/imgPlace が委譲。
- **ダウンロード**: `triggerDownload`。**HTMLエスケープ**: `escapeHtml`。**サイズ整形**: `formatBytes`。
- **ステータス**: `setModeStatus`/`setActionBarStatus`。
- **暗号化検出は意図的にモード別**(統合しない): サニタイズ=絶対平文化しない / pdfedit=getPermissions / imgplace等=ignoreEncryption:true。
- **実行中フラグも統合しない**: 長処理ロック(isConverting/st.exporting)と描画レース制御(st.rendering[renderGen]/isRendering[renderPending])は別概念。

## テスト(tests/ — `npm test` で27本)
| spec | 守るもの |
|---|---|
| `redact.spec.js` | 黒塗り: クリック/重複マージ/**出力の生バイト秘密ゼロ**/no-text誘導/A3フィット/×confirm |
| `geometry.spec.js` | **座標写像ゴールデン**: 回転4×CropBox2(画像配置)+ 黒塗り2。プレビュー≠出力の最頻発バグへの番犬 |
| `exif.spec.js` | EXIFパーサ等価性(orientation 1-8×両エンディアン) |
| `sanitize.spec.js` | 透かし単独ON/フォント遮断トースト/絵文字除去 |
| `img2pdf.spec.js` / `convert.spec.js` / `pdfedit.spec.js` / `compress.spec.js` | 各モードの v3.7.x で直した代表バグの回帰防止 |

`tests/helpers.js` に合成PDF生成・出力blob捕捉(detach対策)・ピクセル判定・生バイト走査の共通部品。

## 検証の作法(リファクタの防波堤)
- リファクタ中(byte保存)は `node build.js --check` で byte 一致を SHA 確認。
- 実コード改修(Phase 2以降)は byte 一致を捨て、**27テストが防波堤**。
- 表面の結果を信じず**ピクセルかバイトで機械判定**(過去、透かしを秘密残骸と誤認・blob detach で空判定の偽FAILを踏んだ)。
- プレビューが重いページで劣化したら **preview サーバごと再起動**。

## リファクタの履歴(2026-06 完了分)
17,265行の単一HTML monolith → src/ 分割 + 連結build.js + 17モジュール(全≤966行)。
Phase 0(テスト基盤)→ Phase 1(ビルド工程+app.js7分割)→ Phase 2(共通基盤6統合)→
Phase 3(imgPlace7分割+00-core5分割で全ファイル1,500行以下達成)。
**配布物 bundle は機能不変**(byte保存の分割 + テストで担保した挙動不変の統合)。
