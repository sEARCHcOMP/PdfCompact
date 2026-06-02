# 黒塗り(墨消し)機能 実装プラン (workflow設計)

> ワークフロー wf_f45bb47e で並列設計→adversarial検証→合成。スパイクで核心(ラスタ化で textLen=0=文字物理消滅)確認済み。

## 設計判定
条件付きGO（ただし現状の設計のままでは NO-GO）。エンジン基盤(compressPdfBlobPhotoMode 9579行・customCell UI 12544-12767行・getTextContent 9443行・getOperatorList 12263行・stepStripMetadata 8303行・copyPages)は全て実在を確認でき、reconの再利用評価は概ね正確。本体テキストを物理消去する核心思想(canvas fillRect黒焼き+JPEG embed強制・drawRectangleで黒を置かない)も正しい。しかし『偽リダクションにならないか』の観点で2つの致命的未解決があり、これを潰すまで実装着手は不可: (A)回転ページで黒矩形がズレて機密がラスタ画像に丸見えで焼かれる事故。既存imgPlace出力に同根のTODO(16503-16506行)が放置されており、redactionでは軽微バグが情報漏洩に化ける。verify_stepの文字残存チェックでは検出不能なため、座標一致を実機スパイクで先に証明し、watermarkの回転処理(8458行)で補正を確立すること。(B)非affectedページの注釈/しおり/フォーム値/CropBox外/OCGに対象テキストが copyPages 経由で残る漏洩。削除コードは前例ゼロの新規実装で、最も事故りやすい部分が未検証。検証も全ページの付随情報を走査対象に含めること。この(A)(B)を不変条件に昇格し、apply_order 1→2→3→4 を完了させてから機能GO。回帰リスク自体は新IIFE分離方針で十分低く抑えられる。

## アーキテクチャ
配置: 新6モード「🖤 黒塗り」。理由=黒塗りは既存5モードと別ワークフロー(矩形を描く→ラスタで本物消去)で、imgPlace のカスタムセルUIは流用するが「画像配置」とは意図が違うため独立タブが最適。imgPlace IIFE への相乗りは autosave スキーマ/clearBase 等が画像配置前提で密結合のため回帰源になるので採らない。

全体構成(touch 箇所を最小化):
1. 共有HTML(🔴): C:\Users\PC-92\pdf-compact\pdf_compact_bundle.html の mode-tabs(3849付近の imgplace タブ直後)に <button class="mode-tab" data-mode="redact"> を1個追加。mode-panel として <div class="mode-panel" id="modeRedact"> を imgPlace パネルの後ろに1個追加。
2. 共有JS(🟡・1行): mode 切替の panelIdMap(9856)に redact:'modeRedact' を1エントリ追加。これだけで既存5モードは無傷(他は p.classList.remove('active') の汎用処理)。
3. 共有CSS(🟡): .redact-cell / .redact-cell-handle / .redact-cell-delete 等を新規追加(既存 .imgplace-custom-cell* は絶対に流用しない=クラス名衝突で imgPlace 編集UIに副作用。MEMORY『既存クラス名流用ミス防止』準拠)。色は黒系(半透明 rgba(0,0,0,.55))。
4. 新IIFE(🟢・本体): (function redactModule(){ ... })() を imgPlace IIFE の後に1個追加。内部に pdf.js 読込/ページ表示/矩形描画UI(写経)/出力(ラスタ+メタ削除)/出力前検証/出力後プレビューを全部閉じ込める。グローバルは window.PDFLib/pdfjsLib を読むだけ(再代入禁止)。
5. 別 IndexedDB(🟢): const RD_IDB_DB='pdfcompact_redact_autosave' など imgPlace の IDB_DB_NAME と別 DB 名にし、autosave 衝突を物理回避(verify 回帰#5)。

座標系3層(全て実在確認済): ブラウザpx(canvasFrame 基準, getBoundingClientRect) → ページmm(pageSizesMm, /Rotate 適用後) → ラスタpx(getViewport({scale:dpi/72}), 同じ /Rotate 適用後)。getPagePosMm(13155)で px→mm。矩形は {xMm,yMm,widthMm,heightMm}(中心+mm)で保持し %指定で DOM 配置(updateCustomCellDom 12544 と同型, 解像度非依存)。mmToPt は PT_PER_MM 既存定数で trivial(ただし黒塗り本体は pt 描画を使わないので不要、ページ寸法 addPage 用にのみ baseVp.width/height を使う)。

出力パイプライン方式(verify の3案混在を1案に確定): PDFDocument.create() で空 outDoc を作り、全ページを順に積む。
- affectedページ(黒塗り矩形あり)→ getViewport({scale:dpi/72}) で canvas レンダ → ctx.fillRect で黒焼き → toDataURL('image/jpeg') → embedJpg → addPage([baseVp.width,baseVp.height]) に drawImage(9604-9609 と同型)。回転は viewport が吸収済みなので addPage は回転0素ページ。
- 非affectedページ → outDoc.copyPages(srcDoc,[i]) でベクター温存コピー → 直後に付随情報削除(後述)を必ず通す。
この方式なら「黒塗りページは画像化で本物消去」「非黒塗りページはベクター品質温存」を両立し、create() ベースなので catalog/Info も新規=不要物が乗りにくい(ただし copyPages が持ち込む注釈等は明示削除が必須)。

## 実装ステップ
### 1. 回転スパイク (本実装前の検証・最優先)
- action: /Rotate 90/180/270 を持つサンプルPDF(スマホスキャナ出力)で、ユーザーが描いた黒塗り矩形 mm 座標 → ラスタ canvas px の落ち位置が、意図したテキスト上に正しく乗るかを目視確認する。
- detail: renderCurrentPage(13073-13112)が page.getViewport({scale})(/Rotate 適用後)で canvas を作り、pageSizesMm(12129)も同じ getViewport で作られている事を根拠に『描画フレーム=ラスタフレーム=回転適用後で一致』を仮説とし、これを実機で証明する。確認手順: redactModule の出力ラスタ関数だけ先に作り、画面右端に矩形を1個描いて出力→出力PDFのその矩形が右端テキストを隠しているか目視。ズレたら getRotation()/buildPageOrientationMatrix(8403)で補正を入れるが、仮説通りならゼロ補正で合うはず(canvas 焼き込みは pdf-lib page.getSize() の回転前座標を一切使わないため、imgPlace 16503 の TODO とは無関係)。ここがNGなら以降全工程が無意味なので、最初に潰す。

### 2. 共有HTML: タブ + パネル (🔴 スコープ宣言)
- action: pdf_compact_bundle.html 3849(imgplace タブ)直後に黒塗りタブを追加、imgPlace パネル後に <div id="modeRedact"> を追加。
- detail: <button class="mode-tab" data-mode="redact"><svg>(目隠しアイコン)</svg><span>黒塗り</span></button>。パネルは hero(『契約書・図面の一部を本当に消す。黒塗りページは画像化されます』)+ dropzone(redactDropzone)+ canvasFrame(redactCanvasFrame/redactCanvas)+ 矩形レイヤ(redactCellLayer)+ ページナビ + DPIプリセット(図面300/契約書150/既定200)+ 出力ボタン + 出力後プレビュー領域 を配置。id は全て redact 接頭辞で imgPlace と衝突回避。回帰チェック: 追加後に既存5モードのタブ切替とレイアウト崩れが無いかブラウザで確認(変更スコープ🔴宣言)。

### 3. 共有JS: mode 切替マップ (🟡・1行)
- action: 9856 の panelIdMap に redact: 'modeRedact' を1エントリ追加。
- detail: 他は触らない。document.querySelectorAll('.mode-panel')(9855)の汎用 remove('active') が新パネルも面倒を見るので、追加はこの1行のみ。scrollGuideToSection(9870)は取説未整備でも try されないなら無害。

### 4. 共有CSS: .redact-* 独自クラス (🟡)
- action: .imgplace-custom-cell 系(クラス定義箇所)を写経して .redact-cell / .redact-cell-handle.handle-nw|ne|sw|se / .redact-cell-delete / .redact-cell-preview を新規作成。
- detail: 色のみ黒系に変更: 本体 background rgba(0,0,0,.55)、border 1px solid #000、ハンドルは白縁の黒小四角。既存 .imgplace-* は1つも再利用しない(MEMORY『既存クラス名流用ミス防止』=流用すると imgPlace 編集UIに副作用)。プレビュー黒は『半透明=下が透ける』を厳守(完全不透明だと『もう消えた』と誤認し未出力配布事故を誘発、safety_ux 反映)。

### 5. 新IIFE redactModule: 読込 + ページ表示 + 矩形描画UI写経
- action: (function redactModule(){'use strict'; ...})() を imgPlace IIFE 後に追加。pdf.js 読込→pageSizesMm 構築(12127-12134 写経)→renderCurrentPage(13073-13112 写経, intent:'print')→renderCustomCells/updateCustomCellDom/getPagePosMm/handleCustomCellEditMove/handleCustomCellEditEnd/computeCustomCellSnap(12544-12767 写経, 変数名 redactCellsByPage 等にリネーム)。
- detail: 矩形は redactCellsByPage{pageIndex→[{xMm,yMm,widthMm,heightMm}]} で保持。罫線スナップ(extractPageLines/buildDetectedSnapTargets)は黒塗りに必須でないので初版は省略可(写経対象を絞り事故率減)。複製(+)ボタンは流用、×削除も流用。autosave は別 DB(RD_IDB_DB)に redactCellsByPage を put(openIdb 16062 写経, DB名だけ変更)。CDN フォント取得コード(WM_NOTO_URL 8341)は黒塗り経路に絶対混入させない(100%LOCAL 維持, safety_ux 反映)。

### 6. 新IIFE: 本物消去エンジン (affectedページ raster + 黒焼き)
- action: compressPdfBlobPhotoMode(9579-9617)を写経し generateRedactedPdf() を作る。create() で outDoc → 全ページループ → affected はラスタ+fillRect黒焼き、非affected は copyPages。
- detail: affectedページ判定 = redactCellsByPage[i] が存在し、かつ widthMm>0.5 && heightMm>0.5 の有効矩形を1つ以上含む(空矩形/極小矩形/削除後の空配列は非affected扱いにし、ただしUIで『このページは黒塗り無し』と明示してverify critical_issue#5の取り違え防止)。ラスタ手順: page.getViewport({scale:dpi/72})→canvas白背景→page.render(9595-9597)→各矩形を ctx.fillStyle='#000';ctx.fillRect(xMm/pageWmm*canvas.width, yMm/pageHmm*canvas.height, wMm/pageWmm*canvas.width, hMm/pageHmm*canvas.height) で焼く(左上原点 mm→px、xMm/yMm は中心なので xL=xMm-w/2 等で左上換算)→toDataURL('image/jpeg',q)→atob→Uint8Array→embedJpg→addPage([baseVp.width,baseVp.height])→drawImage(9608-9609)。canvas.width=0 + setTimeout(0) で1枚ずつ解放(9611-9612, perf 必須)。【不変条件】pdf-lib drawRectangle で黒を置くコードは絶対に書かない(レビューで grep 確認)。黒塗りページは必ず embedJpg 経路を通す条件分岐を物理的に固定(ベクターのまま黒矩形を乗せる分岐を作らない)。

### 7. 新IIFE: 全ページ付随情報削除 (前例ゼロの新規実装・最重要)
- action: outDoc 全ページ(affected/非affected両方)に対しメタ/注釈/しおり/フォーム/名前付き宛先を明示削除。stepStripMetadata(8303-8331)を写経しベースにする。
- detail: (1)Info 8項目(Title/Author/Subject/Keywords/Producer/Creator/CreationDate/ModDate)+ XMP /Metadata 参照+context.delete(8303-8331 写経)。(2)全ページ /Annots 削除: page.node.delete(PDFName.of('Annots'))(注釈/リンク/フォーム値に黒塗り対象が残るため。affectedはラスタで本体消えるが注釈は別オブジェクトなので別途必須、非affectedも copyPages が持ち込むため必須=verify critical_issue(B)対応)。(3)AcroForm 削除: catalog.delete(PDFName.of('AcroForm'))(Widget は注釈とフォーム辞書の二重参照で施主名/契約金額が残る罠)。(4)Outlines(しおり)削除: catalog.delete(PDFName.of('Outlines'))(しおり名に施主名/金額の典型漏洩、デフォルト全削除)。(5)Names/Dests/OpenAction/JavaScript/EmbeddedFiles: catalog から点検・削除。(6)各ページ /Thumb 削除(黒塗り前縮小画像残留)。各削除は件数を検証ログに記録。全て pdf-lib 生 API で写経元が薄いため、各削除後に getTextContent 検証(step8)で実効を確認する二重防御。

### 8. 新IIFE: 出力前ブロッキング自動検証 (本物消去の機械的証明)
- action: save 前に outBytes を pdf.js で再 getDocument し、(a)全 affectedページの getTextContent().items.length===0、(b)全 affectedページの getOperatorList に Tj/TJ/'/" 無し(画像 Do のみ)、(c)全ページの残 Annots/Outlines が無い、を検証。1つでも違反したらDLさせずエラー。
- detail: getTextContent は detectBestMode(9443)を写経、getOperatorList は extractPageLines(12263)を写経。fail-safe: affectedページに1文字でも残れば『❌黒塗り失敗:文字が残っています。出力中止』。非affectedページは getTextContent で黒塗り対象語(ユーザーが塗った領域の元テキスト)が残らない事は構造上保証できない(ベクター温存だから)ので、ここは『注釈/しおり/メタが消えたか』のみ検証し、本文残留は『非affectedページは元のまま温存(黒塗り対象を含むなら affected にすべき)』とUIで明示。検証はブロッキング+進捗表示(perf_notes: ラスタ+検証で実質2回処理のため検証フェーズも進捗バー)。

### 9. 新IIFE: 安全UX (Apple水準・誤配布事故防止)
- action: プレビュー仮黒塗りは半透明+赤注記『今は仮表示。下の文字はまだ生きています。出力して初めて消えます』。affectedページサムネに『🖤画像化される(文字選択不可・解像度低下)』バッジ常時表示。出力ボタン押下時モーダル『Nページが画像に変換され、文字のコピー/検索ができなくなります。これは情報を物理的に消す仕様です』+チェック『理解した』必須。
- detail: 矩形は対象文字+各辺2mm余白推奨ツールチップ(物理塗り残し防止, leak_check⑬)。『黒塗りの無いページはベクター品質のまま温存』を明示(全ページ画像化との誤解防止)。『出力後も元PDFは手元に残る。原本を誤配布しないよう別フォルダへ』警告(墨消し典型事故=原本取り違え)。iPad(iOS Safari)は canvas 面積上限(~16.7Mpx)で A3@300dpi が破綻し得るため、デバイス判定でDPI上限クランプ+『この端末では○dpiに制限しました』明示(perf_notes 反映)。空矩形/ページ外矩形は affected にカウントしないがUIで『黒塗り0個のページ』と明示(取り違え事故防止)。ファイル名は 墨消し_{YYYYMMDD}_{連番}.pdf(規約準拠)。

### 10. 新IIFE: 出力後プレビュー (ユーザー目視検証)
- action: 出力直後、結果PDFを pdf.js で全ページ再レンダしプレビュー表示。affectedページに『🖤画像化済(文字選択不可)』バッジ。各黒塗り箇所を拡大表示するボタンで塗り残し(矩形からはみ出た文字)を目視確認。
- detail: プレビューにテキストレイヤを敢えて載せない=ユーザーが文字選択を試みても選択できず『本当に消えた』を体感確認。検証ログ(影響ページ番号/残テキスト件数=0/画像オペレータのみ/削除した注釈・しおり件数)を画面表示しエビデンス化。『検証はあなたのPC内で完結、外部送信なし』明記(100%LOCAL 担保)。投げっぱなしにしない(CLAUDE.md UI方針)。

### 11. 回帰防御の最終確認
- action: 既存5モード+サニタイズ _steps(8514)が無傷である事を確認。
- detail: (a)_steps 配列(8514)に push しない(二重描画回帰防止)。(b)window.PDFLib/pdfjsLib 再代入しない(グローバル汚染禁止)。(c).redact-* CSS が .imgplace-* と完全分離。(d)autosave が別 DB 名で imgPlace の IDB と非衝突。(e)CDN フォント非混入。(f)既存5モード全部をブラウザで開いて回帰チェック(タブ切替/軽量化/画像→PDF/変換/PDF編集/画像配置 が従来通り動く)。

## 本物消去の証明テスト
【本物消去の証明テスト = 出力PDFを pdf.js で開き getTextContent が黒塗り対象を返さない事を機械的に確認】

■ テスト用入力の準備(3パターン必須):
(1)通常PDF: テキスト『施主名:山田太郎 契約金額:1,200万円』を含むベクターPDF。
(2)回転PDF: 上記を /Rotate 90 で保存したもの(verify critical_issue(A) の回転ズレ証明用・最重要)。
(3)注釈/しおり付きPDF: しおり名に『山田太郎』、テキスト注釈に『契約金額』、フォームフィールドに施主名を入れたもの(verify critical_issue(B) の付随情報残留証明用)。

■ 検証コード(出力直前にブロッキング実行 + テスト時は手動再現):
```js
async function proveRedaction(outBytes, affectedPageIndices, redactedTerms) {
  const doc = await pdfjsLib.getDocument({ data: outBytes.slice(0) }).promise;
  const report = { ok: true, details: [] };
  // (A) affectedページ: テキストが完全にゼロである事
  for (const i of affectedPageIndices) {
    const page = await doc.getPage(i + 1);
    const tc = await page.getTextContent();          // 写経元: detectBestMode 9443
    const textLen = tc.items.reduce((s, it) => s + (it.str || '').length, 0);
    if (textLen !== 0) { report.ok = false; report.details.push(`page${i+1}: テキスト${textLen}文字残存=黒塗り失敗`); }
    // (B) テキスト描画オペレータが皆無(画像 Do のみ)
    const opList = await page.getOperatorList();      // 写経元: extractPageLines 12263
    const OPS = pdfjsLib.OPS;
    const textOps = [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText];
    const hasText = opList.fnArray.some(fn => textOps.includes(fn));
    if (hasText) { report.ok = false; report.details.push(`page${i+1}: Tj/TJ 描画オペレータ残存=embed漏れ`); }
  }
  // (C) 全ページ走査: 黒塗り対象語が本文/注釈/しおりのどこにも残らない
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const joined = tc.items.map(it => it.str || '').join('');
    for (const term of redactedTerms) {
      if (joined.includes(term)) { report.ok = false; report.details.push(`page${i}本文: 黒塗り対象「${term}」残存`); }
    }
    const annos = await page.getAnnotations();
    for (const a of annos) {
      const t = (a.contents||'')+(a.fieldValue||'')+(a.title||'');
      for (const term of redactedTerms) if (t.includes(term)) { report.ok=false; report.details.push(`page${i}注釈: 「${term}」残存`); }
    }
  }
  // (D) しおり(outline)に黒塗り対象語が無い
  const outline = await doc.getOutline();
  const walk = (items) => { if(!items) return; for(const it of items){ for(const term of redactedTerms) if((it.title||'').includes(term)){report.ok=false;report.details.push(`しおり: 「${term}」残存`);} walk(it.items);} };
  walk(outline);
  return report;   // report.ok===false なら DL を止める(fail-safe)
}
```

■ 合格基準(全て満たさないと NO-GO):
1. パターン(1): affectedページの textLen===0、Tj/TJ なし、本文に『山田太郎』『1,200万円』が出ない。
2. パターン(2)回転: 同上 + さらに『出力PDFを目視レンダして黒矩形が確かに施主名/金額の上に乗っている』(getTextContent はゼロを返すが、黒が"別の場所"に乗ってると本文はラスタ画像に丸見えで焼かれる=getTextContent では検出不能。よって目視 + 可能なら黒矩形領域のピクセルが #000 一色である事をプログラムで確認(canvas で該当 px をサンプリングし RGB≈0,0,0)を追加)。これが verify critical_issue(A) を潰す唯一の手段。
3. パターン(3): 全ページ走査(C)(D)で『山田太郎』『契約金額』が本文・注釈・フォーム・しおりのどこにも出ない(付随情報削除 step7 の実効証明、verify critical_issue(B) を潰す)。
4. fail-safe 動作確認: わざと付随情報削除を1つ無効化し、report.ok===false でDLがブロックされる事を確認(検証が実際に効いている事の証明)。

■ 自動化手順: テスト用 HTML(またはブラウザコンソール)で上記3パターンを順に redactModule に通し、出力 outBytes を proveRedaction() に渡し report を console 出力。3パターン全て report.ok===true(かつ回転は黒矩形ピクセル #000 確認)で GO。1つでも false なら原因(座標ズレ/embed漏れ/付随削除漏れ)を特定して修正。

## adversarial critical issues
1. 【最重大・偽リダクション直結】黒塗り矩形が回転ページ(/Rotate 90/180/270)でズレて隠し損ねる。既存 imgPlace 出力 (16503-16506行) に明示TODOあり: 『pl.xMm/yMm は pdf.js viewport(回転後)座標、page.getSize() は回転前。配置がズレる。現在は回転0前提』。imgPlace では写真が少しズレるだけの軽微バグだが、黒塗りでは『黒が別の場所に乗り、機密テキストが丸見えで画像に焼かれる』致命的事故になる。設計STEP4(c)の px 変換『mm/pageWmm * canvas.width』は、canvas が回転後 viewport なら一見整合するが、ユーザーが矩形を描く座標系(getPagePosMm=回転後 viewport ベース)と、ラスタ canvas(同じ回転後 viewport)が一致していれば偶然合う。だが verify_step がこの一致を保証していない。スキャナ系(回転持ち)PDFで矩形位置を必ず実機テストし、不一致なら出力ブロックする回帰テストが必須。recon の『baseVp は回転適用後なので素直』は full-page raster の向きだけの話で、矩形位置の正しさは別問題。

2. 【設計の自己矛盾・本物消去の核心穴】消去エンジンとして名指しの compressPdfBlobPhotoMode(9579-9617行)は PDFDocument.create() で新規ドキュメントを作る経路。これは annot/outline/AcroForm/XMP が自動的に落ちるから安全。しかし本設計は『ベクターページ温存』要件のため STEP3 で PDFDocument.load(原本) ベースに切替え、STEP5 で create()+copyPages 混在へさらに切替えと、3案が混在し未確定。copyPages は注釈をそのまま持ち越す(7168行のマーケ文言『注釈すべてオリジナルのまま保持』が証拠)。つまり『非affectedページの注釈/フォーム値/しおりに黒塗り対象が残る』漏洩は copyPages 経路では構造的に必ず発生する。設計はこれを STEP8 の手動削除で塞ぐ前提だが、後述の通りその削除コードは前例ゼロ。

3. 【前例ゼロの新規低レベルコード】Annots/Outlines/AcroForm/Widget/Names/Dests/EmbeddedFiles を削除するコードは 16855行中に1つも存在しない(grep 全0ヒット)。再利用可能なのは stepStripMetadata(Info8項目+XMP, 8303行)だけ。設計の leak_checks ③④⑤⑧(注釈・フォーム値・しおり・名前付き宛先削除)は全て pdf-lib 生 API での新規実装で、写経元が無い=最も事故りやすい部分が未検証。特に AcroForm の Widget は注釈とフォーム辞書の二重参照で、片方消しても値が残る罠があり『施主名・契約金額が残る』典型漏洩に直結。

4. 【verify_step の前提崩れ】出力後検証(getTextContent items.length===0 / getOperatorList に Tj/TJ無し)は affectedページにしか走らない設計。だが上記の通り漏洩の主戦場は非affectedページ(copyPages で注釈・しおり経由)。自動検証が『安全』と緑を出しても、非affectedページの注釈に機密が残っていれば素通りする。検証は全ページの Annots/Outlines/AcroForm の文字列も走査しないと『機械的に100%遮断』は誇大。

5. 【影響ページ判定の取りこぼし】affectedPages 判定は『黒塗り矩形が1つ以上ある pageIndex』。しかし矩形を描いた後に削除すると配列が空になり非affected扱い→ラスタされず、しかしユーザーは『一度塗った』記憶で安心して配布、の取り違え事故が起き得る。また矩形がページ外(clamp 漏れ)や width/height≈0 の極小矩形のとき affected と数えるか未定義。空矩形は『塗ったつもり』の最悪の偽リダクション。

## 安全UX
- 【画像化の明示・最重要】黒塗りを1つ置いた瞬間、そのページサムネに「🖤画像化される(文字選択不可・解像度低下)」バッジを常時表示。出力ボタン押下時にモーダル『N ページが画像に変換されます。元のベクター品質は失われ、文字のコピー/検索ができなくなります。これは情報を物理的に消すための仕様です。』を必ず1回挟む(チェックボックス『理解した』必須)。
- 【偽黒塗りの誤解を断つ】プレビューの仮黒塗りは半透明(下が透けて見える)で表示し『今は仮表示。下の文字はまだ生きています。出力して初めて消えます』と赤注記。完全不透明で見せると『もう消えた』と誤認し未出力ファイルを配布する事故を誘発するため、あえて透ける表現にする。
- 【DPI=証拠隠滅の盲点を警告】低DPI(150未満)だと黒塗り隣接の極小文字が画像化前のレンダリングで潰れず、拡大すると周辺が読める懸念は無い(ラスタ後は一律潰れる)が、逆に『黒塗り矩形を小さく描きすぎて文字の端がはみ出す』事故を防ぐため、矩形は対象文字より各辺+2mm 余白を推奨とツールチップ表示。
- 【非影響ページは無傷の明示】『黒塗りの無いページはベクター品質のまま(高精細・文字選択可)で温存されます』とUIに明記。全ページ画像化と誤解させない(=軽量化フォトモードとの差別化、品質劣化を必要最小に)。
- 【100%LOCAL の維持】既存の透かし機能は外部CDNフォント(WM_NOTO_URL/NotoSansJP, bundle 8341行)を取得するが、黒塗りは黒矩形のみでフォント不要。よって黒塗り処理は完全オフラインで動く。この点を『黒塗りは通信ゼロで完結』と明示し設計思想(社外送信ゼロ)を担保。フォント取得コードを黒塗り経路に絶対に混ぜない。
- 【元ファイル保持の警告】『出力後も元PDFは手元に残ります。黒塗り前の原本を誤って配布しないよう、原本は別フォルダへ』と注記(墨消しの典型事故=原本取り違え)。
- 【プレビュー必須化】出力後に自動で結果PDFを pdf.js で再レンダリングし全ページ表示『これが実際に配布されるファイルです。黒塗り箇所と、画像化されたページを目視確認してください』と促す(投げっぱなしにしない=CLAUDE.md UI方針)。
- 【回帰ゼロの担保】既存5モード+サニタイズIIFEには一切触れず、黒塗りは独立した新IIFE(写経)として追加。共有CSS/HTMLに触る場合は変更スコープ宣言(🟢/🟡/🔴)を出す。

## 検証チェックリスト
- [ ] 【最優先スパイク】/Rotate 90/180/270 PDF で黒塗り矩形が意図したテキスト上に正しく焼ける事を実機で証明した(canvas getViewport フレーム一致仮説の検証)。ズレるなら getRotation 補正を入れた。これが通るまで本実装に進まない。
- [ ] 黒塗り本体は ctx.fillRect(canvas px)でのみ実現し、pdf-lib drawRectangle で黒を置くコードがコード中に一切無い(grep で確認)。
- [ ] 黒塗り矩形が1つでも乗ったページは必ず embedJpg ラスタ経路を通る条件分岐になっており、ベクターのまま黒矩形を乗せる分岐が物理的に存在しない。
- [ ] 出力前ブロッキング検証(proveRedaction)で affectedページ getTextContent().items.length===0 かつ Tj/TJ オペレータ皆無を確認し、違反時はDL中止(fail-safe)が動く。
- [ ] 全ページの Info/XMP/Annots/AcroForm+Widget/Outlines/Names/Dests/OpenAction/JavaScript/EmbeddedFiles/Thumb を削除し、削除件数を検証ログに表示している。
- [ ] 出力後プレビューで全ページ再レンダ、affectedに画像化バッジ、黒塗り箇所拡大で塗り残し目視、テキストレイヤ非搭載で『選択できない』を体感確認できる。
- [ ] 回転テスト(パターン2)で黒矩形領域のピクセルが #000 一色(RGB≈0,0,0)である事を確認した(座標ズレで機密が丸見えで焼かれていない事の証明=getTextContent では検出不能な漏洩の唯一の検出手段)。
- [ ] 付随情報テスト(パターン3)で施主名/契約金額がしおり・注釈・フォーム値・本文のどこにも残らない事を全ページ走査で確認した。
- [ ] プレビュー仮黒塗りは半透明(下が透ける)+赤注記『今は仮表示、出力で消える』で表示し、完全不透明にしていない(未出力配布事故の誘発防止)。
- [ ] 出力時モーダル『Nページが画像化・文字選択不可・解像度低下』にチェック『理解した』必須を実装した。原本取り違え警告も表示している。
- [ ] iPad/iOS Safari で A3@300dpi 指定時にDPI上限クランプし『この端末では○dpiに制限』を明示、canvas.width=0+setTimeout(0)で1枚ずつ解放、ラスタ+検証の二重進捗バーを出している。
- [ ] 空矩形/ページ外/極小矩形(widthMm<=0.5等)は affected にカウントせず、かつ『このページは黒塗り0個』とUIで明示し『塗ったつもり』取り違え事故を防いでいる。
- [ ] 【回帰ゼロ】既存5モード(軽量化/画像→PDF/変換/PDF編集/画像配置)+サニタイズ _steps が従来通り動く事をブラウザで確認した。
- [ ] 新IIFE は完全独立、.redact-* 独自CSSクラス(.imgplace-* 非流用)、autosave は別 IndexedDB DB 名、window.PDFLib/pdfjsLib 再代入なし、_steps 非タッチ、CDN フォント非混入。
- [ ] 共有HTML(タブ+パネル)追加は 🔴、共有CSS/JS map 追加は 🟡 として変更スコープを宣言した。
- [ ] 報告に対象ファイル(pdf_compact_bundle.html)の総行数と今回追加行数を明記した(CLAUDE.md 作業後報告ルール)。
