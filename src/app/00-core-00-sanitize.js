  // ===================================================================
  // ===== バージョン管理 + 起動時アップデートチェック =====
  // -------------------------------------------------------------------
  // 設定方法:
  //   1. 新版を出すたびに APP_VERSION を上げる (semver: x.y.z)
  //   2. _BASE_B64 を更新したい場合は btoa('https://HOST/') で base64 化した
  //      文字列に差替える (配布元の隠蔽のため、平文URLはコメントにも書かない)
  //   3. 配布サーバ(リポジトリ直結)に次の2ファイルを置く:
  //        - version.json:  { "version": "2.2.0", "notes": "..." [, "download_path": "..." ] }
  //        - index.html (新版本体。旧名 pdf_compact_bundle.html から改名済)
  //   4. 配信は Cloudflare Pages (Access-Control-Allow-Origin: * を実測確認済み。
  //      v3.9.x までは GitHub raw。Google Drive は CORS で大半失敗するため不可)
  // 隠蔽方式 (casual viewer 向け):
  //   - URL は base64 にして source 直読みでは配布元が見えない
  //   - DL は fetch → Blob → <a download> で起動、アドレスバーに raw URL 出ない
  //   * DevTools のネットワークタブを開かれたら見える (完全秘匿は不可)
  // ===================================================================
  const APP_VERSION = '4.3.1';
  // base64(raw配布URL)。平文URLをコメントに書くと隠蔽が無意味になるため書かない(更新時は btoa() の結果だけ貼る)
  const _BASE_B64 = 'aHR0cHM6Ly9wZGZjb21wYWN0LnBhZ2VzLmRldi8=';
  function _decodeBase() {
    try { return atob(_BASE_B64); } catch (_e) { return ''; }
  }
  function _manifestUrl() {
    const b = _decodeBase();
    return b ? b + 'version.json' : '';
  }
  function _downloadUrl(manifest) {
    const b = _decodeBase();
    if (!b) return '';
    if (manifest && manifest.download_path) return b + manifest.download_path;
    // 互換: 絶対 URL の download_url が指定されてればそれ (但し username 漏洩注意)
    if (manifest && manifest.download_url) return manifest.download_url;
    return b + 'index.html';
  }

/* ===================================================================
 * window.PdfSanitize  (v3.6.0 rank1: メタデータ除去 / v3.7.0 rank2: 透かし)
 * -------------------------------------------------------------------
 * 全PDF出力点から呼ぶ共通サニタイザ。top-level スコープ(メインscript直下)に
 * 置き、各エンジン(jsPDF / pdf-lib)の IIFE からも window 経由で叩ける。
 *
 * 使い方(各出力点に最小挿入):
 *   blob = await window.PdfSanitize.process(blob);   // PDF blob のみ通す
 *
 * 設計:
 *   - 設定の真実源は UI 側 window.PdfSanitizeSettings (localStorage pdfc_settings_v1)。
 *     未ロード時のフォールバックのみ自前 localStorage / デフォルトON を見る。
 *   - 設定OFF時は完全パススルー(渡された blob をそのまま返す)
 *   - ONなら pdf-lib で load → 情報辞書8項目 delete → XMP実体ごと削除 → save
 *   - 暗号化PDFは絶対に平文化しない: load を ignoreEncryption 無しで呼び、
 *     失敗(EncryptedPDFError/破損)時は元 blob をそのまま返すフォールバック。
 *     その際 _lastSkippedEncrypted=true を立て、呼び出し側(setStatus が
 *     スコープにあるモード)が任意に可視化できるようにする。
 *   - rank2(透かし)を後で足せるよう、処理を _steps パイプラインに分割。
 * =================================================================== */
window.PdfSanitize = (function () {
  'use strict';

  var LS_KEY = 'pdfc_settings_v1';   // UI と同一キー(単一真実源)。helper は通常 UI 窓口経由で読む

  // ---- 設定読み取り ---------------------------------------------------
  // 優先順: api.opts.enabled(実行時上書き) > window.PdfSanitizeSettings(UI真実源)
  //         > 自前 localStorage(UI未ロード時の保険) > デフォルトON
  function isEnabled() {
    try {
      if (api.opts && typeof api.opts.enabled === 'boolean') return api.opts.enabled;
    } catch (_e) {}
    // ★ 単一真実源: UI wiring が公開する窓口を最優先で見る
    try {
      if (window.PdfSanitizeSettings &&
          typeof window.PdfSanitizeSettings.metadataEnabled === 'function') {
        return window.PdfSanitizeSettings.metadataEnabled();
      }
    } catch (_e) {}
    // フォールバック: UI 未ロードでも安全側に倒す(同じ JSON キーを直接読む)
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw === null) return true;            // 未設定はデフォルトON(漏洩防止を既定に)
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'stripMetadata' in parsed) {
        return parsed.stripMetadata !== false;
      }
      return true;
    } catch (_e) {
      return true;                              // 読めない環境でも安全側(ON)
    }
  }

  // 設定の書き込みは UI(window.PdfSanitizeSettings / トグル)が一元管理する。
  // helper からの直接書き込み口は実行時上書き opts.enabled のみ提供。
  function setEnabled(on) {
    try { api.opts.enabled = !!on; } catch (_e) {}
  }

  // ---- pdf-lib 参照(遅延取得: 読込前に呼ばれても落とさない) -----------
  function getPDFLib() {
    return (typeof window !== 'undefined' && window.PDFLib) ? window.PDFLib : null;
  }

  // ---- blob → Uint8Array ---------------------------------------------
  async function blobToBytes(blob) {
    if (blob && typeof blob.arrayBuffer === 'function') {
      return new Uint8Array(await blob.arrayBuffer());
    }
    return await new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = reject;
      fr.readAsArrayBuffer(blob);
    });
  }

  // =====================================================================
  // 処理ステップ(パイプライン)。各 step は (pdfDoc, PDFLib) を受け取り
  // pdfDoc を破壊的に編集する。rank2 透かしはここに step を1つ足すだけ。
  // =====================================================================

  // step: メタデータ8項目クリア + XMP削除
  function stepStripMetadata(pdfDoc, PDFLib) {
    if (!isEnabled()) return;   // メタ除去OFF(透かしだけONで process が走った時)は何も消さない
    var PDFName = PDFLib.PDFName;
    // --- 情報辞書(Document Info)から8項目を物理削除 ---
    // setXxx('') だと空文字 () が残るので、辞書から直接 delete する
    var FIELDS = ['Title', 'Author', 'Subject', 'Keywords',
                  'Producer', 'Creator', 'CreationDate', 'ModDate'];
    try {
      var info = pdfDoc.getInfoDict();      // 無ければ pdf-lib が生成して返す
      if (info && typeof info.delete === 'function') {
        for (var i = 0; i < FIELDS.length; i++) {
          info.delete(PDFName.of(FIELDS[i]));
        }
      }
    } catch (_e) { /* 情報辞書なしでも続行 */ }

    // --- XMP メタデータストリームを削除 ---
    // catalog の /Metadata 参照を外し、さらに context から実体を消さないと
    // 孤立オブジェクトとして出力バイトに残り XMP(作成者名等)が漏れる
    try {
      var catalog = pdfDoc.catalog;
      var xmpRef = catalog.get(PDFName.of('Metadata'));
      if (xmpRef) {
        catalog.delete(PDFName.of('Metadata'));
        if (xmpRef.constructor && xmpRef.constructor.name === 'PDFRef'
            && typeof pdfDoc.context.delete === 'function') {
          pdfDoc.context.delete(xmpRef);    // 孤立ストリーム漏洩対策
        }
      }
    } catch (_e) { /* XMP なしでも続行 */ }
  }

  // ====================================================================
  // 透かし (rank2 / v3.7.0) — 以下5関数 + フォントキャッシュは必ず IIFE 内
  // (isWatermarkEnabled / getWatermarkText が私有の api・LS_KEY を参照する)
  // ====================================================================

  // ---- 利用者向け警告トースト (無言スキップ防止) ----
  // メタ除去/透かしが適用できなかった事実を、どのモードからでも見える形で必ず可視化する。
  // 従来は静かにスキップ=「✓完了」のまま透かし無し/メタ残りのPDFを配布する事故経路があった。
  // トーストはサニタイズ層が自前で出すので、各モード側の配線は不要(全出力経路を一括カバー)。
  function notifyWarn(msg) {
    try {
      var el = document.getElementById('pdfcSanitizeWarn');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pdfcSanitizeWarn';
        el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(640px,90vw);z-index:99999;background:#7a2e0e;color:#fff;padding:12px 18px;border-radius:10px;font-size:13.5px;line-height:1.6;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:pointer;';
        el.title = 'クリックで閉じる';
        el.addEventListener('click', function () { el.style.display = 'none'; });
        document.body.appendChild(el);
      }
      el.textContent = '⚠ ' + msg;
      el.style.display = 'block';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(function () { el.style.display = 'none'; }, 12000);
    } catch (_e) { try { console.warn('[PdfSanitize] ' + msg); } catch (_e2) {} }
  }

  // ---- 透かし用 日本語フォント (Noto Sans JP) 遅延ローダ ----
  // imgPlace IIFE 内 NOTO_REGULAR_URL は helper から見えない為、同一 URL を複製。
  var WM_NOTO_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf';
  var _wmFontBytes = null;     // ArrayBuffer キャッシュ (成功時のみ保持)
  var _wmFontPromise = null;   // in-flight 共有 (同時呼び出しでも fetch を1本に)

  function loadWatermarkFont() {
    if (_wmFontBytes) return Promise.resolve(_wmFontBytes);
    if (_wmFontPromise) return _wmFontPromise;
    _wmFontPromise = (function () {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = null;
      if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 60000);
      var opts = { cache: 'force-cache' };
      if (ctrl) opts.signal = ctrl.signal;
      return fetch(WM_NOTO_URL, opts)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (buf) { _wmFontBytes = buf; return buf; })
        .catch(function (err) { _wmFontPromise = null; throw err; })
        .finally(function () { if (timer) clearTimeout(timer); });
    })();
    return _wmFontPromise;
  }

  // ---- 透かし設定の解決 (UI 窓口優先 → localStorage フォールバック) ----
  // 透かしは既定 OFF (opt-in)。判定順は enabled→text→fontkit→font fetch を死守。
  function isWatermarkEnabled() {
    try { if (api.opts && typeof api.opts.watermark === 'boolean') return api.opts.watermark; } catch (_e) {}
    try {
      if (window.PdfSanitizeSettings && typeof window.PdfSanitizeSettings.watermarkEnabled === 'function') {
        return window.PdfSanitizeSettings.watermarkEnabled();
      }
    } catch (_e) {}
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw === null) return false;          // 未設定は OFF (opt-in)
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed.watermark === true;
      return false;
    } catch (_e) { return false; }            // 読めなければ OFF (安全側)
  }

  // 絵文字(サロゲートペア=U+10000以上)は NotoSansJP にグリフが無く出力で欠落する。
  // UI側でも除去するが、過去に保存済みの絵文字入り設定への防御としてここでも除去する (M14)。
  // 除去で空になったら既定の「社外秘」に倒す。
  function sanitizeWatermarkText(t) {
    var s = String(t == null ? '' : t).replace(/[\u{10000}-\u{10FFFF}]/gu, '').trim();
    return s || '社外秘';
  }

  function getWatermarkText() {
    try { if (api.opts && typeof api.opts.watermarkText === 'string' && api.opts.watermarkText) return sanitizeWatermarkText(api.opts.watermarkText); } catch (_e) {}
    try {
      if (window.PdfSanitizeSettings && typeof window.PdfSanitizeSettings.watermarkText === 'function') {
        var t = window.PdfSanitizeSettings.watermarkText();
        if (t && String(t).trim()) return sanitizeWatermarkText(t);
      }
    } catch (_e) {}
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw !== null) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.watermarkText && String(parsed.watermarkText).trim()) {
          return sanitizeWatermarkText(parsed.watermarkText);
        }
      }
    } catch (_e) {}
    return '社外秘';
  }

  // 回転ページの描画系を「見た目の左下原点」に正規化する変換行列。
  // (rawW, rawH は回転前 MediaBox 寸法)
  function buildPageOrientationMatrix(PDFLib, rot, rawW, rawH) {
    var m = PDFLib.concatTransformationMatrix;
    if (rot === 90)  return m(0, 1, -1, 0, rawW, 0);
    if (rot === 180) return m(-1, 0, 0, -1, rawW, rawH);
    if (rot === 270) return m(0, -1, 1, 0, 0, rawH);
    return m(1, 0, 0, 1, 0, 0);                  // rot=0 恒等
  }

  // step: 透かし。全ページ視覚中央に45度・薄グレー・不透明度18%で1個。
  // 日本語必須 → NotoSansJP subset 埋込。失敗は静かにスキップ(出力は止めない)。
  async function stepDrawWatermark(pdfDoc, PDFLib) {
    if (!isWatermarkEnabled()) return;          // OFF なら即 return (font fetch より前)
    var text = getWatermarkText();
    if (!text || !text.trim()) return;
    text = text.trim();

    var fontkit = (typeof window !== 'undefined' && window.fontkit) ? window.fontkit : null;
    if (!fontkit) return;
    if (typeof pdfDoc.registerFontkit !== 'function') return;

    var fontBytes;
    try { fontBytes = await loadWatermarkFont(); }
    catch (_e) {
      // CDN失敗等 → 透かし無しで出力は継続するが、必ず利用者に見える形で知らせる
      notifyWarn('透かしを入れられませんでした(透かし用フォントを取得できません。ネット接続を確認してください)。今回の出力PDFに透かしは入っていません。');
      return;
    }
    if (!fontBytes) return;

    var rgb = PDFLib.rgb;
    var degrees = PDFLib.degrees;

    var font;
    try {
      pdfDoc.registerFontkit(fontkit);           // 冪等。透かしが要る時だけ登録
      font = await pdfDoc.embedFont(fontBytes, { subset: true });
    } catch (_e) {
      // 埋込失敗 → 透かし無しで出力は継続するが、必ず利用者に知らせる
      notifyWarn('透かしを入れられませんでした(フォントの埋め込みに失敗)。今回の出力PDFに透かしは入っていません。');
      return;
    }

    var OPACITY = 0.18;
    var GRAY = rgb(0.5, 0.5, 0.5);
    var ANGLE = 45;
    var RAD = ANGLE * Math.PI / 180;
    var COS = Math.cos(RAD);
    var SIN = Math.sin(RAD);

    var pages = pdfDoc.getPages();
    for (var p = 0; p < pages.length; p++) {
      var page = pages[p];
      // ★ pushOperators/concat/drawText/popGraphicsState を1つの try で囲い、
      //   finally で必ず popGraphicsState する。ここが throw しても process() の
      //   for-catch に落とさない = メタ除去済みPDFを巻き戻さない (regression対策)。
      var pushed = false;
      try {
        var size = page.getSize();
        var rawW = size.width;
        var rawH = size.height;
        var rot = 0;
        try {
          var r = page.getRotation();
          rot = ((r && typeof r.angle === 'number' ? r.angle : 0) % 360 + 360) % 360;
        } catch (_e) { rot = 0; }
        var swap = (rot === 90 || rot === 270);
        var visW = swap ? rawH : rawW;
        var visH = swap ? rawW : rawH;

        var minSide = Math.min(visW, visH);
        var fontSize = minSide * 0.12;
        if (fontSize < 18) fontSize = 18;
        if (fontSize > 140) fontSize = 140;

        var textW, textH;
        try {
          textW = font.widthOfTextAtSize(text, fontSize);
          textH = font.heightAtSize(fontSize);
        } catch (_e) { textW = fontSize * text.length * 0.6; textH = fontSize; }

        // 長文言の見切れ対策: 回転後の文字幅が紙面対角に収まるよう shrink-to-fit。
        // 中央1個なので両端見切れを防ぐ簡易ガード(機能破綻ではないが念のため)。
        var maxSpan = Math.min(visW, visH) * 1.15; // 45度なので短辺基準で余裕を見る
        if (textW > maxSpan && textW > 0) {
          var shrink = maxSpan / textW;
          fontSize = Math.max(12, fontSize * shrink);
          try { textW = font.widthOfTextAtSize(text, fontSize); textH = font.heightAtSize(fontSize); }
          catch (_e) {}
        }

        page.pushOperators(
          PDFLib.pushGraphicsState(),
          buildPageOrientationMatrix(PDFLib, rot, rawW, rawH)
        );
        pushed = true;

        var cx = visW / 2;
        var cy = visH / 2;
        var dx = (textW / 2) * COS - (textH / 2) * SIN;
        var dy = (textW / 2) * SIN + (textH / 2) * COS;
        var anchorX = cx - dx;
        var anchorY = cy - dy;

        page.drawText(text, {
          x: anchorX, y: anchorY, size: fontSize,
          font: font, color: GRAY, opacity: OPACITY, rotate: degrees(ANGLE)
        });
      } catch (_e) {
        // 1ページ失敗でも他ページ・最終 save は継続
      } finally {
        if (pushed) {
          try { page.pushOperators(PDFLib.popGraphicsState()); } catch (_e) {}
        }
      }
    }
  }

  // 実行順パイプライン。メタ除去 → 透かし の順 (透かしは最後に乗せる):
  // ★ 配列リテラルに直接追記のみ。api._steps.push は併用しない(二重登録→2回描画防止)
  var _steps = [stepStripMetadata, stepDrawWatermark];

  // =====================================================================
  // メイン: process(blob) -> Promise<Blob>
  // =====================================================================
  async function process(blob) {
    api._lastSkippedEncrypted = false;   // 毎回リセット(呼び出し側が直後に読む)

    // 入力ガード: blob でない / PDF でないものは触らない(png/jpg等は素通し)
    if (!blob) return blob;
    if (blob.type && blob.type.indexOf('pdf') === -1) return blob;

    // 設定OFF → 完全パススルー(メタ除去と透かしの両方がOFFの時だけ)
    // 従来は isEnabled()=メタ除去設定だけを見ていたため、「メタ除去OFF+透かしON」の組合せで
    // 透かしが無言で入らないバグがあった(stepStripMetadata 側には G4c の内部ガードを追加)
    if (!isEnabled() && !isWatermarkEnabled()) return blob;

    var PDFLib = getPDFLib();
    if (!PDFLib || !PDFLib.PDFDocument) return blob; // ライブラリ未読込でも壊さない

    var bytes;
    try {
      bytes = await blobToBytes(blob);
    } catch (_e) {
      return blob; // 読めなければ原本返す
    }

    var pdfDoc;
    try {
      // ★ ignoreEncryption は付けない。暗号化PDFはここで throw → catch で原本返す
      //    = 平文化しない安全策(他モードの ignoreEncryption:true とは意図的に逆)
      pdfDoc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch (_e) {
      // 暗号化 or 破損 → サニタイズ不可。原本を無加工で返す + 必ず利用者に知らせる
      api._lastSkippedEncrypted = true;
      notifyWarn('このPDFは保護付き(または破損)のため、メタデータ除去/透かしを適用できませんでした。中身はそのまま出力しています。');
      return blob;
    }

    try {
      for (var i = 0; i < _steps.length; i++) {
        await _steps[i](pdfDoc, PDFLib); // step は同期だが将来の非同期に備え await
      }
      // ★ updateMetadata:false 必須。true だと pdf-lib が Producer/ModDate を再注入する
      var outBytes = await pdfDoc.save({ updateMetadata: false });
      return new Blob([outBytes], { type: 'application/pdf' });
    } catch (_e) {
      // 加工/保存で想定外エラー → 安全側で原本を返す(出力は止めないが、必ず利用者に知らせる)
      notifyWarn('出力の仕上げ処理(メタデータ除去/透かし)でエラーが発生したため、未適用のまま出力しました。');
      return blob;
    }
  }

  var api = {
    process: process,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    _steps: _steps,                 // rank2 拡張用に公開
    _lastSkippedEncrypted: false,   // 直近 process で暗号化スキップしたか(mode側が可視化に使う)
    LS_KEY: LS_KEY,
    opts: { /* enabled: true/false で実行時上書き可 */ }
  };
  return api;
})();

  // semver 比較: a > b なら true
