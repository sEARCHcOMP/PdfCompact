  // ===================================================================
  // ===== バージョン管理 + 起動時アップデートチェック =====
  // -------------------------------------------------------------------
  // 設定方法:
  //   1. 新版を出すたびに APP_VERSION を上げる (semver: x.y.z)
  //   2. _BASE_B64 を更新したい場合は btoa('https://raw.githubusercontent.com/USER/REPO/main/')
  //      で base64 化した文字列に差替える (username 隠蔽のため)
  //   3. リポジトリに次の2ファイルを置く:
  //        - version.json:  { "version": "2.2.0", "notes": "..." [, "download_path": "..." ] }
  //        - pdf_compact_bundle.html (新版本体)
  //   4. CORS 全開で安定する GitHub raw を使用 (Google Drive は CORS で大半失敗)
  // 隠蔽方式 (casual viewer 向け):
  //   - URL は base64 にして source 直読みでは username 見えない
  //   - DL は fetch → Blob → <a download> で起動、アドレスバーに raw URL 出ない
  //   * DevTools のネットワークタブを開かれたら見える (完全秘匿は不可)
  // ===================================================================
  const APP_VERSION = '3.8.0';
  // base64('https://raw.githubusercontent.com/sEARCHcOMP/PdfCompact/main/')
  const _BASE_B64 = 'aHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL3NFQVJDSGNPTVAvUGRmQ29tcGFjdC9tYWluLw==';
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
    return b + 'pdf_compact_bundle.html';
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
  function semverGt(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
  // バージョンラベルを footer と トップブランドの両方に表示
  function showVersionLabel() {
    const labels = ['appVersionLabel', 'appVersionTopLabel'];
    for (const id of labels) {
      const el = document.getElementById(id);
      if (el) el.textContent = 'v' + APP_VERSION;
    }
  }
  // blob 経由ダウンロード (URL をアドレスバーに出さない)
  async function downloadUpdate(url, dlBtn) {
    if (!url) return;
    const origLabel = dlBtn ? dlBtn.textContent : '';
    try {
      if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = 'DL中...'; }
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'pdf_compact_bundle.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
      if (dlBtn) dlBtn.textContent = 'DL完了 ✓';
    } catch (e) {
      alert('ダウンロード失敗: ' + (e.message || e) + '\nオフラインや設定不備の可能性あり');
      if (dlBtn) dlBtn.textContent = origLabel || 'DL';
    } finally {
      if (dlBtn) dlBtn.disabled = false;
    }
  }
  // バナー表示
  function showUpdateBanner(manifest) {
    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    const versionLabel = document.getElementById('updateVersionLabel');
    const notes = document.getElementById('updateNotes');
    const dlBtn = document.getElementById('updateDlBtn');
    const closeBtn = document.getElementById('updateCloseBtn');
    if (versionLabel) versionLabel.textContent = manifest.version;
    if (notes) {
      notes.textContent = '';
      notes.classList.remove('scrolling');
      notes.style.removeProperty('--un-shift');
      notes.style.removeProperty('--un-dur');
      var _inner = document.createElement('span');
      _inner.className = 'un-inner';
      _inner.textContent = manifest.notes || '';
      notes.appendChild(_inner);
      // レイアウト確定後に溢れ量を測り、溢れてたらゆっくり往復スクロール
      requestAnimationFrame(function(){
        var ov = _inner.scrollHeight - notes.clientHeight;
        if (ov > 4) {
          notes.style.setProperty('--un-shift', (-ov) + 'px');
          notes.style.setProperty('--un-dur', Math.max(7, Math.round(ov / 10) + 6) + 's');
          notes.classList.add('scrolling');
        }
      });
    }
    if (dlBtn) {
      dlBtn.onclick = () => {
        downloadUpdate(_downloadUrl(manifest), dlBtn);
      };
    }
    if (closeBtn) {
      closeBtn.onclick = () => {
        banner.style.display = 'none';
        try { localStorage.setItem('pdfCompactUpdateDismissed', manifest.version); } catch (_e) {}
      };
    }
    banner.style.display = '';
  }
  // 起動時チェック (オフライン/未設定なら静かに何もしない)
  async function checkForUpdate() {
    const url = _manifestUrl();
    if (!url) return;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      if (!manifest || typeof manifest.version !== 'string') return;
      if (!semverGt(manifest.version, APP_VERSION)) return;
      // 同じバージョンを既に閉じてたら再通知しない
      let dismissed = '';
      try { dismissed = localStorage.getItem('pdfCompactUpdateDismissed') || ''; } catch (_e) {}
      if (dismissed === manifest.version) return;
      showUpdateBanner(manifest);
    } catch (e) {
      // ネットワークエラー / CORS / 無効JSON はオフライン扱いで黙殺
      console.debug('[updateCheck] skipped:', e && e.message);
    }
  }
  // 取説を起動時に自動でドック表示 (ユーザー要件)
  // × で閉じたら sessionStorage に記録、当セッション内は再表示しない
  const GUIDE_AUTO_OPEN_DISMISS_KEY = 'pdfCompact.guideAutoOpenDismissed';
  function autoOpenGuide() {
    // スマホでは自動表示しない (全画面モーダルが立ち上がってツール触れない問題回避)
    // ユーザーが「使い方」ボタン押下した時のみ全画面表示する
    // iPad portrait (768px) はドック可能なので自動表示する
    if (window.innerWidth < 700) return;
    try {
      // 当セッションで × を押されてたらスキップ
      if (sessionStorage.getItem(GUIDE_AUTO_OPEN_DISMISS_KEY) === '1') return;
    } catch(_) {}
    // 既に開いてる場合はスキップ (二重起動防止)
    const modal = document.getElementById('guideModal');
    if (modal && modal.classList.contains('open')) return;
    if (typeof window.openGuide === 'function') {
      try { window.openGuide(); } catch(e) { console.debug('autoOpenGuide failed:', e); }
    }
  }
  // DOMContentLoaded 後にバージョンラベル表示 + 2秒遅延でチェック + 取説自動表示
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      showVersionLabel();
      setTimeout(checkForUpdate, 2000);
      // ページレンダリング完了後に取説オープン (少し遅らせて他の init を邪魔しない)
      setTimeout(autoOpenGuide, 100);
      setTimeout(initSettingsHint, 800);
    });
  } else {
    showVersionLabel();
    setTimeout(checkForUpdate, 2000);
    setTimeout(autoOpenGuide, 100);
    setTimeout(initSettingsHint, 800);
  }

  // Defensive: wrap in try so a missing library doesn't block function declarations below
  try {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  } catch (e) { console.warn('pdf.js worker setup failed:', e); }

  // ===== Guide modal =====
  function openGuide() {
    const modal = document.getElementById('guideModal');
    const iframe = document.getElementById('guideFrame');
    const srcEl = document.getElementById('guideSource');
    if (!modal || !iframe || !srcEl) {
      console.error('Guide elements missing', { modal: !!modal, iframe: !!iframe, srcEl: !!srcEl });
      alert('取説の読み込みに失敗しました。ページを再読み込みしてください。');
      return;
    }
    const src = srcEl.textContent || srcEl.innerHTML || '';
    if (!src || src.length < 100) {
      console.error('Guide source empty or too short:', src.length);
      alert('取説の内容が空です。ページを再読み込みしてください。');
      return;
    }

    // Show modal first
    modal.classList.add('open');
    // 常にドック表示で開く (ユーザー要件: 「開いたら右に出す、不要なら×で閉じる」)
    // 過去の docked 状態は記憶しない (= 全画面切替は当セッションのみ有効)
    setGuideDocked(true, false);

    // Install anchor-click interceptor inside the iframe doc.
    // This prevents hash links from navigating (which triggers the Claude
    // artifact viewer's "loading" error) and scrolls manually instead.
    function installAnchorHandler() {
      try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!doc || doc.__anchorHandlerInstalled) return;
        doc.__anchorHandlerInstalled = true;
        // ガイド側の topnav-cta 「ツールを開く」を非表示 (親側の × ボタンと役割重複するため)
        // 親 JS で style 注入 (ガイド HTML 内に script 入れると外側の <script type="text/html"> が早期終了する)
        try {
          const hideStyle = doc.createElement('style');
          hideStyle.textContent = '.topnav-cta { display: none !important; }';
          (doc.head || doc.documentElement).appendChild(hideStyle);
        } catch (e2) { /* ignore */ }
        // 現在の active タブに合わせて該当セクションへスクロール
        // (iframe load 中にタブ切替された場合に備えて、ここで再取得する)
        const _currentTab = document.querySelector('.mode-tab.active');
        const _currentMode = _currentTab ? _currentTab.dataset.mode : null;
        if (_currentMode && typeof scrollGuideToSection === 'function') {
          try { scrollGuideToSection(_currentMode, 'auto'); } catch(_) {}
        }
        doc.addEventListener('click', function(e) {
          let el = e.target;
          // Walk up to find an anchor with href
          while (el && el !== doc.body && el.tagName !== 'A') {
            el = el.parentNode;
          }
          if (!el || el.tagName !== 'A') return;
          const href = el.getAttribute('href');
          if (!href || href.charAt(0) !== '#') return;
          e.preventDefault();
          const id = href.slice(1);
          if (!id) {
            // href="#" → scroll to top
            (doc.documentElement || doc.body).scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
          const target = doc.getElementById(id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, true);
      } catch (e) {
        console.warn('Anchor handler install failed:', e);
      }
    }

    // onload fires for srcdoc and data URL paths
    iframe.onload = installAnchorHandler;

    // Write content into iframe — try multiple methods for max compatibility
    let written = false;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (doc) {
        doc.open();
        doc.write(src);
        doc.close();
        written = true;
        // doc.write doesn't always fire iframe.onload → install synchronously
        installAnchorHandler();
      }
    } catch (e) {
      console.warn('iframe.contentDocument.write failed:', e);
    }

    // Fallback: srcdoc attribute
    if (!written) {
      try {
        iframe.srcdoc = src;
        written = true;
      } catch (e) {
        console.warn('iframe.srcdoc failed:', e);
      }
    }

    // Last resort: data URL (works everywhere but URL-encodes)
    if (!written) {
      try {
        iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(src);
      } catch (e) {
        console.error('All iframe load methods failed:', e);
        alert('取説の表示に失敗しました。ブラウザを変更してお試しください。');
      }
    }
  }
  function closeGuide() {
    const modal = document.getElementById('guideModal');
    const iframe = document.getElementById('guideFrame');
    if (modal) {
      modal.classList.remove('open');
      // docked 状態も解除 (html の padding-right も外す)
      modal.classList.remove('docked');
      document.body.classList.remove('guide-docked');
      document.documentElement.style.removeProperty('padding-right');
      document.body.style.overflow = '';
    }
    // × で閉じた場合、当セッションは自動表示しない (リロードまでは再オープンしない)
    try { sessionStorage.setItem(GUIDE_AUTO_OPEN_DISMISS_KEY, '1'); } catch(_) {}
    setTimeout(() => {
      if (iframe) {
        // Clear all possible content sources
        try { iframe.srcdoc = ''; } catch(e) {}
        try { iframe.removeAttribute('srcdoc'); } catch(e) {}
        try { iframe.src = 'about:blank'; } catch(e) {}
      }
    }, 320);
  }
  // ===== 取説のドック切替 (右側ピン留め ⇔ 全画面モーダル) =====
  const GUIDE_DOCK_KEY = 'pdfCompact.guideDocked.v2'; // v3.3.2: 旧キーが auto-save で汚染されてたので刷新
  const GUIDE_DOCK_W_KEY = 'pdfCompact.guideDockWidth';
  const GUIDE_DOCK_MIN = 320;
  // スマホ・狭画面ではドック禁止 (ドック幅 > viewport で tool が完全に隠れる)
  // iPad portrait (768px) はギリギリ通すため 700px 閾値
  const GUIDE_DOCK_MIN_VIEWPORT = 700;
  function isMobileViewport() {
    return window.innerWidth < GUIDE_DOCK_MIN_VIEWPORT;
  }
  // viewport 適応のデフォルトドック幅 (iPad portrait 768 → 345px, iPad landscape 1024 → 460px, PC → 480px)
  function getGuideDockDefault() {
    return Math.min(480, Math.max(GUIDE_DOCK_MIN, Math.floor(window.innerWidth * 0.45)));
  }
  // 旧キー (v3.3.0/3.3.1) を削除 (新規ユーザーは影響なし、旧ユーザーはリセット)
  try { localStorage.removeItem('pdfCompact.guideDocked'); } catch(e) {}
  function getGuideDockMax() {
    // 画面幅の 70% を上限 (ツール側が狭くなりすぎないように)
    return Math.max(GUIDE_DOCK_MIN + 100, Math.floor(window.innerWidth * 0.7));
  }
  function applyGuideDockWidth(px) {
    const clamped = Math.max(GUIDE_DOCK_MIN, Math.min(getGuideDockMax(), px));
    document.documentElement.style.setProperty('--guide-dock-w', clamped + 'px');
    // padding-right は html 要素に inline で設定 (body だと Chrome の何かに弾かれて効かない)
    if (document.body.classList.contains('guide-docked')) {
      document.documentElement.style.setProperty('padding-right', clamped + 'px', 'important');
    }
    try { localStorage.setItem(GUIDE_DOCK_W_KEY, String(clamped)); } catch(e) {}
    return clamped;
  }
  // persist=true なら設定保存 (ユーザー操作)、false なら表示変更のみ (openGuide からの自動適用)
  function setGuideDocked(docked, persist) {
    if (persist === undefined) persist = true;
    const modal = document.getElementById('guideModal');
    if (!modal) return;
    // スマホ・狭画面では強制的に全画面モーダル化 (docked を許可するとツール側が完全に隠れる)
    if (docked && isMobileViewport()) {
      docked = false;
    }
    const btn = document.getElementById('guideDockBtn');
    if (docked) {
      modal.classList.add('docked');
      document.body.classList.add('guide-docked');
      // body の overflow を戻す (docked なら下のツール操作できる必要あり)
      document.body.style.overflow = '';
      if (btn) btn.title = '全画面表示に戻す';
      // 保存された幅を適用 (この中で body の padding-right も inline 設定される)
      let saved = parseInt(localStorage.getItem(GUIDE_DOCK_W_KEY) || '0', 10);
      if (!saved || isNaN(saved)) saved = getGuideDockDefault();
      applyGuideDockWidth(saved);
      if (persist) { try { localStorage.setItem(GUIDE_DOCK_KEY, '1'); } catch(e) {} }
    } else {
      modal.classList.remove('docked');
      document.body.classList.remove('guide-docked');
      // html の inline padding-right を解除 (CSS のデフォルトに戻す)
      document.documentElement.style.removeProperty('padding-right');
      // モーダル開いてる時のみ overflow hidden に戻す
      if (modal.classList.contains('open')) {
        document.body.style.overflow = 'hidden';
      }
      if (btn) btn.title = '右側にドッキング (ツールと並べて表示)';
      if (persist) { try { localStorage.setItem(GUIDE_DOCK_KEY, '0'); } catch(e) {} }
    }
  }
  function toggleGuideDock() {
    const modal = document.getElementById('guideModal');
    if (!modal) return;
    setGuideDocked(!modal.classList.contains('docked'), true);
  }

  // スプリッターのドラッグでドック幅をリアルタイム調整
  (function initGuideDockSplitter() {
    const start = () => {
      const splitter = document.getElementById('guideDockSplitter');
      if (!splitter) return;
      let dragging = false;
      const onDown = (e) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.classList.add('guide-dock-resizing');
        try { splitter.setPointerCapture(e.pointerId); } catch(_) {}
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        // パネルは右端固定 → 幅 = viewport幅 - クリックX
        const newW = window.innerWidth - e.clientX;
        applyGuideDockWidth(newW);
      };
      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('guide-dock-resizing');
        try { splitter.releasePointerCapture(e.pointerId); } catch(_) {}
      };
      splitter.addEventListener('pointerdown', onDown);
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
      splitter.addEventListener('pointercancel', onUp);
      // setPointerCapture が失敗するブラウザ用フォールバック:
      // ポインタが iframe 上に逃げて離されても確実に dragging を解除
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  })();

  // 起動時: 保存された ドック幅を CSS var に反映 (即用意しないと初回ガクッと動く)
  (function restoreGuideDockWidth() {
    let saved = parseInt(localStorage.getItem(GUIDE_DOCK_W_KEY) || '0', 10);
    if (!saved || isNaN(saved)) saved = getGuideDockDefault();
    // 大画面で保存 → 小画面で起動した時、視窗の 70% を超えないよう clamp
    const clamped = Math.max(GUIDE_DOCK_MIN, Math.min(getGuideDockMax(), saved));
    document.documentElement.style.setProperty('--guide-dock-w', clamped + 'px');
  })();

  // ウィンドウリサイズ時にドック幅を再 clamp (ブラウザ縮めた時のはみ出し防止)
  // モバイル幅に縮んだ時はドックを強制解除して全画面モーダル化
  window.addEventListener('resize', () => {
    if (!document.body.classList.contains('guide-docked')) return;
    // モバイル幅になったらドック解除 (ツール側が完全に隠れるのを防ぐ)
    if (isMobileViewport()) {
      setGuideDocked(false, false);
      return;
    }
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--guide-dock-w'), 10) || getGuideDockDefault();
    applyGuideDockWidth(cur);
  });
  window.addEventListener('message', (e) => {
    if (e.data === 'closeGuide') closeGuide();
  });
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('guideModal');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeGuide();
    }
  });
  document.getElementById('guideModal').addEventListener('click', (e) => {
    if (e.target.id === 'guideModal') closeGuide();
  });

  // ===== Success celebration modal =====
  let successAutoCloseTimer = null;
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function buildParticles() {
    const container = document.getElementById('successParticles');
    container.innerHTML = '';
    const colors = ['var(--accent)', 'var(--purple)', 'var(--success)', '#fbbf24'];
    const shapes = ['sq', 'ci', 'ci', 'sq', 'tr'];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const distance = 90 + Math.random() * 70;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      const shape = shapes[i % shapes.length];
      const color = colors[i % colors.length];
      const delay = 0.75 + Math.random() * 0.15;
      const p = document.createElement('div');
      p.className = 'success-particle ' + shape;
      p.style.setProperty('--x', x + 'px');
      p.style.setProperty('--y', y + 'px');
      p.style.setProperty('--delay', delay + 's');
      if (shape === 'tr') {
        p.style.borderBottomColor = color;
      } else {
        p.style.background = color;
      }
      const size = 6 + Math.random() * 6;
      if (shape !== 'tr') {
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.margin = `-${size/2}px 0 0 -${size/2}px`;
      }
      container.appendChild(p);
    }
  }
  function showSuccess(options) {
    const opts = options || {};
    const modal = document.getElementById('successModal');
    if (!modal) return;

    document.getElementById('successTitle').textContent = opts.title || '完了しました';
    document.getElementById('successSubtitle').textContent = opts.subtitle || '処理が終わりました';

    const statsEl = document.getElementById('successStats');
    if (opts.stats && opts.stats.length) {
      statsEl.style.display = 'grid';
      statsEl.innerHTML = opts.stats.map(s => {
        const hl = s.highlight === 'green' ? ' highlight-green' : (s.highlight ? ' highlight' : '');
        return `<div class="success-stat-row">
          <span class="success-stat-label">${s.label}</span>
          <span class="success-stat-value${hl}">${s.value}</span>
        </div>`;
      }).join('');
    } else {
      statsEl.style.display = 'none';
    }

    modal.classList.add('open');
    buildParticles();

    // Haptic feedback on mobile
    try {
      if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
    } catch (e) {}

    // Auto-close after 6 seconds
    if (successAutoCloseTimer) clearTimeout(successAutoCloseTimer);
    successAutoCloseTimer = setTimeout(closeSuccess, 6000);
  }
  function closeSuccess() {
    const modal = document.getElementById('successModal');
    if (!modal) return;
    modal.classList.remove('open');
    if (successAutoCloseTimer) { clearTimeout(successAutoCloseTimer); successAutoCloseTimer = null; }
  }
  // Dismiss on backdrop click or Esc
  document.getElementById('successModal').addEventListener('click', (e) => {
    if (e.target.id === 'successModal') closeSuccess();
  });
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('successModal');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) {
      closeSuccess();
    }
  });


  const jsPDF = (window.jspdf && window.jspdf.jsPDF) || null;
  if (!jsPDF) console.warn("jsPDF CDN not loaded yet");

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const actionBar = document.getElementById('actionBar');
  const totalStats = document.getElementById('totalStats');
  const compressBtn = document.getElementById('compressBtn');
  const clearBtn = document.getElementById('clearBtn');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const dpiSlider = document.getElementById('dpiSlider');
  const qSlider = document.getElementById('qSlider');
  const dpiVal = document.getElementById('dpiVal');
  const qVal = document.getElementById('qVal');
  const presetsEl = document.getElementById('presets');

  let files = [];
  let currentMode = 'auto';
  let ocrWorker = null; // cached Tesseract worker

  // OCR toggle
  const ocrToggle = document.getElementById('ocrToggle');
  const ocrBody = document.getElementById('ocrBody');
  const ocrLang = document.getElementById('ocrLang');
  ocrToggle.addEventListener('change', () => {
    ocrBody.classList.toggle('active', ocrToggle.checked);
  });

  // Mode button handling
  document.getElementById('modes').querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('modes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
    });
  });

  // Preset handling
  presetsEl.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      presetsEl.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      dpiSlider.value = btn.dataset.dpi;
      qSlider.value = parseFloat(btn.dataset.q) * 100;
      updateSliderLabels();
    });
  });

  function updateSliderLabels() {
    dpiVal.textContent = dpiSlider.value;
    qVal.textContent = qSlider.value + '%';
    // deselect presets if manually changed
    const activeDpi = presetsEl.querySelector('.preset-btn.active');
    if (activeDpi) {
      const matchesDpi = +activeDpi.dataset.dpi === +dpiSlider.value;
      const matchesQ = Math.round(+activeDpi.dataset.q * 100) === +qSlider.value;
      if (!matchesDpi || !matchesQ) {
        presetsEl.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      }
    }
  }
  dpiSlider.addEventListener('input', updateSliderLabels);
  qSlider.addEventListener('input', updateSliderLabels);

  // Drag & drop
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

  function handleFiles(fileListObj) {
    for (const f of fileListObj) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        files.push({
          id: Date.now() + Math.random(),
          file: f,
          origSize: f.size,
          status: 'pending',
          progress: 0,
          result: null,
          newSize: null
        });
      }
    }
    render();
    // ドロップ後、結果が見える位置へ自動スクロール
    requestAnimationFrame(() => {
      if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function render() {
    const fbar = document.getElementById('compressFilenameBar');
    if (files.length === 0) {
      fileList.innerHTML = '';
      actionBar.style.display = 'none';
      if (fbar) fbar.style.display = 'none';
      return;
    }
    actionBar.style.display = 'flex';
    if (fbar) fbar.style.display = 'flex';
    fileList.innerHTML = files.map(f => {
      const status = f.status;
      const rowClass = status === 'done' ? ' done' : status === 'error' ? ' error' : status === 'processing' ? ' processing' : '';
      let metaHtml = `<span class="meta-tag">${formatSize(f.origSize)}</span>`;
      let statusHtml = '';
      let actionsHtml = '';

      if (status === 'pending') {
        statusHtml = `<div class="status">待機中</div>`;
        actionsHtml = `<button class="btn btn-small" onclick="removeFile('${f.id}')">×</button>`;
      } else if (status === 'processing') {
        metaHtml += `<span class="meta-tag">${f.currentStep || ''}</span>`;
        statusHtml = `<div class="status">処理中 ${Math.round(f.progress)}%</div>
          <div class="progress-wrap"><div class="progress-bar" style="width:${f.progress}%"></div></div>`;
      } else if (status === 'done') {
        const reduction = Math.round((1 - f.newSize / f.origSize) * 100);
        const modeLabel = f.mode === 'doc' ? '書類' : f.mode === 'photo' ? '写真' : '';
        const reductionDisplay = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
        const reductionClass = reduction >= 0 ? 'reduction' : 'reduction-neg';
        metaHtml += `<span class="arrow">→</span>
          <span class="meta-tag">${formatSize(f.newSize)}</span>
          <span class="${reductionClass}">${reductionDisplay}</span>`;
        if (modeLabel) {
          metaHtml += `<span class="meta-tag mode-tag">${modeLabel}モード</span>`;
        }
        if (f.ocrApplied) {
          metaHtml += `<span class="meta-tag ocr-tag">🔍 OCR済</span>`;
        }
        const noteStr = f.note ? ` (${f.note})` : '';
        statusHtml = `<div class="status done">✓ 完了${noteStr}</div>`;
        actionsHtml = `<button class="btn btn-primary btn-small" onclick="downloadFile('${f.id}')">DL</button>`;
      } else if (status === 'error') {
        statusHtml = `<div class="status error">エラー: ${f.error || '処理失敗'}</div>`;
        actionsHtml = `<button class="btn btn-small" onclick="removeFile('${f.id}')">×</button>`;
      }

      return `<div class="file-row${rowClass}">
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.file.name)}</div>
          <div class="file-meta">${metaHtml}</div>
          ${statusHtml}
        </div>
        <div class="file-actions">${actionsHtml}</div>
      </div>`;
    }).join('');

    // totals
    const done = files.filter(f => f.status === 'done');
    if (done.length > 0) {
      const totalOrig = done.reduce((s, f) => s + f.origSize, 0);
      const totalNew = done.reduce((s, f) => s + f.newSize, 0);
      const totalRed = Math.round((1 - totalNew / totalOrig) * 100);
      totalStats.innerHTML = `${files.length} ファイル ・ 完了 ${done.length} / 合計 <strong>${formatSize(totalOrig)} → ${formatSize(totalNew)}</strong> (-${totalRed}%)`;
      downloadAllBtn.style.display = done.length > 1 ? '' : 'none';
    } else {
      totalStats.textContent = `${files.length} ファイル`;
      downloadAllBtn.style.display = 'none';
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  window.removeFile = (id) => {
    files = files.filter(f => f.id != id);
    render();
  };

  window.downloadFile = async (id) => {
    const f = files.find(x => x.id == id);
    if (!f || !f.result) return;
    let blob = f.result;
    // v3.6.0: 出力前メタデータ除去 (compress出力は常にPDFだが型ガード)
    if (blob.type === 'application/pdf' && window.PdfSanitize) {
      blob = await window.PdfSanitize.process(blob);
    }
    triggerDownload(blob, makeOutputName(f.file.name));
  };

  // Filename input wiring (compress mode — custom prefix)
  (function() {
    const fin = document.getElementById('compressFilenameInput');
    const fcl = document.getElementById('compressFilenameClear');
    if (!fin) return;
    fin.addEventListener('input', () => {
      const v = fin.value;
      const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
      if (v !== cleaned) fin.value = cleaned;
      fcl.classList.toggle('visible', !!fin.value);
    });
    fcl.addEventListener('click', () => {
      fin.value = '';
      fcl.classList.remove('visible');
      fin.focus();
    });
  })();

  function makeOutputName(origName) {
    const userPrefixEl = document.getElementById('compressFilenameInput');
    const userPrefix = (userPrefixEl && userPrefixEl.value || '').trim();
    const base = origName.replace(/\.pdf$/i, '');
    let core;
    if (userPrefix) {
      if (files.length === 1) {
        core = userPrefix;
      } else {
        core = `${userPrefix}_${base}`;
      }
    } else {
      core = `${base}_軽量化`;
    }
    return `${appendTimestamp(core, 'compressFilenameTs')}.pdf`;
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  clearBtn.addEventListener('click', () => {
    files = [];
    render();
  });

  downloadAllBtn.addEventListener('click', () => {
    const doneFiles = files.filter(f => f.status === 'done');
    doneFiles.forEach((f, i) => {
      setTimeout(async () => {
        let blob = f.result;
        // v3.6.0: 出力前メタデータ除去 (型ガード付き)
        if (blob.type === 'application/pdf' && window.PdfSanitize) {
          blob = await window.PdfSanitize.process(blob);
        }
        triggerDownload(blob, makeOutputName(f.file.name));
      }, i * 300);
    });
    // 全DL終了後に保持ファイルをクリア (連続作業しやすく)
    if (doneFiles.length > 0) {
      const totalDelay = doneFiles.length * 300 + 500;
      setTimeout(() => {
        files = [];
        render();
      }, totalDelay);
    }
  });

  compressBtn.addEventListener('click', async () => {
    const dpi = +dpiSlider.value;
    const quality = +qSlider.value / 100;
    const ocrEnabled = ocrToggle.checked;
    const ocrLangValue = ocrLang.value;

    // 全件処理済みでの再クリック = 設定変更後の再圧縮とみなし、全件を未処理に戻す
    // (未処理・エラーが1件でも残っていれば従来どおりその分だけ処理)
    if (files.length > 0 && files.every(f => f.status === 'done')) {
      for (const f of files) {
        f.status = 'pending';
        f.progress = 0;
        f.result = null;
        f.newSize = null;
        f.currentStep = '';
        f.mode = null;
        f.note = null;
        f.ocrApplied = false;
        f.error = null;
      }
      render();
    }

    compressBtn.disabled = true;
    clearBtn.disabled = true;

    for (const f of files) {
      if (f.status === 'done') continue;
      try {
        f.status = 'processing';
        f.progress = 0;
        render();

        // Mode routing
        let mode = currentMode;
        if (mode === 'auto') {
          f.currentStep = '判定中...';
          render();
          mode = await detectBestMode(f.file);
        }
        f.mode = mode;

        let result;
        if (mode === 'doc') {
          result = await compressPdfDocMode(f, dpi, quality);
          if (ocrEnabled) f.note = 'OCR不要(元々テキスト検索可)';
        } else if (ocrEnabled) {
          result = await compressPdfPhotoModeOCR(f, dpi, quality, ocrLangValue);
          f.ocrApplied = true;
        } else {
          result = await compressPdfPhotoMode(f, dpi, quality);
        }

        // If output ended up larger than original, keep original (rare but possible)
        if (result.blob.size >= f.origSize && !f.ocrApplied) {
          f.status = 'done';
          f.result = new Blob([await f.file.arrayBuffer()], { type: 'application/pdf' });
          f.newSize = f.origSize;
          f.note = '元のまま(圧縮効果なし)';
        } else {
          f.result = result.blob;
          f.newSize = result.blob.size;
          f.status = 'done';
        }
        render();
      } catch (err) {
        console.error(err);
        f.status = 'error';
        let errMsg = err.message || '不明';
        // 保護付き(編集制限)PDFは書類モードの load (ignoreEncryption:false) で
        // 英語の生エラーになるため、日本語の説明と回避策に差し替える
        if (/encrypt/i.test(errMsg)) {
          errMsg = '保護付き(編集制限)のPDFのため書類モードで処理できません。圧縮モードを「写真」にすると処理できます';
        }
        f.error = errMsg;
        render();
      }
    }

    // Cleanup OCR worker after batch
    if (ocrWorker) {
      try { await ocrWorker.terminate(); } catch (e) {}
      ocrWorker = null;
    }

    compressBtn.disabled = false;
    clearBtn.disabled = false;

    // Celebrate!
    const doneFiles = files.filter(f => f.status === 'done');
    const errFiles = files.filter(f => f.status === 'error');
    if (doneFiles.length > 0) {
      const totalOrig = doneFiles.reduce((s, f) => s + f.origSize, 0);
      const totalNew = doneFiles.reduce((s, f) => s + f.newSize, 0);
      const reduction = totalOrig > 0 ? Math.round((1 - totalNew / totalOrig) * 100) : 0;
      const stats = [
        { label: '処理ファイル', value: `${doneFiles.length} 件` },
        { label: '元のサイズ', value: formatBytes(totalOrig) },
        { label: '新サイズ', value: formatBytes(totalNew) },
      ];
      if (reduction > 0) {
        stats.push({ label: '削減率', value: `-${reduction}%`, highlight: 'green' });
      } else if (reduction < 0) {
        stats.push({ label: '変化', value: `+${Math.abs(reduction)}%`, highlight: true });
      }
      let sub = '軽量化が完了しました';
      if (errFiles.length > 0) sub += ` (${errFiles.length}件エラー)`;
      showSuccess({
        title: '軽量化完了',
        subtitle: sub,
        stats: stats
      });
    } else if (errFiles.length > 0) {
      // 全ファイルがエラー → 何が起きたか明示 (success-modal 経路に乗らないので独自に)
      setStatus(`✕ ${errFiles.length}件すべて圧縮失敗。ファイル形式・破損・ロックを確認してください`, 'error');
    }
  });

  // Auto-detect: if PDF has significant text content, use doc mode
  async function detectBestMode(file) {
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pagesToCheck = Math.min(pdf.numPages, 3);
      let totalTextLen = 0;
      for (let i = 1; i <= pagesToCheck; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        totalTextLen += tc.items.reduce((s, it) => s + (it.str || '').length, 0);
      }
      // Average > 200 chars per page suggests real text content
      return (totalTextLen / pagesToCheck) > 200 ? 'doc' : 'photo';
    } catch (e) {
      return 'photo';
    }
  }

  // DOC MODE: preserve text/vectors, only recompress embedded JPEG images
  async function compressPdfDocMode(fileObj, targetDpi, jpegQuality) {
    const { PDFDocument, PDFName, PDFRawStream, PDFNumber } = PDFLib;
    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuf, { ignoreEncryption: false });

    // Collect image XObjects
    const imageEntries = [];
    const indirectObjects = pdfDoc.context.enumerateIndirectObjects();
    for (const [ref, obj] of indirectObjects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;
      imageEntries.push([ref, obj]);
    }

    fileObj.currentStep = `画像 0/${imageEntries.length}`;
    render();

    let processed = 0;
    let replaced = 0;

    // Target max image dimension: assume an image shown at most at full letter-size width
    // at target DPI: ~8.5 inches * DPI
    const maxDim = Math.round(targetDpi * 10);

    for (const [ref, obj] of imageEntries) {
      const dict = obj.dict;
      const filter = dict.get(PDFName.of('Filter'));
      const filterStr = filter ? filter.toString() : '';

      // Skip if has soft mask (transparency) - JPEG can't handle it
      const hasSMask = !!dict.get(PDFName.of('SMask'));

      // Only process pure JPEG (DCTDecode) images without SMask
      const isJpeg = filterStr === '/DCTDecode'
        || (filterStr.includes('DCTDecode') && !filterStr.includes('JBIG2'));

      if (!isJpeg || hasSMask) {
        processed++;
        continue;
      }

      try {
        const jpegBytes = obj.contents;
        // Skip tiny images (icons, bullets)
        if (jpegBytes.length < 5000) {
          processed++;
          continue;
        }

        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        const img = await createImageBitmap(blob);

        const maxCurrentDim = Math.max(img.width, img.height);
        const scale = maxCurrentDim > maxDim ? maxDim / maxCurrentDim : 1.0;

        const newW = Math.max(1, Math.round(img.width * scale));
        const newH = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = newW;
        canvas.height = newH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, newW, newH);
        ctx.drawImage(img, 0, 0, newW, newH);

        const newBlob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', jpegQuality)
        );
        const newBytes = new Uint8Array(await newBlob.arrayBuffer());

        // Only replace if actually smaller
        if (newBytes.length < jpegBytes.length * 0.95) {
          // Build a new dict preserving entries but updating dimensions & length
          const newDict = pdfDoc.context.obj({});
          for (const [key, val] of dict.entries()) {
            const keyStr = key.toString();
            // Skip entries that become invalid after re-encoding
            if (keyStr === '/DecodeParms' || keyStr === '/Decode') continue;
            newDict.set(key, val);
          }
          newDict.set(PDFName.of('Width'), PDFNumber.of(newW));
          newDict.set(PDFName.of('Height'), PDFNumber.of(newH));
          newDict.set(PDFName.of('Length'), PDFNumber.of(newBytes.length));
          newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          // canvas再エンコードJPEGは常にRGB(3成分)。元のColorSpace
          // (DeviceGray/DeviceCMYK等)をコピーすると色化けするため常にDeviceRGB
          newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          newDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));

          const newStream = PDFRawStream.of(newDict, newBytes);
          pdfDoc.context.assign(ref, newStream);
          replaced++;
        }

        // Cleanup
        canvas.width = 0;
        canvas.height = 0;
        img.close && img.close();
      } catch (e) {
        console.warn('image skipped:', e.message);
      }

      processed++;
      fileObj.progress = (processed / imageEntries.length) * 100;
      fileObj.currentStep = `書類モード: 画像 ${processed}/${imageEntries.length} (${replaced}枚再圧縮)`;
      render();
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false
    });
    return { blob: new Blob([outBytes], { type: 'application/pdf' }) };
  }

  // PHOTO MODE: rasterize everything (old behavior, good for photo-heavy PDFs)
  async function compressPdfPhotoMode(fileObj, targetDpi, jpegQuality) {
    return compressPdf(fileObj, targetDpi, jpegQuality);
  }

  // Standalone blob compressor for reuse from other modules (e.g., PDF edit split)
  // Rasterizes each page → JPEG → embeds into new PDF (photo mode pipeline)
  async function compressPdfBlobPhotoMode(blob, targetDpi, jpegQuality, onProgress) {
    const { PDFDocument } = PDFLib;
    const arrayBuf = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf.slice(0) }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;
    const outDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      if (onProgress) onProgress(pageNum, numPages);
      const page = await pdf.getPage(pageNum);
      const renderViewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
      const base64 = dataUrl.split(',')[1];
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const jpgImage = await outDoc.embedJpg(bytes);

      // Page dimension in PDF points (72dpi basis), matching original page
      const baseVp = page.getViewport({ scale: 1 });
      const pdfPage = outDoc.addPage([baseVp.width, baseVp.height]);
      pdfPage.drawImage(jpgImage, { x: 0, y: 0, width: baseVp.width, height: baseVp.height });

      canvas.width = 0; canvas.height = 0;
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await outDoc.save({ useObjectStreams: true });
    return new Blob([outBytes], { type: 'application/pdf' });
  }

  // PHOTO MODE + OCR: rasterize + add invisible searchable text layer via Tesseract
  async function compressPdfPhotoModeOCR(fileObj, targetDpi, jpegQuality, lang) {
    const { PDFDocument } = PDFLib;

    // Initialize worker (cached across files in same batch)
    if (!ocrWorker || ocrWorker._lang !== lang) {
      if (ocrWorker) {
        try { await ocrWorker.terminate(); } catch (e) {}
      }
      fileObj.currentStep = 'OCR辞書をダウンロード中...';
      render();
      const langList = lang.split('+');
      ocrWorker = await Tesseract.createWorker(langList, 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            fileObj.currentStep = `OCR認識中 ${Math.round(m.progress * 100)}%`;
            render();
          } else if (m.status && m.status.includes('loading')) {
            fileObj.currentStep = `辞書ロード中 ${Math.round(m.progress * 100)}%`;
            render();
          }
        }
      });
      ocrWorker._lang = lang;
    }

    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;

    const outDoc = await PDFDocument.create();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      fileObj.currentStep = `ページ ${pageNum}/${numPages} - 描画`;
      render();

      const page = await pdf.getPage(pageNum);
      const renderViewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      // Compress canvas to JPEG first (for smaller input to Tesseract's PDF embedder)
      const jpegBlob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', jpegQuality)
      );

      fileObj.currentStep = `ページ ${pageNum}/${numPages} - OCR`;
      render();

      // Run OCR with PDF output
      const ocrResult = await ocrWorker.recognize(
        jpegBlob,
        {},
        { pdf: true }
      );

      const ocrPdfBytes = new Uint8Array(ocrResult.data.pdf);
      const ocrPdf = await PDFDocument.load(ocrPdfBytes);
      const [copiedPage] = await outDoc.copyPages(ocrPdf, [0]);
      // Tesseract はDPI不明のJPEGを70dpi扱いするため、OCR結果PDFのページ寸法が
      // 元より膨張する (px × 72/70)。元ページのpt寸法 (72dpi基準) に戻す。
      // scale() はコンテンツ・MediaBox・注釈を一括スケールするので透明テキスト層の位置関係も保たれる
      const baseVp = page.getViewport({ scale: 1 });
      const sx = baseVp.width / copiedPage.getWidth();
      const sy = baseVp.height / copiedPage.getHeight();
      if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
        copiedPage.scale(sx, sy);
      }
      outDoc.addPage(copiedPage);

      // cleanup
      canvas.width = 0;
      canvas.height = 0;

      fileObj.progress = (pageNum / numPages) * 100;
      render();
      await new Promise(r => setTimeout(r, 0));
    }

    const outBytes = await outDoc.save({ useObjectStreams: true });
    return { blob: new Blob([outBytes], { type: 'application/pdf' }) };
  }

  async function compressPdf(fileObj, targetDpi, jpegQuality) {
    const arrayBuf = await fileObj.file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    const numPages = pdf.numPages;
    const renderScale = targetDpi / 72;

    let outPdf = null;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      const ctx = canvas.getContext('2d');
      // White background to avoid transparent → black on JPEG
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      const jpegDataUrl = canvas.toDataURL('image/jpeg', jpegQuality);

      // Use original page size in points for the output PDF
      const pw = baseViewport.width;
      const ph = baseViewport.height;
      const orientation = pw > ph ? 'landscape' : 'portrait';

      if (pageNum === 1) {
        outPdf = new jsPDF({
          orientation: orientation,
          unit: 'pt',
          format: [pw, ph],
          compress: true
        });
      } else {
        outPdf.addPage([pw, ph], orientation);
      }
      outPdf.addImage(jpegDataUrl, 'JPEG', 0, 0, pw, ph, undefined, 'FAST');

      // cleanup
      canvas.width = 0;
      canvas.height = 0;

      fileObj.progress = (pageNum / numPages) * 100;
      fileObj.currentStep = `${pageNum}/${numPages}ページ`;
      render();
      // Yield to UI
      await new Promise(r => setTimeout(r, 0));
    }

    const blob = outPdf.output('blob');
    return { blob };
  }


  // =========================================================
  // FILENAME TIMESTAMP TOGGLE — shared helpers
  // =========================================================
  // state lives on the button element as data-ts-enabled
  function makeTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  }
  function isTimestampEnabled(toggleId) {
    const el = document.getElementById(toggleId);
    return !!(el && el.classList.contains('active'));
  }
  function appendTimestamp(baseName, toggleId) {
    if (!isTimestampEnabled(toggleId)) return baseName;
    return `${baseName}_${makeTimestamp()}`;
  }
  function setupTimestampToggle(toggleId, previewId) {
    const btn = document.getElementById(toggleId);
    const preview = document.getElementById(previewId);
    if (!btn) return;
    function updatePreview() {
      if (!preview) return;
      preview.textContent = btn.classList.contains('active') ? `_${makeTimestamp()}` : '';
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      btn.classList.toggle('active');
      updatePreview();
    });
    // Refresh preview every minute while visible so it stays accurate
    setInterval(() => { if (btn.offsetParent !== null) updatePreview(); }, 30000);
    updatePreview();
  }
  // Set up all 4 timestamp toggles once DOM is ready
  setupTimestampToggle('compressFilenameTs', 'compressFilenameTsPreview');
  setupTimestampToggle('imgFilenameTs', 'imgFilenameTsPreview');
  setupTimestampToggle('convFilenameTs', 'convFilenameTsPreview');
  setupTimestampToggle('editFilenameTs', 'editFilenameTsPreview');

  // =========================================================
  // MODE TAB SWITCHING
  // =========================================================
  function restartWarpAnimations(panel) {
    if (!panel) return;
    // Find every brand-mark / dropzone-icon inside the panel and force animation restart
    const iconEls = panel.querySelectorAll('.brand-mark, .dropzone-icon');
    iconEls.forEach(el => {
      // Disable animation temporarily
      el.style.animation = 'none';
      // Reset SVG line-draw animations too
      el.querySelectorAll('svg > *').forEach(child => {
        child.style.animation = 'none';
      });
      // Force browser to flush styles (reflow)
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight;
      // Re-enable — CSS animation rule kicks back in from scratch
      requestAnimationFrame(() => {
        el.style.animation = '';
        el.querySelectorAll('svg > *').forEach(child => {
          child.style.animation = '';
        });
      });
    });
  }

  // モード(data-mode) → ガイド側セクション ID マッピング
  const GUIDE_SECTION_MAP = {
    compress: 'part-compress',
    imgtopdf: 'part-imgtopdf',
    convert: 'part-convert',
    pdfedit: 'part-edit',
    imgplace: 'part-imgplace'
  };
  // 取説 iframe を該当セクションまでスクロール (ドック表示中の時のみ意味あり)
  // behavior: 'smooth' (タブ切替時のアニメ) or 'auto' (再表示時の瞬間移動)
  function scrollGuideToSection(mode, behavior) {
    const sectionId = GUIDE_SECTION_MAP[mode];
    if (!sectionId) return;
    // ガイドが開いてない時は早期 return (毎タブ切替で iframe 触らない)
    const modal = document.getElementById('guideModal');
    if (!modal || !modal.classList.contains('open')) return;
    const iframe = document.getElementById('guideFrame');
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (!doc) return;
      const target = doc.getElementById(sectionId);
      if (target) target.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
    } catch (e) { /* CORS 等で読めない場合は黙殺 */ }
  }

  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.mode;
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.mode-panel').forEach(p => p.classList.remove('active'));
      const panelIdMap = {
        compress: 'modeCompress',
        imgtopdf: 'modeImgToPdf',
        convert: 'modeConvert',
        pdfedit: 'modePdfEdit',
        imgplace: 'modeImgPlace',
        redact: 'modeRedact'
      };
      const targetId = panelIdMap[target] || 'modeCompress';
      const targetPanel = document.getElementById(targetId);
      targetPanel.classList.add('active');
      // Retrigger the warp-in animation on newly-active panel's icons
      restartWarpAnimations(targetPanel);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // 取説ドックが開いてたら該当セクションへスクロール
      scrollGuideToSection(target);
    });
  });

  // =========================================================
  // IMAGE → PDF TOOL (isolated scope)
  // =========================================================
  (function imgToPdfModule() {
    'use strict';
    const { jsPDF } = window.jspdf;

    let files = [];
    let fitMode = 'contain';
    let pageSizeKey = 'a4';
    let qualityKey = 'standard';
    let dragIdx = null;

    const $ = (id) => document.getElementById(id);
    const dropzone = $('imgDropzone');
    const fileInput = $('imgFileInput');
    const fileGrid = $('imgFileGrid');
    const listPanel = $('imgListPanel');
    const actionBar = $('imgActionBar');
    const totalStats = $('imgTotalStats');
    const generateBtn = $('imgGenerateBtn');
    const clearBtn = $('imgClearBtn');
    const statusMsg = $('imgStatusMsg');
    const progressWrap = $('imgProgressWrap');
    const progressBar = $('imgProgressBar');
    const filenameInput = $('imgFilenameInput');
    const filenameClear = $('imgFilenameClear');
    if (filenameInput) {
      filenameInput.addEventListener('input', () => {
        const v = filenameInput.value;
        const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
        if (v !== cleaned) filenameInput.value = cleaned;
        filenameClear.classList.toggle('visible', !!filenameInput.value);
      });
      filenameClear.addEventListener('click', () => {
        filenameInput.value = '';
        filenameClear.classList.remove('visible');
        filenameInput.focus();
      });
    }

    // Preset selection
    $('imgPageSizePresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgPageSizePresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pageSizeKey = btn.dataset.size;
      });
    });
    $('imgFitModes').querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgFitModes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fitMode = btn.dataset.fit;
      });
    });
    $('imgQualityPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('imgQualityPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        qualityKey = btn.dataset.q;
      });
    });

    // Dropzone
    ['dragenter', 'dragover'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', ev => {
      if (ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', ev => {
      if (ev.target.files) addFiles(ev.target.files);
      ev.target.value = '';
    });

    clearBtn.addEventListener('click', () => {
      files.forEach(it => {
        if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
      });
      files = [];
      setStatus('');
      render();
    });
    generateBtn.addEventListener('click', generatePdf);

    function isHeic(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'heic' || ext === 'heif' || file.type === 'image/heic' || file.type === 'image/heif';
    }
    function isTiff(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'tif' || ext === 'tiff' || file.type === 'image/tiff' || file.type === 'image/tif';
    }
    function isBmp(file) {
      const ext = file.name.toLowerCase().split('.').pop();
      return ext === 'bmp' || file.type === 'image/bmp' || file.type === 'image/x-ms-bmp';
    }
    function isPdf(file) {
      return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    }
    function isValidImage(file) {
      const ok = ['image/png', 'image/jpeg', 'image/jpg', 'image/avif'];
      if (ok.includes(file.type)) return true;
      if (isHeic(file) || isTiff(file) || isBmp(file)) return true;
      const ext = file.name.toLowerCase().split('.').pop();
      return ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif'].includes(ext);
    }
    function isValidInput(file) {
      return isValidImage(file) || isPdf(file);
    }
    async function convertHeicToJpeg(file) {
      const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      const result = Array.isArray(blob) ? blob[0] : blob;
      return new File([result], file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg'), { type: 'image/jpeg' });
    }
    // TIFF → PNG (UTIF.js). Handles multi-page TIFFs by returning array of File objects.
    async function convertTiffToPng(file) {
      const buf = await file.arrayBuffer();
      const ifds = UTIF.decode(buf);
      if (!ifds || ifds.length === 0) throw new Error('TIFF decode failed');
      const results = [];
      for (let i = 0; i < ifds.length; i++) {
        const ifd = ifds[i];
        UTIF.decodeImage(buf, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        const canvas = document.createElement('canvas');
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(ifd.width, ifd.height);
        imgData.data.set(rgba);
        ctx.putImageData(imgData, 0, 0);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const suffix = ifds.length > 1 ? `_page${i + 1}` : '';
        const baseName = file.name.replace(/\.(tiff?|TIFF?)$/i, '');
        results.push(new File([blob], `${baseName}${suffix}.png`, { type: 'image/png' }));
        canvas.width = 0; canvas.height = 0;
      }
      return results;
    }

    function setStatus(text, type) {
      if (statusMsg) {
        statusMsg.textContent = text;
        statusMsg.className = 'img-status-msg' + (type ? ' ' + type : '');
      }
      // ミラー: アクションバー中央 (常時見える位置)
      const abs = document.getElementById('imgActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
    }

    async function addPdfFile(file) {
      const buf = await file.arrayBuffer();
      // pdf.js consumes the buffer, so clone for later re-rendering
      const loadBuf = buf.slice(0);
      const pdfDoc = await pdfjsLib.getDocument({ data: loadBuf }).promise;
      const numPages = pdfDoc.numPages;

      // Render first page as thumbnail
      const firstPage = await pdfDoc.getPage(1);
      const native = firstPage.getViewport({ scale: 1 });
      const thumbMaxDim = 300;
      const thumbScale = Math.min(thumbMaxDim / native.width, thumbMaxDim / native.height, 1.5);
      const thumbView = firstPage.getViewport({ scale: thumbScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(thumbView.width);
      canvas.height = Math.ceil(thumbView.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await firstPage.render({ canvasContext: ctx, viewport: thumbView }).promise;
      const thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
      canvas.width = 0; canvas.height = 0;

      files.push({
        type: 'pdf',
        file: file,
        url: thumbUrl,
        name: file.name,
        numPages: numPages,
        pdfBuffer: buf,           // original buffer kept for full rendering at generate time
        width: native.width,
        height: native.height
      });
    }

    async function addFiles(fileList) {
      const arr = [...fileList].filter(isValidInput);
      if (arr.length === 0) {
        setStatus('⚠ PNG / JPG / HEIC / BMP / TIFF / AVIF / PDF のみ対応しています', 'error');
        return;
      }
      setStatus('');

      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)

      for (const origFile of arr) {
        try {
          if (isPdf(origFile)) {
            setStatus(`PDF読込中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
            await addPdfFile(origFile);
          } else if (isTiff(origFile)) {
            setStatus(`TIFF変換中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
            const pngFiles = await convertTiffToPng(origFile);
            for (const pf of pngFiles) {
              const url = URL.createObjectURL(pf);
              await new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                  files.push({
                    type: 'image', file: pf, url,
                    name: pf.name,
                    width: img.naturalWidth,
                    height: img.naturalHeight
                  });
                  resolve();
                };
                img.onerror = () => {
                  failedNames.push(`${pf.name} (TIFF変換結果の表示に失敗)`);
                  try { URL.revokeObjectURL(url); } catch(_) {}
                  resolve();
                };
                img.src = url;
              });
            }
          } else {
            let file = origFile;
            if (isHeic(origFile)) {
              setStatus(`HEIC変換中... (${loaded + 1}/${total})`, 'info');
              file = await convertHeicToJpeg(origFile);
            } else if (isBmp(origFile)) {
              setStatus(`BMP読込中... (${loaded + 1}/${total})`, 'info');
              // BMP is natively supported by browsers, just load it
            }
            const url = URL.createObjectURL(file);
            await new Promise(resolve => {
              const img = new Image();
              img.onload = () => {
                files.push({
                  type: 'image',
                  file, url,
                  name: origFile.name,
                  width: img.naturalWidth,
                  height: img.naturalHeight
                });
                resolve();
              };
              img.onerror = () => {
                // ブラウザ未対応形式 (古い Firefox の AVIF 等) or 破損ファイル
                const ext = (origFile.name.split('.').pop() || '').toUpperCase();
                failedNames.push(`${origFile.name} (${ext} がブラウザ未対応 or 破損)`);
                try { URL.revokeObjectURL(url); } catch(_) {}
                resolve();
              };
              img.src = url;
            });
          }
        } catch (err) {
          console.error('Load error:', origFile.name, err);
          failedNames.push(origFile.name);
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示(従来は直後の setStatus('') で一瞬で消えて無言スキップになっていた)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした: ${failedNames.join(' / ')}` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function render() {
      const imageCount = files.filter(f => f.type === 'image').length;
      const pdfCount = files.filter(f => f.type === 'pdf').length;
      const totalOutputPages = files.reduce((sum, f) => sum + (f.type === 'pdf' ? f.numPages : 1), 0);

      if (files.length === 0) {
        totalStats.textContent = '0 ファイル';
        actionBar.style.display = 'none';
        const fbar = document.getElementById('imgFilenameBar');
        if (fbar) fbar.style.display = 'none';
        if (listPanel) listPanel.style.display = 'none';
        fileGrid.innerHTML = '';
        return;
      }

      const parts = [];
      if (imageCount > 0) parts.push(`${imageCount}枚の画像`);
      if (pdfCount > 0) parts.push(`${pdfCount}個のPDF`);
      totalStats.innerHTML = `<strong style="color:white;">${parts.join(' + ')}</strong> · 出力 ${totalOutputPages}ページ`;
      actionBar.style.display = 'flex';
      const fbar = document.getElementById('imgFilenameBar');
      if (fbar) fbar.style.display = 'flex';
      if (listPanel) listPanel.style.display = 'block';

      fileGrid.innerHTML = files.map((it, i) => {
        const isPdfItem = it.type === 'pdf';
        const cardCls = 'img-file-card' + (isPdfItem ? ' is-pdf' : '');
        const pdfBadge = isPdfItem ? `<div class="pdf-type-badge">PDF</div>` : '';
        const pagesBadge = isPdfItem ? `<div class="pdf-pages-badge">${it.numPages}ページ</div>` : '';
        return `
          <div class="${cardCls}" draggable="true" data-idx="${i}">
            ${pdfBadge}
            <img class="img-file-thumb" src="${it.url}" alt="${escapeHtml(it.name)}">
            ${pagesBadge}
            <button class="img-file-remove" data-remove="${i}" title="削除" aria-label="削除">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <div class="img-file-meta">
              <span class="img-file-num">${i + 1}</span>
              <span class="img-file-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            </div>
          </div>
        `;
      }).join('');

      fileGrid.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.remove;
          const it = files[idx];
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
          files.splice(idx, 1);
          render();
        });
      });

      fileGrid.querySelectorAll('.img-file-card').forEach(card => {
        card.addEventListener('dragstart', ev => {
          dragIdx = +card.dataset.idx;
          card.classList.add('dragging');
          ev.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          dragIdx = null;
          fileGrid.querySelectorAll('.img-file-card').forEach(c => c.classList.remove('dragover-card'));
        });
        card.addEventListener('dragover', ev => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          card.classList.add('dragover-card');
        });
        card.addEventListener('dragleave', () => card.classList.remove('dragover-card'));
        card.addEventListener('drop', ev => {
          ev.preventDefault();
          card.classList.remove('dragover-card');
          const toIdx = +card.dataset.idx;
          if (dragIdx !== null && dragIdx !== toIdx) {
            const item = files.splice(dragIdx, 1)[0];
            files.splice(toIdx, 0, item);
            render();
          }
        });
      });
    }

    const QUALITY_PRESETS = {
      light:    { maxPx: 1200, jpegQuality: 0.55 },
      standard: { maxPx: 2000, jpegQuality: 0.75 },
      high:     { maxPx: 3200, jpegQuality: 0.90 },
      original: { maxPx: Infinity, jpegQuality: 1.0 },
    };
    function getPageDims(size) {
      switch(size) {
        case 'a3': return [297, 420];
        case 'a4': return [210, 297];
        case 'b4': return [257, 364];
        case 'b5': return [182, 257];
        default: return null;
      }
    }
    function compressImage(file, maxPx, jpegQuality) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
          const img = new Image();
          img.onerror = reject;
          img.onload = () => {
            let w = img.naturalWidth, h = img.naturalHeight;
            if (maxPx < Infinity && (w > maxPx || h > maxPx)) {
              if (w > h) { h = Math.round(h * (maxPx / w)); w = maxPx; }
              else { w = Math.round(w * (maxPx / h)); h = maxPx; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', jpegQuality));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }
    function loadImageData(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // v3.7.6 (H4): JPEG の EXIF Orientation タグ (1-8) を読む軽量パーサ。
    // SOI → セグメント走査 → APP1 "Exif" → TIFF ヘッダ → IFD0 の 0x0112 を探す。
    // JPEG以外・タグ無し・解析失敗時は 1 (補正不要) を返す = 従来どおり生パススルーに倒す。
    async function readJpegOrientation(file) {
      try {
        const buf = await file.slice(0, 256 * 1024).arrayBuffer();
        const view = new DataView(buf);
        if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return 1; // SOI が無い = JPEGでない
        let offset = 2;
        while (offset + 4 <= view.byteLength) {
          const marker = view.getUint16(offset);
          if ((marker & 0xFF00) !== 0xFF00) return 1;  // マーカー列が壊れている
          if (marker === 0xFFDA) return 1;             // SOS (画像データ) 以降に EXIF は無い
          const size = view.getUint16(offset + 2);
          if (size < 2) return 1;                      // 不正サイズ (無限ループ防止)
          if (marker === 0xFFE1 && offset + 18 <= view.byteLength &&
              view.getUint32(offset + 4) === 0x45786966) { // "Exif"
            const tiff = offset + 10;                  // TIFF ヘッダ先頭
            const endianMark = view.getUint16(tiff);
            if (endianMark !== 0x4949 && endianMark !== 0x4D4D) return 1;
            const little = endianMark === 0x4949;      // "II" = リトルエンディアン
            const ifd = tiff + view.getUint32(tiff + 4, little);
            if (ifd + 2 > view.byteLength) return 1;
            const count = view.getUint16(ifd, little);
            for (let i = 0; i < count; i++) {
              const entry = ifd + 2 + i * 12;
              if (entry + 12 > view.byteLength) return 1;
              if (view.getUint16(entry, little) === 0x0112) { // 0x0112 = Orientation
                const val = view.getUint16(entry + 8, little);
                return (val >= 1 && val <= 8) ? val : 1;
              }
            }
            return 1;                                  // Orientation タグ無し
          }
          offset += 2 + size;
        }
      } catch (e) {
        // 解析失敗は「補正不要」扱い (従来どおり生パススルー)
      }
      return 1;
    }

    // Rasterize one PDF page at a target quality; returns {dataUrl, nativeW, nativeH}
    async function renderPdfPageToJpeg(page, preset, qKey) {
      const native = page.getViewport({ scale: 1 });
      const nativeW = native.width;   // points
      const nativeH = native.height;
      const maxDim = Math.max(nativeW, nativeH);

      let renderScale;
      if (qKey === 'original') {
        renderScale = 2.5;  // ~180 DPI
      } else {
        // target maxPx in pixels, relative to native (at 72dpi/point)
        renderScale = Math.min(5, Math.max(0.5, preset.maxPx / maxDim));
      }
      const rv = page.getViewport({ scale: renderScale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(rv.width);
      canvas.height = Math.ceil(rv.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: rv }).promise;
      const q = qKey === 'original' ? 0.95 : preset.jpegQuality;
      const dataUrl = canvas.toDataURL('image/jpeg', q);
      canvas.width = 0; canvas.height = 0;
      return { dataUrl, nativeW, nativeH };
    }

    // Add a rasterized page to the output PDF document. Returns the doc.
    function addPageToDoc(doc, imgData, nativeW, nativeH, isFirst) {
      const isLandscape = nativeW > nativeH;

      if (pageSizeKey === 'fit') {
        // Use native dimensions (image at 96dpi, PDF points at 72dpi → convert to mm)
        // For images: px at 96dpi → mm: x * 25.4 / 96
        // For PDF pages: points (72dpi) → mm: x * 25.4 / 72
        // We tag images differently by assuming they come in as px (for img path we used /96);
        // For PDFs we pass points (width in pts). We'll use /72 for PDF path explicitly.
        // NOTE: this function is called with px-at-96 for images, points for PDFs.
        // To unify, caller should convert beforehand. See callers below.
        const pw = nativeW;
        const ph = nativeH;
        // v3.7.6 (H3): jsPDF 2.5.1 は format:[w,h] で w>h だと既定 orientation 'p' が勝って
        // 縦横を強制スワップする → 横長が縦ページに化けるため orientation を明示する
        const fitOrient = pw > ph ? 'l' : 'p';
        if (isFirst) {
          doc = new jsPDF({ orientation: fitOrient, unit: 'mm', format: [pw, ph] });
        } else {
          doc.addPage([pw, ph], fitOrient);
        }
        doc.addImage(imgData, 'JPEG', 0, 0, pw, ph);
        return doc;
      } else {
        const baseDims = getPageDims(pageSizeKey);
        const short = Math.min(baseDims[0], baseDims[1]);
        const long = Math.max(baseDims[0], baseDims[1]);
        const pw = isLandscape ? long : short;
        const ph = isLandscape ? short : long;
        const orient = isLandscape ? 'landscape' : 'portrait';

        if (isFirst) {
          doc = new jsPDF({ orientation: orient, unit: 'mm', format: [pw, ph] });
        } else {
          doc.addPage([pw, ph], orient);
        }
        const imgRatio = nativeW / nativeH;
        const pageRatio = pw / ph;
        let drawW, drawH;
        if (fitMode === 'contain') {
          if (imgRatio > pageRatio) { drawW = pw; drawH = pw / imgRatio; }
          else { drawH = ph; drawW = ph * imgRatio; }
        } else {
          if (imgRatio > pageRatio) { drawH = ph; drawW = ph * imgRatio; }
          else { drawW = pw; drawH = pw / imgRatio; }
        }
        const x = (pw - drawW) / 2;
        const y = (ph - drawH) / 2;
        doc.addImage(imgData, 'JPEG', x, y, drawW, drawH);
        return doc;
      }
    }

    async function generatePdf() {
      if (files.length === 0) return;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus('PDF生成中...', 'info');
      await new Promise(r => setTimeout(r, 50));
      let successFlag = false;

      try {
        const preset = QUALITY_PRESETS[qualityKey];
        let doc = null;
        let isFirst = true;
        const genFailedNames = [];   // v3.7.6 (M3): 変換に失敗した画像名 (1枚の失敗でバッチ全滅させない)

        const totalOutputPages = files.reduce((sum, f) => sum + (f.type === 'pdf' ? f.numPages : 1), 0);
        let completedPages = 0;

        for (let i = 0; i < files.length; i++) {
          const it = files[i];

          if (it.type === 'pdf') {
            // Re-load the PDF fresh (buffer gets consumed by pdf.js)
            const srcPdf = await pdfjsLib.getDocument({ data: it.pdfBuffer.slice(0) }).promise;
            for (let p = 1; p <= srcPdf.numPages; p++) {
              setStatus(`PDF処理中... ${it.name} (${p}/${srcPdf.numPages})`, 'info');
              await new Promise(r => setTimeout(r, 0));

              const page = await srcPdf.getPage(p);
              const { dataUrl, nativeW, nativeH } = await renderPdfPageToJpeg(page, preset, qualityKey);

              // For "fit" mode with PDF, use points → mm (72dpi basis)
              let pageW = nativeW, pageH = nativeH;
              if (pageSizeKey === 'fit') {
                pageW = nativeW * 25.4 / 72;
                pageH = nativeH * 25.4 / 72;
              }
              doc = addPageToDoc(doc, dataUrl, pageW, pageH, isFirst);
              isFirst = false;
              completedPages++;
              if (progressBar) {
                progressBar.style.width = Math.round(completedPages / totalOutputPages * 100) + '%';
              }
            }
          } else {
            // Image case
            setStatus(`画像処理中... (${i+1}/${files.length}) ${it.name}`, 'info');
            await new Promise(r => setTimeout(r, 0));

            // v3.7.6 (M3): 1枚の失敗でバッチ全体を道連れにしない per-item catch
            // (PDF入力ページのレンダ失敗は従来どおり外側 catch で全体エラーになる = 既知の限界)
            try {
              // v3.7.6 (H4/M3): 無圧縮でも canvas 経由が必要なケースを判定
              //  - AVIF: jsPDF 2.5.1 は AVIF を埋め込めない → 常に canvas で JPEG 化
              //  - EXIF Orientation≠1 の JPEG: jsPDF は EXIF を無視して横倒しになる
              //    → 回転写真だけ高品質(0.95)再エンコードに落とす (canvas が EXIF 回転を適用)
              //  orientation=1 の JPEG と PNG は従来どおり生パススルー (無圧縮の約束を守る)
              let viaCanvas = qualityKey !== 'original';
              if (!viaCanvas) {
                const ext = (it.file.name || it.name || '').toLowerCase().split('.').pop();
                if (ext === 'avif' || it.file.type === 'image/avif') {
                  viaCanvas = true;
                } else if (ext === 'jpg' || ext === 'jpeg' || it.file.type === 'image/jpeg') {
                  const exifOri = await readJpegOrientation(it.file);
                  if (exifOri !== 1) viaCanvas = true;
                }
              }
              const imgData = viaCanvas
                ? await compressImage(it.file, preset.maxPx, qualityKey === 'original' ? 0.95 : preset.jpegQuality)
                : await loadImageData(it.file);

              // For "fit" mode with image, use px at 96dpi → mm
              let pageW = it.width, pageH = it.height;
              if (pageSizeKey === 'fit') {
                pageW = it.width * 25.4 / 96;
                pageH = it.height * 25.4 / 96;
              }
              doc = addPageToDoc(doc, imgData, pageW, pageH, isFirst);
              isFirst = false;
            } catch (imgErr) {
              console.error('画像の変換に失敗:', it.name, imgErr);
              genFailedNames.push(it.name);
            }
            completedPages++;
            if (progressBar) {
              progressBar.style.width = Math.round(completedPages / totalOutputPages * 100) + '%';
            }
          }
        }

        // v3.7.6 (M3): 全ファイル失敗時は doc が null のまま → 分かる言葉で止める
        if (!doc) throw new Error(`すべてのファイルの変換に失敗しました: ${genFailedNames.join(' / ')}`);

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        let pdfBlob = doc.output('blob');
        // v3.6.0: 出力前メタデータ除去 (imgtopdf は常にPDF・ガード不要)
        if (window.PdfSanitize) pdfBlob = await window.PdfSanitize.process(pdfBlob);
        const sizeMB = (pdfBlob.size / (1024 * 1024)).toFixed(2);
        const qLabel = { light: '軽量', standard: '標準', high: '高画質', original: '無圧縮' }[qualityKey];

        // Trigger download
        const url = URL.createObjectURL(pdfBlob);
        const a = document.createElement('a');
        a.href = url;
        // Custom filename from user, or fall back to auto name
        const imgFilenameEl = document.getElementById('imgFilenameInput');
        const userName = (imgFilenameEl && imgFilenameEl.value || '').trim();
        const hasPdf = files.some(f => f.type === 'pdf');
        const hasImg = files.some(f => f.type === 'image');
        const prefix = hasPdf && hasImg ? 'merged' : (hasPdf ? 'pdfmerge' : 'images');
        // User name: append TS if toggled. Empty: always uses TS.
        let finalBase;
        if (userName) {
          finalBase = appendTimestamp(userName, 'imgFilenameTs');
        } else {
          finalBase = `${prefix}_${ts}`;
        }
        a.download = `${finalBase}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 200);

        // v3.7.6 (M3): 失敗分を除いた実ページ数で表示し、失敗があれば消えないまとめ表示にする
        const okPages = totalOutputPages - genFailedNames.length;
        if (genFailedNames.length) {
          setStatus(`✓ ${okPages}ページ · ${sizeMB} MB (${qLabel}) · ダウンロード完了 / ⚠ ${genFailedNames.length}件は変換できず除外: ${genFailedNames.join(' / ')}`, 'error');
        } else {
          setStatus(`✓ ${okPages}ページ · ${sizeMB} MB (${qLabel}) · ダウンロード完了`, 'success');
        }

        // Celebrate!
        const imgCnt = files.filter(f => f.type === 'image').length;
        const pdfCnt = files.filter(f => f.type === 'pdf').length;
        const inputParts = [];
        if (imgCnt > 0) inputParts.push(`画像 ${imgCnt}`);
        if (pdfCnt > 0) inputParts.push(`PDF ${pdfCnt}`);
        const stats = [
          { label: '入力', value: inputParts.join(' + ') },
          { label: '出力ページ', value: `${okPages} ページ`, highlight: true },
          { label: 'ファイルサイズ', value: `${sizeMB} MB` },
          { label: '画質', value: qLabel }
        ];
        showSuccess({
          title: 'PDF作成完了',
          subtitle: 'ダウンロードが始まりました',
          stats: stats
        });
        successFlag = true;
      } catch (err) {
        console.error(err);
        setStatus(`✕ エラー: ${err.message}`, 'error');
      }

      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // PDF出力成功時のみ保持ファイルを破棄 (次の作業に備えてリセット)
      if (successFlag) {
        files.forEach(it => {
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
        });
        files = [];
        render();
      }
      setTimeout(() => {
        if (progressWrap) progressWrap.classList.remove('active');
      }, 1500);
    }

    render();
  })();

  // =========================================================
  // FORMAT CONVERTER (isolated scope)
  // =========================================================
  (function converterModule() {
    'use strict';
    const { jsPDF } = window.jspdf;

    let files = [];
    let outputFormat = 'jpg';
    let quality = 'standard';
    let outputMode = 'individual';
    let isConverting = false;   // 実行中ガード: ✕削除・追加で変換ループの添字がズレるのを防ぐ

    const $ = (id) => document.getElementById(id);
    const dropzone = $('convDropzone');
    const fileInput = $('convFileInput');
    const fileGrid = $('convFileGrid');
    const listPanel = $('convListPanel');
    const actionBar = $('convActionBar');
    const totalStats = $('convTotalStats');
    const generateBtn = $('convGenerateBtn');
    const clearBtn = $('convClearBtn');
    const statusMsg = $('convStatusMsg');
    const progressWrap = $('convProgressWrap');
    const progressBar = $('convProgressBar');
    const qualityPanel = $('convQualityPanel');

    // Format preset
    $('convFormatPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convFormatPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        outputFormat = btn.dataset.format;
        // Hide quality panel if format doesn't benefit from JPEG quality
        qualityPanel.style.opacity = (outputFormat === 'jpg' || outputFormat === 'pdf') ? '1' : '0.45';
        // Update filename extension hint based on output mode
        updateFilenameExtDisplay();
        // Re-render stats (output format changed)
        render();
      });
    });
    function updateFilenameExtDisplay() {
      const extEl = document.getElementById('convFilenameExt');
      if (!extEl) return;
      if (outputMode === 'zip') {
        extEl.textContent = '.zip';
      } else {
        extEl.textContent = `.${outputFormat}`;
      }
    }
    $('convQualityPresets').querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convQualityPresets').querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        quality = btn.dataset.quality;
      });
    });
    $('convOutputModes').querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $('convOutputModes').querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        outputMode = btn.dataset.output;
        updateFilenameExtDisplay();
        render();
      });
    });

    // Filename input wiring
    (function() {
      const fin = document.getElementById('convFilenameInput');
      const fcl = document.getElementById('convFilenameClear');
      if (!fin) return;
      fin.addEventListener('input', () => {
        const v = fin.value;
        const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
        if (v !== cleaned) fin.value = cleaned;
        fcl.classList.toggle('visible', !!fin.value);
      });
      fcl.addEventListener('click', () => {
        fin.value = '';
        fcl.classList.remove('visible');
        fin.focus();
      });
    })();

    // Dropzone
    ['dragenter', 'dragover'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', ev => {
      if (ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', ev => {
      if (ev.target.files) addFiles(ev.target.files);
      ev.target.value = '';
    });

    clearBtn.addEventListener('click', () => {
      files.forEach(it => {
        if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
      });
      files = [];
      setStatus('');
      render();
    });
    generateBtn.addEventListener('click', convertAll);

    // ---- Input type detection ----
    function getExt(f) { return f.name.toLowerCase().split('.').pop(); }
    function isHeic(f) {
      const e = getExt(f);
      return e === 'heic' || e === 'heif' || f.type === 'image/heic' || f.type === 'image/heif';
    }
    function isTiff(f) {
      const e = getExt(f);
      return e === 'tif' || e === 'tiff' || f.type === 'image/tiff';
    }
    function isBmp(f) {
      const e = getExt(f);
      return e === 'bmp' || f.type === 'image/bmp' || f.type === 'image/x-ms-bmp';
    }
    function isPdf(f) {
      return f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    }
    function isValidInput(f) {
      const e = getExt(f);
      return ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif', 'pdf'].includes(e)
        || isPdf(f) || isHeic(f) || isTiff(f) || isBmp(f)
        || ['image/png', 'image/jpeg', 'image/jpg', 'image/avif'].includes(f.type);
    }

    function setStatus(text, type) {
      if (statusMsg) {
        statusMsg.textContent = text;
        statusMsg.className = 'img-status-msg' + (type ? ' ' + type : '');
      }
      // ミラー: アクションバー中央 (常時見える位置)
      const abs = document.getElementById('convActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
    }

    async function convertHeicToJpeg(file) {
      const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      const result = Array.isArray(blob) ? blob[0] : blob;
      return new File([result], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
    }
    async function convertTiffToCanvas(file) {
      // Returns array of {canvas, name} — one per TIFF page
      const buf = await file.arrayBuffer();
      const ifds = UTIF.decode(buf);
      if (!ifds || ifds.length === 0) throw new Error('TIFF decode failed');
      const results = [];
      for (let i = 0; i < ifds.length; i++) {
        const ifd = ifds[i];
        UTIF.decodeImage(buf, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        const canvas = document.createElement('canvas');
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(ifd.width, ifd.height);
        imgData.data.set(rgba);
        ctx.putImageData(imgData, 0, 0);
        const suffix = ifds.length > 1 ? `_page${i + 1}` : '';
        const baseName = file.name.replace(/\.(tiff?)$/i, '');
        results.push({ canvas, baseName: `${baseName}${suffix}` });
      }
      return results;
    }

    // Load any input file → array of {canvas, baseName} entries
    // (PDFs and multi-page TIFFs yield multiple entries)
    async function loadToCanvases(file) {
      const name = file.name;
      const baseName = name.replace(/\.[^.]+$/, '');

      if (isTiff(file)) {
        return await convertTiffToCanvas(file);
      }

      if (isPdf(file)) {
        const buf = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
        const results = [];
        for (let p = 1; p <= pdfDoc.numPages; p++) {
          const page = await pdfDoc.getPage(p);
          const native = page.getViewport({ scale: 1 });
          const maxDim = Math.max(native.width, native.height);
          const targetPx = 2200;
          const scale = Math.min(4, targetPx / maxDim);
          const vp = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const suffix = pdfDoc.numPages > 1 ? `_page${p}` : '';
          results.push({ canvas, baseName: `${baseName}${suffix}` });
        }
        return results;
      }

      // Images (PNG/JPG/HEIC/BMP) → load into canvas
      let loadFile = file;
      if (isHeic(file)) {
        loadFile = await convertHeicToJpeg(file);
      }
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(loadFile);
        const img = new Image();
        img.onload = () => {
          // Chrome系のcanvas上限(長辺16384px・面積制限)超過で toBlob/toDataURL が壊れるため、
          // 長辺 8192px を超える巨大画像は縦横比を保って縮小する
          const MAX_DIM = 8192;
          const dimScale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * dimScale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * dimScale));
          const ctx = canvas.getContext('2d');
          // For transparent-capable formats, don't fill white unless going to JPG/BMP
          if (outputFormat === 'jpg' || outputFormat === 'bmp') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          resolve([{ canvas, baseName }]);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像読込失敗')); };
        img.src = url;
      });
    }

    async function addFiles(fileList) {
      const arr = [...fileList].filter(isValidInput);
      if (arr.length === 0) {
        setStatus('⚠ PNG / JPG / HEIC / BMP / TIFF / AVIF / PDF のみ対応しています', 'error');
        return;
      }
      if (isConverting) {
        setStatus('変換中はファイルを追加できません', 'error');
        return;
      }
      setStatus('');

      // Build thumbnails for preview
      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)
      for (const origFile of arr) {
        try {
          setStatus(`読込中... (${loaded + 1}/${total}) ${origFile.name}`, 'info');
          const ext = getExt(origFile);

          // For thumbnail we just need ONE preview image per file
          let thumbUrl = null;
          let pageCount = 1;
          let nativeWidth = 0;
          let nativeHeight = 0;

          if (isTiff(origFile)) {
            const canvases = await convertTiffToCanvas(origFile);
            pageCount = canvases.length;
            const first = canvases[0].canvas;
            nativeWidth = first.width;
            nativeHeight = first.height;
            thumbUrl = makeThumbUrl(first);
          } else if (isPdf(origFile)) {
            const buf = await origFile.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
            pageCount = pdf.numPages;
            const page = await pdf.getPage(1);
            const native = page.getViewport({ scale: 1 });
            nativeWidth = native.width;
            nativeHeight = native.height;
            const thumbScale = Math.min(250 / native.width, 250 / native.height, 1.5);
            const vp = page.getViewport({ scale: thumbScale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
            canvas.width = 0; canvas.height = 0;
          } else if (isHeic(origFile)) {
            const jpg = await convertHeicToJpeg(origFile);
            thumbUrl = URL.createObjectURL(jpg);
          } else {
            thumbUrl = URL.createObjectURL(origFile);
          }

          files.push({
            file: origFile,
            url: thumbUrl,
            name: origFile.name,
            ext: ext,
            pageCount: pageCount,
            isPdf: isPdf(origFile),
            isTiff: isTiff(origFile),
            width: nativeWidth,
            height: nativeHeight
          });
        } catch (err) {
          console.error('Conv load error:', origFile.name, err);
          failedNames.push(origFile.name);
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示(保護付きPDF・破損ファイルの無言スキップ防止)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした(保護付き/破損の可能性): ${failedNames.join(' / ')}` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    function makeThumbUrl(canvas) {
      // Shrink to thumbnail
      const maxDim = 250;
      const scale = Math.min(maxDim / canvas.width, maxDim / canvas.height, 1);
      const thumb = document.createElement('canvas');
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      const ctx = thumb.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, thumb.width, thumb.height);
      ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
      const url = thumb.toDataURL('image/jpeg', 0.75);
      thumb.width = 0; thumb.height = 0;
      return url;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function render() {
      const convFbar = document.getElementById('convFilenameBar');
      if (files.length === 0) {
        totalStats.textContent = '0 ファイル';
        actionBar.style.display = 'none';
        if (convFbar) convFbar.style.display = 'none';
        if (listPanel) listPanel.style.display = 'none';
        fileGrid.innerHTML = '';
        return;
      }
      const totalOutputs = files.reduce((s, f) => s + f.pageCount, 0);
      totalStats.innerHTML = `<strong style="color:white;">${files.length}</strong> ファイル · 出力 ${totalOutputs} 枚 · → ${outputFormat.toUpperCase()}`;
      actionBar.style.display = 'flex';
      // Filename bar is useful for both ZIP and individual modes now
      if (convFbar) convFbar.style.display = 'flex';
      if (listPanel) listPanel.style.display = 'block';

      fileGrid.innerHTML = files.map((it, i) => {
        const multiPage = it.pageCount > 1;
        const extBadge = `<div class="pdf-type-badge">${it.ext.toUpperCase()}</div>`;
        const pagesBadge = multiPage ? `<div class="pdf-pages-badge">${it.pageCount}ページ</div>` : '';
        return `
          <div class="img-file-card${it.isPdf ? ' is-pdf' : ''}" data-idx="${i}">
            ${extBadge}
            <img class="img-file-thumb" src="${it.url}" alt="${escapeHtml(it.name)}">
            ${pagesBadge}
            <button class="img-file-remove" data-remove="${i}" title="削除" aria-label="削除">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
            <div class="img-file-meta">
              <span class="img-file-num">${i + 1}</span>
              <span class="img-file-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>
            </div>
          </div>
        `;
      }).join('');

      fileGrid.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          if (isConverting) { setStatus('変換中はファイルを変更できません', 'error'); return; }
          const idx = +btn.dataset.remove;
          const it = files[idx];
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
          files.splice(idx, 1);
          render();
        });
      });
    }

    // ---- Quality map ----
    const QUALITY = {
      light:    0.55,
      standard: 0.80,
      high:     0.95,
      max:      1.00
    };

    // ---- Output helpers ----
    // 透過部を白で埋める (JPEG/BMP/PDF は透過を保持できず黒化けするため)。
    // destination-over で既存描画の「下」に白を敷くので、コピーcanvasを作らずメモリ増なしで合成できる
    function flattenWhite(canvas) {
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      return canvas;
    }
    function canvasToJpegBlob(canvas) {
      flattenWhite(canvas);   // TIFF入力など読込時に白埋めされない経路の保険
      return new Promise(r => canvas.toBlob(r, 'image/jpeg', QUALITY[quality]));
    }
    function canvasToPngBlob(canvas) {
      return new Promise(r => canvas.toBlob(r, 'image/png'));
    }
    // BMP: hand-rolled 32bpp uncompressed encoder
    function canvasToBmpBlob(canvas) {
      flattenWhite(canvas);   // 透過は白背景に変換 (多くのビューアは32bpp BMPのアルファを無視して黒くなるため)
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const w = canvas.width;
      const h = canvas.height;
      const rowSize = w * 4;              // 32bpp BGRA
      const pixelArraySize = rowSize * h;
      const fileSize = 54 + pixelArraySize;
      const buffer = new ArrayBuffer(fileSize);
      const dv = new DataView(buffer);
      const u8 = new Uint8Array(buffer);
      // BMP File Header
      dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);        // 'BM'
      dv.setUint32(2, fileSize, true);                    // file size
      dv.setUint32(6, 0, true);                           // reserved
      dv.setUint32(10, 54, true);                         // pixel data offset
      // DIB Header (BITMAPINFOHEADER, 40 bytes)
      dv.setUint32(14, 40, true);                         // header size
      dv.setInt32(18, w, true);                           // width
      dv.setInt32(22, -h, true);                          // negative height = top-down
      dv.setUint16(26, 1, true);                          // planes
      dv.setUint16(28, 32, true);                         // 32bpp
      dv.setUint32(30, 0, true);                          // BI_RGB (no compression)
      dv.setUint32(34, pixelArraySize, true);
      dv.setUint32(38, 2835, true);                       // 72 DPI
      dv.setUint32(42, 2835, true);
      dv.setUint32(46, 0, true); dv.setUint32(50, 0, true);
      // Pixel data: BGRA, top-down
      const src = imgData.data;
      let p = 54;
      for (let i = 0; i < src.length; i += 4) {
        u8[p++] = src[i + 2]; // B
        u8[p++] = src[i + 1]; // G
        u8[p++] = src[i];     // R
        u8[p++] = src[i + 3]; // A
      }
      return new Blob([buffer], { type: 'image/bmp' });
    }
    // TIFF: uses UTIF.encode (RGBA8 buffer)
    function canvasToTiffBlob(canvas) {
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const tiffBuf = UTIF.encodeImage(imgData.data, canvas.width, canvas.height);
      return new Blob([tiffBuf], { type: 'image/tiff' });
    }
    // PDF: 1 canvas = 1 PDF page (sized to canvas)
    function canvasToPdfBlob(canvas) {
      // 透過PNG/AVIF/TIFF→PDF の黒化け防止: JPEG化の前に透過部を白で埋める (FAQ「PDFは白背景に変換」と整合)
      flattenWhite(canvas);
      const jpegData = canvas.toDataURL('image/jpeg', QUALITY[quality]);
      // Use mm with 96dpi conversion
      const wMm = canvas.width * 25.4 / 96;
      const hMm = canvas.height * 25.4 / 96;
      const orient = wMm > hMm ? 'landscape' : 'portrait';
      const doc = new jsPDF({ orientation: orient, unit: 'mm', format: [wMm, hMm] });
      doc.addImage(jpegData, 'JPEG', 0, 0, wMm, hMm);
      return doc.output('blob');
    }

    function extFor(format) {
      return {
        jpg: 'jpg',
        png: 'png',
        pdf: 'pdf',
        bmp: 'bmp',
        tiff: 'tiff'
      }[format];
    }

    // 出力名が重複したら「name (2).ext」形式の連番を振る (JSZip.file は同名上書きで無言消失するため)
    function uniqueFilename(name, usedNames) {
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (usedNames.has(`${stem} (${n})${ext}`)) n++;
      const result = `${stem} (${n})${ext}`;
      usedNames.add(result);
      return result;
    }

    async function canvasToOutputBlob(canvas, format) {
      if (format === 'jpg') return canvasToJpegBlob(canvas);
      if (format === 'png') return canvasToPngBlob(canvas);
      if (format === 'pdf') return canvasToPdfBlob(canvas);
      if (format === 'bmp') return canvasToBmpBlob(canvas);
      if (format === 'tiff') return canvasToTiffBlob(canvas);
      throw new Error('Unknown format: ' + format);
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 200);
    }

    async function convertAll() {
      if (files.length === 0 || isConverting) return;
      isConverting = true;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus('変換中...', 'info');
      await new Promise(r => setTimeout(r, 50));

      const outputs = []; // {blob, filename}
      const usedNames = new Set();   // ZIP内の同名上書き(無言消失)防止用
      const failedNames = [];        // 変換失敗ファイル(1件の失敗で全滅させない)
      const totalOutputs = files.reduce((s, f) => s + f.pageCount, 0);
      let completed = 0;
      let totalSize = 0;
      let successFlag = false;

      try {
        for (let fi = 0; fi < files.length; fi++) {
          const f = files[fi];
          setStatus(`変換中 (${fi + 1}/${files.length}) ${f.name}`, 'info');
          await new Promise(r => setTimeout(r, 0));

          // 1ファイルの失敗(巨大画像のcanvas上限超過・破損等)は記録して続行する
          try {
            const canvasList = await loadToCanvases(f.file);
            for (const { canvas, baseName } of canvasList) {
              const blob = await canvasToOutputBlob(canvas, outputFormat);
              // canvas上限超過などで toBlob が null を返すことがある → このファイルだけ失敗扱いにする
              if (!blob) throw new Error('エンコード失敗(画像が大きすぎる可能性)');
              const filename = uniqueFilename(`${baseName}.${extFor(outputFormat)}`, usedNames);
              outputs.push({ blob, filename });
              totalSize += blob.size;
              completed++;
              if (progressBar) {
                progressBar.style.width = Math.round(completed / totalOutputs * 100) + '%';
              }
              // Free memory
              canvas.width = 0; canvas.height = 0;
            }
          } catch (perFileErr) {
            console.error('Conv error:', f.name, perFileErr);
            failedNames.push(f.name);
          }
        }

        if (outputs.length === 0) {
          throw new Error(failedNames.length ? `全${failedNames.length}件の変換に失敗しました` : '出力0件');
        }

        // v3.6.0: 出力前メタデータ除去 (PDF限定ガード — 画像形式は素通し)
        if (outputFormat === 'pdf' && window.PdfSanitize) {
          setStatus('PDFメタデータ除去中...', 'info');
          let _encSkipped = false;
          for (let i = 0; i < outputs.length; i++) {
            outputs[i].blob = await window.PdfSanitize.process(outputs[i].blob);
            if (window.PdfSanitize._lastSkippedEncrypted) _encSkipped = true;
          }
          if (_encSkipped) setStatus('暗号化PDFはメタデータ除去をスキップしました', 'info');
        }

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;

        // 個別DL かつ 2枚以上 → ブラウザの「複数ファイルDL許可」プロンプト回避のため
        // 自動で ZIP にまとめる。1枚だけの時はそのまま個別DL。
        const effectiveMode = (outputMode === 'individual' && outputs.length > 1) ? 'zip' : outputMode;
        const autoZipped = (effectiveMode === 'zip' && outputMode !== 'zip');

        if (effectiveMode === 'zip') {
          setStatus('ZIP作成中...', 'info');
          await new Promise(r => setTimeout(r, 10));
          const zip = new JSZip();
          outputs.forEach(o => zip.file(o.filename, o.blob));
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const convUserName = (document.getElementById('convFilenameInput')?.value || '').trim();
          let convZipName;
          if (convUserName) {
            convZipName = `${appendTimestamp(convUserName, 'convFilenameTs')}.zip`;
          } else {
            convZipName = `converted_${outputFormat}_${ts}.zip`;
          }
          triggerDownload(zipBlob, convZipName);
          const zipSizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
          const autoZipNote = autoZipped ? ' (複数ファイルのためZIPに自動集約)' : '';
          setStatus(`✓ ${outputs.length}枚変換 · ZIP ${zipSizeMB} MB${autoZipNote}`, 'success');
          showSuccess({
            title: '変換完了',
            subtitle: autoZipped
              ? `複数ファイル→ZIPダウンロードが始まりました`
              : `ZIPダウンロードが始まりました`,
            stats: [
              { label: '変換ファイル', value: `${outputs.length} 枚`, highlight: true },
              { label: '出力形式', value: outputFormat.toUpperCase() },
              { label: 'ZIPサイズ', value: `${zipSizeMB} MB` }
            ]
          });
        } else {
          // Individual download: trigger one by one with a small stagger
          const convUserNameInd = (document.getElementById('convFilenameInput')?.value || '').trim();
          const tsSuffix = isTimestampEnabled('convFilenameTs') ? `_${makeTimestamp()}` : '';
          for (let i = 0; i < outputs.length; i++) {
            let fname = outputs[i].filename;
            if (convUserNameInd) {
              const ext = extFor(outputFormat);
              if (outputs.length === 1) {
                fname = `${convUserNameInd}${tsSuffix}.${ext}`;
              } else {
                fname = `${convUserNameInd}_${String(i + 1).padStart(2, '0')}${tsSuffix}.${ext}`;
              }
            }
            triggerDownload(outputs[i].blob, fname);
            if (i < outputs.length - 1) await new Promise(r => setTimeout(r, 250));
          }
          const totalMB = (totalSize / (1024 * 1024)).toFixed(2);
          setStatus(`✓ ${outputs.length}枚変換 · 合計 ${totalMB} MB`, 'success');
          showSuccess({
            title: '変換完了',
            subtitle: `${outputs.length}件のダウンロードが始まりました`,
            stats: [
              { label: '変換ファイル', value: `${outputs.length} 枚`, highlight: true },
              { label: '出力形式', value: outputFormat.toUpperCase() },
              { label: '合計サイズ', value: `${totalMB} MB` }
            ]
          });
        }
        // 失敗ファイルがあれば成功表示を上書きして必ず知らせる(完走分はダウンロード済み)
        if (failedNames.length) {
          setStatus(`⚠ ${failedNames.length}件失敗: ${failedNames.join(' / ')}(他の ${outputs.length} 枚は変換・ダウンロード済み)`, 'error');
        }
        successFlag = true;
      } catch (err) {
        console.error(err);
        // どこまで進んでたかも示す (完全失敗 vs 途中失敗の区別)
        const progressInfo = completed > 0 ? `${completed}/${totalOutputs}まで変換、残りで失敗。` : '全て失敗。';
        setStatus(`✕ ${progressInfo} エラー: ${err.message}`, 'error');
      }

      isConverting = false;   // 成功・失敗どちらでも必ず解除 (catch後にここへ到達する)
      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // 変換成功時のみ保持ファイルを破棄 (次の作業に備えてリセット)
      if (successFlag) {
        files.forEach(it => {
          if (it.url && it.url.startsWith('blob:')) URL.revokeObjectURL(it.url);
        });
        files = [];
        render();
      }
      setTimeout(() => {
        if (progressWrap) progressWrap.classList.remove('active');
      }, 1500);
    }

    render();
  })();

  // =========================================================
  // PDF EDIT MODE (delete / reorder / rotate / split)
  // =========================================================
  (function pdfEditModule() {
    'use strict';

    let sources = [];
    let pages = [];
    let splits = new Set();
    let dragIdx = null;

    const $ = (id) => document.getElementById(id);
    const dropzone = $('editDropzone');
    const fileInput = $('editFileInput');
    const listPanel = $('editListPanel');
    const actionBar = $('editActionBar');
    const totalStats = $('editTotalStats');
    const pageGrid = $('editPageGrid');
    const generateBtn = $('editGenerateBtn');
    const clearBtn = $('editClearBtn');
    const selectAllBtn = $('editSelectAll');
    const deleteSelectedBtn = $('editDeleteSelected');
    const rotateSelectedBtn = $('editRotateSelected');
    const clearSplitsBtn = $('editClearSplits');
    const statusMsg = $('editStatusMsg');
    const progressWrap = $('editProgressWrap');
    const progressBar = $('editProgressBar');
    const extractSelectedBtn = $('editExtractSelected');
    const filenameInput = $('editFilenameInput');
    const filenameBar = $('editFilenameBar');
    const filenameClear = $('editFilenameClear');
    const autoCompressBtn = $('editAutoCompress');
    // Wire auto-compress toggle
    if (autoCompressBtn) {
      autoCompressBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        autoCompressBtn.classList.toggle('active');
      });
    }

    function setStatus(text, type) {
      if (statusMsg) {
        statusMsg.textContent = text;
        statusMsg.className = 'img-status-msg' + (type ? ' ' + type : '');
      }
      // ミラー: アクションバー中央 (常時見える位置)
      const abs = document.getElementById('editActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    ['dragenter','dragover'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('dragover'); });
    });
    ['dragleave','drop'].forEach(e => {
      dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('dragover'); });
    });
    dropzone.addEventListener('drop', ev => {
      if (ev.dataTransfer.files) addFiles(ev.dataTransfer.files);
    });
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', ev => {
      if (ev.target.files) addFiles(ev.target.files);
      ev.target.value = '';
    });

    clearBtn.addEventListener('click', () => {
      sources = [];
      pages = [];
      splits.clear();
      setStatus('');
      render();
    });
    generateBtn.addEventListener('click', generateOutput);

    selectAllBtn.addEventListener('click', () => {
      const allSelected = pages.length > 0 && pages.every(p => p.selected);
      pages.forEach(p => p.selected = !allSelected);
      render();
    });
    deleteSelectedBtn.addEventListener('click', () => {
      const before = pages.length;
      const oldSplits = new Set(splits);
      const keep = pages.map((p, i) => ({ p, keep: !p.selected, oldIdx: i }));
      const kept = keep.filter(x => x.keep);
      const newSplits = new Set();
      for (let i = 0; i < kept.length - 1; i++) {
        const oldIdx = kept[i].oldIdx;
        if (oldSplits.has(oldIdx)) newSplits.add(i);
      }
      pages = kept.map(x => x.p);
      splits = newSplits;
      if (pages.length < before) setStatus(`${before - pages.length}ページ削除`, 'success');
      render();
    });
    rotateSelectedBtn.addEventListener('click', () => {
      const selected = pages.filter(p => p.selected);
      if (selected.length === 0) return;
      selected.forEach(p => { p.rotation = (p.rotation + 90) % 360; });
      render();
    });
    clearSplitsBtn.addEventListener('click', () => {
      splits.clear();
      setStatus('分割ポイントを解除', 'info');
      render();
    });

    extractSelectedBtn.addEventListener('click', async () => {
      const selected = pages.filter(p => p.selected);
      if (selected.length === 0) return;
      await generateOutput({ onlySelected: true });
    });

    // Filename input: live-sanitize and toggle clear button
    filenameInput.addEventListener('input', () => {
      const v = filenameInput.value;
      // Strip dangerous characters as you type
      const cleaned = v.replace(/[\\/:*?"<>|]/g, '');
      if (v !== cleaned) filenameInput.value = cleaned;
      filenameClear.classList.toggle('visible', !!filenameInput.value);
    });
    filenameClear.addEventListener('click', () => {
      filenameInput.value = '';
      filenameClear.classList.remove('visible');
      filenameInput.focus();
    });

    async function addFiles(fileList) {
      const arr = [...fileList].filter(f =>
        f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
      );
      if (arr.length === 0) {
        setStatus('⚠ PDFファイルのみ対応しています', 'error');
        return;
      }
      setStatus('');
      let loaded = 0;
      const total = arr.length;
      const failedNames = [];   // 読込失敗を覚えて最後にまとめて表示(直後の setStatus('') で消さない)
      for (const file of arr) {
        try {
          setStatus(`PDF読込中... (${loaded+1}/${total}) ${file.name}`, 'info');
          await addPdf(file);
        } catch (err) {
          console.error('PDF load failed:', file.name, err);
          failedNames.push(file.name + (String(err && err.message).indexOf('PROTECTED_PDF') >= 0 ? '(保護付きPDFのため編集不可)' : ''));
        }
        loaded++;
      }
      // 失敗があれば消えないまとめ表示。このまま生成するとその分は入らない事も明示(無言欠落防止)
      setStatus(failedNames.length ? `⚠ ${failedNames.length}件を読み込めませんでした: ${failedNames.join(' / ')} — このまま生成すると、その分は含まれません` : '');
      render();
      // ドロップ後、結果が見える位置へ自動スクロール
      requestAnimationFrame(() => {
        if (actionBar && actionBar.offsetParent) actionBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }

    async function addPdf(file) {
      const buffer = await file.arrayBuffer();
      const pdfJsBuf = buffer.slice(0);
      const pdfDoc = await pdfjsLib.getDocument({ data: pdfJsBuf }).promise;
      // 保護付き(オーナーパスワード/編集制限)PDF は読込時点で弾く。
      // pdf-lib 1.17.1 は復号できないため、ignoreEncryption:true で強行すると
      // 「成功」表示のまま中身の壊れたPDFを出力してしまう(プレビューは pdf.js が
      // 透過復号するので正常に見え、提出後に発覚する最悪パターン)。
      // getPermissions() は暗号化なしなら null、保護付きなら権限配列を返す。
      let _perms = null;
      try { _perms = await pdfDoc.getPermissions(); } catch (_e) { /* 判定不能は通す(誤遮断防止) */ }
      if (_perms !== null) throw new Error('PROTECTED_PDF');
      // しおり(目次)の有無を記録 — 複数PDF結合 (copyPages) ではしおりが引き継がれないため、生成時の通知に使う。
      // getOutline() はしおり無しなら null、有りなら配列を返す (pdf.js)
      let _outline = null;
      try { _outline = await pdfDoc.getOutline(); } catch (_e) { /* 取得失敗は「しおり無し」扱い(誤通知防止) */ }
      const sourceId = 'src_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      sources.push({ id: sourceId, name: file.name, buffer: buffer, hasOutline: !!(_outline && _outline.length > 0) });

      const numPages = pdfDoc.numPages;
      for (let p = 1; p <= numPages; p++) {
        setStatus(`サムネ生成中... ${file.name} ${p}/${numPages}`, 'info');
        await new Promise(r => setTimeout(r, 0));
        const page = await pdfDoc.getPage(p);
        const native = page.getViewport({ scale: 1 });
        const maxDim = 240;
        const scale = Math.min(maxDim / native.width, maxDim / native.height, 1.5);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const thumbUrl = canvas.toDataURL('image/jpeg', 0.75);
        canvas.width = 0; canvas.height = 0;

        pages.push({
          id: sourceId + '_p' + p,
          sourceId: sourceId,
          sourcePageIndex: p - 1,
          rotation: 0,
          thumbUrl: thumbUrl,
          sourceName: file.name,
          selected: false
        });
      }
    }

    function render() {
      if (pages.length === 0) {
        listPanel.style.display = 'none';
        actionBar.style.display = 'none';
        filenameBar.style.display = 'none';
        pageGrid.innerHTML = '';
        totalStats.textContent = '0 ページ';
        return;
      }

      listPanel.style.display = 'block';
      actionBar.style.display = 'flex';
      filenameBar.style.display = 'flex';

      const selectedCount = pages.filter(p => p.selected).length;
      const splitCount = splits.size;
      const outputCount = splitCount + 1;
      let statsHtml = `<strong style="color:white;">${pages.length}</strong> ページ`;
      if (selectedCount > 0) statsHtml += ` · <span style="color:#6b8eff;">${selectedCount}選択中</span>`;
      if (splitCount > 0) statsHtml += ` · ${outputCount}個のPDFに分割`;
      totalStats.innerHTML = statsHtml;

      // Auto-compress toggle: only relevant when splitting (causes size explosion)
      if (autoCompressBtn) {
        autoCompressBtn.style.display = splitCount > 0 ? 'inline-flex' : 'none';
      }

      deleteSelectedBtn.disabled = selectedCount === 0;
      rotateSelectedBtn.disabled = selectedCount === 0;
      extractSelectedBtn.disabled = selectedCount === 0;
      clearSplitsBtn.disabled = splitCount === 0;

      const htmlParts = [];

      pages.forEach((p, i) => {
        const rotStyle = p.rotation ? `style="transform: rotate(${p.rotation}deg);"` : '';
        const srcBadge = `<div class="edit-page-src-badge" title="${escapeHtml(p.sourceName)}">${escapeHtml(p.sourceName)} p.${p.sourcePageIndex + 1}</div>`;
        const rotBadge = p.rotation ? `<span class="edit-split-info" style="margin-left:auto;">${p.rotation}°</span>` : '';
        const isSplitAfter = i < pages.length - 1 && splits.has(i);
        const splitChipCls = isSplitAfter ? 'edit-split-chip active' : 'edit-split-chip';

        const card = `
          <div class="edit-page-card${p.selected ? ' selected' : ''}" draggable="true" data-idx="${i}">
            ${srcBadge}
            <button class="edit-page-checkbox" data-toggle-select="${i}" type="button" title="${p.selected ? 'このページを選択解除' : 'このページを選択'}" aria-label="選択"></button>
            <div class="edit-page-actions">
              <button class="edit-page-action-btn rotate" data-rotate="${i}" title="90°回転" aria-label="回転">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
              </button>
              <button class="edit-page-action-btn remove" data-remove="${i}" title="削除" aria-label="削除">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div class="edit-page-thumb-wrap">
              <img class="edit-page-thumb" src="${p.thumbUrl}" ${rotStyle} alt="page">
            </div>
            <div class="edit-page-meta">
              <span class="edit-page-num">${i + 1}</span>
              <span class="edit-page-src-label" title="${escapeHtml(p.sourceName)}">${escapeHtml(p.sourceName)}</span>
              ${rotBadge}
            </div>
          </div>`;

        // Split chip on right edge (except last)
        let splitChip = '';
        if (i < pages.length - 1) {
          splitChip = `
            <button class="${splitChipCls}" data-split="${i}" type="button" title="${isSplitAfter ? 'ここで分割中 - クリックで解除' : 'ここで分割する'}" aria-label="分割ポイント">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="6" r="3"/>
                <circle cx="6" cy="18" r="3"/>
                <line x1="20" y1="4" x2="8.12" y2="15.88"/>
                <line x1="14.47" y1="14.48" x2="20" y2="20"/>
                <line x1="8.12" y1="8.12" x2="12" y2="12"/>
              </svg>
            </button>`;
        }

        htmlParts.push(`<div class="edit-page-slot">${card}${splitChip}</div>`);

        if (isSplitAfter) {
          let segNum = 2;
          for (let j = 0; j < i; j++) if (splits.has(j)) segNum++;
          htmlParts.push(`
            <div class="edit-segment-divider">
              <div class="edit-segment-divider-chip">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="6" cy="6" r="3"/>
                  <circle cx="6" cy="18" r="3"/>
                  <line x1="20" y1="4" x2="8.12" y2="15.88"/>
                  <line x1="14.47" y1="14.48" x2="20" y2="20"/>
                  <line x1="8.12" y1="8.12" x2="12" y2="12"/>
                </svg>
                PART ${segNum} START
              </div>
            </div>`);
        }
      });

      const html = htmlParts.join('');

      pageGrid.innerHTML = html;

      pageGrid.querySelectorAll('[data-rotate]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.rotate;
          pages[idx].rotation = (pages[idx].rotation + 90) % 360;
          render();
        });
      });
      pageGrid.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.remove;
          const oldSplits = new Set(splits);
          splits = new Set();
          oldSplits.forEach(s => {
            if (s < idx) splits.add(s);
            else if (s > idx) splits.add(s - 1);
          });
          pages.splice(idx, 1);
          render();
        });
      });
      pageGrid.querySelectorAll('[data-split]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +btn.dataset.split;
          if (splits.has(idx)) splits.delete(idx);
          else splits.add(idx);
          render();
        });
      });
      pageGrid.querySelectorAll('[data-toggle-select]').forEach(cb => {
        cb.addEventListener('click', ev => {
          ev.stopPropagation();
          const idx = +cb.dataset.toggleSelect;
          pages[idx].selected = !pages[idx].selected;
          render();
        });
      });

      pageGrid.querySelectorAll('.edit-page-card').forEach(card => {
        card.addEventListener('dragstart', ev => {
          dragIdx = +card.dataset.idx;
          card.classList.add('dragging');
          ev.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('dragging');
          dragIdx = null;
          pageGrid.querySelectorAll('.edit-page-card').forEach(c => c.classList.remove('dragover-card'));
        });
        card.addEventListener('dragover', ev => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          card.classList.add('dragover-card');
        });
        card.addEventListener('dragleave', () => card.classList.remove('dragover-card'));
        card.addEventListener('drop', ev => {
          ev.preventDefault();
          card.classList.remove('dragover-card');
          const toIdx = +card.dataset.idx;
          if (dragIdx !== null && dragIdx !== toIdx) {
            const item = pages.splice(dragIdx, 1)[0];
            pages.splice(toIdx, 0, item);
            // 並び替えると分割位置の意味が変わるため解除する。無言で消すと
            // 「3分割のつもりが1本の結合PDF」事故になるので、消した時だけ告知する
            const hadSplits = splits.size > 0;
            splits.clear();
            if (hadSplits) setStatus('並び替えたため、分割ポイント(✂)を解除しました。必要なら付け直してください', 'info');
            render();
          }
        });
      });
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 200);
    }

    async function generateOutput(opts) {
      opts = opts || {};
      const onlySelected = !!opts.onlySelected;
      const workingPages = onlySelected ? pages.filter(p => p.selected) : pages;
      if (workingPages.length === 0) return;
      generateBtn.disabled = true;
      clearBtn.disabled = true;
      if (progressWrap) progressWrap.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      setStatus(onlySelected ? '選択ページを抽出中...' : 'PDFを組み立て中...', 'info');
      await new Promise(r => setTimeout(r, 50));
      let successFlag = false;

      try {
        const { PDFDocument, degrees } = PDFLib;

        // Only load sources that are referenced
        const neededSourceIds = new Set(workingPages.map(p => p.sourceId));
        const sourceDocsCache = {};
        for (const src of sources) {
          if (neededSourceIds.has(src.id)) {
            sourceDocsCache[src.id] = await PDFDocument.load(src.buffer, { ignoreEncryption: true });
          }
        }

        // Build segments: if onlySelected, no splitting (single output)
        const segments = [];
        if (onlySelected) {
          segments.push(workingPages);
        } else {
          let currentSeg = [];
          workingPages.forEach((p, i) => {
            currentSeg.push(p);
            if (splits.has(i)) {
              segments.push(currentSeg);
              currentSeg = [];
            }
          });
          if (currentSeg.length > 0) segments.push(currentSeg);
        }

        const outputBlobs = [];
        const totalWork = workingPages.length;
        let doneWork = 0;
        const debugSizes = [];

        // Check if all pages in all segments come from a single source PDF.
        // If so, we can use a much more efficient approach: clone the source and remove unused pages.
        // This lets pdf-lib's object tree properly prune dead resources on save.
        const allSourceIds = new Set();
        workingPages.forEach(p => allSourceIds.add(p.sourceId));
        const singleSource = allSourceIds.size === 1;
        // 複数ソース結合 (戦略B) では copyPages がしおり(目次)を引き継がない。
        // 元PDFのいずれかにしおりがある場合だけ、完了時に一言通知する (単一ソースのクローン方式では保持されるので出さない)
        const outlineLost = !singleSource && sources.some(src => allSourceIds.has(src.id) && src.hasOutline);

        for (let s = 0; s < segments.length; s++) {
          const seg = segments[s];
          setStatus(`セグメント ${s+1}/${segments.length} を組み立て中...`, 'info');
          await new Promise(r => setTimeout(r, 0));

          let outDoc;
          if (singleSource) {
            // STRATEGY A: Clone source, remove unused pages (best for pruning dead resources)
            const sourceId = [...allSourceIds][0];
            const src = sources.find(sr => sr.id === sourceId);
            // Load a fresh copy of the source document
            outDoc = await PDFDocument.load(src.buffer, { ignoreEncryption: true });

            // Determine which original page indices to keep, in what order
            const keepIndices = seg.map(p => p.sourcePageIndex);
            const numOrigPages = outDoc.getPageCount();

            // Remove pages not in the keep list (iterate from end to preserve indices)
            const keepSet = new Set(keepIndices);
            for (let i = numOrigPages - 1; i >= 0; i--) {
              if (!keepSet.has(i)) outDoc.removePage(i);
            }

            // Now outDoc has only the kept pages, but in original order.
            // We need to reorder to match seg order + apply rotations.
            // Build a map: originalIndex → current index in outDoc (after removal)
            const sortedKept = [...keepSet].sort((a, b) => a - b);
            const origToCurrent = new Map();
            sortedKept.forEach((origIdx, curIdx) => origToCurrent.set(origIdx, curIdx));

            // Get pages once, then reorder via movePage
            for (let targetIdx = 0; targetIdx < seg.length; targetIdx++) {
              const p = seg[targetIdx];
              const currentIdx = origToCurrent.get(p.sourcePageIndex);
              if (currentIdx === undefined) continue;
              // Apply rotation
              const page = outDoc.getPage(currentIdx);
              if (p.rotation) {
                const existing = page.getRotation().angle;
                page.setRotation(degrees((existing + p.rotation) % 360));
              }
            }
            // 並び順をユーザーの希望順に揃える。
            // 注意: pdf-lib 1.17.1 に movePage は存在しない(呼ぶと TypeError で生成が必ず失敗していた)。
            // removePage + insertPage の組で同じ「ページ移動」を行う(insertPage は同一文書の PDFPage を受け取れる)。
            const desiredOrder = seg.map(p => p.sourcePageIndex);
            // Only reorder if the current order differs from desired order
            const currentOrder = sortedKept.slice();
            if (desiredOrder.some((v, i) => v !== currentOrder[i])) {
              // outDoc のページは sortedKept 順で並んでいる → desiredOrder へ1枚ずつ移動
              const workingOrder = currentOrder.slice();
              for (let i = 0; i < desiredOrder.length; i++) {
                const want = desiredOrder[i];
                const curPos = workingOrder.indexOf(want);
                if (curPos !== i && curPos >= 0) {
                  const pg = outDoc.getPage(curPos);
                  outDoc.removePage(curPos);
                  outDoc.insertPage(i, pg);
                  // Update workingOrder to reflect move
                  const [moved] = workingOrder.splice(curPos, 1);
                  workingOrder.splice(i, 0, moved);
                }
              }
            }

            doneWork += seg.length;
            if (progressBar) progressBar.style.width = Math.round(doneWork / totalWork * 100) + '%';
          } else {
            // STRATEGY B: Multiple sources — use copyPages (may have some bloat from shared resources,
            // but this is the only way to combine pages from multiple PDFs)
            outDoc = await PDFDocument.create();
            const bySource = new Map();
            seg.forEach((p, localIdx) => {
              if (!bySource.has(p.sourceId)) bySource.set(p.sourceId, []);
              bySource.get(p.sourceId).push({ page: p, localIdx });
            });

            const copiedByLocalIdx = new Array(seg.length);
            for (const [sourceId, entries] of bySource) {
              const srcDoc = sourceDocsCache[sourceId];
              const indices = entries.map(e => e.page.sourcePageIndex);
              const copiedBatch = await outDoc.copyPages(srcDoc, indices);
              copiedBatch.forEach((cp, i) => {
                copiedByLocalIdx[entries[i].localIdx] = { page: entries[i].page, copied: cp };
              });
            }

            for (let i = 0; i < seg.length; i++) {
              const entry = copiedByLocalIdx[i];
              if (!entry) continue;
              const { page: p, copied } = entry;
              if (p.rotation) {
                const existing = copied.getRotation().angle;
                copied.setRotation(degrees((existing + p.rotation) % 360));
              }
              outDoc.addPage(copied);
              doneWork++;
              if (progressBar) progressBar.style.width = Math.round(doneWork / totalWork * 100) + '%';
            }
          }

          // Save with aggressive compression options
          const bytes = await outDoc.save({
            useObjectStreams: true,
            addDefaultPage: false,
            updateFieldAppearances: false
          });
          debugSizes.push(bytes.length);
          const blob = new Blob([bytes], { type: 'application/pdf' });
          outputBlobs.push(blob);
        }

        // Log for debugging (visible in browser console)
        const originalSize = Array.from(neededSourceIds).reduce((sum, id) => {
          const src = sources.find(s => s.id === id);
          return sum + (src ? src.buffer.byteLength : 0);
        }, 0);
        const totalOutSize = debugSizes.reduce((a, b) => a + b, 0);
        console.log(`[PDF Edit] 戦略: ${singleSource ? 'クローン+削除 (単一ソース)' : 'copyPages (複数ソース)'}`);
        console.log(`[PDF Edit] 元サイズ: ${(originalSize/1024/1024).toFixed(2)}MB → 出力合計: ${(totalOutSize/1024/1024).toFixed(2)}MB (${segments.length}分割)`);
        if (segments.length > 1) {
          console.log(`[PDF Edit] セグメント別サイズ:`, debugSizes.map(b => `${(b/1024/1024).toFixed(2)}MB`).join(', '));
        }

        // AUTO-COMPRESS: If splitting and toggle is on, apply photo-mode compression to each segment
        const autoCompressEnabled = outputBlobs.length > 1
          && autoCompressBtn
          && autoCompressBtn.classList.contains('active');
        let compressedInfo = null;
        if (autoCompressEnabled) {
          const beforeSize = totalOutSize;
          const compressedBlobs = [];
          const targetDpi = 150;      // balanced quality
          const jpegQuality = 0.72;   // balanced compression
          for (let i = 0; i < outputBlobs.length; i++) {
            setStatus(`分割${i+1}/${outputBlobs.length} を軽量化中...`, 'info');
            await new Promise(r => setTimeout(r, 0));
            try {
              const smallBlob = await compressPdfBlobPhotoMode(
                outputBlobs[i], targetDpi, jpegQuality,
                (pn, tot) => {
                  setStatus(`分割${i+1}/${outputBlobs.length} 軽量化中: ページ ${pn}/${tot}`, 'info');
                }
              );
              compressedBlobs.push(smallBlob);
            } catch (err) {
              console.warn(`[PDF Edit] 分割${i+1}の軽量化失敗、元データを使用:`, err);
              compressedBlobs.push(outputBlobs[i]);
            }
            if (progressBar) {
              const pct = Math.round((i + 1) / outputBlobs.length * 100);
              progressBar.style.width = pct + '%';
            }
          }
          const afterSize = compressedBlobs.reduce((a, b) => a + b.size, 0);
          compressedInfo = { beforeSize, afterSize };
          console.log(`[PDF Edit] 自動軽量化: ${(beforeSize/1024/1024).toFixed(2)}MB → ${(afterSize/1024/1024).toFixed(2)}MB`);
          // Replace outputBlobs
          outputBlobs.length = 0;
          outputBlobs.push(...compressedBlobs);
        }

        // v3.6.0: 出力前メタデータ除去 — 単一/ZIP/自動軽量化済みの全経路を一括カバー
        if (window.PdfSanitize) {
          for (let _i = 0; _i < outputBlobs.length; _i++) {
            outputBlobs[_i] = await window.PdfSanitize.process(outputBlobs[_i]);
          }
        }

        const now = new Date();
        const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        const userName = (filenameInput.value || '').trim();

        if (outputBlobs.length === 1) {
          const blob = outputBlobs[0];
          const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
          const defaultPrefix = onlySelected ? 'extracted' : 'edited';
          let finalName;
          if (userName) {
            finalName = `${appendTimestamp(userName, 'editFilenameTs')}.pdf`;
          } else {
            finalName = `${defaultPrefix}_${ts}.pdf`;
          }
          triggerDownload(blob, finalName);
          setStatus(`✓ ${workingPages.length}ページ · ${sizeMB} MB · DL完了${outlineLost ? ' — ※しおり(目次)は結合では引き継がれません' : ''}`, 'success');
          showSuccess({
            title: onlySelected ? 'ページ抽出完了' : 'PDF編集完了',
            subtitle: outlineLost ? 'ダウンロードが始まりました ※しおり(目次)は結合では引き継がれません' : 'ダウンロードが始まりました',
            stats: [
              { label: '出力ページ', value: `${workingPages.length} ページ`, highlight: true },
              { label: 'ファイルサイズ', value: `${sizeMB} MB` },
              { label: 'ファイル名', value: finalName }
            ]
          });
          successFlag = true;
        } else {
          setStatus('ZIP作成中...', 'info');
          const zip = new JSZip();
          const tsSuffix = isTimestampEnabled('editFilenameTs') ? `_${makeTimestamp()}` : '';
          outputBlobs.forEach((b, i) => {
            const partBase = userName ? `${userName}_${i+1}` : `part${i+1}`;
            zip.file(`${partBase}${tsSuffix}.pdf`, b);
          });
          const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
          const sizeMB = (zipBlob.size / (1024 * 1024)).toFixed(2);
          let zipName;
          if (userName) {
            zipName = `${appendTimestamp(userName, 'editFilenameTs')}.zip`;
          } else {
            zipName = `edited_split_${ts}.zip`;
          }
          triggerDownload(zipBlob, zipName);
          setStatus(`✓ ${outputBlobs.length}個のPDFに分割 · ZIP ${sizeMB} MB · DL完了${outlineLost ? ' — ※しおり(目次)は結合では引き継がれません' : ''}`, 'success');
          const editStats = [
            { label: '分割数', value: `${outputBlobs.length} 個`, highlight: true },
            { label: '総ページ', value: `${workingPages.length} ページ` },
            { label: 'ZIPサイズ', value: `${sizeMB} MB` }
          ];
          if (compressedInfo) {
            const reduction = Math.round((1 - compressedInfo.afterSize / compressedInfo.beforeSize) * 100);
            editStats.push({
              label: '軽量化',
              value: `-${reduction}%`,
              highlight: 'green'
            });
          }
          showSuccess({
            title: 'PDF分割完了',
            subtitle: (compressedInfo ? `${outputBlobs.length}個を軽量化してZIPでDL` : `${outputBlobs.length}個のPDFをZIPでDL`) + (outlineLost ? ' ※しおり(目次)は結合では引き継がれません' : ''),
            stats: editStats
          });
          successFlag = true;
        }
      } catch (err) {
        console.error(err);
        setStatus(`✕ エラー: ${err.message}`, 'error');
      }

      generateBtn.disabled = false;
      clearBtn.disabled = false;
      // PDF出力成功時のみ保持データを破棄 (sources/pages/splits まとめてリセット)
      if (successFlag) {
        sources = [];
        pages = [];
        splits.clear();
        render();
      }
      setTimeout(() => {
        if (progressWrap) progressWrap.classList.remove('active');
      }, 1500);
    }

    render();
  })();

  // =========================================================
  // IMG PLACE MODE (PDFに画像配置 - Phase 1 / 段階A: 基盤)
  // =========================================================
  (function imgPlaceModule() {
    'use strict';

    // ----- 状態 -----
    let basePdfBytes = null;
    let pdfjsDoc = null;
    let pageCount = 0;
    let pageSizesMm = [];
    let currentPageIndex = 0;
    let isRendering = false;
    let renderPending = false; // 描画中に来た再描画要求(後勝ちで1件だけ覚え、描画完了後に消化)
    // 画像ライブラリ: [{ id, filename, mimeType, dataUrl, originalWidthPx, originalHeightPx }]
    let imageLibrary = [];
    // 配置: [{ id, pageIndex, imageId, xMm, yMm, widthMm, heightMm, aspectLocked, caption }]
    let placements = [];
    // 選択中の placement IDs（複数選択対応）
    let selectedPlacementIds = new Set();
    // 主選択（プロパティパネル表示・リサイズハンドル表示の対象、最後にクリックしたもの）
    let selectedPlacementId = null;
    // ラバーバンド選択状態 { startXMm, startYMm, startClientX, startClientY, moved, el, addMode, lastXMm, lastYMm }
    let rubberState = null;
    let libSeq = 0;
    let plSeq = 0;
    // ライブラリからのドラッグ中の画像ID
    let draggingLibImageId = null;
    // ライブラリ複数選択 (選択順序を保持するため Array)
    let libSelectedIds = [];
    let libLastClickedId = null; // shift範囲選択の基点
    // ベース PDF ページの複数選択 (一括削除用)
    let pageSelectedIndices = new Set();
    let pageLastClickedIndex = null;
    // 順次配置モード: 選択した順に Canvas クリックで配置
    let placeQueue = [];
    let placeQueueMode = false;
    // 移動/リサイズ中のドラッグ状態
    // 形: { mode:'move'|'resize', corner?:'nw'|'ne'|'sw'|'se', placementId, startMouseXMm, startMouseYMm, original:{xMm,yMm,widthMm,heightMm} }
    let dragState = null;
    // プロパティパネルの数値入力 DOM 参照（smart-sync 用）
    let propsInputs = { x: null, y: null, w: null, h: null };
    // スナップ機能の状態
    let snapEnabled = (function() {
      try { return localStorage.getItem('imgPlaceSnapEnabled') !== 'false'; }
      catch (e) { return true; }
    })();
    // 現在表示中のスナップガイド線 [{type:'v'|'h', mm:number}, ...]
    let activeGuides = [];
    // キャプション一括フォント設定（localStorage 永続）
    let captionFont = (function() {
      try { return localStorage.getItem('imgPlaceCaptionFont') || "'Noto Sans JP', sans-serif"; }
      catch (e) { return "'Noto Sans JP', sans-serif"; }
    })();
    // PDF出力時に埋め込む日本語フォント（Noto Sans JP 固定。display 用 captionFont とは別）
    // 一度ダウンロードしたら ArrayBuffer を保持して再利用
    let cachedNotoRegular = null;
    let cachedNotoBold = null;
    // IndexedDB autosave 状態
    let autosaveBaseSha = null;            // 現在のベースPDFのSHA-256（autosave key）
    let autosaveTimer = null;              // debounce タイマー
    let cachedBasePdfBase64 = null;        // base PDF base64 のキャッシュ（autosave 性能対策）
    let autosaveBaseFilename = 'base.pdf'; // 元のファイル名（autosave 表示用）
    const AUTOSAVE_DEBOUNCE_MS = 5000;
    const IDB_DB_NAME = 'pdfCompactImgPlace';
    const IDB_STORE = 'autosave';
    // タッチ複数指追跡 + ピンチリサイズ状態
    const activeTouches = new Map(); // pointerId → { clientX, clientY, placementId }
    let pinchState = null;           // { placementId, startDistance, original: {xMm, yMm, widthMm, heightMm} }

    // ----- 定数 -----
    const PT_PER_MM = 72 / 25.4;
    const MAX_PDF_BYTES = 50 * 1024 * 1024;
    const MAX_IMG_BYTES = 20 * 1024 * 1024;
    const THUMB_SCALE = 0.28;
    const MAX_RENDER_SCALE = 4; // メモリ上限ガード（A3でも約64MB以内）
    const ACCEPTED_IMG_TYPES = ['image/jpeg', 'image/png'];
    const ACCEPTED_IMG_EXT = /\.(jpe?g|png)$/i;

    // ----- DOM -----
    const dropzone = document.getElementById('imgPlacePdfDropzone');
    const fileInput = document.getElementById('imgPlacePdfInput');
    const statusEl = document.getElementById('imgPlacePdfStatus');
    const clearBtn = document.getElementById('imgPlaceClearBtn');
    const editorPanel = document.getElementById('imgPlaceEditorPanel');
    const pageList = document.getElementById('imgPlacePageList');
    const pagesPanel = document.getElementById('imgPlacePagesPanel');
    const canvas = document.getElementById('imgPlaceCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const canvasFrame = document.getElementById('imgPlaceCanvasFrame');
    const overlay = document.getElementById('imgPlaceOverlay');
    const libDropzone = document.getElementById('imgPlaceLibDropzone');
    const libInput = document.getElementById('imgPlaceLibInput');
    const libList = document.getElementById('imgPlaceLibList');
    const libWrap = libList ? libList.closest('.imgplace-library') : null;
    const trashEl = document.getElementById('imgPlaceTrash');
    // ゴミ箱は document.body 直下に移動（ghost と同じ stacking context にして z-index を確実に効かせる）
    if (trashEl && trashEl.parentNode !== document.body) {
      document.body.appendChild(trashEl);
    }
    const snapBtn = document.getElementById('imgPlaceSnapBtn');
    const snapLabel = document.getElementById('imgPlaceSnapLabel');
    const fontSelect = document.getElementById('imgPlaceFontSelect');
    const saveProjectBtn = document.getElementById('imgPlaceSaveProjectBtn');
    const loadProjectBtn = document.getElementById('imgPlaceLoadProjectBtn');
    const loadProjectInput = document.getElementById('imgPlaceLoadProjectInput');
    const exportPdfBtn = document.getElementById('imgPlaceExportPdfBtn');
    const lineDetectBtn = document.getElementById('imgPlaceLineDetectBtn');
    const linesOverlay = document.getElementById('imgPlaceLinesOverlay');
    let lineDetectionEnabled = false;
    // 検出した罫線をスナップ対象に変換した結果（mm単位、左上原点）。OFF時は null
    // 形式: { vXsMm: [x1, x2, ...], hYsMm: [y1, y2, ...] }
    let detectedSnapTargets = null;
    // ユーザー手動定義のカスタムセル: { pageIndex: [{xMm, yMm, widthMm, heightMm}, ...] }
    let customCellsByPage = {};
    let customCellModeOn = false;
    // 画像配置時のサイズ上限 (ページ 1/3) を効かせるか。localStorage 永続化、デフォルト ON
    let sizeCapEnabled = true;
    try {
      const saved = localStorage.getItem('imgPlaceSizeCap');
      if (saved === 'off') sizeCapEnabled = false;
    } catch (_e) {}
    // スナップ中のセル (緑外枠ハイライト用)
    let activeSnapCell = null;
    // カスタムセル描画中の state
    let customCellDrawState = null;
    const metaEl = document.getElementById('imgPlaceMeta');
    const filenameBar = document.getElementById('imgPlaceFilenameBar');
    const actionBar = document.getElementById('imgPlaceActionBar');

    if (!dropzone || !canvas) return; // パネル未配置時は無効化

    // ----- 単位変換 -----
    function ptToMm(pt) { return pt / PT_PER_MM; }
    // mmToPt は段階E (PDF出力) で使用予定

    // ----- ステータス表示 -----
    function setStatus(text, type) {
      if (statusEl) {
        if (!text) {
          statusEl.style.display = 'none';
          statusEl.textContent = '';
          statusEl.classList.remove('error');
        } else {
          statusEl.style.display = '';
          statusEl.textContent = text;
          statusEl.classList.toggle('error', type === 'error');
        }
      }
      // ミラー: アクションバー中央 (罫線スナップなど検出結果が常時見える位置)
      const abs = document.getElementById('imgPlaceActionBarStatus');
      if (abs) {
        abs.textContent = text || '';
        abs.classList.toggle('visible', !!text);
        abs.classList.toggle('error', type === 'error');
        abs.classList.toggle('success', type === 'success' || type === 'done');
      }
    }

    // ----- クリア（やり直し） -----
    function clearBase() {
      basePdfBytes = null;
      pdfjsDoc = null;
      pageCount = 0;
      pageSizesMm = [];
      currentPageIndex = 0;
      imageLibrary = [];
      placements = [];
      clearSelection();
      if (dragState && dragState.ghost) destroyDragGhost(dragState.ghost);
      dragState = null;
      activeGuides = [];
      // autosave 状態リセット
      cancelAutosaveTimer();
      autosaveBaseSha = null;
      autosaveBaseFilename = 'base.pdf';
      cachedBasePdfBase64 = null;
      if (rubberState && rubberState.el && rubberState.el.parentNode) {
        rubberState.el.parentNode.removeChild(rubberState.el);
      }
      rubberState = null;
      if (pageList) pageList.innerHTML = '';
      if (libList) libList.innerHTML = '';
      if (overlay) overlay.innerHTML = '';
      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
      }
      if (metaEl) metaEl.textContent = '';
      if (editorPanel) editorPanel.style.display = 'none';
      if (filenameBar) filenameBar.style.display = 'none';
      if (actionBar) actionBar.style.display = 'none';
      // 編集モード OFF: hero+upload panel 再表示
      const modeImgPlaceEl = document.getElementById('modeImgPlace');
      if (modeImgPlaceEl) modeImgPlaceEl.classList.remove('imgplace-editing');
      hideTrash();
      const modePanel = document.getElementById('modeImgPlace');
      if (modePanel) modePanel.classList.remove('imgplace-dragging');
      // Lv.2: 罫線スナップ状態もリセット
      detectedSnapTargets = null;
      if (linesOverlay) {
        while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
        linesOverlay.classList.remove('visible');
      }
      if (lineDetectionEnabled && lineDetectBtn) {
        lineDetectionEnabled = false;
        lineDetectBtn.dataset.active = 'off';
        lineDetectBtn.textContent = '📐 罫線スナップ OFF';
      }
      // カスタムセル + ハイライト + アライメントガイドもリセット
      customCellsByPage = {};
      activeSnapCell = null;
      updateActiveSnapCellOverlay();
      clearAlignmentGuides();
      // ライブラリ複数選択 + 順次配置モードもリセット
      libSelectedIds = [];
      libLastClickedId = null;
      if (placeQueueMode) stopPlaceQueueMode();
      updatePlaceQueueBtn();
      // ベースPDFページ複数選択もリセット
      pageSelectedIndices.clear();
      pageLastClickedIndex = null;
      const customCellLayer = document.getElementById('imgPlaceCustomCellLayer');
      if (customCellLayer) customCellLayer.innerHTML = '';
      const customCellBtn = document.getElementById('imgPlaceCustomCellBtn');
      if (customCellModeOn && customCellBtn) {
        customCellModeOn = false;
        customCellBtn.dataset.active = 'off';
        customCellBtn.textContent = '✏️ カスタムセル OFF';
        if (customCellLayer) customCellLayer.classList.remove('active');
      }
      setStatus('');
    }

    // ----- ベースPDF読込 (初回は新規読込、2回目以降は末尾に追加) -----
    async function loadBasePdf(file) {
      if (!file) return;
      if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
        setStatus('PDFファイルを選んでください', 'error');
        return;
      }
      if (file.size > MAX_PDF_BYTES) {
        setStatus('PDFサイズが50MBを超えています（' + (file.size / 1024 / 1024).toFixed(1) + 'MB）', 'error');
        return;
      }
      const isAppend = !!basePdfBytes;
      setStatus(isAppend ? '末尾にページ追加中…' : '読み込み中…');
      try {
        const newBytes = await file.arrayBuffer();
        let addedPageCount = 0;
        if (isAppend) {
          // pdf-lib で 既存PDF に新PDF のページを末尾追加
          const PDFLib = window.PDFLib;
          if (!PDFLib || !PDFLib.PDFDocument) throw new Error('pdf-lib が利用不可');
          const existingDoc = await PDFLib.PDFDocument.load(basePdfBytes);
          const newDoc = await PDFLib.PDFDocument.load(newBytes);
          const copiedPages = await existingDoc.copyPages(newDoc, newDoc.getPageIndices());
          addedPageCount = copiedPages.length;
          for (const pg of copiedPages) existingDoc.addPage(pg);
          basePdfBytes = (await existingDoc.save()).buffer;
        } else {
          basePdfBytes = newBytes;
        }
        // pdf.js は ArrayBuffer を内部で消費するためスライスして渡す
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        const oldPageCount = pageCount;
        pageCount = pdfjsDoc.numPages;
        pageSizesMm = [];

        for (let i = 1; i <= pageCount; i++) {
          const p = await pdfjsDoc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          pageSizesMm.push({
            width: ptToMm(vp.width),
            height: ptToMm(vp.height)
          });
        }

        if (!isAppend) {
          currentPageIndex = 0;
          editorPanel.style.display = '';
          filenameBar.style.display = '';
          actionBar.style.display = '';
          // 編集モード ON: hero+upload panel を CSS で隠して editor が viewport 上部に
          const modeImgPlaceEl = document.getElementById('modeImgPlace');
          if (modeImgPlaceEl) modeImgPlaceEl.classList.add('imgplace-editing');
        }
        // autosave 状態を準備（base64 キャッシュは初回 serialize 時に作る）
        cachedBasePdfBase64 = null;
        if (!isAppend) autosaveBaseFilename = file.name || 'base.pdf';
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        renderLibrary(); // 初期表示時に「画像なし」状態クラスを反映
        await renderThumbnails();
        await renderCurrentPage();
        updateMeta(autosaveBaseFilename);
        if (isAppend) {
          setStatus('「' + file.name + '」の ' + addedPageCount + ' ページを末尾に追加 (合計 ' + pageCount + ' ページ)');
          // 追加後の最初のページにジャンプ
          if (oldPageCount < pageCount) {
            currentPageIndex = oldPageCount;
            await renderCurrentPage();
            // サムネ active 更新
            pageList.querySelectorAll('.page-thumb-wrap').forEach((el, idx) => {
              el.classList.toggle('active', idx === currentPageIndex);
            });
          }
          scheduleAutosave();
        } else {
          setStatus(file.name + ' を読み込みました（' + pageCount + 'ページ）');
        }
        // 初回ロードのみ: スクロール + 復元提案
        if (!isAppend) {
          requestAnimationFrame(() => {
            editorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          const shaForRestore = autosaveBaseSha;
          setTimeout(() => { checkAndOfferRestore(shaForRestore); }, 100);
        }
      } catch (err) {
        console.error('[imgPlace] PDF読込失敗:', err);
        setStatus('PDF読込に失敗しました: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    // ----- ページ削除 (pdf-lib で removePage → placements/customCells インデックス再マップ) -----
    async function deletePage(pageIndex) {
      if (!basePdfBytes) {
        setStatus('PDFが読み込まれていません', 'error');
        return;
      }
      if (pageCount <= 1) {
        setStatus('最後の1ページは削除できません', 'error');
        return;
      }
      const placementsOnThis = placements.filter(p => p.pageIndex === pageIndex).length;
      const cellsOnThis = (customCellsByPage[pageIndex] || []).length;
      let msg = 'ページ ' + (pageIndex + 1) + ' を削除しますか?';
      if (placementsOnThis || cellsOnThis) {
        msg += '\n(配置画像 ' + placementsOnThis + ' 枚 / カスタムセル ' + cellsOnThis + ' 個 もまとめて削除)';
      }
      if (!confirm(msg)) return;
      try {
        const PDFLib = window.PDFLib;
        if (!PDFLib || !PDFLib.PDFDocument) throw new Error('pdf-lib 未読込');
        const doc = await PDFLib.PDFDocument.load(basePdfBytes);
        doc.removePage(pageIndex);
        basePdfBytes = (await doc.save()).buffer;
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        pageCount = pdfjsDoc.numPages;
        pageSizesMm.splice(pageIndex, 1);

        // 配置画像: 削除ページ上のものは破棄、それ以降のページはインデックス -1
        placements = placements
          .filter(p => p.pageIndex !== pageIndex)
          .map(p => p.pageIndex > pageIndex ? Object.assign({}, p, { pageIndex: p.pageIndex - 1 }) : p);

        // カスタムセル: 削除ページのキーを除外、それ以降のキーを -1 シフト
        const newCells = {};
        for (const k of Object.keys(customCellsByPage)) {
          const ki = parseInt(k, 10);
          if (ki === pageIndex) continue;
          newCells[ki > pageIndex ? ki - 1 : ki] = customCellsByPage[k];
        }
        customCellsByPage = newCells;

        // currentPageIndex 調整
        if (currentPageIndex === pageIndex) {
          currentPageIndex = Math.min(pageIndex, pageCount - 1);
        } else if (currentPageIndex > pageIndex) {
          currentPageIndex -= 1;
        }

        clearSelection();
        cachedBasePdfBase64 = null;
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        await renderThumbnails();
        await renderCurrentPage();
        setStatus('ページ ' + (pageIndex + 1) + ' を削除 (残り ' + pageCount + ' ページ)');
        scheduleAutosave();
      } catch (err) {
        console.error('[imgPlace] ページ削除失敗:', err);
        setStatus('ページ削除失敗: ' + (err.message || err), 'error');
      }
    }

    // ----- メタ情報 -----
    function updateMeta(filename) {
      if (!metaEl) return;
      const cur = pageSizesMm[currentPageIndex];
      if (!cur) {
        metaEl.textContent = '';
        return;
      }
      metaEl.textContent =
        'ファイル: ' + (filename || '(現在のPDF)') +
        ' | ページ: ' + (currentPageIndex + 1) + ' / ' + pageCount +
        ' | サイズ: ' + cur.width.toFixed(1) + ' × ' + cur.height.toFixed(1) + ' mm';
    }

    // ----- PoC: pdf.js page から罫線抽出（CTM追跡 + curve飛ばし + 極小線フィルタ） -----
    // OPS.save/restore/transform で current transformation matrix (CTM) を維持
    // OPS.constructPath の中の moveTo/lineTo/curve*/rectangle/closePath を順に解析
    // 抽出した line/rect は CTM を適用してユーザー空間（pt）座標に変換
    // 最後に極小線（< 2pt ≈ 0.7mm）はノイズ扱いで除外
    async function extractPageLines(page) {
      const opList = await page.getOperatorList();
      const OPS = pdfjsLib.OPS;
      const lines = [];
      const rects = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const mul = (m1, m2) => [
        m1[0]*m2[0] + m1[2]*m2[1],
        m1[1]*m2[0] + m1[3]*m2[1],
        m1[0]*m2[2] + m1[2]*m2[3],
        m1[1]*m2[2] + m1[3]*m2[3],
        m1[0]*m2[4] + m1[2]*m2[5] + m1[4],
        m1[1]*m2[4] + m1[3]*m2[5] + m1[5]
      ];
      const apply = (x, y) => [
        ctm[0]*x + ctm[2]*y + ctm[4],
        ctm[1]*x + ctm[3]*y + ctm[5]
      ];

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPS.save) {
          stack.push(ctm.slice());
        } else if (fn === OPS.restore) {
          if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.transform) {
          ctm = mul(ctm, args);
        } else if (fn === OPS.constructPath) {
          const ops = args[0];
          const opArgs = args[1];
          let argIdx = 0;
          let curX = 0, curY = 0;
          for (const op of ops) {
            if (op === OPS.moveTo) {
              curX = opArgs[argIdx++];
              curY = opArgs[argIdx++];
            } else if (op === OPS.lineTo) {
              const x = opArgs[argIdx++];
              const y = opArgs[argIdx++];
              const [tx1, ty1] = apply(curX, curY);
              const [tx2, ty2] = apply(x, y);
              lines.push({ x1: tx1, y1: ty1, x2: tx2, y2: ty2 });
              curX = x; curY = y;
            } else if (op === OPS.curveTo) {
              argIdx += 6; // 3 control pts + endpoint
              curX = opArgs[argIdx-2]; curY = opArgs[argIdx-1];
            } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
              argIdx += 4;
              curX = opArgs[argIdx-2]; curY = opArgs[argIdx-1];
            } else if (op === OPS.closePath) {
              // no args
            } else if (op === OPS.rectangle) {
              const x = opArgs[argIdx++];
              const y = opArgs[argIdx++];
              const w = opArgs[argIdx++];
              const h = opArgs[argIdx++];
              const [tx1, ty1] = apply(x, y);
              const [tx2, ty2] = apply(x + w, y + h);
              rects.push({
                x: Math.min(tx1, tx2),
                y: Math.min(ty1, ty2),
                w: Math.abs(tx2 - tx1),
                h: Math.abs(ty2 - ty1)
              });
            } else {
              // 未対応 op が来た時点で path 終了（args 数不明のため）
              break;
            }
          }
        }
      }

      // ノイズ除去: 10mm未満の短い線は装飾(ロゴ・テキスト等)とみなして罫線扱いしない
      // ※セル最小サイズ MIN_CELL_SIZE_MM=15mm より小さく取って、セル境界は確実に拾う
      const MIN_LEN_PT = 10 * (72 / 25.4); // 10mm ≒ 28.35pt
      const filtered = lines.filter(l => {
        const dx = l.x2 - l.x1;
        const dy = l.y2 - l.y1;
        return Math.sqrt(dx*dx + dy*dy) >= MIN_LEN_PT;
      });
      return { lines: filtered, rects: rects, totalLinesBeforeFilter: lines.length };
    }

    // ----- セル系ヘルパー（検出セル + カスタムセルの統合 + ハイライト） -----
    // 現ページで snap 対象になる「セル」を全部返す（検出 + カスタム）
    function getActiveCells() {
      const out = [];
      if (detectedSnapTargets && Array.isArray(detectedSnapTargets.cellCentersMm)) {
        for (const c of detectedSnapTargets.cellCentersMm) out.push(c);
      }
      const custom = customCellsByPage[currentPageIndex];
      if (custom) for (const c of custom) out.push(c);
      return out;
    }
    // カスタムセル編集時に1点 (xMm, yMm) を検出罫線へスナップ
    // detectedSnapTargets が無い時はそのまま返す
    function snapPointToDetectedLines(xMm, yMm) {
      if (!detectedSnapTargets) return { xMm: xMm, yMm: yMm };
      const threshold = (typeof getSnapThresholdMm === 'function') ? getSnapThresholdMm() : 3.0;
      let outX = xMm, outY = yMm;
      let bestDx = threshold, bestDy = threshold;
      const vXs = detectedSnapTargets.vXsMm || [];
      const hYs = detectedSnapTargets.hYsMm || [];
      for (let i = 0; i < vXs.length; i++) {
        const d = Math.abs(vXs[i] - xMm);
        if (d <= bestDx) { bestDx = d; outX = vXs[i]; }
      }
      for (let i = 0; i < hYs.length; i++) {
        const d = Math.abs(hYs[i] - yMm);
        if (d <= bestDy) { bestDy = d; outY = hYs[i]; }
      }
      return { xMm: outX, yMm: outY };
    }

    // カスタムセル編集 (描画/移動/リサイズ) の統合スナップ
    //   xCands: スナップを検討する X 座標群 (例: 移動中なら [xL, xR, xC])
    //   yCands: 同様の Y 座標群
    //   excludeCell: 自分自身は他セルから除外
    // 戻り値: { dx, dy, vGuide, hGuide }
    //   vGuide: { xMm, sources:[{srcRange:[yT,yB]|null}, ...] } | null
    //   hGuide: { yMm, sources:[{srcRange:[xL,xR]|null}, ...] } | null
    //   srcRange=null は「検出罫線(全頁線)」を意味する
    function computeCustomCellSnap(xCands, yCands, excludeCell) {
      const threshold = (typeof getSnapThresholdMm === 'function') ? getSnapThresholdMm() : 3.0;
      const otherCells = (customCellsByPage[currentPageIndex] || []).filter(c => c !== excludeCell);
      // V targets (X 値とソース範囲)
      const vTargets = [];
      if (detectedSnapTargets) {
        for (const x of (detectedSnapTargets.vXsMm || [])) vTargets.push({ xMm: x, srcRange: null });
      }
      for (const oc of otherCells) {
        const xL = oc.xMm - oc.widthMm / 2;
        const xR = oc.xMm + oc.widthMm / 2;
        const yT = oc.yMm - oc.heightMm / 2;
        const yB = oc.yMm + oc.heightMm / 2;
        vTargets.push({ xMm: xL, srcRange: [yT, yB] });
        vTargets.push({ xMm: xR, srcRange: [yT, yB] });
        vTargets.push({ xMm: oc.xMm, srcRange: [yT, yB] });
      }
      // H targets
      const hTargets = [];
      if (detectedSnapTargets) {
        for (const y of (detectedSnapTargets.hYsMm || [])) hTargets.push({ yMm: y, srcRange: null });
      }
      for (const oc of otherCells) {
        const xL = oc.xMm - oc.widthMm / 2;
        const xR = oc.xMm + oc.widthMm / 2;
        const yT = oc.yMm - oc.heightMm / 2;
        const yB = oc.yMm + oc.heightMm / 2;
        hTargets.push({ yMm: yT, srcRange: [xL, xR] });
        hTargets.push({ yMm: yB, srcRange: [xL, xR] });
        hTargets.push({ yMm: oc.yMm, srcRange: [xL, xR] });
      }
      // V スナップ best
      let bestDx = null, bestVCoord = null, bestVSources = [];
      for (const xc of xCands) {
        for (const t of vTargets) {
          const d = t.xMm - xc;
          const ad = Math.abs(d);
          if (ad > threshold) continue;
          if (bestDx === null || ad < Math.abs(bestDx) - 1e-6) {
            bestDx = d; bestVCoord = t.xMm; bestVSources = [t];
          } else if (Math.abs(t.xMm - (bestVCoord || 0)) < 0.01) {
            bestVSources.push(t);
          }
        }
      }
      // H スナップ best
      let bestDy = null, bestHCoord = null, bestHSources = [];
      for (const yc of yCands) {
        for (const t of hTargets) {
          const d = t.yMm - yc;
          const ad = Math.abs(d);
          if (ad > threshold) continue;
          if (bestDy === null || ad < Math.abs(bestDy) - 1e-6) {
            bestDy = d; bestHCoord = t.yMm; bestHSources = [t];
          } else if (Math.abs(t.yMm - (bestHCoord || 0)) < 0.01) {
            bestHSources.push(t);
          }
        }
      }
      return {
        dx: bestDx || 0,
        dy: bestDy || 0,
        vGuide: bestVCoord !== null ? { xMm: bestVCoord, sources: bestVSources } : null,
        hGuide: bestHCoord !== null ? { yMm: bestHCoord, sources: bestHSources } : null
      };
    }

    // アライメントガイド SVG への描画 / クリア
    // movingRect: { xL, xR, yT, yB } — 編集中セルの範囲（ガイド線がそこも通るように長さ算出）
    function renderAlignmentGuides(vGuide, hGuide, movingRect) {
      const svg = document.getElementById('imgPlaceAlignGuides');
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      svg.setAttribute('viewBox', '0 0 ' + pageSize.width + ' ' + pageSize.height);
      const svgNs = 'http://www.w3.org/2000/svg';
      const DOT_R = 1.4; // mm

      if (vGuide) {
        let yMin = movingRect.yT, yMax = movingRect.yB;
        let fullPage = false;
        const dotYs = [movingRect.yT, movingRect.yB];
        for (const s of vGuide.sources) {
          if (!s.srcRange) { fullPage = true; }
          else {
            yMin = Math.min(yMin, s.srcRange[0]);
            yMax = Math.max(yMax, s.srcRange[1]);
            dotYs.push(s.srcRange[0], s.srcRange[1]);
          }
        }
        if (fullPage) { yMin = 0; yMax = pageSize.height; }
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', vGuide.xMm); line.setAttribute('y1', yMin);
        line.setAttribute('x2', vGuide.xMm); line.setAttribute('y2', yMax);
        line.setAttribute('class', 'align-line');
        svg.appendChild(line);
        for (const y of dotYs) {
          const c = document.createElementNS(svgNs, 'circle');
          c.setAttribute('cx', vGuide.xMm); c.setAttribute('cy', y);
          c.setAttribute('r', DOT_R);
          c.setAttribute('class', 'align-dot');
          svg.appendChild(c);
        }
      }
      if (hGuide) {
        let xMin = movingRect.xL, xMax = movingRect.xR;
        let fullPage = false;
        const dotXs = [movingRect.xL, movingRect.xR];
        for (const s of hGuide.sources) {
          if (!s.srcRange) { fullPage = true; }
          else {
            xMin = Math.min(xMin, s.srcRange[0]);
            xMax = Math.max(xMax, s.srcRange[1]);
            dotXs.push(s.srcRange[0], s.srcRange[1]);
          }
        }
        if (fullPage) { xMin = 0; xMax = pageSize.width; }
        const line = document.createElementNS(svgNs, 'line');
        line.setAttribute('x1', xMin); line.setAttribute('y1', hGuide.yMm);
        line.setAttribute('x2', xMax); line.setAttribute('y2', hGuide.yMm);
        line.setAttribute('class', 'align-line');
        svg.appendChild(line);
        for (const x of dotXs) {
          const c = document.createElementNS(svgNs, 'circle');
          c.setAttribute('cx', x); c.setAttribute('cy', hGuide.yMm);
          c.setAttribute('r', DOT_R);
          c.setAttribute('class', 'align-dot');
          svg.appendChild(c);
        }
      }
    }
    function clearAlignmentGuides() {
      const svg = document.getElementById('imgPlaceAlignGuides');
      if (!svg) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    // スナップハイライト用: activeSnapCell を canvas-frame 上のオーバーレイ div に反映
    function updateActiveSnapCellOverlay() {
      const el = document.getElementById('imgPlaceActiveSnapCell');
      if (!el) return;
      if (!activeSnapCell) {
        el.style.display = 'none';
        return;
      }
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) { el.style.display = 'none'; return; }
      const c = activeSnapCell;
      const xL = c.xMm - c.widthMm / 2;
      const yT = c.yMm - c.heightMm / 2;
      el.style.display = '';
      el.style.left   = (xL / pageSize.width  * 100) + '%';
      el.style.top    = (yT / pageSize.height * 100) + '%';
      el.style.width  = (c.widthMm  / pageSize.width  * 100) + '%';
      el.style.height = (c.heightMm / pageSize.height * 100) + '%';
    }
    // カスタムセル個別の DOM 更新ヘルパー (リサイズ/移動中の頻繁更新で再描画を避けるため)
    function updateCustomCellDom(div, c) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const xL = c.xMm - c.widthMm / 2;
      const yT = c.yMm - c.heightMm / 2;
      div.style.left   = (xL / pageSize.width  * 100) + '%';
      div.style.top    = (yT / pageSize.height * 100) + '%';
      div.style.width  = (c.widthMm  / pageSize.width  * 100) + '%';
      div.style.height = (c.heightMm / pageSize.height * 100) + '%';
    }

    // カスタムセル: 編集 state (移動 / リサイズ)
    let customCellEditState = null; // { mode:'move'|'resize', cell, div, original, corner?, startXMm, startYMm, moved:bool }

    // カスタムセルを div として描画（編集モード ON 時はハンドル + × ボタン）
    function renderCustomCells() {
      const layer = document.getElementById('imgPlaceCustomCellLayer');
      if (!layer) return;
      // 描画中プレビューだけは保持
      const preview = layer.querySelector('.imgplace-custom-cell-preview');
      layer.innerHTML = '';
      if (preview) layer.appendChild(preview);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const cells = customCellsByPage[currentPageIndex] || [];
      for (const c of cells) {
        const div = document.createElement('div');
        div.className = 'imgplace-custom-cell';
        updateCustomCellDom(div, c);
        div.title = customCellModeOn ? 'ドラッグで移動 / 隅を引っ張ってリサイズ / × で削除' : '';

        // ----- 本体ドラッグ = 移動 -----
        div.addEventListener('pointerdown', (e) => {
          if (!customCellModeOn) return;
          // ハンドルや×は別 handler が stopPropagation で先取り
          if (e.target !== div) return;
          e.preventDefault();
          e.stopPropagation();
          customCellEditState = {
            mode: 'move',
            cell: c,
            div: div,
            original: { xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm },
            startXMm: 0, startYMm: 0,
            moved: false
          };
          const start = getPagePosMm(e.clientX, e.clientY);
          if (start) {
            customCellEditState.startXMm = start.xMm;
            customCellEditState.startYMm = start.yMm;
          }
          try { div.setPointerCapture(e.pointerId); } catch (_e) {}
        });

        // ----- 4隅ハンドル: リサイズ -----
        ['nw','ne','sw','se'].forEach((corner) => {
          const h = document.createElement('div');
          h.className = 'imgplace-custom-cell-handle handle-' + corner;
          h.dataset.corner = corner;
          h.addEventListener('pointerdown', (e) => {
            if (!customCellModeOn) return;
            e.preventDefault();
            e.stopPropagation();
            customCellEditState = {
              mode: 'resize',
              cell: c,
              div: div,
              original: { xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm },
              corner: corner,
              startXMm: 0, startYMm: 0,
              moved: false
            };
            const start = getPagePosMm(e.clientX, e.clientY);
            if (start) {
              customCellEditState.startXMm = start.xMm;
              customCellEditState.startYMm = start.yMm;
            }
            try { h.setPointerCapture(e.pointerId); } catch (_e) {}
          });
          div.appendChild(h);
        });

        // ----- + 複製ボタン -----
        const copyBtn = document.createElement('div');
        copyBtn.className = 'imgplace-custom-cell-copy';
        copyBtn.textContent = '+';
        copyBtn.title = '複製';
        copyBtn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
        });
        copyBtn.addEventListener('click', (e) => {
          if (!customCellModeOn) return;
          e.stopPropagation();
          const pageSize = pageSizesMm[currentPageIndex];
          if (!pageSize) return;
          const OFFSET_MM = 5;
          const halfW = c.widthMm / 2;
          const halfH = c.heightMm / 2;
          // デフォルトで右下にオフセット、ページ外なら左上方向に反転
          let nx = c.xMm + OFFSET_MM;
          let ny = c.yMm + OFFSET_MM;
          if (nx + halfW > pageSize.width)  nx = c.xMm - OFFSET_MM;
          if (ny + halfH > pageSize.height) ny = c.yMm - OFFSET_MM;
          // ページ内 clamp
          nx = Math.max(halfW, Math.min(nx, pageSize.width  - halfW));
          ny = Math.max(halfH, Math.min(ny, pageSize.height - halfH));
          if (!customCellsByPage[currentPageIndex]) customCellsByPage[currentPageIndex] = [];
          customCellsByPage[currentPageIndex].push({
            xMm: nx, yMm: ny,
            widthMm: c.widthMm, heightMm: c.heightMm
          });
          renderCustomCells();
          scheduleAutosave && scheduleAutosave();
          setStatus('カスタムセル複製（合計 ' + customCellsByPage[currentPageIndex].length + ' 個）');
        });
        div.appendChild(copyBtn);

        // ----- × 削除ボタン -----
        const delBtn = document.createElement('div');
        delBtn.className = 'imgplace-custom-cell-delete';
        delBtn.textContent = '×';
        delBtn.title = '削除';
        delBtn.addEventListener('pointerdown', (e) => {
          // 移動 handler を発火させない
          e.stopPropagation();
        });
        delBtn.addEventListener('click', (e) => {
          if (!customCellModeOn) return;
          e.stopPropagation();
          const arr = customCellsByPage[currentPageIndex];
          if (!arr) return;
          const idx = arr.indexOf(c);
          if (idx !== -1) {
            arr.splice(idx, 1);
            if (arr.length === 0) delete customCellsByPage[currentPageIndex];
            renderCustomCells();
            scheduleAutosave && scheduleAutosave();
            setStatus('カスタムセル削除（残り ' + (arr.length) + ' 個）');
          }
        });
        div.appendChild(delBtn);

        layer.appendChild(div);
      }
    }

    // カスタムセル: 編集 (move/resize) のグローバル pointermove/up handler
    // div.setPointerCapture を使うので window 不要だが、保険で window でも捕捉
    function handleCustomCellEditMove(e) {
      if (!customCellEditState) return;
      const cur = getPagePosMm(e.clientX, e.clientY);
      if (!cur) return;
      const st = customCellEditState;
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return;
      const MIN = 5; // 最小辺
      if (st.mode === 'move') {
        const dx = cur.xMm - st.startXMm;
        const dy = cur.yMm - st.startYMm;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) st.moved = true;
        let newCx = st.original.xMm + dx;
        let newCy = st.original.yMm + dy;
        // スナップ候補: 中心 + 4辺 (xL/xR/yT/yB) どれが揃ってもOK
        const halfW = st.cell.widthMm / 2;
        const halfH = st.cell.heightMm / 2;
        const xCands = [newCx - halfW, newCx + halfW, newCx];
        const yCands = [newCy - halfH, newCy + halfH, newCy];
        const snap = computeCustomCellSnap(xCands, yCands, st.cell);
        newCx += snap.dx;
        newCy += snap.dy;
        // ページ範囲内 clamp
        newCx = Math.max(halfW, Math.min(newCx, pageSize.width  - halfW));
        newCy = Math.max(halfH, Math.min(newCy, pageSize.height - halfH));
        st.cell.xMm = newCx;
        st.cell.yMm = newCy;
        updateCustomCellDom(st.div, st.cell);
        // ガイド線描画 (移動後 rect 範囲を渡す)
        renderAlignmentGuides(snap.vGuide, snap.hGuide, {
          xL: newCx - halfW, xR: newCx + halfW,
          yT: newCy - halfH, yB: newCy + halfH
        });
      } else if (st.mode === 'resize') {
        st.moved = true;
        const o = st.original;
        let xL = o.xMm - o.widthMm / 2;
        let xR = o.xMm + o.widthMm / 2;
        let yT = o.yMm - o.heightMm / 2;
        let yB = o.yMm + o.heightMm / 2;
        // 引いてる点を統合スナップ
        const snap = computeCustomCellSnap([cur.xMm], [cur.yMm], st.cell);
        const nx = cur.xMm + snap.dx;
        const ny = cur.yMm + snap.dy;
        const c = st.corner;
        if (c === 'nw') { xL = Math.min(nx, xR - MIN); yT = Math.min(ny, yB - MIN); }
        if (c === 'ne') { xR = Math.max(nx, xL + MIN); yT = Math.min(ny, yB - MIN); }
        if (c === 'sw') { xL = Math.min(nx, xR - MIN); yB = Math.max(ny, yT + MIN); }
        if (c === 'se') { xR = Math.max(nx, xL + MIN); yB = Math.max(ny, yT + MIN); }
        // ページ範囲内 clamp
        xL = Math.max(0, xL); yT = Math.max(0, yT);
        xR = Math.min(pageSize.width,  xR); yB = Math.min(pageSize.height, yB);
        st.cell.xMm = (xL + xR) / 2;
        st.cell.yMm = (yT + yB) / 2;
        st.cell.widthMm  = xR - xL;
        st.cell.heightMm = yB - yT;
        updateCustomCellDom(st.div, st.cell);
        // ガイド線描画 (リサイズ後 rect 範囲を渡す)
        renderAlignmentGuides(snap.vGuide, snap.hGuide, { xL, xR, yT, yB });
      }
    }
    function handleCustomCellEditEnd(e) {
      if (!customCellEditState) return;
      const wasMoved = customCellEditState.moved;
      const mode = customCellEditState.mode;
      customCellEditState = null;
      clearAlignmentGuides();
      if (wasMoved) {
        scheduleAutosave && scheduleAutosave();
        setStatus(mode === 'move' ? 'カスタムセル移動完了' : 'カスタムセルサイズ変更');
      }
    }
    // window レベルで補足（capture 漏れ対策）
    window.addEventListener('pointermove', handleCustomCellEditMove);
    window.addEventListener('pointerup',   handleCustomCellEditEnd);
    window.addEventListener('pointercancel', handleCustomCellEditEnd);

    // ----- Lv.2: 検出した線/矩形 → スナップ対象 (mm, 左上原点) に変換 -----
    // pdf座標 (pt, 左下原点) → 内部座標 (mm, 左上原点) 変換
    // 水平/垂直線のみ採用（斜め線は無視、0.5pt 以内の傾きは平行扱い）
    // 矩形は4辺すべてエッジを採用
    // セル検出: H/V 線の grid 候補ペアごとに4辺すべて実線で覆われてるかチェック
    // dedup: 0.3mm 以内は同一視（targets配列の爆発を防ぐ）
    function buildDetectedSnapTargets(lineData, page) {
      const baseViewport = page.getViewport({ scale: 1 });
      const pageHeightPt = baseViewport.height;
      const pageHeightMm = ptToMm(pageHeightPt);
      const PARALLEL_TOL_PT = 0.5; // 平行線判定の許容（傾き）
      const DEDUP_TOL_MM = 0.3;    // 重複除去の許容
      // typed lines (mm, 左上原点)
      const hLines = []; // { yMm, xMinMm, xMaxMm }
      const vLines = []; // { xMm, yMinMm, yMaxMm }

      for (const ln of lineData.lines) {
        const dx = Math.abs(ln.x2 - ln.x1);
        const dy = Math.abs(ln.y2 - ln.y1);
        if (dx <= PARALLEL_TOL_PT && dy > PARALLEL_TOL_PT) {
          // 縦線
          const xMm = ptToMm((ln.x1 + ln.x2) / 2);
          // y軸反転後は y1/y2 の min/max が逆転することに注意 → ptToMm + flip 後に min/max
          const yA = pageHeightMm - ptToMm(ln.y1);
          const yB = pageHeightMm - ptToMm(ln.y2);
          vLines.push({ xMm, yMinMm: Math.min(yA, yB), yMaxMm: Math.max(yA, yB) });
        } else if (dy <= PARALLEL_TOL_PT && dx > PARALLEL_TOL_PT) {
          // 横線（PDF y は下原点 → 上原点）
          const yPt = (ln.y1 + ln.y2) / 2;
          const yMm = pageHeightMm - ptToMm(yPt);
          const xA = ptToMm(ln.x1);
          const xB = ptToMm(ln.x2);
          hLines.push({ yMm, xMinMm: Math.min(xA, xB), xMaxMm: Math.max(xA, xB) });
        }
      }
      // 矩形の4辺も同様に typed line として登録
      for (const r of lineData.rects) {
        const xL = ptToMm(r.x);
        const xR = ptToMm(r.x + r.w);
        const yTop = pageHeightMm - ptToMm(r.y + r.h);
        const yBot = pageHeightMm - ptToMm(r.y);
        hLines.push({ yMm: yTop, xMinMm: xL, xMaxMm: xR });
        hLines.push({ yMm: yBot, xMinMm: xL, xMaxMm: xR });
        vLines.push({ xMm: xL, yMinMm: yTop, yMaxMm: yBot });
        vLines.push({ xMm: xR, yMinMm: yTop, yMaxMm: yBot });
      }
      // dedup（ソートして近接値を間引き）
      const dedup = (arr, tol) => {
        const sorted = arr.slice().sort((a, b) => a - b);
        const out = [];
        for (const v of sorted) {
          if (out.length === 0 || Math.abs(v - out[out.length - 1]) > tol) {
            out.push(v);
          }
        }
        return out;
      };
      const vXsMm = dedup(vLines.map(l => l.xMm), DEDUP_TOL_MM);
      const hYsMm = dedup(hLines.map(l => l.yMm), DEDUP_TOL_MM);

      // ----- セル検出 (all-pairs + 複数segment union coverage + leaf filter + min area) -----
      // 隣接 grid だけだと、grid に細かい分割線 (ラベル枠の letter/code 分割線等) があるとき
      // 大きい画像セルが「複数 grid 跨ぐ」せいで検出できない。
      // → i < i' と j < j' の全組合せをチェック (軸別バケットで高速化)
      // → JWW PDF は罫線が小刻みな segment 列で構成されるので、coverage は
      //    「複数 segment の union でカバーされていれば OK」(GAP_TOL_MM 内の隙間は許容)
      // → 内側により小さい valid セルがある「外枠的セル」は leaf filter で除外
      // → 面積最小値で文字セル (~64mm²) などのノイズを除外
      const COVERAGE_TOL_MM = 0.8;        // 線位置の許容 (やや緩め)
      const SHRINK_MM = 0.3;              // セル端から内側へ縮めて覆う必要長を判定 (緩め)
      const GAP_TOL_MM = 1.5;             // segment 間の小さい隙間を許容
      // 各辺 15mm 以上 = 「画像配置に使えるサイズの空きセル」のみ採用
      // (文字欄・ラベル欄は高さ ~8mm で除外される)
      const MIN_CELL_SIZE_MM = 15.0;
      const MIN_CELL_AREA_MM2 = 500;      // 面積 500mm² 未満は無視 (細長い帯状のノイズ対策)
      // 扁平率上限: 長辺/短辺 が これを超えるセルは「帯状」とみなして除外
      //   1.0 = 正方形、1.41 = A4、2 = よくある写真、4 = 細長すぎ
      const MAX_CELL_ASPECT_RATIO = 4.0;
      // 性能ガード: 上限の素朴な見積もり (実際は xR-xL < 5mm / 面積<500 で大半が早期スキップされるので
      // 2M でも実質コストは数十万 cover-check に収まる)
      const MAX_PAIRS = 2000000;

      // 軸別バケット: y / x を 0.5mm 単位で量子化、前後 ±1 step まで近傍検索
      const QUANT_MM = 0.5;
      const qk = (v) => Math.round(v / QUANT_MM);
      const hByY = new Map();
      for (const h of hLines) {
        const k = qk(h.yMm);
        if (!hByY.has(k)) hByY.set(k, []);
        hByY.get(k).push(h);
      }
      const vByX = new Map();
      for (const v of vLines) {
        const k = qk(v.xMm);
        if (!vByX.has(k)) vByX.set(k, []);
        vByX.get(k).push(v);
      }
      const getHAt = (y) => {
        const k = qk(y);
        const out = [];
        for (let dk = -1; dk <= 1; dk++) {
          const arr = hByY.get(k + dk);
          if (arr) for (const x of arr) out.push(x);
        }
        return out;
      };
      const getVAt = (x) => {
        const k = qk(x);
        const out = [];
        for (let dk = -1; dk <= 1; dk++) {
          const arr = vByX.get(k + dk);
          if (arr) for (const v of arr) out.push(v);
        }
        return out;
      };
      // segment 列 [{lo, hi}] が target [t0, t1] を union でカバーするか
      // GAP_TOL_MM 以内の隙間は連続扱い (JWW の小刻み segment 対策)
      const segmentsCover = (segments, t0, t1) => {
        if (segments.length === 0) return false;
        if (t1 <= t0) return true;
        const sorted = segments.slice().sort((a, b) => a.lo - b.lo);
        let pos = t0;
        for (const s of sorted) {
          if (s.hi < pos) continue;        // 既にカバー済み区間
          if (s.lo > pos + GAP_TOL_MM) return false; // 隙間でかすぎ
          if (s.hi > pos) pos = s.hi;
          if (pos >= t1) return true;
        }
        return pos >= t1;
      };
      const hasHCover = (yQuery, xL, xR) => {
        const xLN = xL + SHRINK_MM, xRN = xR - SHRINK_MM;
        const segs = [];
        for (const h of getHAt(yQuery)) {
          if (Math.abs(h.yMm - yQuery) > COVERAGE_TOL_MM) continue;
          segs.push({ lo: h.xMinMm, hi: h.xMaxMm });
        }
        return segmentsCover(segs, xLN, xRN);
      };
      const hasVCover = (xQuery, yT, yB) => {
        const yTN = yT + SHRINK_MM, yBN = yB - SHRINK_MM;
        const segs = [];
        for (const v of getVAt(xQuery)) {
          if (Math.abs(v.xMm - xQuery) > COVERAGE_TOL_MM) continue;
          segs.push({ lo: v.yMinMm, hi: v.yMaxMm });
        }
        return segmentsCover(segs, yTN, yBN);
      };

      const N = vXsMm.length, M = hYsMm.length;
      const totalPairs = (N * (N - 1) / 2) * (M * (M - 1) / 2);
      const allCells = [];
      if (N >= 2 && M >= 2 && totalPairs <= MAX_PAIRS) {
        for (let i = 0; i < N - 1; i++) {
          for (let i2 = i + 1; i2 < N; i2++) {
            const xL = vXsMm[i], xR = vXsMm[i2];
            if (xR - xL < MIN_CELL_SIZE_MM) continue;
            for (let j = 0; j < M - 1; j++) {
              for (let j2 = j + 1; j2 < M; j2++) {
                const yT = hYsMm[j], yB = hYsMm[j2];
                if (yB - yT < MIN_CELL_SIZE_MM) continue;
                const _w = xR - xL, _h = yB - yT;
                if (_w * _h < MIN_CELL_AREA_MM2) continue;
                // 扁平率チェック: 長辺/短辺 が閾値を超えるセルは「帯状」とみなして除外
                if (Math.max(_w, _h) / Math.min(_w, _h) > MAX_CELL_ASPECT_RATIO) continue;
                if (hasHCover(yT, xL, xR)
                    && hasHCover(yB, xL, xR)
                    && hasVCover(xL, yT, yB)
                    && hasVCover(xR, yT, yB)) {
                  allCells.push({
                    xL, xR, yT, yB,
                    xMm: (xL + xR) / 2,
                    yMm: (yT + yB) / 2,
                    widthMm: xR - xL,
                    heightMm: yB - yT
                  });
                }
              }
            }
          }
        }
      }

      // leaf filter: 自分の内側に他の valid セルが完全に収まっているセルは除外
      // (外枠 / 行全体 / 列全体など、もっと細かいセルに分割される「箱の箱」を弾く)
      const TOL = 0.5; // mm
      const leafCells = allCells.filter(c => {
        return !allCells.some(o => {
          if (o === c) return false;
          // o が c の内側に完全に収まる && o の方が小さい
          const inside = (o.xL >= c.xL - TOL) && (o.xR <= c.xR + TOL)
                      && (o.yT >= c.yT - TOL) && (o.yB <= c.yB + TOL);
          if (!inside) return false;
          const smaller = (o.widthMm < c.widthMm - TOL) || (o.heightMm < c.heightMm - TOL);
          return smaller;
        });
      });
      const cellCentersMm = leafCells.map(c => ({
        xMm: c.xMm, yMm: c.yMm, widthMm: c.widthMm, heightMm: c.heightMm
      }));

      // 診断ログ (0個 or デバッグ用) — window.imgPlaceDebug = true で有効
      if (cellCentersMm.length === 0 || window.imgPlaceDebug) {
        const overCap = totalPairs > MAX_PAIRS;
        console.log('[imgPlace cells] hLines=' + hLines.length + ' vLines=' + vLines.length
          + ' grid=' + N + 'x' + M
          + ' totalPairs=' + totalPairs + (overCap ? ' (over MAX_PAIRS=' + MAX_PAIRS + ' → 検出スキップ!)' : '')
          + ' allCells=' + allCells.length
          + ' leafCells=' + leafCells.length);
        // 各辺カバレッジの内訳を一部サンプル
        if (cellCentersMm.length === 0 && N >= 2 && M >= 2) {
          let sampleHpass = 0, sampleVpass = 0, samplePairs = 0;
          for (let i = 0; i < N - 1 && samplePairs < 100; i++) {
            for (let i2 = i + 1; i2 < N && samplePairs < 100; i2++) {
              for (let j = 0; j < M - 1 && samplePairs < 100; j++) {
                for (let j2 = j + 1; j2 < M && samplePairs < 100; j2++) {
                  samplePairs++;
                  if (hasHCover(hYsMm[j], vXsMm[i], vXsMm[i2])) sampleHpass++;
                  if (hasVCover(vXsMm[i], hYsMm[j], hYsMm[j2])) sampleVpass++;
                }
              }
            }
          }
          console.log('[imgPlace cells diag] (first ' + samplePairs + ' pairs) '
            + 'hCoverPass=' + sampleHpass + ' vCoverPass=' + sampleVpass
            + ' SHRINK=' + SHRINK_MM + ' COVERAGE_TOL=' + COVERAGE_TOL_MM
            + ' GAP_TOL=' + GAP_TOL_MM);
          // 線の y/x 値分布を確認
          console.log('[imgPlace cells diag] vXsMm sample:', vXsMm.slice(0, 10));
          console.log('[imgPlace cells diag] hYsMm sample:', hYsMm.slice(0, 10));
        }
      }

      return {
        vXsMm: vXsMm,
        hYsMm: hYsMm,
        cellCentersMm: cellCentersMm,
        pageHeightPt: pageHeightPt
      };
    }

    // ----- PoC: SVG オーバーレイに罫線を描画 -----
    // 入力: pdf座標 (pt, 左下原点) → SVG座標 (mm, 左上原点) に変換
    // snapTargets が渡されたら、セル中心に + マーカーも描画
    function renderLineOverlay(lineData, page, snapTargets) {
      if (!linesOverlay) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const pageWidthPt = baseViewport.width;
      const pageHeightPt = baseViewport.height;
      // viewBox を pt 単位で設定
      linesOverlay.setAttribute('viewBox', '0 0 ' + pageWidthPt + ' ' + pageHeightPt);
      // 中身クリア
      while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
      const svgNs = 'http://www.w3.org/2000/svg';
      // 線描画 (y は pdf座標→svg座標で反転)
      for (const ln of lineData.lines) {
        const el = document.createElementNS(svgNs, 'line');
        el.setAttribute('x1', ln.x1);
        el.setAttribute('y1', pageHeightPt - ln.y1);
        el.setAttribute('x2', ln.x2);
        el.setAttribute('y2', pageHeightPt - ln.y2);
        linesOverlay.appendChild(el);
      }
      // 矩形描画
      for (const r of lineData.rects) {
        const el = document.createElementNS(svgNs, 'rect');
        el.setAttribute('x', r.x);
        el.setAttribute('y', pageHeightPt - r.y - r.h); // y軸反転
        el.setAttribute('width', r.w);
        el.setAttribute('height', Math.abs(r.h));
        linesOverlay.appendChild(el);
      }
      // セル中心に + マーカー（mm → pt 変換、Y は SVG なので反転不要：snapTargets は既に上原点 mm）
      let cellCount = 0;
      if (snapTargets && Array.isArray(snapTargets.cellCentersMm)) {
        cellCount = snapTargets.cellCentersMm.length;
        const PT_PER_MM_LOCAL = 72 / 25.4;
        const MARK_PT = 6; // + マーカーの腕長 (pt)
        const g = document.createElementNS(svgNs, 'g');
        g.setAttribute('class', 'cell-marker');
        for (const c of snapTargets.cellCentersMm) {
          const cx = c.xMm * PT_PER_MM_LOCAL;
          const cy = c.yMm * PT_PER_MM_LOCAL;
          // 横棒
          const h = document.createElementNS(svgNs, 'line');
          h.setAttribute('x1', cx - MARK_PT); h.setAttribute('y1', cy);
          h.setAttribute('x2', cx + MARK_PT); h.setAttribute('y2', cy);
          g.appendChild(h);
          // 縦棒
          const v = document.createElementNS(svgNs, 'line');
          v.setAttribute('x1', cx); v.setAttribute('y1', cy - MARK_PT);
          v.setAttribute('x2', cx); v.setAttribute('y2', cy + MARK_PT);
          g.appendChild(v);
        }
        linesOverlay.appendChild(g);
      }
      const totalBefore = lineData.totalLinesBeforeFilter || lineData.lines.length;
      const filteredOut = totalBefore - lineData.lines.length;
      setStatus('罫線検出: 直線 ' + lineData.lines.length + '本 / 矩形 ' + lineData.rects.length + '個'
              + ' / セル ' + cellCount + '個'
              + (filteredOut > 0 ? '（極小線 ' + filteredOut + '本ノイズ除外）' : ''));
    }

    // ----- 現在ページのレンダリング -----
    async function renderCurrentPage() {
      if (!pdfjsDoc) return;
      // 描画中の要求は捨てずに「最後の1件」として覚える(サムネ連打で表示と配置先がズレる事故防止)。
      // renderCurrentPage は常に最新の currentPageIndex を描くため、フラグ1個で後勝ちキューになる
      if (isRendering) { renderPending = true; return; }
      isRendering = true;
      try {
        // レイアウト確定を待つ（初回 editorPanel 表示直後の clientWidth=0 対策）
        await new Promise(resolve => requestAnimationFrame(resolve));
        const page = await pdfjsDoc.getPage(currentPageIndex + 1);
        const baseViewport = page.getViewport({ scale: 1 });
        // canvas-frame の aspect-ratio を PDF サイズに合わせる
        // CSS の max-width/max-height と組み合わさって viewport にフィット
        if (canvasFrame) {
          canvasFrame.style.aspectRatio = baseViewport.width + ' / ' + baseViewport.height;
        }
        // aspect-ratio 設定後にレイアウト確定を待つ（clientWidth 取得前）
        await new Promise(resolve => requestAnimationFrame(resolve));
        // 動的スケール計算: 表示幅×DPR で必要解像度を決定。最低でも3倍密度を確保
        const containerWidth = (canvasFrame && canvasFrame.clientWidth)
          || (canvas && canvas.clientWidth)
          || baseViewport.width;
        const dpr = Math.max(window.devicePixelRatio || 1, 3); // 最低3倍密度
        const targetPx = Math.max(containerWidth, baseViewport.width) * dpr;
        let scale = targetPx / baseViewport.width;
        if (scale > MAX_RENDER_SCALE) scale = MAX_RENDER_SCALE; // メモリ上限ガード
        if (scale < 3) scale = 3; // 最低 3倍密度を強制（ベクター見た目に近づける）
        const viewport = page.getViewport({ scale: scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        // 表示サイズはCSSの "width: 100%; height: auto" に完全に任せる
        canvas.style.width = '';
        canvas.style.height = '';
        // Canvas の描画品質を最高に
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // intent: 'print' で印刷品質モード（テキスト・ベクターのアンチエイリアス改善）
        await page.render({
          canvasContext: ctx,
          viewport: viewport,
          intent: 'print'
        }).promise;
        updateMeta();
        renderPlacements();
        // Lv.2: 罫線スナップON時、現在ページから線を抽出 → 可視化 + スナップ対象に追加
        if (lineDetectionEnabled) {
          try {
            const lineData = await extractPageLines(page);
            detectedSnapTargets = buildDetectedSnapTargets(lineData, page);
            renderLineOverlay(lineData, page, detectedSnapTargets);
          } catch (err) {
            console.warn('[imgPlace] 罫線検出失敗:', err);
            detectedSnapTargets = null;
          }
        } else {
          detectedSnapTargets = null;
        }
        // カスタムセル（手動定義）の再描画
        renderCustomCells();
        // ページ切替時はハイライトもリセット
        if (activeSnapCell) {
          activeSnapCell = null;
          updateActiveSnapCellOverlay();
        }
      } catch (err) {
        console.error('[imgPlace] ページ描画失敗:', err);
        // 白紙キャンバスのまま当てずっぽうで配置されるのを防ぐため、画面にも警告を出す
        setStatus('⚠ ページの表示に失敗しました（ページが大きすぎる可能性）。このページへの配置は控えてください', 'error');
      } finally {
        isRendering = false;
        // 描画中に溜まった要求を消化(最新の currentPageIndex を描き直す)
        if (renderPending) {
          renderPending = false;
          renderCurrentPage();
        }
      }
    }

    // ----- リサイズ追従（debounced） -----
    let resizeTimer = null;
    if (typeof ResizeObserver === 'function' && canvasFrame) {
      const ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (pdfjsDoc) renderCurrentPage();
        }, 220);
      });
      ro.observe(canvasFrame);
    }

    // ----- 座標変換: 画面座標 → ページmm -----
    function getPagePosMm(clientX, clientY) {
      if (!canvasFrame) return null;
      const rect = canvasFrame.getBoundingClientRect();
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize || rect.width === 0 || rect.height === 0) return null;
      return {
        xMm: (clientX - rect.left) / rect.width * pageSize.width,
        yMm: (clientY - rect.top) / rect.height * pageSize.height
      };
    }

    // ----- リサイズ計算: 8ハンドル対応（四隅 + 四辺中央） -----
    // 動いているエッジだけを再計算、対辺は固定（anchor）
    function applyResize(corner, mouseXMm, mouseYMm, orig, lockAspect) {
      const MIN_MM = 5;
      let newX = orig.xMm, newY = orig.yMm;
      let newW = orig.widthMm, newH = orig.heightMm;

      const moveLeft   = corner === 'nw' || corner === 'sw' || corner === 'w';
      const moveRight  = corner === 'ne' || corner === 'se' || corner === 'e';
      const moveTop    = corner === 'nw' || corner === 'ne' || corner === 'n';
      const moveBottom = corner === 'sw' || corner === 'se' || corner === 's';

      // 水平方向の変化（左 or 右ヘリだけが動く）
      if (moveLeft) {
        const anchorRight = orig.xMm + orig.widthMm;
        newW = Math.max(MIN_MM, anchorRight - mouseXMm);
        newX = anchorRight - newW;
      } else if (moveRight) {
        newW = Math.max(MIN_MM, mouseXMm - orig.xMm);
        // newX = orig.xMm
      }
      // 垂直方向の変化（上 or 下ヘリだけが動く）
      if (moveTop) {
        const anchorBottom = orig.yMm + orig.heightMm;
        newH = Math.max(MIN_MM, anchorBottom - mouseYMm);
        newY = anchorBottom - newH;
      } else if (moveBottom) {
        newH = Math.max(MIN_MM, mouseYMm - orig.yMm);
        // newY = orig.yMm
      }

      // アスペクト比固定
      if (lockAspect && orig.widthMm > 0 && orig.heightMm > 0) {
        const aspect = orig.widthMm / orig.heightMm;
        const isCorner = (moveLeft || moveRight) && (moveTop || moveBottom);
        const isHEdge  = (moveLeft || moveRight) && !moveTop && !moveBottom; // 'w' or 'e'
        const isVEdge  = (moveTop || moveBottom) && !moveLeft && !moveRight; // 'n' or 's'

        if (isCorner) {
          // 4隅: 大きい方の縮尺に合わせて対角を anchor に伸縮
          if (newW / aspect > newH) {
            const adj = newW / aspect;
            if (moveTop) newY = (orig.yMm + orig.heightMm) - adj;
            newH = adj;
          } else {
            const adj = newH * aspect;
            if (moveLeft) newX = (orig.xMm + orig.widthMm) - adj;
            newW = adj;
          }
        } else if (isHEdge) {
          // 左右ヘリ: 幅変化に追従して高さも変える、元の縦中心線を保つ
          newH = newW / aspect;
          newY = orig.yMm + (orig.heightMm - newH) / 2;
        } else if (isVEdge) {
          // 上下ヘリ: 高さ変化に追従して幅も変える、元の横中心線を保つ
          newW = newH * aspect;
          newX = orig.xMm + (orig.widthMm - newW) / 2;
        }
      }

      return { xMm: newX, yMm: newY, widthMm: newW, heightMm: newH };
    }

    // ----- スナップ機能 -----
    // 18px相当をmmに換算（canvas表示幅 → ページ実寸）
    // 仕様§4.6は5pxだが現場感覚優先で広め（吸い付き強く）
    function getSnapThresholdMm() {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize || !canvasFrame) return 5;
      const rect = canvasFrame.getBoundingClientRect();
      if (rect.width === 0) return 5;
      return 18 / rect.width * pageSize.width;
    }
    // 現在ページの他の配置の矩形情報を取得
    // exclude: 単一ID (string) or Set<string>。指定IDは結果から除外
    function getOtherPlacementRects(exclude) {
      let excludeSet;
      if (exclude instanceof Set) excludeSet = exclude;
      else if (exclude == null) excludeSet = new Set();
      else excludeSet = new Set([exclude]);
      const result = [];
      for (const p of placements) {
        if (excludeSet.has(p.id)) continue;
        if (p.pageIndex !== currentPageIndex) continue;
        result.push({
          left: p.xMm,
          top: p.yMm,
          right: p.xMm + p.widthMm,
          bottom: p.yMm + p.heightMm,
          centerX: p.xMm + p.widthMm / 2,
          centerY: p.yMm + p.heightMm / 2
        });
      }
      return result;
    }
    // ref が targets のどれかと threshold 以内なら最も近いのを返す
    function findClosest(ref, targets, threshold) {
      let best = null;
      for (const t of targets) {
        const diff = t - ref;
        if (Math.abs(diff) < threshold && (!best || Math.abs(diff) < Math.abs(best.delta))) {
          best = { delta: diff, target: t };
        }
      }
      return best;
    }
    // 移動用スナップ計算: 左右端・中央 vs 他画像エッジ・他画像中心線・ページ中央線・検出罫線・セル中心
    function computeSnapForMove(newX, newY, w, h) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return { dx: 0, dy: 0, guides: [] };
      const threshold = getSnapThresholdMm();
      // マルチ選択時は全ての選択中placementを除外（一緒に移動中なので互いに snap しない）
      const others = getOtherPlacementRects(selectedPlacementIds);
      const vTargets = [pageSize.width / 2];
      const hTargets = [pageSize.height / 2];
      for (const r of others) {
        vTargets.push(r.left, r.right, r.centerX);
        hTargets.push(r.top, r.bottom, r.centerY);
      }
      // Lv.2: 検出した罫線/矩形エッジもスナップ対象に
      if (detectedSnapTargets) {
        for (const x of detectedSnapTargets.vXsMm) vTargets.push(x);
        for (const y of detectedSnapTargets.hYsMm) hTargets.push(y);
      }
      // ===== セル中心スナップ（XY同時、最優先） =====
      // 画像中心が threshold 内のセル中心があれば、per-axis snap より優先して XY 同時に吸い付く
      // 「マルチ選択時はセル中心スナップを無効化」(複数枚を一点に集約してしまうため)
      // 検出セル + カスタムセル を統合した getActiveCells() を使用
      const cellsForSnap = (!selectedPlacementIds || selectedPlacementIds.size <= 1) ? getActiveCells() : [];
      if (cellsForSnap.length > 0) {
        const imgCx = newX + w / 2;
        const imgCy = newY + h / 2;
        let bestCell = null;
        let bestDist2 = Infinity;
        for (const c of cellsForSnap) {
          const ddx = Math.abs(c.xMm - imgCx);
          const ddy = Math.abs(c.yMm - imgCy);
          if (ddx > threshold || ddy > threshold) continue;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestCell = c;
          }
        }
        if (bestCell) {
          return {
            dx: bestCell.xMm - imgCx,
            dy: bestCell.yMm - imgCy,
            guides: [
              { type: 'v', mm: bestCell.xMm },
              { type: 'h', mm: bestCell.yMm }
            ],
            cell: bestCell
          };
        }
      }
      let bestX = null;
      for (const ref of [newX, newX + w, newX + w / 2]) {
        const s = findClosest(ref, vTargets, threshold);
        if (s && (!bestX || Math.abs(s.delta) < Math.abs(bestX.delta))) bestX = s;
      }
      let bestY = null;
      for (const ref of [newY, newY + h, newY + h / 2]) {
        const s = findClosest(ref, hTargets, threshold);
        if (s && (!bestY || Math.abs(s.delta) < Math.abs(bestY.delta))) bestY = s;
      }
      const guides = [];
      if (bestX) guides.push({ type: 'v', mm: bestX.target });
      if (bestY) guides.push({ type: 'h', mm: bestY.target });
      return {
        dx: bestX ? bestX.delta : 0,
        dy: bestY ? bestY.delta : 0,
        guides: guides
      };
    }
    // リサイズ用スナップ計算: 動いているエッジだけを対象に（検出罫線含む）
    function computeSnapForResize(corner, rect) {
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) return { snapX: null, snapY: null, guides: [] };
      const threshold = getSnapThresholdMm();
      const others = getOtherPlacementRects(selectedPlacementId);
      const vTargets = [pageSize.width / 2];
      const hTargets = [pageSize.height / 2];
      for (const r of others) {
        vTargets.push(r.left, r.right, r.centerX);
        hTargets.push(r.top, r.bottom, r.centerY);
      }
      // Lv.2: 検出した罫線/矩形エッジもスナップ対象に
      if (detectedSnapTargets) {
        for (const x of detectedSnapTargets.vXsMm) vTargets.push(x);
        for (const y of detectedSnapTargets.hYsMm) hTargets.push(y);
      }
      const isLeftMoving   = corner === 'nw' || corner === 'sw' || corner === 'w';
      const isRightMoving  = corner === 'ne' || corner === 'se' || corner === 'e';
      const isTopMoving    = corner === 'nw' || corner === 'ne' || corner === 'n';
      const isBottomMoving = corner === 'sw' || corner === 'se' || corner === 's';
      let snapX = null, snapY = null;
      // 水平方向: 動いてるエッジ + 中心線も候補に。最も近い target を採用
      if (isLeftMoving || isRightMoving) {
        const candidates = [];
        if (isLeftMoving)  candidates.push({ edge: 'left',    val: rect.left });
        if (isRightMoving) candidates.push({ edge: 'right',   val: rect.right });
        candidates.push({ edge: 'centerX', val: (rect.left + rect.right) / 2 });
        for (const c of candidates) {
          const s = findClosest(c.val, vTargets, threshold);
          if (s && (!snapX || Math.abs(s.delta) < Math.abs(snapX.delta))) {
            snapX = { edge: c.edge, delta: s.delta, target: s.target };
          }
        }
      }
      // 垂直方向: 同上
      if (isTopMoving || isBottomMoving) {
        const candidates = [];
        if (isTopMoving)    candidates.push({ edge: 'top',     val: rect.top });
        if (isBottomMoving) candidates.push({ edge: 'bottom',  val: rect.bottom });
        candidates.push({ edge: 'centerY', val: (rect.top + rect.bottom) / 2 });
        for (const c of candidates) {
          const s = findClosest(c.val, hTargets, threshold);
          if (s && (!snapY || Math.abs(s.delta) < Math.abs(snapY.delta))) {
            snapY = { edge: c.edge, delta: s.delta, target: s.target };
          }
        }
      }
      const guides = [];
      if (snapX) guides.push({ type: 'v', mm: snapX.target });
      if (snapY) guides.push({ type: 'h', mm: snapY.target });
      return { snapX: snapX, snapY: snapY, guides: guides };
    }
    // スナップトグルボタン表示更新
    function updateSnapBtn() {
      if (!snapBtn) return;
      snapBtn.dataset.snap = snapEnabled ? 'on' : 'off';
      if (snapLabel) snapLabel.textContent = snapEnabled ? 'スナップ ON' : 'スナップ OFF';
    }

    // ----- 選択ヘルパー -----
    function selectSingle(id) {
      selectedPlacementIds = new Set([id]);
      selectedPlacementId = id;
    }
    function clearSelection() {
      selectedPlacementIds = new Set();
      selectedPlacementId = null;
    }
    function toggleSelected(id) {
      if (selectedPlacementIds.has(id)) {
        selectedPlacementIds.delete(id);
        if (selectedPlacementId === id) {
          // primary を選択中の他のものに更新（最後に追加されたもの優先）
          const remain = [...selectedPlacementIds];
          selectedPlacementId = remain.length > 0 ? remain[remain.length - 1] : null;
        }
      } else {
        selectedPlacementIds.add(id);
        selectedPlacementId = id;
      }
    }
    function removeFromSelection(id) {
      selectedPlacementIds.delete(id);
      if (selectedPlacementId === id) {
        const remain = [...selectedPlacementIds];
        selectedPlacementId = remain.length > 0 ? remain[remain.length - 1] : null;
      }
    }

    // ----- 配置削除（複数選択対応） -----
    function deletePlacement(id) {
      const target = placements.find(p => p.id === id);
      const affectedPage = target ? target.pageIndex : currentPageIndex;
      placements = placements.filter(p => p.id !== id);
      removeFromSelection(id);
      renderPlacements();
      renderLibrary(); // バッジ数更新
      queueThumbUpdate(affectedPage);
    }
    function deleteSelected() {
      if (selectedPlacementIds.size === 0) return;
      const idsToDelete = [...selectedPlacementIds];
      placements = placements.filter(p => !selectedPlacementIds.has(p.id));
      clearSelection();
      renderPlacements();
      renderLibrary();
    }

    // ----- ゴミ箱の表示制御 -----
    function isOverTrash(clientX, clientY) {
      if (!trashEl) return false;
      const rect = trashEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return clientX >= rect.left && clientX <= rect.right
          && clientY >= rect.top && clientY <= rect.bottom;
    }
    function showTrash() {
      if (trashEl) trashEl.classList.add('visible');
    }
    function hideTrash() {
      if (trashEl) trashEl.classList.remove('visible', 'hover');
    }

    // ----- ドラッグゴースト（カーソル追従の半透明コピー） -----
    function createDragGhost(placement, imgMeta, clientX, clientY) {
      if (!canvasFrame) return null;
      const frameRect = canvasFrame.getBoundingClientRect();
      const pageSize = pageSizesMm[placement.pageIndex];
      if (!pageSize || frameRect.width === 0) return null;
      // 元配置の画面座標
      const plLeftPx = frameRect.left + (placement.xMm / pageSize.width) * frameRect.width;
      const plTopPx = frameRect.top + (placement.yMm / pageSize.height) * frameRect.height;
      const plWidthPx = (placement.widthMm / pageSize.width) * frameRect.width;
      const plHeightPx = (placement.heightMm / pageSize.height) * frameRect.height;
      // カーソルの「画像内オフセット」を保持（自然なドラッグ感のため）
      const offsetX = clientX - plLeftPx;
      const offsetY = clientY - plTopPx;
      const ghost = document.createElement('div');
      ghost.className = 'imgplace-drag-ghost';
      ghost.style.width = plWidthPx + 'px';
      ghost.style.height = plHeightPx + 'px';
      ghost.style.left = (clientX - offsetX) + 'px';
      ghost.style.top = (clientY - offsetY) + 'px';
      const g = document.createElement('img');
      g.src = imgMeta.dataUrl;
      g.alt = imgMeta.filename || '';
      ghost.appendChild(g);
      document.body.appendChild(ghost);
      return { ghost: ghost, offsetX: offsetX, offsetY: offsetY };
    }
    function updateDragGhostPos(ghostInfo, clientX, clientY) {
      if (!ghostInfo || !ghostInfo.ghost) return;
      ghostInfo.ghost.style.left = (clientX - ghostInfo.offsetX) + 'px';
      ghostInfo.ghost.style.top = (clientY - ghostInfo.offsetY) + 'px';
    }
    function destroyDragGhost(ghostInfo) {
      if (ghostInfo && ghostInfo.ghost && ghostInfo.ghost.parentNode) {
        ghostInfo.ghost.parentNode.removeChild(ghostInfo.ghost);
      }
    }

    // ----- 整列関数（複数選択時のみ機能） -----
    function getSelectedPlacements() {
      const ids = [...selectedPlacementIds];
      return ids
        .map(id => placements.find(p => p.id === id))
        .filter(p => p && p.pageIndex === currentPageIndex);
    }
    // 横並び等間隔: 左端から右端の範囲を等間隔配置、Yは最初の選択画像に揃える
    function alignHEqualSpacing() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const firstY = pls[0].yMm; // selectedPlacementIds の最初に追加された画像
      const sortedByX = pls.slice().sort((a, b) => a.xMm - b.xMm);
      const leftmost = sortedByX[0];
      const rightmost = sortedByX[sortedByX.length - 1];
      const totalSpan = (rightmost.xMm + rightmost.widthMm) - leftmost.xMm;
      const sumWidths = sortedByX.reduce((s, p) => s + p.widthMm, 0);
      const gap = (totalSpan - sumWidths) / (sortedByX.length - 1);
      let cursor = leftmost.xMm;
      for (const p of sortedByX) {
        p.xMm = cursor;
        p.yMm = firstY;
        cursor += p.widthMm + gap;
      }
      renderPlacements();
    }
    // 上端揃え: Y座標を最小値に
    function alignTop() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const minY = Math.min(...pls.map(p => p.yMm));
      pls.forEach(p => { p.yMm = minY; });
      renderPlacements();
    }
    // 下端揃え: Y+H を最大値に
    function alignBottom() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const maxBottom = Math.max(...pls.map(p => p.yMm + p.heightMm));
      pls.forEach(p => { p.yMm = maxBottom - p.heightMm; });
      renderPlacements();
    }
    // 縦中央揃え: Y中心を平均値に
    function alignCenterVertical() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const avgCenterY = pls.reduce((s, p) => s + p.yMm + p.heightMm / 2, 0) / pls.length;
      pls.forEach(p => { p.yMm = avgCenterY - p.heightMm / 2; });
      renderPlacements();
    }
    // 幅統一: Primary（最後クリック）の幅に全選択を揃える。各画像のAR Lockが ON なら高さも比率連動
    function unifyWidth() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const primary = placements.find(p => p.id === selectedPlacementId);
      if (!primary) return;
      const targetW = primary.widthMm;
      for (const p of pls) {
        if (p.id === primary.id) continue;
        if (p.aspectLocked !== false && p.widthMm > 0 && p.heightMm > 0) {
          const aspect = p.widthMm / p.heightMm;
          p.heightMm = targetW / aspect;
        }
        p.widthMm = targetW;
      }
      renderPlacements();
    }
    // キャプション一括プロパティ設定（マルチ選択の全画像の全キャプションに適用）
    function bulkSetCaptionProperty(prop, value) {
      const pls = getSelectedPlacements();
      if (pls.length < 1) return;
      for (const pl of pls) {
        normalizeCaptions(pl);
        for (const cap of pl.captions) {
          cap[prop] = value;
        }
      }
      renderPlacements();
    }

    // 高さ統一: 同上の高さ版
    function unifyHeight() {
      const pls = getSelectedPlacements();
      if (pls.length < 2) return;
      const primary = placements.find(p => p.id === selectedPlacementId);
      if (!primary) return;
      const targetH = primary.heightMm;
      for (const p of pls) {
        if (p.id === primary.id) continue;
        if (p.aspectLocked !== false && p.widthMm > 0 && p.heightMm > 0) {
          const aspect = p.widthMm / p.heightMm;
          p.widthMm = targetH * aspect;
        }
        p.heightMm = targetH;
      }
      renderPlacements();
    }

    // ----- プロパティパネル: 値だけ同期（DOM再構築せず、入力中のフィールドは触らない） -----
    function syncPropsInputValues(pl) {
      const active = document.activeElement;
      if (propsInputs.x && active !== propsInputs.x) propsInputs.x.value = pl.xMm.toFixed(1);
      if (propsInputs.y && active !== propsInputs.y) propsInputs.y.value = pl.yMm.toFixed(1);
      if (propsInputs.w && active !== propsInputs.w) propsInputs.w.value = pl.widthMm.toFixed(1);
      if (propsInputs.h && active !== propsInputs.h) propsInputs.h.value = pl.heightMm.toFixed(1);
    }

    // ----- プロパティパネル: 入力変更を反映 -----
    function handlePropsInputChange(propKey, value) {
      const pl = placements.find(p => p.id === selectedPlacementId);
      if (!pl) return;
      if (propKey === 'widthMm') {
        if (value <= 0) return;
        // アスペクト比固定なら H 連動
        if (pl.aspectLocked !== false && pl.widthMm > 0 && pl.heightMm > 0) {
          const aspect = pl.widthMm / pl.heightMm;
          pl.heightMm = value / aspect;
        }
        pl.widthMm = value;
      } else if (propKey === 'heightMm') {
        if (value <= 0) return;
        // アスペクト比固定なら W 連動
        if (pl.aspectLocked !== false && pl.widthMm > 0 && pl.heightMm > 0) {
          const aspect = pl.widthMm / pl.heightMm;
          pl.widthMm = value * aspect;
        }
        pl.heightMm = value;
      } else {
        // X/Y はクランプなし（直接入力でページ外配置も許容）
        pl[propKey] = value;
      }
      renderPlacements();
    }

    // ----- プロパティパネル描画 -----
    function renderProps() {
      const propsEl = document.getElementById('imgPlaceProps');
      if (!propsEl) return;
      const count = selectedPlacementIds.size;
      const selected = (count === 1 && selectedPlacementId)
        ? placements.find(p => p.id === selectedPlacementId)
        : null;
      // smart-sync 用キー: 単一選択なら ID + キャプション数、マルチ選択は "multi:N"
      // キャプション数を含むことで add/remove 時に確実にDOM再構築させる
      if (selected) normalizeCaptions(selected);
      const newKey = count > 1
        ? ('multi:' + count)
        : (selected ? (selected.id + ':cap' + selected.captions.length) : '');
      const currentKey = propsEl.dataset.propsKey || '';

      // 同じ単一placementの継続表示なら値同期だけで終了（フォーカス保持）
      if (currentKey === newKey && count === 1 && selected && propsInputs.x) {
        syncPropsInputValues(selected);
        return;
      }

      // 構造変更 → 完全再構築
      propsEl.innerHTML = '';
      propsEl.dataset.propsKey = newKey;
      propsInputs = { x: null, y: null, w: null, h: null };

      const title = document.createElement('div');
      title.className = 'imgplace-props-title';
      title.textContent = 'プロパティ';
      propsEl.appendChild(title);

      // 0個選択: 空メッセージ
      if (count === 0) {
        const empty = document.createElement('div');
        empty.className = 'imgplace-props-empty';
        empty.textContent = '画像を選択してください';
        propsEl.appendChild(empty);
        return;
      }

      // 2個以上選択: マルチ選択UI（カウント + 整列ボタン）
      if (count > 1) {
        const countDiv = document.createElement('div');
        countDiv.className = 'imgplace-props-count';
        countDiv.textContent = count + ' 個の画像を選択中';
        propsEl.appendChild(countDiv);

        const alignTitle = document.createElement('div');
        alignTitle.className = 'imgplace-align-title';
        alignTitle.textContent = '整列（Y軸）';
        propsEl.appendChild(alignTitle);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'imgplace-align-buttons';
        const buttons = [
          ['横並び等間隔', alignHEqualSpacing],
          ['上端揃え',     alignTop],
          ['下端揃え',     alignBottom],
          ['縦中央揃え',   alignCenterVertical]
        ];
        for (const [label, fn] of buttons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-align-btn';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          btnGroup.appendChild(btn);
        }
        propsEl.appendChild(btnGroup);

        // サイズ統一セクション
        const sizeTitle = document.createElement('div');
        sizeTitle.className = 'imgplace-align-title';
        sizeTitle.textContent = 'サイズ統一';
        propsEl.appendChild(sizeTitle);
        const sizeGroup = document.createElement('div');
        sizeGroup.className = 'imgplace-align-buttons';
        const sizeButtons = [
          ['幅を統一',   unifyWidth],
          ['高さを統一', unifyHeight]
        ];
        for (const [label, fn] of sizeButtons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-align-btn';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          sizeGroup.appendChild(btn);
        }
        propsEl.appendChild(sizeGroup);

        const hint = document.createElement('div');
        hint.className = 'imgplace-props-hint';
        hint.style.paddingLeft = '0';
        hint.style.marginTop = '8px';
        hint.textContent = '基準は最後にクリックした画像。AR固定 ON の画像は比率を維持して連動。';
        propsEl.appendChild(hint);

        // ===== キャプション一括設定 =====
        const capBulkTitle = document.createElement('div');
        capBulkTitle.className = 'imgplace-align-title';
        capBulkTitle.textContent = 'キャプション一括';
        propsEl.appendChild(capBulkTitle);
        // ボタングループ生成ヘルパー
        function makeBulkRow(labelText, options, propKey) {
          const row = document.createElement('div');
          row.className = 'imgplace-caption-toggle';
          const lbl = document.createElement('span');
          lbl.className = 'imgplace-caption-toggle-label';
          lbl.textContent = labelText;
          row.appendChild(lbl);
          for (const [val, label] of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'imgplace-caption-toggle-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => bulkSetCaptionProperty(propKey, val));
            row.appendChild(btn);
          }
          propsEl.appendChild(row);
        }
        makeBulkRow('揃え',   [['left','左'], ['center','中'], ['right','右']],            'align');
        makeBulkRow('サイズ', [['small','小'], ['medium','中'], ['large','大']],          'size');
        makeBulkRow('位置',   [['above','上'], ['below','下']],                            'position');
        makeBulkRow('太字',   [[false,'標準'], [true,'太字']],                              'bold');

        const capBulkHint = document.createElement('div');
        capBulkHint.className = 'imgplace-props-hint';
        capBulkHint.style.paddingLeft = '0';
        capBulkHint.style.marginTop = '6px';
        capBulkHint.textContent = '選択中の全画像の全キャプションに即時適用。フォントは下部の一括フォントで変更。';
        propsEl.appendChild(capBulkHint);
        return;
      }

      // X/Y/W/H 数値入力行
      function makeInputRow(labelText, propKey) {
        const row = document.createElement('div');
        row.className = 'imgplace-input-row';
        const lbl = document.createElement('label');
        lbl.textContent = labelText;
        row.appendChild(lbl);
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.1';
        input.value = selected[propKey].toFixed(1);
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          if (isNaN(v)) return;
          handlePropsInputChange(propKey, v);
        });
        row.appendChild(input);
        const unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = 'mm';
        row.appendChild(unit);
        propsEl.appendChild(row);
        return input;
      }
      propsInputs.x = makeInputRow('X', 'xMm');
      propsInputs.y = makeInputRow('Y', 'yMm');
      propsInputs.w = makeInputRow('W', 'widthMm');
      propsInputs.h = makeInputRow('H', 'heightMm');

      // 区切り
      const hr = document.createElement('hr');
      propsEl.appendChild(hr);

      // アスペクト比固定チェックボックス
      const row = document.createElement('label');
      row.className = 'imgplace-props-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.aspectLocked !== false;
      cb.addEventListener('change', () => {
        selected.aspectLocked = cb.checked;
      });
      const txt = document.createElement('span');
      txt.textContent = 'アスペクト比を固定';
      row.appendChild(cb);
      row.appendChild(txt);
      propsEl.appendChild(row);
      const hint = document.createElement('div');
      hint.className = 'imgplace-props-hint';
      hint.textContent = 'リサイズ中に Shift で一時反転';
      propsEl.appendChild(hint);

      // ===== キャプション編集セクション（複数キャプション対応） =====
      const capSection = document.createElement('div');
      capSection.className = 'imgplace-caption-section';
      const capTitle = document.createElement('div');
      capTitle.className = 'imgplace-align-title';
      capTitle.textContent = 'キャプション';
      capSection.appendChild(capTitle);

      // selected.captions を確実に配列に
      normalizeCaptions(selected);

      // 複数キャプションある時のみ「全キャプション一括」セクション
      if (selected.captions.length >= 2) {
        const bulkBox = document.createElement('div');
        bulkBox.className = 'imgplace-caption-bulk-single';
        const bulkTitle = document.createElement('div');
        bulkTitle.className = 'imgplace-caption-bulk-title';
        bulkTitle.textContent = '全キャプション一括';
        bulkBox.appendChild(bulkTitle);

        function applyBulkSingle(prop, value) {
          for (const cap of selected.captions) {
            cap[prop] = value;
          }
          // 個別カードの active クラスも更新するため、propsKey を無効化して完全再構築
          propsEl.dataset.propsKey = '';
          renderPlacements();
        }
        function makeBulkRow(labelText, options, prop) {
          const row = document.createElement('div');
          row.className = 'imgplace-caption-toggle';
          const lbl = document.createElement('span');
          lbl.className = 'imgplace-caption-toggle-label';
          lbl.textContent = labelText;
          row.appendChild(lbl);
          for (const [val, label] of options) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'imgplace-caption-toggle-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => applyBulkSingle(prop, val));
            row.appendChild(btn);
          }
          bulkBox.appendChild(row);
        }
        makeBulkRow('揃え',   [['left','左'], ['center','中'], ['right','右']],   'align');
        makeBulkRow('サイズ', [['small','小'], ['medium','中'], ['large','大']], 'size');
        makeBulkRow('位置',   [['above','上'], ['below','下']],                  'position');
        makeBulkRow('太字',   [[false,'標準'], [true,'太字']],                    'bold');

        capSection.appendChild(bulkBox);
      }

      // 各キャプションをカードとして描画
      function renderCaptionCard(cap, index) {
        const card = document.createElement('div');
        card.className = 'imgplace-caption-card';

        // テキスト入力
        const capInput = document.createElement('input');
        capInput.type = 'text';
        capInput.className = 'imgplace-caption-input';
        capInput.placeholder = '例: 3 台';
        capInput.value = cap.text || '';
        capInput.addEventListener('input', () => {
          cap.text = capInput.value;
          renderPlacements(); // smart-sync で props は再構築されない → 入力フォーカス保持
        });
        card.appendChild(capInput);

        // 削除ボタン (×)
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'imgplace-caption-remove';
        removeBtn.textContent = '×';
        removeBtn.title = 'このキャプションを削除';
        removeBtn.addEventListener('click', () => {
          selected.captions.splice(index, 1);
          // propsKey が変わるので renderProps は自動で完全再構築
          renderPlacements();
        });
        card.appendChild(removeBtn);

        // 揃え（左/中/右）
        const alignToggle = document.createElement('div');
        alignToggle.className = 'imgplace-caption-toggle';
        const alignLbl = document.createElement('span');
        alignLbl.className = 'imgplace-caption-toggle-label';
        alignLbl.textContent = '揃え';
        alignToggle.appendChild(alignLbl);
        const alignOptions = [['left', '左'], ['center', '中'], ['right', '右']];
        const alignBtns = [];
        for (const [val, label] of alignOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.align || 'center') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.align = val;
            for (const b of alignBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          alignBtns.push(btn);
          alignToggle.appendChild(btn);
        }
        card.appendChild(alignToggle);

        // サイズ（小/中/大）
        const sizeToggle = document.createElement('div');
        sizeToggle.className = 'imgplace-caption-toggle';
        const sizeLbl = document.createElement('span');
        sizeLbl.className = 'imgplace-caption-toggle-label';
        sizeLbl.textContent = 'サイズ';
        sizeToggle.appendChild(sizeLbl);
        const sizeOptions = [['small', '小'], ['medium', '中'], ['large', '大']];
        const sizeBtns = [];
        for (const [val, label] of sizeOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.size || 'medium') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.size = val;
            for (const b of sizeBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          sizeBtns.push(btn);
          sizeToggle.appendChild(btn);
        }
        card.appendChild(sizeToggle);

        // 位置（上/下）
        const posToggle = document.createElement('div');
        posToggle.className = 'imgplace-caption-toggle';
        const posLbl = document.createElement('span');
        posLbl.className = 'imgplace-caption-toggle-label';
        posLbl.textContent = '位置';
        posToggle.appendChild(posLbl);
        const posOptions = [['above', '上'], ['below', '下']];
        const posBtns = [];
        for (const [val, label] of posOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((cap.position || 'below') === val ? ' active' : '');
          btn.textContent = label;
          btn.addEventListener('click', () => {
            cap.position = val;
            for (const b of posBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          posBtns.push(btn);
          posToggle.appendChild(btn);
        }
        card.appendChild(posToggle);

        // 太字（標準/太字）
        const boldToggle = document.createElement('div');
        boldToggle.className = 'imgplace-caption-toggle';
        const boldLbl = document.createElement('span');
        boldLbl.className = 'imgplace-caption-toggle-label';
        boldLbl.textContent = '太字';
        boldToggle.appendChild(boldLbl);
        const boldOptions = [[false, '標準'], [true, '太字']];
        const boldBtns = [];
        for (const [val, label] of boldOptions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'imgplace-caption-toggle-btn' + ((!!cap.bold) === val ? ' active' : '');
          btn.textContent = label;
          if (val === true) btn.style.fontWeight = '700'; // "太字" ボタンは太字表示
          btn.addEventListener('click', () => {
            cap.bold = val;
            for (const b of boldBtns) b.classList.toggle('active', b === btn);
            renderPlacements();
          });
          boldBtns.push(btn);
          boldToggle.appendChild(btn);
        }
        card.appendChild(boldToggle);

        return card;
      }

      for (let i = 0; i < selected.captions.length; i++) {
        capSection.appendChild(renderCaptionCard(selected.captions[i], i));
      }

      // + キャプション追加ボタン
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'imgplace-caption-add';
      addBtn.textContent = '+ キャプション追加';
      addBtn.addEventListener('click', () => {
        selected.captions.push({ text: '', align: 'center', size: 'medium' });
        renderPlacements(); // propsKey 変化で完全再構築
      });
      capSection.appendChild(addBtn);

      propsEl.appendChild(capSection);
    }

    // キャプションのサイズマップ（mm単位）
    const CAPTION_SIZE_MM = { small: 3, medium: 4, large: 5 };
    // 旧 pl.caption (単一) → pl.captions (配列) に正規化
    function normalizeCaptions(pl) {
      if (!pl.captions) {
        if (pl.caption && pl.caption.text) {
          pl.captions = [pl.caption];
        } else {
          pl.captions = [];
        }
        delete pl.caption;
      }
    }

    // ----- 配置オーバーレイ描画 -----
    function renderPlacements() {
      if (!overlay) return;
      overlay.innerHTML = '';
      const pageSize = pageSizesMm[currentPageIndex];
      if (!pageSize) { renderProps(); return; }
      const frameRect = canvasFrame ? canvasFrame.getBoundingClientRect() : null;
      const pxPerMm = (frameRect && frameRect.width > 0)
        ? frameRect.width / pageSize.width
        : 4; // フォールバック
      for (const pl of placements) {
        if (pl.pageIndex !== currentPageIndex) continue;
        const img = imageLibrary.find(im => im.id === pl.imageId);
        if (!img) continue;
        const isSelected = selectedPlacementIds.has(pl.id);
        const isPrimary = pl.id === selectedPlacementId;
        // ゴースト透明化は Primary のみ。マルチドラッグ時の他選択は普通に動いて見える
        const isDraggingSource = dragState && dragState.mode === 'move' && dragState.placementId === pl.id;
        const el = document.createElement('div');
        el.className = 'imgplace-placement'
          + (isSelected ? ' selected' : '')
          + (isPrimary ? ' primary' : '')
          + (isDraggingSource ? ' dragging-source' : '');
        el.dataset.placementId = pl.id;
        el.style.left = (pl.xMm / pageSize.width * 100) + '%';
        el.style.top = (pl.yMm / pageSize.height * 100) + '%';
        el.style.width = (pl.widthMm / pageSize.width * 100) + '%';
        el.style.height = (pl.heightMm / pageSize.height * 100) + '%';
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.alt = img.filename;
        el.appendChild(imgEl);

        // 配置クリック: 選択 + 移動ドラッグ開始
        el.addEventListener('pointerdown', (e) => {
          // ハンドルクリック時はハンドル側で stopPropagation するのでここに来ない
          e.preventDefault();
          e.stopPropagation();

          // タッチイベント時は activeTouches に追加して、2 指目ならピンチ開始
          if (e.pointerType === 'touch') {
            // 3本目以降のタッチは無視 (activeTouches leak で pinchState 残留を防ぐ)
            if (activeTouches.size >= 2) return;
            activeTouches.set(e.pointerId, {
              clientX: e.clientX, clientY: e.clientY,
              placementId: pl.id
            });
            if (activeTouches.size === 2) {
              // 2 指目: 1 指目で触ってた配置を対象にピンチ開始
              const pts = [...activeTouches.values()];
              const firstPid = pts[0].placementId;
              const targetPl = placements.find(p => p.id === firstPid);
              if (targetPl) {
                const dx = pts[1].clientX - pts[0].clientX;
                const dy = pts[1].clientY - pts[0].clientY;
                const startDist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                // 既存のドラッグを中止（ゴーストとゴミ箱を破棄）
                if (dragState) {
                  if (dragState.ghost) destroyDragGhost(dragState.ghost);
                  dragState = null;
                  const mp = document.getElementById('modeImgPlace');
                  if (mp) mp.classList.remove('imgplace-dragging');
                  hideTrash();
                }
                pinchState = {
                  placementId: targetPl.id,
                  startDistance: startDist,
                  original: {
                    xMm: targetPl.xMm, yMm: targetPl.yMm,
                    widthMm: targetPl.widthMm, heightMm: targetPl.heightMm
                  }
                };
                selectSingle(targetPl.id);
                renderPlacements();
                return; // ピンチ開始したので通常のドラッグ設定はスキップ
              }
            }
          }

          // Ctrl/Cmd+クリック: 選択トグルのみ（ドラッグ開始しない）
          if (e.ctrlKey || e.metaKey) {
            toggleSelected(pl.id);
            renderPlacements();
            return;
          }

          // 通常クリック: 選択外なら単独選択に置き換え、選択中ならそのまま Primary 更新
          if (!selectedPlacementIds.has(pl.id)) {
            selectSingle(pl.id);
          } else {
            selectedPlacementId = pl.id; // Primary を最新クリックに
          }

          const start = getPagePosMm(e.clientX, e.clientY);
          if (start) {
            const ghostInfo = createDragGhost(pl, img, e.clientX, e.clientY);
            // マルチ選択の場合、Primary 以外の他選択の元位置も記録（一緒に動かすため）
            const multiOriginals = [];
            for (const id of selectedPlacementIds) {
              if (id === pl.id) continue;
              const otherPl = placements.find(p => p.id === id);
              if (otherPl) {
                multiOriginals.push({
                  id: id,
                  xMm: otherPl.xMm,
                  yMm: otherPl.yMm,
                  widthMm: otherPl.widthMm,
                  heightMm: otherPl.heightMm
                });
              }
            }
            dragState = {
              mode: 'move',
              placementId: pl.id,
              startMouseXMm: start.xMm,
              startMouseYMm: start.yMm,
              original: { xMm: pl.xMm, yMm: pl.yMm, widthMm: pl.widthMm, heightMm: pl.heightMm },
              overTrash: false,
              ghost: ghostInfo,
              multiOriginals: multiOriginals
            };
            const modePanel = document.getElementById('modeImgPlace');
            if (modePanel) modePanel.classList.add('imgplace-dragging');
            showTrash();
          }
          renderPlacements();
        });

        // リサイズハンドル（Primary 選択のみ表示）: 四隅 + 四辺中央の計8個
        if (isPrimary && selectedPlacementIds.size === 1) {
          const corners = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];
          for (const corner of corners) {
            const h = document.createElement('div');
            h.className = 'imgplace-resize-handle imgplace-resize-' + corner;
            h.dataset.corner = corner;
            h.addEventListener('pointerdown', (e) => {
              e.preventDefault();
              e.stopPropagation();
              const start = getPagePosMm(e.clientX, e.clientY);
              if (!start) return;
              dragState = {
                mode: 'resize',
                corner: corner,
                placementId: pl.id,
                startMouseXMm: start.xMm,
                startMouseYMm: start.yMm,
                original: { xMm: pl.xMm, yMm: pl.yMm, widthMm: pl.widthMm, heightMm: pl.heightMm }
              };
              const modePanel = document.getElementById('modeImgPlace');
              if (modePanel) modePanel.classList.add('imgplace-dragging');
            });
            el.appendChild(h);
          }
        }

        overlay.appendChild(el);

        // キャプション描画（複数対応・上下スタック、空文字列はスキップ）
        normalizeCaptions(pl);
        if (pl.captions.length > 0) {
          const drawCaption = (cap, yMm) => {
            const sizeMm = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const fontSizePx = Math.max(8, sizeMm * pxPerMm);
            const capEl = document.createElement('div');
            capEl.className = 'imgplace-caption';
            capEl.style.left = (pl.xMm / pageSize.width * 100) + '%';
            capEl.style.top = (yMm / pageSize.height * 100) + '%';
            capEl.style.width = (pl.widthMm / pageSize.width * 100) + '%';
            capEl.style.textAlign = cap.align || 'center';
            capEl.style.fontSize = fontSizePx + 'px';
            capEl.style.fontFamily = captionFont;
            capEl.style.fontWeight = cap.bold ? '700' : '400';
            capEl.textContent = cap.text;
            overlay.appendChild(capEl);
          };
          // 下スタック: 画像下端 + 3mm から下方向へ
          let cursorBelow = pl.yMm + pl.heightMm + 3;
          // 上スタック: 画像上端 - 3mm から上方向へ（先頭が画像に最も近い）
          let cursorAbove = pl.yMm - 3;
          for (const cap of pl.captions) {
            if (!cap.text || !cap.text.trim()) continue;
            const sizeMm = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const heightMm = sizeMm * 1.15;
            const pos = cap.position || 'below';
            if (pos === 'above') {
              // 上配置: heightMm 分を引いた位置に描画
              const yMm = cursorAbove - heightMm;
              drawCaption(cap, yMm);
              cursorAbove = yMm - 1; // 次の上キャプション位置（1mm gap）
            } else {
              drawCaption(cap, cursorBelow);
              cursorBelow += heightMm + 1;
            }
          }
        }
      }
      // スナップガイド線を描画（配置の上に重ねる）
      if (pageSize && activeGuides.length > 0) {
        for (const g of activeGuides) {
          const guideEl = document.createElement('div');
          guideEl.className = 'imgplace-guide imgplace-guide-' + g.type;
          if (g.type === 'v') {
            guideEl.style.left = (g.mm / pageSize.width * 100) + '%';
          } else {
            guideEl.style.top = (g.mm / pageSize.height * 100) + '%';
          }
          overlay.appendChild(guideEl);
        }
      }
      // 選択状態に応じてプロパティパネルも更新
      renderProps();
      // 状態変化を autosave 対象として debounce 登録
      scheduleAutosave();
    }

    // ----- サムネイル一覧 -----
    async function renderThumbnails() {
      pageList.innerHTML = '';
      for (let i = 0; i < pageCount; i++) {
        const wrap = document.createElement('div');
        let cls = 'page-thumb-wrap';
        if (i === currentPageIndex) cls += ' active';
        if (pageSelectedIndices.has(i)) cls += ' page-multi-selected';
        wrap.className = cls;
        wrap.dataset.pageIndex = i;
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('tabindex', '0');
        wrap.setAttribute('aria-label', 'ページ ' + (i + 1));

        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.className = 'page-thumb';

        const label = document.createElement('div');
        label.className = 'page-thumb-label';
        label.textContent = 'P.' + (i + 1);

        // × 削除ボタン (1ページしか無い時は出さない)
        if (pageCount > 1) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'page-thumb-delete';
          delBtn.textContent = '×';
          const pageIdx = i; // closure
          // ボタンのタイトル: マルチ選択中なら一括件数を表示
          const updateDelTitle = () => {
            if (pageSelectedIndices.size > 1 && pageSelectedIndices.has(pageIdx)) {
              delBtn.title = '選択中の ' + pageSelectedIndices.size + ' ページを一括削除';
            } else {
              delBtn.title = 'このページを削除';
            }
          };
          updateDelTitle();
          delBtn.setAttribute('aria-label', 'ページ ' + (i + 1) + ' を削除');
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (pageSelectedIndices.size > 1 && pageSelectedIndices.has(pageIdx)) {
              await deleteMultiplePages(Array.from(pageSelectedIndices));
            } else {
              await deletePage(pageIdx);
            }
          });
          wrap.appendChild(delBtn);
        }

        wrap.appendChild(thumbCanvas);
        wrap.appendChild(label);
        pageList.appendChild(wrap);

        try {
          const page = await pdfjsDoc.getPage(i + 1);
          const vp = page.getViewport({ scale: THUMB_SCALE });
          thumbCanvas.width = Math.ceil(vp.width);
          thumbCanvas.height = Math.ceil(vp.height);
          await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: vp }).promise;
        } catch (err) {
          console.warn('[imgPlace] サムネ描画失敗 P.' + (i + 1), err);
        }

        const handleSelect = (e) => {
          const isCtrl = e && (e.ctrlKey || e.metaKey);
          const isShift = e && e.shiftKey;
          if (isCtrl) {
            // トグル選択 (currentPageIndex は変えない)
            if (pageSelectedIndices.has(i)) pageSelectedIndices.delete(i);
            else pageSelectedIndices.add(i);
            pageLastClickedIndex = i;
            updatePageSelectionDom();
            return;
          }
          if (isShift && pageLastClickedIndex !== null) {
            // 範囲選択
            const lo = Math.min(pageLastClickedIndex, i);
            const hi = Math.max(pageLastClickedIndex, i);
            for (let k = lo; k <= hi; k++) pageSelectedIndices.add(k);
            updatePageSelectionDom();
            return;
          }
          // 通常: 選択クリア → currentPage 切替
          pageSelectedIndices.clear();
          pageLastClickedIndex = i;
          updatePageSelectionDom();
          if (i === currentPageIndex) return;
          currentPageIndex = i;
          pageList.querySelectorAll('.page-thumb-wrap').forEach((el, idx) => {
            el.classList.toggle('active', idx === currentPageIndex);
          });
          renderCurrentPage();
          // 順次配置モード中ならステータス再表示
          if (placeQueueMode && placeQueue.length > 0) {
            setStatus('順次配置: P.' + (currentPageIndex + 1) + ' クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc キャンセル)');
          }
        };
        wrap.addEventListener('click', handleSelect);
        wrap.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleSelect(e);
          }
        });
      }
      // サムネ生成後、配置画像のオーバーレイも非同期で描画開始
      schedulePlacementOverlayAll();
    }

    // ----- サムネに配置画像を反映 (PDFレイヤー上に placements を描き重ね) -----
    // pre-load した HTMLImageElement のキャッシュ (imageId → HTMLImage)
    const thumbImgCache = new Map();
    function loadImageForThumb(imageId) {
      if (thumbImgCache.has(imageId)) {
        const cached = thumbImgCache.get(imageId);
        if (cached.complete) return Promise.resolve(cached);
      }
      const img = imageLibrary.find(im => im.id === imageId);
      if (!img || !img.dataUrl) return Promise.resolve(null);
      return new Promise((resolve) => {
        const el = new Image();
        el.onload = () => { thumbImgCache.set(imageId, el); resolve(el); };
        el.onerror = () => resolve(null);
        el.src = img.dataUrl;
      });
    }
    // 指定ページのサムネに、PDFレイヤー描画 → placements を上に drawImage
    async function renderThumbWithPlacements(pageIndex) {
      if (!pdfjsDoc || !pageList) return;
      const wrap = pageList.querySelector('.page-thumb-wrap[data-page-index="' + pageIndex + '"]');
      if (!wrap) return;
      const canvas = wrap.querySelector('canvas.page-thumb');
      if (!canvas) return;
      try {
        const page = await pdfjsDoc.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: THUMB_SCALE });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const pageSize = pageSizesMm[pageIndex];
        if (!pageSize) return;
        const scale = vp.width / pageSize.width;
        const placementsOnPage = placements.filter(p => p.pageIndex === pageIndex);
        for (const pl of placementsOnPage) {
          const imgEl = await loadImageForThumb(pl.imageId);
          if (!imgEl) continue;
          const x = pl.xMm * scale;
          const y = pl.yMm * scale;
          const w = pl.widthMm * scale;
          const h = pl.heightMm * scale;
          try { ctx.drawImage(imgEl, x, y, w, h); } catch (_) {}
        }
      } catch (e) {
        // pdf.js のレンダ競合等は無視 (次回更新で復帰)
      }
    }
    // debounce 付きで複数ページ同時更新
    let thumbUpdateQueue = new Set();
    let thumbUpdateTimer = null;
    function queueThumbUpdate(pageIndex) {
      if (typeof pageIndex !== 'number' || pageIndex < 0 || pageIndex >= pageCount) return;
      thumbUpdateQueue.add(pageIndex);
      if (thumbUpdateTimer) clearTimeout(thumbUpdateTimer);
      thumbUpdateTimer = setTimeout(async () => {
        const list = Array.from(thumbUpdateQueue);
        thumbUpdateQueue.clear();
        thumbUpdateTimer = null;
        for (const i of list) await renderThumbWithPlacements(i);
      }, 350);
    }
    // 全ページサムネ更新 (renderThumbnails の最後に呼ばれる)
    function schedulePlacementOverlayAll() {
      // 既存サムネをまず PDFのみで素早く表示 → 後で placements を上書き描画
      // 全ページ即時更新 (debounce 通さない)
      (async () => {
        for (let i = 0; i < pageCount; i++) {
          // placements がある or current page のみ更新 (空ページは PDF だけで十分)
          if (i === currentPageIndex || placements.some(p => p.pageIndex === i)) {
            await renderThumbWithPlacements(i);
          }
        }
      })();
    }

    // ----- ページ選択 DOM 更新 (再描画せずクラス切替だけ) -----
    function updatePageSelectionDom() {
      if (!pageList) return;
      pageList.querySelectorAll('.page-thumb-wrap').forEach((el) => {
        const idx = parseInt(el.dataset.pageIndex, 10);
        el.classList.toggle('page-multi-selected', pageSelectedIndices.has(idx));
      });
    }

    // ----- 複数ページ一括削除 -----
    async function deleteMultiplePages(indices) {
      if (!basePdfBytes || !indices || indices.length === 0) return;
      if (indices.length >= pageCount) {
        setStatus('全ページ選択中は一括削除できません (最低1ページ残す)', 'error');
        // 選択も解除して × ボタンのタイトル「N ページ一括削除」誤誘導を消す
        pageSelectedIndices.clear();
        updatePageSelectionDom();
        return;
      }
      // 関連配置/セル件数を集計
      const totalPlaces = placements.filter(p => indices.indexOf(p.pageIndex) !== -1).length;
      const totalCells = indices.reduce((sum, idx) => sum + (customCellsByPage[idx] || []).length, 0);
      let msg = indices.length + ' ページを一括削除しますか?';
      if (totalPlaces || totalCells) {
        msg += '\n(配置画像 ' + totalPlaces + ' 枚 / カスタムセル ' + totalCells + ' 個 もまとめて削除)';
      }
      if (!confirm(msg)) return;
      try {
        const PDFLib = window.PDFLib;
        const doc = await PDFLib.PDFDocument.load(basePdfBytes);
        // 高い index から削除しないと インデックスがずれる
        const sortedDesc = indices.slice().sort((a, b) => b - a);
        for (const idx of sortedDesc) doc.removePage(idx);
        basePdfBytes = (await doc.save()).buffer;
        pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
        pageCount = pdfjsDoc.numPages;
        // pageSizesMm を index 高い順に splice
        for (const idx of sortedDesc) pageSizesMm.splice(idx, 1);
        // 配置: 削除対象ページのものは破棄、それ以外は新インデックスにマップ
        // 新インデックス = 旧インデックス - (自分より小さい削除index の数)
        const sortedAsc = indices.slice().sort((a, b) => a - b);
        const countDeletedBefore = (oldIdx) => sortedAsc.filter(d => d < oldIdx).length;
        placements = placements
          .filter(p => indices.indexOf(p.pageIndex) === -1)
          .map(p => Object.assign({}, p, { pageIndex: p.pageIndex - countDeletedBefore(p.pageIndex) }));
        // customCellsByPage 同様
        const newCells = {};
        for (const k of Object.keys(customCellsByPage)) {
          const ki = parseInt(k, 10);
          if (indices.indexOf(ki) !== -1) continue;
          const newK = ki - countDeletedBefore(ki);
          newCells[newK] = customCellsByPage[k];
        }
        customCellsByPage = newCells;
        // currentPageIndex 調整
        if (indices.indexOf(currentPageIndex) !== -1) {
          // 削除されたページにいた場合、残ったページの中で一番近いものへ
          currentPageIndex = Math.max(0, Math.min(currentPageIndex - countDeletedBefore(currentPageIndex), pageCount - 1));
        } else {
          currentPageIndex -= countDeletedBefore(currentPageIndex);
        }
        // 選択クリア
        pageSelectedIndices.clear();
        pageLastClickedIndex = null;
        clearSelection();
        cachedBasePdfBase64 = null;
        autosaveBaseSha = await sha256Hex(basePdfBytes);
        await renderThumbnails();
        await renderCurrentPage();
        setStatus(indices.length + ' ページを削除 (残り ' + pageCount + ' ページ)');
        scheduleAutosave();
      } catch (err) {
        console.error('[imgPlace] 一括削除失敗:', err);
        setStatus('一括削除失敗: ' + (err.message || err), 'error');
      }
    }

    // ----- ページラバーバンド (リスト空きエリアからドラッグで複数選択) -----
    let pagesRubberState = null;
    if (pageList) {
      pageList.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // ターゲットが pageList 自身か、その直下のテキストノードクリックの場合
        if (e.target !== pageList) return;
        const rect = pageList.getBoundingClientRect();
        const startX = e.clientX - rect.left + pageList.scrollLeft;
        const startY = e.clientY - rect.top + pageList.scrollTop;
        const band = document.createElement('div');
        band.className = 'imgplace-pages-rubberband';
        pageList.appendChild(band);
        pagesRubberState = {
          startX, startY, curX: startX, curY: startY,
          band: band,
          pointerId: e.pointerId,
          additive: e.ctrlKey || e.metaKey || e.shiftKey,
          baselineSet: new Set(pageSelectedIndices)
        };
        try { pageList.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      pageList.addEventListener('pointermove', (e) => {
        if (!pagesRubberState) return;
        const rect = pageList.getBoundingClientRect();
        pagesRubberState.curX = e.clientX - rect.left + pageList.scrollLeft;
        pagesRubberState.curY = e.clientY - rect.top + pageList.scrollTop;
        const s = pagesRubberState;
        const xL = Math.min(s.startX, s.curX);
        const yT = Math.min(s.startY, s.curY);
        const xR = Math.max(s.startX, s.curX);
        const yB = Math.max(s.startY, s.curY);
        s.band.style.left = xL + 'px';
        s.band.style.top = yT + 'px';
        s.band.style.width = (xR - xL) + 'px';
        s.band.style.height = (yB - yT) + 'px';
        // 各ページサムネと交差判定
        const r1 = {
          left: rect.left + xL - pageList.scrollLeft,
          top: rect.top + yT - pageList.scrollTop,
          right: rect.left + xR - pageList.scrollLeft,
          bottom: rect.top + yB - pageList.scrollTop
        };
        const newSel = s.additive ? new Set(s.baselineSet) : new Set();
        pageList.querySelectorAll('.page-thumb-wrap').forEach(el => {
          const ir = el.getBoundingClientRect();
          const hit = !(ir.right < r1.left || ir.left > r1.right || ir.bottom < r1.top || ir.top > r1.bottom);
          if (hit) {
            const idx = parseInt(el.dataset.pageIndex, 10);
            if (!isNaN(idx)) newSel.add(idx);
          }
        });
        pageSelectedIndices = newSel;
        updatePageSelectionDom();
      });
      const endPagesRubber = () => {
        if (!pagesRubberState) return;
        if (pagesRubberState.band && pagesRubberState.band.parentNode) {
          pagesRubberState.band.parentNode.removeChild(pagesRubberState.band);
        }
        pagesRubberState = null;
        if (pageSelectedIndices.size > 1) {
          setStatus(pageSelectedIndices.size + ' ページ選択中 (× で一括削除 / Esc で解除)');
        }
      };
      pageList.addEventListener('pointerup', endPagesRubber);
      pageList.addEventListener('pointercancel', endPagesRubber);
    }

    // ----- ドロップゾーン -----
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadBasePdf(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        loadBasePdf(e.target.files[0]);
        e.target.value = ''; // 同じファイル再選択を許可
      }
    });

    // ----- 画像読込 -----
    // JPEG の SOF マーカーから生のピクセル寸法を取得（EXIF orientation適用前の元寸法）
    function getJpegRawDimensions(buffer) {
      try {
        const view = new DataView(buffer);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return null;
        let offset = 2;
        while (offset < view.byteLength - 1) {
          if (view.getUint8(offset) !== 0xFF) return null;
          const marker = view.getUint16(offset, false);
          offset += 2;
          // SOF0-SOF15 (0xFFC0-0xFFCF) 除く DHT(0xFFC4)・JPG(0xFFC8)・DAC(0xFFCC)
          if (marker >= 0xFFC0 && marker <= 0xFFCF
              && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC) {
            if (offset + 7 > view.byteLength) return null;
            const height = view.getUint16(offset + 3, false);
            const width = view.getUint16(offset + 5, false);
            return { width: width, height: height };
          } else {
            if ((marker & 0xFF00) !== 0xFF00) return null;
            const segLen = view.getUint16(offset, false);
            offset += segLen;
          }
        }
      } catch (e) {
        console.warn('[imgPlace] JPEG SOF parse error:', e);
      }
      return null;
    }

    // JPEG の EXIF orientation タグ (0x0112) を読み取る (1=正、3=180°、6=90°CW、8=90°CCW、他)
    function getJpegOrientation(buffer) {
      try {
        const view = new DataView(buffer);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1;
        let offset = 2;
        while (offset < view.byteLength - 1) {
          if (view.getUint8(offset) !== 0xFF) return 1;
          const marker = view.getUint16(offset, false);
          offset += 2;
          if (marker === 0xFFE1) { // APP1 (EXIF)
            if (offset + 8 > view.byteLength) return 1;
            const segLen = view.getUint16(offset, false);
            if (view.getUint32(offset + 2, false) !== 0x45786966) { // "Exif"
              offset += segLen;
              continue;
            }
            const tiffOffset = offset + 8;
            if (tiffOffset + 8 > view.byteLength) return 1;
            const little = view.getUint16(tiffOffset, false) === 0x4949;
            const ifdOffset = view.getUint32(tiffOffset + 4, little);
            const tagsOffset = tiffOffset + ifdOffset;
            if (tagsOffset + 2 > view.byteLength) return 1;
            const numEntries = view.getUint16(tagsOffset, little);
            for (let i = 0; i < numEntries; i++) {
              const entryOffset = tagsOffset + 2 + i * 12;
              if (entryOffset + 10 > view.byteLength) return 1;
              if (view.getUint16(entryOffset, little) === 0x0112) {
                return view.getUint16(entryOffset + 8, little);
              }
            }
            return 1;
          } else {
            if ((marker & 0xFF00) !== 0xFF00) return 1;
            const segLen = view.getUint16(offset, false);
            offset += segLen;
          }
        }
      } catch (e) {
        console.warn('[imgPlace] EXIF parse error:', e);
      }
      return 1;
    }

    // 画像読込: 'from-image' で正規化済みbitmap取得、SOF寸法と比較して
    // bitmap が raw なら手動回転、auto-rotated ならそのまま使う（両ケース対応）
    async function loadImageFile(file) {
      if (!file) throw new Error('ファイルが空です');
      const isOkType = ACCEPTED_IMG_TYPES.indexOf(file.type) >= 0
        || (file.name && ACCEPTED_IMG_EXT.test(file.name));
      if (!isOkType) throw new Error(file.name + ' はJPG/PNGではありません');
      if (file.size > MAX_IMG_BYTES) throw new Error(file.name + ' は20MBを超えています');
      const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
      const mimeType = isPng ? 'image/png' : 'image/jpeg';

      const buffer = await file.arrayBuffer();
      const orientation = isPng ? 1 : getJpegOrientation(buffer);
      const sofDims = isPng ? null : getJpegRawDimensions(buffer);

      // bitmap 取得（imageOrientation: 'from-image' を試す。ブラウザによっては効かない）
      let source = null, sourceW = 0, sourceH = 0;
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        source = bitmap;
        sourceW = bitmap.width;
        sourceH = bitmap.height;
      } catch (_e) {
        try {
          // options 非対応の古いブラウザ
          const bitmap = await createImageBitmap(file);
          source = bitmap;
          sourceW = bitmap.width;
          sourceH = bitmap.height;
        } catch (_e2) {
          // 最終フォールバック: Image()
          const blob = new Blob([buffer], { type: mimeType });
          const blobUrl = URL.createObjectURL(blob);
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error(file.name + ' を画像として解釈できませんでした'));
            im.src = blobUrl;
          });
          URL.revokeObjectURL(blobUrl);
          source = img;
          sourceW = img.naturalWidth;
          sourceH = img.naturalHeight;
        }
      }

      // bitmap が raw か auto-rotated か判定
      // - 一致(sourceW===sofW && sourceH===sofH) → ブラウザが回転してない → 手動で適用
      // - 入れ替わり(sourceW===sofH && sourceH===sofW) → 既に auto-rotated → そのまま使う
      let bitmapIsRaw = false;
      if (sofDims && orientation >= 5 && orientation <= 8) {
        if (sourceW === sofDims.width && sourceH === sofDims.height) {
          bitmapIsRaw = true; // 'from-image' が効かなかった
        }
      }
      // 180°/flip(orient 2,3,4)は dim 一致判定できないので、'from-image' が動いた前提で何もしない

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let canvasW, canvasH;

      if (bitmapIsRaw) {
        // bitmap は生ピクセル → 手動でEXIF回転を適用
        const swap = orientation >= 5 && orientation <= 8;
        canvasW = swap ? sourceH : sourceW;
        canvasH = swap ? sourceW : sourceH;
        canvas.width = canvasW;
        canvas.height = canvasH;
        switch (orientation) {
          case 3: ctx.translate(canvasW, canvasH); ctx.rotate(Math.PI); break;
          case 6: ctx.translate(canvasW, 0); ctx.rotate(0.5 * Math.PI); break;
          case 8: ctx.translate(0, canvasH); ctx.rotate(-0.5 * Math.PI); break;
          case 2: ctx.translate(canvasW, 0); ctx.scale(-1, 1); break;
          case 4: ctx.translate(0, canvasH); ctx.scale(1, -1); break;
          case 5: ctx.rotate(0.5 * Math.PI); ctx.scale(1, -1); break;
          case 7: ctx.translate(canvasW, 0); ctx.rotate(0.5 * Math.PI); ctx.scale(-1, 1); break;
        }
        ctx.drawImage(source, 0, 0, sourceW, sourceH);
      } else {
        // bitmap は既に正しい向き → そのまま canvas にコピー
        canvasW = sourceW;
        canvasH = sourceH;
        canvas.width = canvasW;
        canvas.height = canvasH;
        ctx.drawImage(source, 0, 0);
      }
      if (source.close) source.close();

      const dataUrl = isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
      return {
        id: 'img_' + (++libSeq),
        filename: file.name,
        mimeType: mimeType,
        dataUrl: dataUrl,
        originalWidthPx: canvasW,
        originalHeightPx: canvasH
      };
    }

    async function addImagesFromFiles(fileListLike) {
      const files = Array.from(fileListLike || []);
      if (!files.length) return;
      const errors = [];
      for (const f of files) {
        try {
          const meta = await loadImageFile(f);
          imageLibrary.push(meta);
        } catch (err) {
          errors.push(err.message || String(err));
        }
      }
      renderLibrary();
      if (errors.length) {
        setStatus('一部読み込めず: ' + errors.join(' / '), 'error');
      }
    }

    // ----- 画像ライブラリ描画 -----
    function renderLibrary() {
      if (!libList) return;
      libList.innerHTML = '';
      // 空かどうかで全体レイアウト切替（empty 時はドロップゾーンが全面に拡張）
      if (libWrap) {
        libWrap.classList.toggle('imgplace-library--empty', imageLibrary.length === 0);
      }
      for (const img of imageLibrary) {
        const item = document.createElement('div');
        item.className = 'imgplace-lib-item';
        item.draggable = true;
        item.dataset.imageId = img.id;
        item.title = img.filename + ' (' + img.originalWidthPx + '×' + img.originalHeightPx + ')';

        const thumb = document.createElement('img');
        thumb.src = img.dataUrl;
        thumb.alt = img.filename;
        item.appendChild(thumb);

        const name = document.createElement('span');
        name.className = 'imgplace-lib-name';
        name.textContent = img.filename;
        item.appendChild(name);

        // 配置済みバッジは B-Gamma で実装、Alpha では仕込みだけ
        const usage = placements.filter(p => p.imageId === img.id).length;
        if (usage > 0) {
          const badge = document.createElement('span');
          badge.className = 'imgplace-lib-badge';
          badge.textContent = usage > 1 ? (usage + '×') : '配置済';
          item.appendChild(badge);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'imgplace-lib-remove';
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', img.filename + ' をライブラリから削除');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          removeLibraryImage(img.id);
        });
        item.appendChild(removeBtn);

        // 複数選択状態を反映
        const selIdx = libSelectedIds.indexOf(img.id);
        if (selIdx !== -1) {
          item.classList.add('lib-selected');
          item.dataset.selOrder = (selIdx + 1);
        }

        // ダブルクリックで現在ページ中央に配置
        item.addEventListener('dblclick', (e) => {
          e.preventDefault();
          placeAtCenter(img.id);
        });

        // クリックで選択 (Ctrl/Cmd = トグル、Shift = 範囲)
        item.addEventListener('click', (e) => {
          // × ボタンクリックは別 handler 経由 (stopPropagation 済)
          handleLibClick(img.id, e);
        });

        // ドラッグ開始: 選択に入ってる場合は全選択をドラッグ、そうでなければ単独
        item.addEventListener('dragstart', (e) => {
          if (libSelectedIds.indexOf(img.id) === -1) {
            // 単独ドラッグ: 選択は触らない (Ctrl 不要で配置できるように)
            draggingLibImageId = img.id;
            if (e.dataTransfer) {
              e.dataTransfer.setData('text/plain', 'imgplace-lib:' + img.id);
              e.dataTransfer.effectAllowed = 'copy';
            }
          } else {
            // 複数ドラッグ
            draggingLibImageId = '__multi__';
            const ids = libSelectedIds.slice();
            if (e.dataTransfer) {
              e.dataTransfer.setData('text/plain', 'imgplace-lib-multi:' + ids.join(','));
              e.dataTransfer.effectAllowed = 'copy';
            }
          }
        });
        item.addEventListener('dragend', () => {
          draggingLibImageId = null;
          if (canvasFrame) canvasFrame.classList.remove('drag-target');
        });

        libList.appendChild(item);
      }
      // 順次配置モードボタン状態を更新
      updatePlaceQueueBtn();
      // ライブラリ変化を autosave 対象として debounce 登録
      scheduleAutosave();
    }

    // クリック時の選択ロジック (Ctrl/Cmd トグル, Shift 範囲, plain は単独選択)
    function handleLibClick(imageId, e) {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      if (isShift && libLastClickedId) {
        // 範囲選択: lastClicked → imageId の間を全部選択 (既存選択は維持)
        const ids = imageLibrary.map(im => im.id);
        const a = ids.indexOf(libLastClickedId);
        const b = ids.indexOf(imageId);
        if (a !== -1 && b !== -1) {
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let k = lo; k <= hi; k++) {
            if (libSelectedIds.indexOf(ids[k]) === -1) libSelectedIds.push(ids[k]);
          }
        }
      } else if (isCtrl) {
        // トグル
        const idx = libSelectedIds.indexOf(imageId);
        if (idx === -1) libSelectedIds.push(imageId);
        else libSelectedIds.splice(idx, 1);
        libLastClickedId = imageId;
      } else {
        // 通常クリック: この1つだけに単独選択 (リセット)
        libSelectedIds = [imageId];
        libLastClickedId = imageId;
      }
      renderLibrary();
    }

    function clearLibSelection() {
      libSelectedIds = [];
      libLastClickedId = null;
      renderLibrary();
    }

    // ----- ライブラリ ラバーバンド選択 (libList 空きエリアからドラッグ) -----
    let libRubberState = null;
    if (libList) {
      libList.addEventListener('pointerdown', (e) => {
        // 左クリックのみ、ターゲットが libList 自身 (アイテムやその子じゃない)
        if (e.button !== 0) return;
        if (e.target !== libList) return;
        const startRect = libList.getBoundingClientRect();
        const startX = e.clientX - startRect.left + libList.scrollLeft;
        const startY = e.clientY - startRect.top + libList.scrollTop;
        const band = document.createElement('div');
        band.className = 'imgplace-lib-rubberband';
        libList.appendChild(band);
        libRubberState = {
          startX, startY, curX: startX, curY: startY,
          band: band,
          pointerId: e.pointerId,
          additive: e.ctrlKey || e.metaKey || e.shiftKey,
          baselineIds: (e.ctrlKey || e.metaKey || e.shiftKey) ? libSelectedIds.slice() : []
        };
        try { libList.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      libList.addEventListener('pointermove', (e) => {
        if (!libRubberState) return;
        const rect = libList.getBoundingClientRect();
        libRubberState.curX = e.clientX - rect.left + libList.scrollLeft;
        libRubberState.curY = e.clientY - rect.top + libList.scrollTop;
        const s = libRubberState;
        const xL = Math.min(s.startX, s.curX);
        const yT = Math.min(s.startY, s.curY);
        const xR = Math.max(s.startX, s.curX);
        const yB = Math.max(s.startY, s.curY);
        s.band.style.left = xL + 'px';
        s.band.style.top = yT + 'px';
        s.band.style.width = (xR - xL) + 'px';
        s.band.style.height = (yB - yT) + 'px';
        // 各 lib-item と交差判定 → libSelectedIds 更新
        const items = libList.querySelectorAll('.imgplace-lib-item');
        const newSel = s.additive ? s.baselineIds.slice() : [];
        items.forEach(it => {
          const ir = it.getBoundingClientRect();
          // ラバーバンド と item の rect が交差してるか (viewport 座標で判定)
          const r1 = {
            left: rect.left + xL - libList.scrollLeft,
            top: rect.top + yT - libList.scrollTop,
            right: rect.left + xR - libList.scrollLeft,
            bottom: rect.top + yB - libList.scrollTop
          };
          const hit = !(ir.right < r1.left || ir.left > r1.right || ir.bottom < r1.top || ir.top > r1.bottom);
          if (hit) {
            const id = it.dataset.imageId;
            if (id && newSel.indexOf(id) === -1) newSel.push(id);
          }
        });
        // 並び順を imageLibrary 順序に揃える (number badge 順序が直感的に)
        const orderMap = new Map(imageLibrary.map((im, i) => [im.id, i]));
        newSel.sort((a, b) => (orderMap.get(a) || 0) - (orderMap.get(b) || 0));
        libSelectedIds = newSel;
        // 軽量再描画: ラバーバンドの上にアイテム視覚状態だけ更新
        items.forEach(it => {
          const id = it.dataset.imageId;
          const selIdx = libSelectedIds.indexOf(id);
          if (selIdx !== -1) {
            it.classList.add('lib-selected');
            it.dataset.selOrder = (selIdx + 1);
          } else {
            it.classList.remove('lib-selected');
            it.removeAttribute('data-sel-order');
          }
        });
      });
      const endRubber = (e) => {
        if (!libRubberState) return;
        if (libRubberState.band && libRubberState.band.parentNode) {
          libRubberState.band.parentNode.removeChild(libRubberState.band);
        }
        libRubberState = null;
        // 順次配置ボタンのラベル更新
        updatePlaceQueueBtn();
      };
      libList.addEventListener('pointerup', endRubber);
      libList.addEventListener('pointercancel', endRubber);
    }

    function removeLibraryImage(imageId) {
      const usage = placements.filter(p => p.imageId === imageId).length;
      if (usage > 0) {
        if (!confirm('この画像はPDF上に ' + usage + ' 枚配置されています。ライブラリから削除すると、配置済みも全て消えます。続行しますか？')) {
          return;
        }
        const removedIds = placements.filter(p => p.imageId === imageId).map(p => p.id);
        placements = placements.filter(p => p.imageId !== imageId);
        // 選択状態クリーンアップ
        for (const rid of removedIds) {
          removeFromSelection(rid);
        }
      }
      imageLibrary = imageLibrary.filter(im => im.id !== imageId);
      // 選択リストからも除外
      libSelectedIds = libSelectedIds.filter(id => id !== imageId);
      if (libLastClickedId === imageId) libLastClickedId = null;
      // 順次配置 Queue にも入ってたら除外
      placeQueue = placeQueue.filter(id => id !== imageId);
      if (placeQueueMode && placeQueue.length === 0) stopPlaceQueueMode('対象画像なし');
      renderLibrary();
      renderPlacements();
    }

    // ----- 初期サイズ計算（72dpi換算 + サイズ上限） -----
    // sizeCapEnabled: true ならページの幅 1/3 + 高さ 1/3 のどちらか厳しい方で縮小
    //                 false なら 72dpi 原寸のまま（ページ幅 100% は超えないよう保険のみ）
    function calcInitialSizeMm(imageMeta) {
      // 72dpi換算: px / 72 * 25.4 = mm (1pt = 1/72 inch, 1mm = 1/25.4 inch)
      let widthMm = imageMeta.originalWidthPx / 72 * 25.4;
      let heightMm = imageMeta.originalHeightPx / 72 * 25.4;
      const pageSize = pageSizesMm[currentPageIndex];
      if (pageSize) {
        if (sizeCapEnabled) {
          // ページの 1/3 を上限に、幅/高さ両軸で厳しい方の比率を採用
          const maxW = pageSize.width / 3;
          const maxH = pageSize.height / 3;
          const ratio = Math.min(1, maxW / widthMm, maxH / heightMm);
          if (ratio < 1) { widthMm *= ratio; heightMm *= ratio; }
        } else {
          // 上限解除時もページ範囲を超えないよう保険 (はみ出し配置防止)
          const ratio = Math.min(1, pageSize.width / widthMm, pageSize.height / heightMm);
          if (ratio < 1) { widthMm *= ratio; heightMm *= ratio; }
        }
      }
      return { widthMm, heightMm };
    }

    // ----- 配置: 現在ページの中央 -----
    function placeAtCenter(imageId) {
      const img = imageLibrary.find(im => im.id === imageId);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!img || !pageSize) return;
      const { widthMm, heightMm } = calcInitialSizeMm(img);
      const xMm = (pageSize.width - widthMm) / 2;
      const yMm = (pageSize.height - heightMm) / 2;
      pushPlacement(img.id, xMm, yMm, widthMm, heightMm);
    }

    // ----- 配置: ドロップ位置を中心に -----
    function placeAtPoint(imageId, dropCenterXMm, dropCenterYMm) {
      const img = imageLibrary.find(im => im.id === imageId);
      const pageSize = pageSizesMm[currentPageIndex];
      if (!img || !pageSize) return;
      const { widthMm, heightMm } = calcInitialSizeMm(img);
      let xMm = dropCenterXMm - widthMm / 2;
      let yMm = dropCenterYMm - heightMm / 2;
      // ページ範囲内にクランプ
      xMm = Math.max(0, Math.min(xMm, pageSize.width - widthMm));
      yMm = Math.max(0, Math.min(yMm, pageSize.height - heightMm));
      pushPlacement(img.id, xMm, yMm, widthMm, heightMm);
    }

    function pushPlacement(imageId, xMm, yMm, widthMm, heightMm) {
      const id = 'pl_' + (++plSeq);
      placements.push({
        id: id,
        pageIndex: currentPageIndex,
        imageId: imageId,
        xMm: xMm,
        yMm: yMm,
        widthMm: widthMm,
        heightMm: heightMm,
        aspectLocked: true,
        captions: [] // 複数キャプション対応（旧 caption: 単一 を置き換え）
      });
      selectSingle(id); // 配置直後は単独選択（既存マルチ選択はリセット）
      renderPlacements();
      renderLibrary();  // バッジ更新
      queueThumbUpdate(currentPageIndex);
    }

    // ----- 画像ライブラリのドロップゾーン配線 -----
    if (libDropzone && libInput) {
      libDropzone.addEventListener('click', () => libInput.click());
      // ドロップゾーン上でホイール → libList にスクロール転送 (画像沢山ある時操作性UP)
      libDropzone.addEventListener('wheel', (e) => {
        if (!libList) return;
        // libList が実際にスクロール可能な時のみ転送 + ページスクロール抑止
        if (libList.scrollHeight > libList.clientHeight) {
          e.preventDefault();
          libList.scrollTop += e.deltaY;
        }
      }, { passive: false });
      libDropzone.addEventListener('dragover', (e) => {
        // ライブラリ自身からのドラッグ（draggingLibImageId）はライブラリへの再ドロップを許可しない
        if (draggingLibImageId) return;
        e.preventDefault();
        libDropzone.classList.add('dragover');
      });
      libDropzone.addEventListener('dragleave', () => libDropzone.classList.remove('dragover'));
      libDropzone.addEventListener('drop', (e) => {
        if (draggingLibImageId) return;
        e.preventDefault();
        libDropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          addImagesFromFiles(e.dataTransfer.files);
        }
      });
      libInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          addImagesFromFiles(e.target.files);
          e.target.value = '';
        }
      });
    }

    // ----- キャンバスへの画像ドロップ（ライブラリからD&D配置） -----
    if (canvasFrame) {
      canvasFrame.addEventListener('dragover', (e) => {
        if (!draggingLibImageId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        canvasFrame.classList.add('drag-target');
      });
      canvasFrame.addEventListener('dragleave', (e) => {
        // canvasFrame 外に出た時のみ解除（子要素間移動を無視）
        if (e.target === canvasFrame) {
          canvasFrame.classList.remove('drag-target');
        }
      });
      canvasFrame.addEventListener('drop', (e) => {
        if (!draggingLibImageId) return;
        e.preventDefault();
        canvasFrame.classList.remove('drag-target');
        const pageSize = pageSizesMm[currentPageIndex];
        if (!pageSize) return;
        const rect = canvasFrame.getBoundingClientRect();
        const xPx = e.clientX - rect.left;
        const yPx = e.clientY - rect.top;
        const xMm = (xPx / rect.width) * pageSize.width;
        const yMm = (yPx / rect.height) * pageSize.height;
        // dataTransfer の中身を見て単一 or 複数 を判別
        const payload = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
        if (payload.startsWith('imgplace-lib-multi:')) {
          const ids = payload.slice('imgplace-lib-multi:'.length).split(',').filter(Boolean);
          // ドロップ点から右下方向に少しずつオフセットして並べる
          const OFFSET_MM = 5;
          ids.forEach((id, i) => {
            placeAtPoint(id, xMm + i * OFFSET_MM, yMm + i * OFFSET_MM);
          });
          setStatus(ids.length + ' 枚を配置 (ドロップ点から右下にオフセット)');
        } else {
          placeAtPoint(draggingLibImageId, xMm, yMm);
        }
        draggingLibImageId = null;
      });

      // 順次配置モード中: canvas クリックで Queue の先頭を配置
      canvasFrame.addEventListener('click', (e) => {
        if (!placeQueueMode || placeQueue.length === 0) return;
        // 配置済み画像クリックや他要素クリックでは反応しない (ターゲット限定)
        if (e.target !== canvasFrame && e.target.tagName !== 'CANVAS') return;
        const pos = getPagePosMm(e.clientX, e.clientY);
        if (!pos) return;
        const nextId = placeQueue.shift();
        placeAtPoint(nextId, pos.xMm, pos.yMm);
        if (placeQueue.length === 0) {
          stopPlaceQueueMode('全て配置完了');
        } else {
          setStatus('順次配置: クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc でキャンセル)');
          updateQueuePreviewContent(); // 次の画像のプレビューに切替
        }
      });
      // canvas 上で pointer 動いたらプレビュー追従
      canvasFrame.addEventListener('pointermove', (e) => {
        if (placeQueueMode && placeQueue.length > 0) {
          moveQueuePreview(e.clientX, e.clientY);
        }
      });
      canvasFrame.addEventListener('pointerleave', () => {
        if (placeQueueMode) hideQueuePreview();
      });
    }
    // 順次配置モード制御
    function startPlaceQueueMode() {
      if (libSelectedIds.length === 0) {
        setStatus('画像ライブラリで配置したい画像を選択してください', 'error');
        return;
      }
      placeQueue = libSelectedIds.slice();
      placeQueueMode = true;
      const mode = document.getElementById('modeImgPlace');
      if (mode) mode.classList.add('imgplace-place-queue-mode');
      setStatus('順次配置: クリックで次を配置 (残り ' + placeQueue.length + ' 枚 / Esc でキャンセル)');
      updatePlaceQueueBtn();
      updateQueuePreviewContent(); // 1枚目のプレビュー内容セット
    }
    function stopPlaceQueueMode(reason) {
      placeQueue = [];
      placeQueueMode = false;
      const mode = document.getElementById('modeImgPlace');
      if (mode) mode.classList.remove('imgplace-place-queue-mode');
      setStatus(reason || '順次配置モード終了');
      updatePlaceQueueBtn();
      hideQueuePreview();
    }
    // ----- 順次配置プレビュー (カーソル追従、サムネ+ファイル名) -----
    function updateQueuePreviewContent() {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (!el) return;
      if (!placeQueueMode || placeQueue.length === 0) {
        el.classList.remove('visible');
        return;
      }
      const nextId = placeQueue[0];
      const img = imageLibrary.find(im => im.id === nextId);
      if (!img) { el.classList.remove('visible'); return; }
      const imgEl = document.getElementById('imgPlaceQueuePreviewImg');
      const nameEl = document.getElementById('imgPlaceQueuePreviewName');
      const metaEl = document.getElementById('imgPlaceQueuePreviewMeta');
      if (imgEl) imgEl.src = img.dataUrl;
      if (nameEl) nameEl.textContent = img.filename;
      if (metaEl) {
        const orderInfo = (libSelectedIds.length - placeQueue.length + 1) + '/' + libSelectedIds.length;
        metaEl.textContent = '次 ' + orderInfo + ' · ' + img.originalWidthPx + '×' + img.originalHeightPx;
      }
      // 表示は pointermove で起動 (canvas に入った時)
    }
    function hideQueuePreview() {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (el) el.classList.remove('visible');
    }
    function moveQueuePreview(clientX, clientY) {
      const el = document.getElementById('imgPlaceQueuePreview');
      if (!el || !placeQueueMode || placeQueue.length === 0) return;
      el.classList.add('visible');
      // カーソル右下に少しオフセット (カーソル隠さないよう)
      const offsetX = 18, offsetY = 18;
      // 画面端近くなら左/上に反転
      const w = el.offsetWidth || 260, h = el.offsetHeight || 76;
      let x = clientX + offsetX;
      let y = clientY + offsetY;
      if (x + w > window.innerWidth) x = clientX - w - 8;
      if (y + h > window.innerHeight) y = clientY - h - 8;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }
    // 順次配置ボタンの表示・ラベル更新
    function updatePlaceQueueBtn() {
      const btn = document.getElementById('imgPlacePlaceQueueBtn');
      if (!btn) return;
      if (placeQueueMode) {
        btn.textContent = '⏹ 順次配置中止 (残り' + placeQueue.length + ')';
        btn.dataset.active = 'on';
        btn.style.display = '';
      } else if (libSelectedIds.length > 0) {
        btn.textContent = '🎯 順次配置 (' + libSelectedIds.length + '枚)';
        btn.dataset.active = 'off';
        btn.style.display = '';
      } else {
        btn.style.display = 'none';
      }
    }
    // Esc キーで順次配置キャンセル + 複数選択解除 (lib / pages)
    window.addEventListener('keydown', (e) => {
      const panel = document.getElementById('modeImgPlace');
      if (!panel || !panel.classList.contains('active')) return;
      if (e.key === 'Escape') {
        if (placeQueueMode) {
          stopPlaceQueueMode('順次配置キャンセル');
        } else if (libSelectedIds.length > 0) {
          clearLibSelection();
        } else if (pageSelectedIndices.size > 0) {
          pageSelectedIndices.clear();
          pageLastClickedIndex = null;
          updatePageSelectionDom();
          setStatus('');
        }
      }
    });

    // ----- ラバーバンド選択 -----
    function startRubberBand(e) {
      const start = getPagePosMm(e.clientX, e.clientY);
      if (!start) return;
      rubberState = {
        startXMm: start.xMm,
        startYMm: start.yMm,
        startClientX: e.clientX,
        startClientY: e.clientY,
        lastXMm: start.xMm,
        lastYMm: start.yMm,
        moved: false,
        el: null,
        // Shift 押下中は既存選択に追加、それ以外は置換
        addMode: !!e.shiftKey
      };
    }
    function updateRubberBand(e) {
      if (!rubberState) return;
      const dx = Math.abs(e.clientX - rubberState.startClientX);
      const dy = Math.abs(e.clientY - rubberState.startClientY);
      if (!rubberState.moved && (dx > 3 || dy > 3)) {
        rubberState.moved = true;
        rubberState.el = document.createElement('div');
        rubberState.el.className = 'imgplace-rubber';
        overlay.appendChild(rubberState.el);
      }
      if (rubberState.moved) {
        const cur = getPagePosMm(e.clientX, e.clientY);
        if (!cur) return;
        rubberState.lastXMm = cur.xMm;
        rubberState.lastYMm = cur.yMm;
        const pageSize = pageSizesMm[currentPageIndex];
        if (pageSize && rubberState.el) {
          const x1 = Math.min(rubberState.startXMm, cur.xMm);
          const y1 = Math.min(rubberState.startYMm, cur.yMm);
          const x2 = Math.max(rubberState.startXMm, cur.xMm);
          const y2 = Math.max(rubberState.startYMm, cur.yMm);
          rubberState.el.style.left = (x1 / pageSize.width * 100) + '%';
          rubberState.el.style.top = (y1 / pageSize.height * 100) + '%';
          rubberState.el.style.width = ((x2 - x1) / pageSize.width * 100) + '%';
          rubberState.el.style.height = ((y2 - y1) / pageSize.height * 100) + '%';
        }
      }
    }
    function completeRubberBand() {
      if (!rubberState) return;
      if (rubberState.moved) {
        // 矩形と交差する全配置を取得
        const x1 = Math.min(rubberState.startXMm, rubberState.lastXMm);
        const y1 = Math.min(rubberState.startYMm, rubberState.lastYMm);
        const x2 = Math.max(rubberState.startXMm, rubberState.lastXMm);
        const y2 = Math.max(rubberState.startYMm, rubberState.lastYMm);
        const insideIds = placements
          .filter(p =>
            p.pageIndex === currentPageIndex &&
            p.xMm < x2 && p.xMm + p.widthMm > x1 &&
            p.yMm < y2 && p.yMm + p.heightMm > y1
          )
          .map(p => p.id);
        if (!rubberState.addMode) {
          selectedPlacementIds = new Set();
        }
        for (const id of insideIds) {
          selectedPlacementIds.add(id);
        }
        if (insideIds.length > 0) {
          selectedPlacementId = insideIds[insideIds.length - 1];
        } else if (selectedPlacementIds.size === 0) {
          selectedPlacementId = null;
        }
      } else {
        // 動いてない＝ただのクリック → 選択クリア（Shift時は維持）
        if (!rubberState.addMode) {
          clearSelection();
        }
      }
      if (rubberState.el && rubberState.el.parentNode) {
        rubberState.el.parentNode.removeChild(rubberState.el);
      }
      rubberState = null;
      renderPlacements();
    }

    // ----- 背景クリック/ドラッグでラバーバンド開始 -----
    if (canvasFrame) {
      canvasFrame.addEventListener('pointerdown', (e) => {
        // canvas / overlay 直接クリック時のみ（placement・ハンドルは stopPropagation 済）
        if (e.target === canvasFrame || e.target === canvas || e.target === overlay) {
          startRubberBand(e);
        }
      });
    }

    // ----- ドラッグ追従: window.pointermove -----
    window.addEventListener('pointermove', (e) => {
      // タッチ位置追跡 + ピンチリサイズ適用（最優先、他のドラッグより前）
      if (e.pointerType === 'touch') {
        const ent = activeTouches.get(e.pointerId);
        if (ent) {
          ent.clientX = e.clientX;
          ent.clientY = e.clientY;
        }
        if (pinchState && activeTouches.size >= 2) {
          const pts = [...activeTouches.values()].slice(0, 2);
          const dx = pts[1].clientX - pts[0].clientX;
          const dy = pts[1].clientY - pts[0].clientY;
          const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const scale = dist / pinchState.startDistance;
          const pl = placements.find(p => p.id === pinchState.placementId);
          if (pl) {
            const MIN_MM = 5;
            const newW = Math.max(MIN_MM, pinchState.original.widthMm * scale);
            const newH = Math.max(MIN_MM, pinchState.original.heightMm * scale);
            pl.widthMm = newW;
            pl.heightMm = newH;
            // 中心固定: 元の center が変わらないよう xMm/yMm を補正
            pl.xMm = pinchState.original.xMm + (pinchState.original.widthMm - newW) / 2;
            pl.yMm = pinchState.original.yMm + (pinchState.original.heightMm - newH) / 2;
            renderPlacements();
          }
          return; // 他のドラッグ処理スキップ
        }
      }
      // ラバーバンド進行中は他のドラッグロジックを bypass
      if (rubberState) {
        updateRubberBand(e);
        return;
      }
      if (!dragState) return;
      // 移動モード中はゴミ箱との重なり判定（カーソル基準、ゴースト位置は後でスナップ後の配置に追従させる）
      if (dragState.mode === 'move') {
        const over = isOverTrash(e.clientX, e.clientY);
        dragState.overTrash = over;
        if (trashEl) trashEl.classList.toggle('hover', over);
        if (dragState.ghost && dragState.ghost.ghost) {
          dragState.ghost.ghost.classList.toggle('over-trash', over);
        }
      }
      const current = getPagePosMm(e.clientX, e.clientY);
      if (!current) return;
      const pl = placements.find(p => p.id === dragState.placementId);
      if (!pl) return;
      if (dragState.mode === 'move') {
        let dx = current.xMm - dragState.startMouseXMm;
        let dy = current.yMm - dragState.startMouseYMm;
        // Shift拘束: 大きい方の軸だけ採用（水平または垂直のみ移動）
        // マルチドラッグでも primary の dx/dy が拘束されると、後段の dxApplied/dyApplied 経由で全選択に伝搬
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const pageSize = pageSizesMm[pl.pageIndex];
        let newX = dragState.original.xMm + dx;
        let newY = dragState.original.yMm + dy;
        // スナップ適用（clamp の前に行う）
        if (snapEnabled) {
          const snap = computeSnapForMove(newX, newY, dragState.original.widthMm, dragState.original.heightMm);
          newX += snap.dx;
          newY += snap.dy;
          activeGuides = snap.guides;
          // セルスナップ中ならハイライト
          if (snap.cell !== activeSnapCell) {
            activeSnapCell = snap.cell || null;
            updateActiveSnapCellOverlay();
          }
        } else {
          activeGuides = [];
          if (activeSnapCell) {
            activeSnapCell = null;
            updateActiveSnapCellOverlay();
          }
        }
        // ページ範囲内にクランプ（移動時のみ）
        if (pageSize) {
          newX = Math.max(0, Math.min(newX, pageSize.width - dragState.original.widthMm));
          newY = Math.max(0, Math.min(newY, pageSize.height - dragState.original.heightMm));
        }
        pl.xMm = newX;
        pl.yMm = newY;
        // マルチドラッグ: 他選択も同 delta（Primary の実移動量）で移動、それぞれページ範囲内にクランプ
        if (dragState.multiOriginals && dragState.multiOriginals.length > 0) {
          const dxApplied = pl.xMm - dragState.original.xMm;
          const dyApplied = pl.yMm - dragState.original.yMm;
          for (const m of dragState.multiOriginals) {
            const otherPl = placements.find(p => p.id === m.id);
            if (!otherPl) continue;
            let newOX = m.xMm + dxApplied;
            let newOY = m.yMm + dyApplied;
            if (pageSize) {
              newOX = Math.max(0, Math.min(newOX, pageSize.width - m.widthMm));
              newOY = Math.max(0, Math.min(newOY, pageSize.height - m.heightMm));
            }
            otherPl.xMm = newOX;
            otherPl.yMm = newOY;
          }
        }
        // ゴーストの位置決め: ハイブリッド方式
        // - カーソルが canvas-frame 内: スナップ後の配置位置に追従（ヘリ/中心がガイドに吸付く視覚）
        // - カーソルが canvas-frame 外: カーソルに自由追従（ゴミ箱までドラッグ可能に）
        if (dragState.ghost && dragState.ghost.ghost && pageSize) {
          const frameRect = canvasFrame.getBoundingClientRect();
          const cursorOutside = (e.clientX < frameRect.left) || (e.clientX > frameRect.right)
                              || (e.clientY < frameRect.top)  || (e.clientY > frameRect.bottom);
          if (cursorOutside) {
            // 自由追従（drag start 時に記録した cursor-to-image オフセットを保ったまま）
            dragState.ghost.ghost.style.left = (e.clientX - dragState.ghost.offsetX) + 'px';
            dragState.ghost.ghost.style.top  = (e.clientY - dragState.ghost.offsetY) + 'px';
          } else if (frameRect.width > 0) {
            const plLeftPx = frameRect.left + pl.xMm / pageSize.width * frameRect.width;
            const plTopPx  = frameRect.top  + pl.yMm / pageSize.height * frameRect.height;
            dragState.ghost.ghost.style.left = plLeftPx + 'px';
            dragState.ghost.ghost.style.top  = plTopPx  + 'px';
          }
        }
      } else if (dragState.mode === 'resize') {
        // デフォルトのアスペクト比固定 (pl.aspectLocked) を Shift で一時反転
        const lockDefault = pl.aspectLocked !== false;
        const lockAspect = lockDefault !== !!e.shiftKey;
        const r = applyResize(dragState.corner, current.xMm, current.yMm, dragState.original, lockAspect);
        pl.xMm = r.xMm;
        pl.yMm = r.yMm;
        pl.widthMm = r.widthMm;
        pl.heightMm = r.heightMm;
        // スナップは AR 非固定時のみ適用（固定時は比率が崩れるので無効化）
        if (snapEnabled && !lockAspect) {
          const rect = {
            left: pl.xMm,
            top: pl.yMm,
            right: pl.xMm + pl.widthMm,
            bottom: pl.yMm + pl.heightMm
          };
          const snap = computeSnapForResize(dragState.corner, rect);
          const cornerNow = dragState.corner;
          const isLeftNow   = cornerNow === 'nw' || cornerNow === 'sw' || cornerNow === 'w';
          const isTopNow    = cornerNow === 'nw' || cornerNow === 'ne' || cornerNow === 'n';
          if (snap.snapX) {
            if (snap.snapX.edge === 'left') {
              pl.xMm = snap.snapX.target;
              pl.widthMm -= snap.snapX.delta;
            } else if (snap.snapX.edge === 'right') {
              pl.widthMm += snap.snapX.delta;
            } else if (snap.snapX.edge === 'centerX') {
              // 中心線スナップ: 動いてない側を anchor として反対側を調整
              if (isLeftNow) {
                const rightAnchor = pl.xMm + pl.widthMm;
                const newLeft = 2 * snap.snapX.target - rightAnchor;
                pl.widthMm = rightAnchor - newLeft;
                pl.xMm = newLeft;
              } else { // 右が動く（'ne'/'se'/'e'）
                const leftAnchor = pl.xMm;
                const newRight = 2 * snap.snapX.target - leftAnchor;
                pl.widthMm = newRight - leftAnchor;
              }
            }
          }
          if (snap.snapY) {
            if (snap.snapY.edge === 'top') {
              pl.yMm = snap.snapY.target;
              pl.heightMm -= snap.snapY.delta;
            } else if (snap.snapY.edge === 'bottom') {
              pl.heightMm += snap.snapY.delta;
            } else if (snap.snapY.edge === 'centerY') {
              if (isTopNow) {
                const bottomAnchor = pl.yMm + pl.heightMm;
                const newTop = 2 * snap.snapY.target - bottomAnchor;
                pl.heightMm = bottomAnchor - newTop;
                pl.yMm = newTop;
              } else {
                const topAnchor = pl.yMm;
                const newBottom = 2 * snap.snapY.target - topAnchor;
                pl.heightMm = newBottom - topAnchor;
              }
            }
          }
          activeGuides = snap.guides;
        } else {
          activeGuides = [];
        }
      }
      renderPlacements();
    });

    // ----- ドラッグ終了（ゴミ箱判定込み） -----
    function endDrag() {
      if (!dragState) return;
      // ゴミ箱上で離した場合は削除
      const deleteId = (dragState.mode === 'move' && dragState.overTrash) ? dragState.placementId : null;
      // マルチ選択時は選択中の全配置を削除対象に
      let deleteIds = [];
      if (deleteId) {
        if (selectedPlacementIds && selectedPlacementIds.size > 1 && selectedPlacementIds.has(deleteId)) {
          deleteIds = Array.from(selectedPlacementIds);
        } else {
          deleteIds = [deleteId];
        }
      }
      // ゴースト破棄
      if (dragState.ghost) destroyDragGhost(dragState.ghost);
      dragState = null;
      // スナップガイド + セルハイライトもクリア
      activeGuides = [];
      if (activeSnapCell) {
        activeSnapCell = null;
        updateActiveSnapCellOverlay();
      }
      const modePanel = document.getElementById('modeImgPlace');
      if (modePanel) modePanel.classList.remove('imgplace-dragging');
      hideTrash();
      if (deleteIds.length > 0) {
        for (const id of deleteIds) deletePlacement(id); // 各 deletePlacement 内で renderPlacements が呼ばれるが、軽量なのでOK
        if (deleteIds.length > 1) setStatus(deleteIds.length + ' 個の配置を削除');
      } else {
        renderPlacements(); // dragging-source クラス除去とガイドクリアのため再描画
        // 移動/リサイズ commit 後にもサムネ更新 (位置・サイズ変化反映)
        queueThumbUpdate(currentPageIndex);
      }
    }
    function endPointerInteraction(e) {
      // タッチの up/cancel: activeTouches から削除、pinch 終了判定
      if (e && e.pointerType === 'touch') {
        activeTouches.delete(e.pointerId);
        if (pinchState && activeTouches.size < 2) {
          // ピンチ終了（残り 1 本指でも自動でドラッグに移行はしない、一度離してから再開）
          pinchState = null;
          return;
        }
      }
      if (rubberState) {
        completeRubberBand();
        return;
      }
      endDrag();
    }
    window.addEventListener('pointerup', endPointerInteraction);
    window.addEventListener('pointercancel', endPointerInteraction);

    // ----- キーボード: Delete / Backspace で選択中の配置を削除 -----
    window.addEventListener('keydown', (e) => {
      // 画像配置タブが active な時のみ反応
      const panel = document.getElementById('modeImgPlace');
      if (!panel || !panel.classList.contains('active')) return;
      // 入力フィールドにフォーカス中は無視
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPlacementIds.size > 0) {
        e.preventDefault();
        deleteSelected(); // マルチ選択時は全部削除
      }
    });

    // ----- Lv.2: 罫線スナップトグルボタン -----
    // ON: 現ページの罫線を抽出 → SVGで可視化 + スナップ対象に登録
    // OFF: オーバーレイクリア + detectedSnapTargets を null に
    if (lineDetectBtn) {
      lineDetectBtn.addEventListener('click', async () => {
        lineDetectionEnabled = !lineDetectionEnabled;
        lineDetectBtn.dataset.active = lineDetectionEnabled ? 'on' : 'off';
        lineDetectBtn.textContent = lineDetectionEnabled ? '📐 罫線スナップ ON' : '📐 罫線スナップ OFF';
        if (linesOverlay) linesOverlay.classList.toggle('visible', lineDetectionEnabled);
        // 即時に現ページを再解析
        if (lineDetectionEnabled && pdfjsDoc) {
          try {
            const page = await pdfjsDoc.getPage(currentPageIndex + 1);
            const lineData = await extractPageLines(page);
            detectedSnapTargets = buildDetectedSnapTargets(lineData, page);
            renderLineOverlay(lineData, page, detectedSnapTargets);
          } catch (err) {
            console.warn('[imgPlace] 罫線検出失敗:', err);
            setStatus('罫線検出失敗: ' + (err.message || err), 'error');
            detectedSnapTargets = null;
          }
        } else {
          // OFF時はオーバーレイ中身クリア + スナップ対象も解除
          if (linesOverlay) {
            while (linesOverlay.firstChild) linesOverlay.removeChild(linesOverlay.firstChild);
          }
          detectedSnapTargets = null;
        }
      });
    }

    // ----- 1/3 サイズ制限トグルボタン -----
    const sizeCapBtn = document.getElementById('imgPlaceSizeCapBtn');
    function applySizeCapBtnState() {
      if (!sizeCapBtn) return;
      sizeCapBtn.dataset.active = sizeCapEnabled ? 'on' : 'off';
      sizeCapBtn.textContent = sizeCapEnabled ? '📏 1/3制限 ON' : '📏 1/3制限 OFF';
    }
    applySizeCapBtnState();
    if (sizeCapBtn) {
      sizeCapBtn.addEventListener('click', () => {
        sizeCapEnabled = !sizeCapEnabled;
        try { localStorage.setItem('imgPlaceSizeCap', sizeCapEnabled ? 'on' : 'off'); } catch (_e) {}
        applySizeCapBtnState();
        setStatus(sizeCapEnabled
          ? '配置サイズ上限: ページの1/3 (以降の配置に適用)'
          : '配置サイズ上限: なし (原寸 / ページ範囲内のみ保険)');
      });
    }

    // ----- カスタムセル トグル + 描画 / 削除 -----
    // ----- 列幅スプリッター: 左/右ペインの幅をドラッグで可変、localStorage 永続化 -----
    (function setupSplitters() {
      const editor = document.querySelector('#modeImgPlace .imgplace-editor');
      const leftSp = document.getElementById('imgPlaceSplitterLeft');
      const rightSp = document.getElementById('imgPlaceSplitterRight');
      if (!editor) return;
      // localStorage から復元 (初回は default)
      try {
        const lw = localStorage.getItem('imgPlaceLeftW');
        const rw = localStorage.getItem('imgPlaceRightW');
        if (lw && /^\d+px$/.test(lw)) editor.style.setProperty('--imgplace-left', lw);
        if (rw && /^\d+px$/.test(rw)) editor.style.setProperty('--imgplace-right', rw);
      } catch (_e) {}
      const MIN_LEFT = 80;
      const MIN_RIGHT = 160;
      function attach(sp, side) {
        if (!sp) return;
        sp.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          try { sp.setPointerCapture(e.pointerId); } catch (_) {}
          sp.classList.add('dragging');
          document.body.style.cursor = 'col-resize';
          const startX = e.clientX;
          const editorRect = editor.getBoundingClientRect();
          const cs = getComputedStyle(editor);
          const initLeft = parseFloat(cs.getPropertyValue('--imgplace-left')) || 180;
          const initRight = parseFloat(cs.getPropertyValue('--imgplace-right')) || 280;
          // canvas 列が小さくなりすぎないよう、左右合計の上限を editor 幅の80%にキャップ
          const maxSumW = editorRect.width * 0.8;
          function onMove(ev) {
            const dx = ev.clientX - startX;
            if (side === 'left') {
              let w = Math.max(MIN_LEFT, initLeft + dx);
              // 右ペインが現状幅のとき、左+右が maxSumW を超えないよう抑制
              if (w + initRight > maxSumW) w = maxSumW - initRight;
              editor.style.setProperty('--imgplace-left', w + 'px');
            } else {
              let w = Math.max(MIN_RIGHT, initRight - dx);
              if (initLeft + w > maxSumW) w = maxSumW - initLeft;
              editor.style.setProperty('--imgplace-right', w + 'px');
            }
          }
          function onEnd() {
            sp.classList.remove('dragging');
            document.body.style.cursor = '';
            sp.removeEventListener('pointermove', onMove);
            sp.removeEventListener('pointerup', onEnd);
            sp.removeEventListener('pointercancel', onEnd);
            try {
              const cur = getComputedStyle(editor);
              const lw = cur.getPropertyValue('--imgplace-left').trim();
              const rw = cur.getPropertyValue('--imgplace-right').trim();
              if (lw) localStorage.setItem('imgPlaceLeftW', lw);
              if (rw) localStorage.setItem('imgPlaceRightW', rw);
            } catch (_) {}
          }
          sp.addEventListener('pointermove', onMove);
          sp.addEventListener('pointerup', onEnd);
          sp.addEventListener('pointercancel', onEnd);
        });
      }
      attach(leftSp, 'left');
      attach(rightSp, 'right');

      // ウィンドウ縮小時、固定値の左/右ペインが canvas を潰しすぎないよう比例縮小
      function clampColumnsToViewport() {
        const W = editor.clientWidth;
        if (W < 100) return;
        const MIN_CANVAS = 280;
        const SPLITTER_TOTAL = 12;
        const maxSum = W - MIN_CANVAS - SPLITTER_TOTAL;
        const cs2 = getComputedStyle(editor);
        const leftStr = cs2.getPropertyValue('--imgplace-left').trim();
        const rightStr = cs2.getPropertyValue('--imgplace-right').trim();
        // ユーザーが固定値 (px) に設定済の時のみ介入。clamp() デフォルトはそのまま CSS に任せる
        const leftFixed = leftStr.match(/^(\d+(?:\.\d+)?)px$/);
        const rightFixed = rightStr.match(/^(\d+(?:\.\d+)?)px$/);
        if (!leftFixed && !rightFixed) return;
        const lv = leftFixed ? parseFloat(leftFixed[1]) : 0;
        const rv = rightFixed ? parseFloat(rightFixed[1]) : 0;
        if (lv + rv > maxSum && maxSum > 0) {
          const ratio = maxSum / (lv + rv);
          if (leftFixed) editor.style.setProperty('--imgplace-left', Math.max(80, Math.round(lv * ratio)) + 'px');
          if (rightFixed) editor.style.setProperty('--imgplace-right', Math.max(160, Math.round(rv * ratio)) + 'px');
        }
      }
      window.addEventListener('resize', clampColumnsToViewport);
      // 初回 + editor サイズ変化時にも実行
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => clampColumnsToViewport());
        ro.observe(editor);
      }
      clampColumnsToViewport();
    })();

    // ----- 右サイドバー 上下スプリッター: props ↔ library -----
    (function setupSidebarSplitter() {
      const sidebar = document.querySelector('#modeImgPlace .imgplace-sidebar');
      const sp = document.getElementById('imgPlaceSidebarSplitter');
      const propsEl = document.getElementById('imgPlaceProps');
      if (!sidebar || !sp || !propsEl) return;
      // localStorage から復元
      try {
        const ph = localStorage.getItem('imgPlacePropsH');
        if (ph && /^\d+px$/.test(ph)) sidebar.style.setProperty('--imgplace-props-h', ph);
      } catch (_e) {}
      const MIN_PROPS = 60;
      const MIN_LIB = 120;
      sp.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { sp.setPointerCapture(e.pointerId); } catch (_) {}
        sp.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        const startY = e.clientY;
        // 自然コンテンツ高さを測る: CSS var を一時クリア → auto に戻る → 測定 → 復元
        // ※同一 JS 同期実行なので画面チラつき無し
        const savedVar = sidebar.style.getPropertyValue('--imgplace-props-h');
        sidebar.style.removeProperty('--imgplace-props-h');
        const naturalH = propsEl.offsetHeight;
        if (savedVar) sidebar.style.setProperty('--imgplace-props-h', savedVar);
        const propsRect = propsEl.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const initH = propsRect.height;
        // sidebar 余裕: 全高 - MIN_LIB - splitter - gap
        const maxBySidebar = sidebarRect.height - MIN_LIB - 6 - 12;
        // コンテンツ自然サイズで cap (これ以上広げても中身ないので無意味)
        const maxByContent = naturalH;
        const maxH = Math.max(MIN_PROPS, Math.min(maxBySidebar, maxByContent));
        function onMove(ev) {
          const dy = ev.clientY - startY;
          let h = Math.max(MIN_PROPS, Math.min(maxH, initH + dy));
          sidebar.style.setProperty('--imgplace-props-h', h + 'px');
        }
        function onEnd() {
          sp.classList.remove('dragging');
          document.body.style.cursor = '';
          sp.removeEventListener('pointermove', onMove);
          sp.removeEventListener('pointerup', onEnd);
          sp.removeEventListener('pointercancel', onEnd);
          try {
            const ph = getComputedStyle(sidebar).getPropertyValue('--imgplace-props-h').trim();
            if (ph) localStorage.setItem('imgPlacePropsH', ph);
          } catch (_) {}
        }
        sp.addEventListener('pointermove', onMove);
        sp.addEventListener('pointerup', onEnd);
        sp.addEventListener('pointercancel', onEnd);
      });

      // sidebar 高さが縮んだ時、固定 props 高さがライブラリを潰さないよう再 clamp
      function clampSidebarToViewport() {
        const H = sidebar.clientHeight;
        if (H < 100) return;
        const cs3 = getComputedStyle(sidebar);
        const phStr = cs3.getPropertyValue('--imgplace-props-h').trim();
        const phFixed = phStr.match(/^(\d+(?:\.\d+)?)px$/);
        if (!phFixed) return;
        const ph = parseFloat(phFixed[1]);
        const maxAllow = H - MIN_LIB - 6 - 12;
        if (ph > maxAllow && maxAllow > MIN_PROPS) {
          sidebar.style.setProperty('--imgplace-props-h', Math.round(maxAllow) + 'px');
        }
      }
      window.addEventListener('resize', clampSidebarToViewport);
      if (typeof ResizeObserver === 'function') {
        const ro2 = new ResizeObserver(() => clampSidebarToViewport());
        ro2.observe(sidebar);
      }
      clampSidebarToViewport();
    })();

    // ----- カスタムセル トグル + 描画 / 削除 -----
    // ON: ドラッグで矩形追加 / 既存矩形クリックで削除
    // OFF: 編集不可だがスナップ対象としては有効
    const customCellBtn = document.getElementById('imgPlaceCustomCellBtn');
    const customCellLayer = document.getElementById('imgPlaceCustomCellLayer');
    if (customCellBtn && customCellLayer) {
      customCellBtn.addEventListener('click', () => {
        customCellModeOn = !customCellModeOn;
        customCellBtn.dataset.active = customCellModeOn ? 'on' : 'off';
        customCellBtn.textContent = customCellModeOn ? '✏️ カスタムセル ON' : '✏️ カスタムセル OFF';
        customCellLayer.classList.toggle('active', customCellModeOn);
        // ON 直後に既存セルを再描画（hover/title が変わる）
        renderCustomCells();
        if (customCellModeOn) {
          setStatus('カスタムセル: ドラッグで追加 / 隅でリサイズ / 本体ドラッグで移動 / × 削除 / + 複製');
        } else {
          clearAlignmentGuides();
          setStatus('');
        }
      });

      // 描画: layer 自身への pointerdown のみ（既存セル div への click は別 handler）
      customCellLayer.addEventListener('pointerdown', (e) => {
        if (!customCellModeOn) return;
        if (e.target !== customCellLayer) return; // 既存セル click は放置
        const startRaw = getPagePosMm(e.clientX, e.clientY);
        if (!startRaw) return;
        // 検出罫線 + 他カスタムセルエッジへのスナップ (始点)
        const startSnap = computeCustomCellSnap([startRaw.xMm], [startRaw.yMm], null);
        const startX = startRaw.xMm + startSnap.dx;
        const startY = startRaw.yMm + startSnap.dy;
        const preview = document.createElement('div');
        preview.className = 'imgplace-custom-cell-preview';
        customCellLayer.appendChild(preview);
        customCellDrawState = {
          startX: startX, startY: startY,
          curX: startX,   curY: startY,
          preview: preview,
          pointerId: e.pointerId
        };
        try { customCellLayer.setPointerCapture(e.pointerId); } catch (_e) {}
        // 始点ガイド (短すぎてもとりあえず描画)
        renderAlignmentGuides(startSnap.vGuide, startSnap.hGuide,
          { xL: startX, xR: startX, yT: startY, yB: startY });
        e.preventDefault();
        e.stopPropagation();
      });
      customCellLayer.addEventListener('pointermove', (e) => {
        if (!customCellDrawState) return;
        const curRaw = getPagePosMm(e.clientX, e.clientY);
        if (!curRaw) return;
        // 終点も検出罫線 + 他カスタムセルエッジへスナップ
        const curSnap = computeCustomCellSnap([curRaw.xMm], [curRaw.yMm], null);
        customCellDrawState.curX = curRaw.xMm + curSnap.dx;
        customCellDrawState.curY = curRaw.yMm + curSnap.dy;
        const ds = customCellDrawState;
        const pageSize = pageSizesMm[currentPageIndex];
        if (!pageSize) return;
        const xL = Math.min(ds.startX, ds.curX);
        const xR = Math.max(ds.startX, ds.curX);
        const yT = Math.min(ds.startY, ds.curY);
        const yB = Math.max(ds.startY, ds.curY);
        ds.preview.style.left   = (xL / pageSize.width  * 100) + '%';
        ds.preview.style.top    = (yT / pageSize.height * 100) + '%';
        ds.preview.style.width  = ((xR - xL) / pageSize.width  * 100) + '%';
        ds.preview.style.height = ((yB - yT) / pageSize.height * 100) + '%';
        // 終点のガイドを更新 (描画中の rect 範囲を movingRect として渡す)
        renderAlignmentGuides(curSnap.vGuide, curSnap.hGuide, { xL, xR, yT, yB });
      });
      const finishCustomDraw = (e) => {
        if (!customCellDrawState) return;
        const ds = customCellDrawState;
        if (ds.preview && ds.preview.parentNode) ds.preview.parentNode.removeChild(ds.preview);
        clearAlignmentGuides();
        const xL = Math.min(ds.startX, ds.curX);
        const xR = Math.max(ds.startX, ds.curX);
        const yT = Math.min(ds.startY, ds.curY);
        const yB = Math.max(ds.startY, ds.curY);
        const w = xR - xL, h = yB - yT;
        customCellDrawState = null;
        // 5mm未満は無視（ノイズ）
        if (w >= 5 && h >= 5) {
          if (!customCellsByPage[currentPageIndex]) customCellsByPage[currentPageIndex] = [];
          customCellsByPage[currentPageIndex].push({
            xMm: (xL + xR) / 2,
            yMm: (yT + yB) / 2,
            widthMm: w,
            heightMm: h
          });
          renderCustomCells();
          scheduleAutosave && scheduleAutosave();
          setStatus('カスタムセル追加（合計 ' + customCellsByPage[currentPageIndex].length + ' 個）');
        }
      };
      customCellLayer.addEventListener('pointerup', finishCustomDraw);
      customCellLayer.addEventListener('pointercancel', finishCustomDraw);
    }

    // ----- スナップトグルボタン -----
    if (snapBtn) {
      updateSnapBtn(); // 初期表示（localStorage の値を反映）
      snapBtn.addEventListener('click', () => {
        snapEnabled = !snapEnabled;
        try {
          localStorage.setItem('imgPlaceSnapEnabled', snapEnabled ? 'true' : 'false');
        } catch (e) { /* localStorage 不可環境では無視 */ }
        updateSnapBtn();
        scheduleAutosave(); // ui_state.snap_enabled も autosave 対象
      });
    }

    // ----- キャプションフォント selector -----
    if (fontSelect) {
      // 初期値を復元（option の value と一致するものを selected に）
      const matchingOption = Array.from(fontSelect.options).find(o => o.value === captionFont);
      if (matchingOption) fontSelect.value = captionFont;
      fontSelect.addEventListener('change', () => {
        captionFont = fontSelect.value;
        try {
          localStorage.setItem('imgPlaceCaptionFont', captionFont);
        } catch (e) { /* 無視 */ }
        renderPlacements(); // 全キャプションを新フォントで再描画 (内部で scheduleAutosave 呼ばれる)
      });
    }

    // ----- ファイルダウンロードヘルパー -----
    // モバイル (iOS/Android) のみ Web Share API を使い、共有シートで保存先を選ばせる
    // デスクトップは Windows 11 の共有ダイアログ等が邪魔なので、常に標準 <a download> 使用
    async function downloadOrShare(blob, filename) {
      const isMobile = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
                    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isMobile) {
        try {
          if (typeof File !== 'undefined' && navigator.canShare) {
            const file = new File([blob], filename, { type: blob.type });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], title: filename });
              return; // 共有シートで処理された
            }
          }
        } catch (e) {
          if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
          console.warn('[imgPlace] share failed, fallback to download:', e);
        }
      }
      // 通常ダウンロード（デスクトップ + モバイルでshare不可な場合）
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    // ----- .lpw 入出力ヘルパー -----
    // ArrayBuffer → Base64（チャンク分割で巨大データにも対応）
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      const chunkSize = 0x8000; // 32KB ずつ
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }
    function base64ToArrayBuffer(b64) {
      const binary = atob(b64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    async function sha256Hex(buffer) {
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ----- IndexedDB autosave ヘルパー -----
    function openIdb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'baseSha' });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    async function autosavePut(record) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        tx.objectStore(IDB_STORE).put(record);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }
    async function autosaveGet(baseSha) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readonly');
        const req = tx.objectStore(IDB_STORE).get(baseSha);
        req.onsuccess = () => { db.close(); resolve(req.result); };
        req.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }
    async function autosaveDelete(baseSha) {
      const db = await openIdb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([IDB_STORE], 'readwrite');
        tx.objectStore(IDB_STORE).delete(baseSha);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = (e) => { db.close(); reject(e.target.error); };
      });
    }

    // 現状を .lpw 形式のオブジェクトにシリアライズ（仕様§6.1）
    async function serializeProject(baseFilename) {
      if (!basePdfBytes) throw new Error('ベースPDF未読込');
      // Base PDF Base64 はキャッシュ（autosave で毎回再エンコードしないため）
      if (!cachedBasePdfBase64) {
        cachedBasePdfBase64 = arrayBufferToBase64(basePdfBytes);
      }
      // SHA も再利用可能ならする（autosaveBaseSha がセット済ならそれ）
      const sha = autosaveBaseSha || await sha256Hex(basePdfBytes);
      const now = new Date().toISOString();
      return {
        format: 'lighting-plan-workspace',
        version: '1.0.0',
        metadata: {
          created_at: now,
          updated_at: now,
          app_version: 'PDF Compact (imgPlace)'
        },
        base_pdf: {
          filename: baseFilename || 'base.pdf',
          data_base64: cachedBasePdfBase64,
          sha256: sha,
          page_count: pageCount,
          page_sizes_mm: pageSizesMm.map(s => ({ width: s.width, height: s.height }))
        },
        image_library: imageLibrary.map(img => ({
          id: img.id,
          filename: img.filename,
          mime_type: img.mimeType,
          data_base64: (img.dataUrl && img.dataUrl.indexOf(',') >= 0)
            ? img.dataUrl.substring(img.dataUrl.indexOf(',') + 1)
            : '',
          original_width_px: img.originalWidthPx,
          original_height_px: img.originalHeightPx
        })),
        placements: placements.map(pl => {
          normalizeCaptions(pl);
          return {
            id: pl.id,
            page_index: pl.pageIndex,
            image_id: pl.imageId,
            x_mm: pl.xMm,
            y_mm: pl.yMm,
            width_mm: pl.widthMm,
            height_mm: pl.heightMm,
            aspect_locked: pl.aspectLocked !== false,
            captions: pl.captions || []
          };
        }),
        ui_state: {
          current_page_index: currentPageIndex,
          snap_enabled: snapEnabled,
          caption_font: captionFont
        },
        // カスタムセル（手動定義のスナップ矩形）。pageIndex キー → セル配列
        custom_cells_by_page: customCellsByPage
      };
    }

    // .lpw JSON から状態を完全復元
    async function loadProject(json) {
      if (!json || json.format !== 'lighting-plan-workspace') {
        throw new Error('.lpw ファイル形式が不正です');
      }
      if (!json.base_pdf || !json.base_pdf.data_base64) {
        throw new Error('ベースPDFデータが含まれていません');
      }
      // 既存状態をクリア（editorPanel も隠れる）
      clearBase();
      // ベースPDF復元 + Base64 キャッシュを既存値で初期化（再エンコード回避）
      cachedBasePdfBase64 = json.base_pdf.data_base64;
      basePdfBytes = base64ToArrayBuffer(json.base_pdf.data_base64);
      pdfjsDoc = await pdfjsLib.getDocument({ data: basePdfBytes.slice(0) }).promise;
      pageCount = pdfjsDoc.numPages;
      // autosave 用 SHA 確定（保存済値 or 再計算）
      autosaveBaseSha = json.base_pdf.sha256 || await sha256Hex(basePdfBytes);
      autosaveBaseFilename = (json.base_pdf.filename) || 'base.pdf';
      // ページサイズ: 保存値があれば使い、なければ再計算
      const savedSizes = json.base_pdf.page_sizes_mm;
      if (savedSizes && savedSizes.length === pageCount) {
        pageSizesMm = savedSizes.map(s => ({ width: s.width, height: s.height }));
      } else {
        pageSizesMm = [];
        for (let i = 1; i <= pageCount; i++) {
          const p = await pdfjsDoc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          pageSizesMm.push({ width: ptToMm(vp.width), height: ptToMm(vp.height) });
        }
      }
      // 画像ライブラリ復元
      imageLibrary = (json.image_library || []).map(img => ({
        id: img.id,
        filename: img.filename,
        mimeType: img.mime_type,
        dataUrl: 'data:' + (img.mime_type || 'image/jpeg') + ';base64,' + img.data_base64,
        originalWidthPx: img.original_width_px,
        originalHeightPx: img.original_height_px
      }));
      // libSeq を ID 衝突回避のため最大値に合わせる
      libSeq = imageLibrary.reduce((m, img) => {
        const match = /img_(\d+)/.exec(img.id || '');
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, libSeq);
      // 配置復元（旧 caption: 単一形式も captions: 配列に互換変換）
      placements = (json.placements || []).map(pl => ({
        id: pl.id,
        pageIndex: pl.page_index,
        imageId: pl.image_id,
        xMm: pl.x_mm,
        yMm: pl.y_mm,
        widthMm: pl.width_mm,
        heightMm: pl.height_mm,
        aspectLocked: pl.aspect_locked !== false,
        captions: pl.captions || (pl.caption ? [pl.caption] : [])
      }));
      plSeq = placements.reduce((m, pl) => {
        const match = /pl_(\d+)/.exec(pl.id || '');
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, plSeq);
      // UI 状態復元
      const ui = json.ui_state || {};
      currentPageIndex = (typeof ui.current_page_index === 'number') ? ui.current_page_index : 0;
      if (currentPageIndex >= pageCount) currentPageIndex = 0;
      snapEnabled = ui.snap_enabled !== false;
      if (ui.caption_font) captionFont = ui.caption_font;
      // カスタムセル復元（互換: 旧 .lpw には custom_cells_by_page が無い）
      customCellsByPage = {};
      if (json.custom_cells_by_page && typeof json.custom_cells_by_page === 'object') {
        for (const k of Object.keys(json.custom_cells_by_page)) {
          const arr = json.custom_cells_by_page[k];
          if (!Array.isArray(arr)) continue;
          customCellsByPage[k] = arr.map(c => ({
            xMm: c.xMm, yMm: c.yMm,
            widthMm: c.widthMm, heightMm: c.heightMm
          })).filter(c =>
            typeof c.xMm === 'number' && typeof c.yMm === 'number'
            && typeof c.widthMm === 'number' && typeof c.heightMm === 'number'
            && c.widthMm > 0 && c.heightMm > 0
          );
        }
      }
      // UI 表示
      editorPanel.style.display = '';
      filenameBar.style.display = '';
      actionBar.style.display = '';
      // 編集モード ON: hero+upload panel を隠す
      const modeImgPlaceEl2 = document.getElementById('modeImgPlace');
      if (modeImgPlaceEl2) modeImgPlaceEl2.classList.add('imgplace-editing');
      // コントロール反映
      updateSnapBtn();
      if (fontSelect) {
        const matchOpt = Array.from(fontSelect.options).find(o => o.value === captionFont);
        if (matchOpt) fontSelect.value = captionFont;
      }
      // 描画
      renderLibrary();
      await renderThumbnails();
      await renderCurrentPage();
      updateMeta(json.base_pdf.filename || '(復元PDF)');
      setStatus('プロジェクト復元完了: ' + (json.base_pdf.filename || '') + ' ・ ' + pageCount + 'ページ ・ 画像' + imageLibrary.length + '個 ・ 配置' + placements.length + '個');
      // エディタにスクロール
      requestAnimationFrame(() => {
        editorPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // ----- autosave: debounce で IndexedDB に保存 -----
    function scheduleAutosave() {
      if (!basePdfBytes || !autosaveBaseSha) return; // ベースPDFなしなら保存対象なし
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(async () => {
        autosaveTimer = null;
        try {
          const json = await serializeProject(autosaveBaseFilename);
          await autosavePut({
            baseSha: autosaveBaseSha,
            json: json,
            savedAt: Date.now(),
            baseFilename: autosaveBaseFilename
          });
        } catch (e) {
          console.warn('[imgPlace] autosave 失敗:', e);
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    }
    function cancelAutosaveTimer() {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
    }

    // 起動/PDF読込時に同一SHAの autosave があれば復元提案
    async function checkAndOfferRestore(sha) {
      if (!sha) return false;
      let record;
      try { record = await autosaveGet(sha); }
      catch (e) { console.warn('[imgPlace] autosave 取得失敗:', e); return false; }
      if (!record || !record.json) return false;
      // 直近 10秒以内の保存はスキップ（同セッション中の周回防止）
      if (Date.now() - (record.savedAt || 0) < 10000) return false;
      const date = new Date(record.savedAt);
      const dateStr = date.toLocaleString('ja-JP');
      const placementCount = (record.json.placements || []).length;
      const libCount = (record.json.image_library || []).length;
      const msg = 'このベースPDFに前回作業の自動保存データがあります。\n'
                + '保存時刻: ' + dateStr + '\n'
                + '配置: ' + placementCount + '個 / 画像: ' + libCount + '個\n\n'
                + '復元しますか？「いいえ」で現在の作業を続行します。';
      if (window.confirm(msg)) {
        try {
          await loadProject(record.json);
          return true;
        } catch (e) {
          console.error('[imgPlace] 自動保存復元失敗:', e);
          setStatus('自動保存の復元失敗: ' + (e.message || e), 'error');
        }
      } else {
        // 拒否されたら同SHAの autosave を削除（毎回聞かない）
        try { await autosaveDelete(sha); } catch (e) { /* 無視 */ }
      }
      return false;
    }

    // ----- プロジェクト保存ボタン -----
    if (saveProjectBtn) {
      saveProjectBtn.addEventListener('click', async () => {
        if (!basePdfBytes) {
          setStatus('ベースPDFが読み込まれていません', 'error');
          return;
        }
        // ファイル名: 入力欄の値（無ければ 'project'）+ タイムスタンプ。prompt() は iOS 互換性のため非使用
        const userName = (document.getElementById('imgPlaceFilenameInput') || {}).value || '';
        const baseName = (userName.trim() || 'project').replace(/[\\/:*?"<>|]/g, '');
        let finalName = (typeof appendTimestamp === 'function')
          ? appendTimestamp(baseName, 'imgPlaceFilenameTs')
          : baseName;
        // iOS は .lpw を未知拡張子と判定して .txt を勝手に付与するため、iOS では .json で出力
        const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        const ext = isIos ? '.json' : '.lpw';
        if (!new RegExp(ext.replace('.', '\\.') + '$', 'i').test(finalName)) finalName += ext;
        try {
          const obj = await serializeProject((userName || 'base') + '.pdf');
          const json = JSON.stringify(obj);
          const blob = new Blob([json], { type: 'application/json' });
          // File System Access API: ブラウザ対応していれば「名前を付けて保存」ダイアログ
          // (Chrome/Edge/Opera 等で利用可、Firefox/Safari/iOS は未対応 → 従来DLに fallback)
          let saved = false;
          if (typeof window.showSaveFilePicker === 'function' && !isIos) {
            try {
              const handle = await window.showSaveFilePicker({
                suggestedName: finalName,
                types: [{
                  description: 'PDF Compact プロジェクト',
                  accept: { 'application/json': ['.lpw', '.json'] }
                }]
              });
              const writable = await handle.createWritable();
              await writable.write(blob);
              await writable.close();
              saved = true;
              setStatus('プロジェクト保存完了: ' + (handle.name || finalName));
            } catch (e) {
              // ユーザーキャンセル (AbortError) はそっと終わる、それ以外は fallback DL
              if (e && e.name === 'AbortError') return;
              console.warn('[imgPlace] showSaveFilePicker 失敗 → 通常DLに fallback:', e);
            }
          }
          if (!saved) {
            await downloadOrShare(blob, finalName);
            setStatus('保存処理を実行しました: ' + finalName + (isIos ? '（iOSは共有シートから「ファイルに保存」、本ツールは .json も読込可）' : ''));
          }
        } catch (err) {
          console.error('[imgPlace] 保存失敗:', err);
          setStatus('保存に失敗: ' + (err.message || err), 'error');
        }
      });
    }

    // ----- プロジェクト読込ボタン -----
    if (loadProjectBtn && loadProjectInput) {
      loadProjectBtn.addEventListener('click', () => loadProjectInput.click());
      loadProjectInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          setStatus('読み込み中…');
          const text = await file.text();
          const json = JSON.parse(text);
          await loadProject(json);
        } catch (err) {
          console.error('[imgPlace] 読込失敗:', err);
          setStatus('読込失敗: ' + (err.message || err), 'error');
        } finally {
          e.target.value = ''; // 同じファイル再選択を許可
        }
      });
    }

    // ----- 日本語フォント (Noto Sans JP) を CDN から取得（初回のみ） -----
    // 公式 notofonts/noto-cjk の SubsetOTF JP（各 ~4.5MB の OTF、フォント内部名が正しい）
    // @fontsource の woff は内部メタデータが Thin 表記になり Acrobat 警告が出るため不採用
    const NOTO_REGULAR_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf';
    const NOTO_BOLD_URL    = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf';
    // タイムアウト付き fetch
    async function fetchWithTimeout(url, timeoutMs) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.arrayBuffer();
      } finally {
        clearTimeout(t);
      }
    }
    // 必要なフォントだけ並行取得（Bold は太字キャプションがある時のみ）
    async function loadCaptionFontsIfNeeded(needBold) {
      const tasks = [];
      if (!cachedNotoRegular) {
        tasks.push(fetchWithTimeout(NOTO_REGULAR_URL, 60000)
          .then(buf => { cachedNotoRegular = buf; })
          .catch(err => { throw new Error('Noto Sans JP Regular 取得失敗: ' + (err.message || err)); }));
      }
      if (needBold && !cachedNotoBold) {
        tasks.push(fetchWithTimeout(NOTO_BOLD_URL, 60000)
          .then(buf => { cachedNotoBold = buf; })
          .catch(err => { throw new Error('Noto Sans JP Bold 取得失敗: ' + (err.message || err)); }));
      }
      if (tasks.length === 0) return;
      setStatus('Noto Sans JP を取得中… (' + tasks.length + ' ファイル並行ダウンロード)');
      await Promise.all(tasks);
    }

    // ----- PDF出力: ベースPDF + 画像 + キャプション（画像化方式） -----
    // キャプションは Canvas に描画→PNG→embedPng で焼き込み（フォント埋め込みの相性問題を完全回避）
    // → display と同じフォントで描画される、文字検索不可だが互換性は最強
    async function generatePdfOutput() {
      if (!basePdfBytes) throw new Error('ベースPDF未読込');
      if (!window.PDFLib) throw new Error('pdf-lib が読み込まれていません');
      const { PDFDocument, degrees } = window.PDFLib;
      const pdfDoc = await PDFDocument.load(basePdfBytes.slice(0), { ignoreEncryption: true });

      // 画像 embed をキャッシュ（同じ画像を複数配置時に再 embed 回避）
      const embedCache = {};
      async function getEmbedded(img) {
        if (embedCache[img.id]) return embedCache[img.id];
        const dataB64 = img.dataUrl.substring(img.dataUrl.indexOf(',') + 1);
        const bytes = base64ToArrayBuffer(dataB64);
        let embedded;
        if (/png/i.test(img.mimeType || '')) {
          embedded = await pdfDoc.embedPng(bytes);
        } else {
          embedded = await pdfDoc.embedJpg(bytes);
        }
        embedCache[img.id] = embedded;
        return embedded;
      }

      // キャプションを Canvas で描画→PNG bytes に変換し PDF に embed
      // maxWidthMm: 最大幅mm(=配置幅)。超える長文はプレビュー(nowrap+overflow:hidden)と同様に切り詰める
      // 戻り値: { pdfImage, widthMm, heightMm }
      async function captionToPdfImage(cap, sizeMm, maxWidthMm) {
        // 300dpi相当の解像度で crispness 確保（1mm ≈ 11.8px）
        const intFontPx = Math.max(48, Math.round(sizeMm * 12));
        const fontDecl = (cap.bold ? 'bold ' : '') + intFontPx + 'px ' + (captionFont || 'sans-serif');
        // 文字幅計測
        const mCanvas = document.createElement('canvas');
        const mctx = mCanvas.getContext('2d');
        mctx.font = fontDecl;
        const metrics = mctx.measureText(cap.text);
        const textW = Math.max(2, Math.ceil(metrics.width));
        const ascent  = metrics.actualBoundingBoxAscent  || (intFontPx * 0.85);
        const descent = metrics.actualBoundingBoxDescent || (intFontPx * 0.25);
        const totalH = Math.max(2, Math.ceil(ascent + descent));
        // 実描画用 canvas
        // 配置幅(maxWidthMm)を超える長文はプレビューと同様に canvas 幅で切り詰める
        // (px↔mm 換算: totalH px が sizeMm*1.15 mm に対応。左から描画し、はみ出しは自動クリップ)
        let drawWidthPx = textW;
        if (typeof maxWidthMm === 'number' && maxWidthMm > 0) {
          const maxWidthPx = Math.max(2, Math.floor(totalH * (maxWidthMm / (sizeMm * 1.15))));
          if (drawWidthPx > maxWidthPx) drawWidthPx = maxWidthPx;
        }
        const canvas = document.createElement('canvas');
        canvas.width = drawWidthPx;
        canvas.height = totalH;
        const ctx = canvas.getContext('2d');
        ctx.font = fontDecl;
        ctx.fillStyle = '#000';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(cap.text, 0, ascent);
        // PNG → embedPng
        const dataUrl = canvas.toDataURL('image/png');
        const bytes = base64ToArrayBuffer(dataUrl.split(',')[1]);
        const pdfImage = await pdfDoc.embedPng(bytes);
        // mm 換算: テキスト高さ = sizeMm * 1.15（display と整合）。幅は切り詰め後の canvas 幅から算出
        const heightMm = sizeMm * 1.15;
        const widthMm = (canvas.width / totalH) * heightMm;
        return { pdfImage, widthMm, heightMm };
      }

      // ----- /Rotate 付きページ対応の座標変換 -----
      // 配置座標 (pl.xMm/yMm) は pdf.js viewport(回転後の見た目・左上原点)基準、
      // pdf-lib の描画は回転前のページ座標系(左下原点)。回転を無視すると
      // スキャンPDF(/Rotate 90 等)でプレビューと全く違う場所・向きに焼かれるため、
      // 見た目の矩形を回転前座標へ逆写像し、画像自体も同角だけ回して「見た目どおり」に焼く。
      // rotate は反時計回り(PDF標準)。/Rotate は時計回り表示なので同角の CCW 描画で正立する。
      // 回転0ではアンカー・角度とも旧計算と完全一致(既存PDFへの回帰なし)。
      function viewportRectToDrawOpts(page, xMm, yMm, wMm, hMm) {
        // プレビュー(pdf.js viewport)は CropBox 基準のため、MediaBox(getSize)基準で写像すると
        // CropBox≠MediaBox の図面PDF(CAD/プロッタ出力)で全配置が一定量ズレる。
        // → CropBox 寸法で写像し、最後に CropBox 原点を加算してページ絶対座標へ平行移動する。
        // pdf-lib の getCropBox() は CropBox 未定義なら MediaBox を返す。万一の例外・不正値は getSize にフォールバック(従来動作)。
        let crop = null;
        try { crop = page.getCropBox(); } catch (e) { crop = null; }
        if (!crop || !(crop.width > 0) || !(crop.height > 0)) {
          const size = page.getSize();
          crop = { x: 0, y: 0, width: size.width, height: size.height };
        }
        const W = crop.width, H = crop.height;
        let rot = ((page.getRotation().angle % 360) + 360) % 360;
        if (rot !== 90 && rot !== 180 && rot !== 270) rot = 0;   // 90の倍数以外(仕様外)は回転なし扱い
        const a = xMm * PT_PER_MM, b = yMm * PT_PER_MM;
        const w = wMm * PT_PER_MM, h = hMm * PT_PER_MM;
        // アンカー = 画像の「見た目の左下」(viewport 座標 (a, b+h)) を回転前 CropBox 相対座標へ逆写像
        let x, y;
        if (rot === 90)       { x = b + h;       y = a; }
        else if (rot === 180) { x = W - a;       y = b + h; }
        else if (rot === 270) { x = W - (b + h); y = H - a; }
        else                  { x = a;           y = H - (b + h); }
        // CropBox 原点を加算(CropBox=MediaBox 原点(0,0) の通常PDFでは +0 で従来と完全一致)
        return { x: x + crop.x, y: y + crop.y, width: w, height: h, rotate: degrees(rot) };
      }

      const totalPages = pdfDoc.getPageCount();
      for (const pl of placements) {
        if (pl.pageIndex < 0 || pl.pageIndex >= totalPages) continue;
        const img = imageLibrary.find(im => im.id === pl.imageId);
        if (!img) continue;
        const page = pdfDoc.getPage(pl.pageIndex);
        const embedded = await getEmbedded(img);

        // 画像描画: 見た目の矩形(mm/左上) → 回転補正込みの drawImage 引数
        page.drawImage(embedded, viewportRectToDrawOpts(page, pl.xMm, pl.yMm, pl.widthMm, pl.heightMm));

        // キャプション描画（renderPlacements と同じスタッキング。座標は全て見た目(viewport)のmmで組み、最後に同じ変換を通す）
        normalizeCaptions(pl);
        if (pl.captions && pl.captions.length > 0) {
          let cursorBelow = pl.yMm + pl.heightMm + 3;
          let cursorAbove = pl.yMm - 3;
          for (const cap of pl.captions) {
            if (!cap.text || !cap.text.trim()) continue;
            const sizeMm    = CAPTION_SIZE_MM[cap.size || 'medium'] || 4;
            const stackHMm  = sizeMm * 1.15;
            const pos       = cap.position || 'below';
            let topYMm;
            if (pos === 'above') {
              topYMm = cursorAbove - stackHMm;
              cursorAbove = topYMm - 1;
            } else {
              topYMm = cursorBelow;
              cursorBelow += stackHMm + 1;
            }
            // Canvas で画像化(配置幅で切り詰め: プレビューの overflow:hidden と整合)
            const capImg = await captionToPdfImage(cap, sizeMm, pl.widthMm);
            // 揃え: placement 幅内での配置(見た目のmmで計算)
            const align = cap.align || 'center';
            let xCapMm;
            if (align === 'left')       xCapMm = pl.xMm;
            else if (align === 'right') xCapMm = pl.xMm + pl.widthMm - capImg.widthMm;
            else                        xCapMm = pl.xMm + (pl.widthMm - capImg.widthMm) / 2;
            page.drawImage(capImg.pdfImage, viewportRectToDrawOpts(page, xCapMm, topYMm, capImg.widthMm, capImg.heightMm));
          }
        }
      }
      return await pdfDoc.save({ useObjectStreams: true });
    }

    // ----- PDF出力ボタン -----
    // 1タップで生成 + DL。downloadOrShare 内で Web Share API 利用可なら共有シート、
    // 不可なら標準 <a download> にフォールバック（iOS でも fallback 経路で動く）
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener('click', async () => {
        if (!basePdfBytes) {
          setStatus('ベースPDFが読み込まれていません', 'error');
          return;
        }
        // ファイル名: 入力欄の値（無ければ 'output'）+ タイムスタンプ
        const userName = (document.getElementById('imgPlaceFilenameInput') || {}).value || '';
        const baseName = (userName.trim() || 'output').replace(/[\\/:*?"<>|]/g, '');
        let finalName = (typeof appendTimestamp === 'function')
          ? appendTimestamp(baseName, 'imgPlaceFilenameTs')
          : baseName;
        if (!/\.pdf$/i.test(finalName)) finalName += '.pdf';
        try {
          setStatus('PDF生成中…');
          exportPdfBtn.disabled = true;
          const bytes = await generatePdfOutput();
          let blob = new Blob([bytes], { type: 'application/pdf' });
          // v3.6.0: 出力前メタデータ除去 (imgPlace は常にPDF・ガード不要)
          if (window.PdfSanitize) blob = await window.PdfSanitize.process(blob);
          await downloadOrShare(blob, finalName);
          setStatus('PDF出力完了: ' + finalName + '（画像 ' + placements.length + ' 個焼き込み済）');
        } catch (err) {
          console.error('[imgPlace] PDF出力失敗:', err);
          setStatus('PDF出力失敗: ' + (err.message || err), 'error');
        } finally {
          exportPdfBtn.disabled = false;
        }
      });
    }

    // ----- クリアボタン -----
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearBase();
      });
    }

    // ----- 順次配置トグルボタン -----
    const placeQueueBtn = document.getElementById('imgPlacePlaceQueueBtn');
    if (placeQueueBtn) {
      placeQueueBtn.addEventListener('click', () => {
        if (placeQueueMode) {
          stopPlaceQueueMode('順次配置キャンセル');
        } else {
          startPlaceQueueMode();
        }
      });
    }

    // ----- 追加PDF ボタン (ファイル選択 → 末尾にマージ) -----
    const addPdfBtn = document.getElementById('imgPlaceAddPdfBtn');
    const addPdfInput = document.getElementById('imgPlaceAddPdfInput');
    if (addPdfBtn && addPdfInput) {
      addPdfBtn.addEventListener('click', () => addPdfInput.click());
      addPdfInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        await loadBasePdf(file); // basePdfBytes 既存 → 自動で append モード
        e.target.value = ''; // 同じファイル再選択許可
      });
    }
    // editor 全域に PDF ドロップ受付 (canvas-wrap + 周辺) → 末尾追加
    if (canvasFrame) {
      const editorEl = document.querySelector('#modeImgPlace .imgplace-editor');
      const handlePdfDrop = async (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
        const file = e.dataTransfer.files[0];
        if (!file || (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name))) return;
        e.preventDefault();
        e.stopPropagation();
        if (editorEl) editorEl.classList.remove('imgplace-pdf-dragover');
        await loadBasePdf(file); // basePdfBytes 既存なら append
      };
      const handlePdfDragOver = (e) => {
        // PDF ファイルドラッグ時のみハイライト (画像ドラッグは既存 handler 任せ)
        if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(it =>
            it.kind === 'file' && (it.type === 'application/pdf'))) {
          e.preventDefault();
          if (editorEl) editorEl.classList.add('imgplace-pdf-dragover');
        }
      };
      const handlePdfDragLeave = (e) => {
        if (editorEl && e.relatedTarget && !editorEl.contains(e.relatedTarget)) {
          editorEl.classList.remove('imgplace-pdf-dragover');
        }
      };
      if (editorEl) {
        editorEl.addEventListener('drop', handlePdfDrop);
        editorEl.addEventListener('dragover', handlePdfDragOver);
        editorEl.addEventListener('dragleave', handlePdfDragLeave);
      }
    }

    // ----- タイムスタンプトグル -----
    if (typeof setupTimestampToggle === 'function') {
      setupTimestampToggle('imgPlaceFilenameTs', 'imgPlaceFilenameTsPreview');
    }
  })();

  /* ============================================================
   * 黒塗り(墨消し)モード — v3.8.0 Phase1 (描画まで・出力は次版)
   * 自己完結 IIFE。window.pdfjsLib のみ参照。既存モードに非依存。
   * 矩形は「ページ比率(0..1)」で保持し解像度非依存。
   * ============================================================ */
  (function redactModule(){
    'use strict';
    var L = window.pdfjsLib;
    var upload = document.getElementById('redactUpload');
    var fileInput = document.getElementById('redactFileInput');
    var editor = document.getElementById('redactEditor');
    var wrap = document.getElementById('redactCanvasWrap');
    var canvas = document.getElementById('redactCanvas');
    var textLayer = document.getElementById('redactTextLayer');
    var overlay = document.getElementById('redactOverlay');
    var cellsLayer = document.getElementById('redactCells');
    var pageInfo = document.getElementById('redactPageInfo');
    var prevBtn = document.getElementById('redactPrev');
    var nextBtn = document.getElementById('redactNext');
    var clearBtn = document.getElementById('redactClearPage');
    var resetBtn = document.getElementById('redactResetBtn');
    var modeTextBtn = document.getElementById('redactModeText');
    var modeRectBtn = document.getElementById('redactModeRect');
    var modeHint = document.getElementById('redactModeHint');
    if (!upload || !canvas || !overlay || !textLayer || !cellsLayer) return;

    var st = { pdf:null, numPages:0, pageIndex:0, rects:{}, mode:'text', prefMode:'text', pageHasText:false,
               renderTask:null, textTask:null,
               renderGen:0, rendering:false,   // 頁描画の世代番号(連打レース対策)と描画中フラグ(描画中は黒塗り入力を受けない)
               pageWidthPt:0,                  // 表示中ページの実幅(pt)。dedupe の横ギャップ許容の実寸クランプに使う
               textFetchFailed:false,          // getTextContent が例外だった頁(「文字なし」と区別して文言を変える)
               exporting:false };              // 出力(黒塗り焼き込み)実行中フラグ。trueの間は編集系UIを全て遮断
    var MIN_PX = 2;   // 退化矩形(空白/潰れ)の足切り閾値(canvas px)。ページ比率基準にしない=大判図面の小さい文字を捨てない

    // ---- モード切替 (文字を選ぶ / 自由に四角) ----
    function setMode(m){
      st.prefMode = m;   // ユーザーの希望(text/rect)を保持。実効modeは下で算出
      // 文字レイヤーが無いページで text を選んだら rect に矯正
      if (m === 'text' && !st.pageHasText){
        m = 'rect';
        // 読取失敗(getTextContent例外)のページでは「無い」と断定しない文言にする
        if (modeHint) modeHint.textContent = st.textFetchFailed
          ? 'このページは文字データを読み取れないので「自由に四角」で囲ってください。'
          : 'このページは文字データが無いので「自由に四角」で囲ってください(スキャン画像/CAD出力など)。';
      } else if (modeHint) {
        modeHint.textContent = (m === 'text')
          ? '文字をクリック、またはなぞって選ぶと、その文字の上に黒塗りが付きます(タブレットはタップか長押し。重なりは自動でまとめます)。'
          : 'ページ上をドラッグして、黒塗りする範囲を四角で描きます。';
      }
      st.mode = m;
      wrap.classList.toggle('mode-text', m === 'text');
      wrap.classList.toggle('mode-rect', m === 'rect');
      if (modeTextBtn) modeTextBtn.classList.toggle('active', m === 'text');
      if (modeRectBtn) modeRectBtn.classList.toggle('active', m === 'rect');
    }

    // ---- PDF 読込 ----
    async function loadPdf(file){
      if (!file || file.type !== 'application/pdf') { alert('PDFファイルを選んでください'); return; }
      try {
        var buf = await file.arrayBuffer();
        st.bytes = buf.slice(0);                               // pdf-lib(出力)用に原本バイト保持
        st.pdf = await L.getDocument({ data: buf }).promise;
        st.numPages = st.pdf.numPages;
        st.pageIndex = 0; st.rects = {};
        upload.style.display = 'none';
        editor.classList.add('active');
        await renderPage(0);
      } catch(e){
        console.error('redact load failed', e);
        alert('PDFの読み込みに失敗しました: ' + (e && e.message ? e.message : e));
      }
    }

    // ---- ページ描画 (canvas + テキストレイヤー + 黒塗りセル) ----
    async function renderPage(idx){
      if (!st.pdf) return;
      idx = Math.max(0, Math.min(st.numPages-1, idx));
      var gen = ++st.renderGen;   // 世代トークン: 連打されても「最後の呼び出し」だけが画面と状態を確定させる(後勝ち)
      st.rendering = true;        // 描画完了まで黒塗り入力をロック(旧頁の見た目で取った座標が新頁に保存される事故防止)
      st.pageIndex = idx;
      if (st.renderTask){ try{ st.renderTask.cancel(); }catch(_){ } st.renderTask=null; }
      if (st.textTask){ try{ st.textTask.cancel(); }catch(_){ } st.textTask=null; }
      var page = await st.pdf.getPage(idx+1);
      if (gen !== st.renderGen) return;   // 待っている間に新しい頁送りが始まった→この呼び出しは捨てる(canvasを触らない)
      var vp1 = page.getViewport({ scale: 1 });
      st.pageWidthPt = vp1.width;   // 表示中ページの実幅(pt・回転込み)。dedupe の横ギャップ許容の実寸クランプに使う
      // 表示はステージ幅にフィット(A3横/A1横でも横スクロール不要)、レンダは高DPIで鮮明に。
      // 旧 920/vp1.width 方式は A3横(幅1190pt)で scale=1 止まり → 画面外 + 72DPI相当で荒かった。
      var stageEl = wrap.closest('.redact-stage');
      var availW = stageEl ? stageEl.clientWidth : 0;
      if (availW < 50) availW = 900;   // 非表示等で測れない時は標準幅(表示時に resize で再描画され正される)
      availW -= 16;                     // 枠+スクロールバー分の安全マージン(確実に収める)
      var displayScale = Math.min(2, availW / vp1.width);            // 大判は縮小、小さい紙は最大2倍まで
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var renderScale = Math.max(displayScale * dpr * 1.5, 1.5);     // 縮小表示でもCAD線/小文字をくっきり(最低1.5倍レンダ)
      var MAXDIM = 4000;               // 巨大図面(A0等)で canvas がメモリ爆発しない上限
      var maxRender = Math.max(vp1.width, vp1.height) * renderScale;
      if (maxRender > MAXDIM) renderScale = renderScale * MAXDIM / maxRender;
      var rvp = page.getViewport({ scale: renderScale });            // 高解像度レンダ用
      var dvp = page.getViewport({ scale: displayScale });           // 表示・テキスト層用(canvasのCSSサイズと一致)
      var RW = Math.ceil(rvp.width), RH = Math.ceil(rvp.height);
      var DW = Math.floor(dvp.width), DH = Math.floor(dvp.height);   // 表示は切り捨て=ステージ幅を1pxも超えない
      // canvas のバッキングは高解像度(RW×RH)、CSS表示はフィットサイズ(DW×DH)=ブラウザが縮小して鮮明に
      canvas.width = RW; canvas.height = RH;
      canvas.style.width = DW + 'px'; canvas.style.height = DH + 'px';
      wrap.style.width = DW + 'px'; wrap.style.height = DH + 'px';
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,RW,RH);
      st.renderTask = page.render({ canvasContext: ctx, viewport: rvp });
      try { await st.renderTask.promise; } catch(e){ if (e && e.name === 'RenderingCancelledException') return; }
      st.renderTask = null;
      // テキストレイヤー構築(表示ビューポートで配置=CSS表示サイズの canvas と完全一致。世代を渡し旧呼び出しの span 書き込みを止める)
      await buildTextLayer(page, dvp, displayScale, gen);
      if (gen !== st.renderGen) return;   // 追い越されていたら頁番号・ボタン・セルを触らない(旧頁による上書き=表示の嘘を防ぐ)
      pageInfo.textContent = (idx+1) + ' / ' + st.numPages;
      prevBtn.disabled = (idx === 0);
      nextBtn.disabled = (idx === st.numPages-1);
      renderCells();
      st.rendering = false;   // 最新世代が最後まで描けた時だけ入力ロック解除(破棄された旧呼び出しは解除しない)
    }

    // ---- テキストレイヤー(選択可能なspan群)を canvas に重ねる ----
    async function buildTextLayer(page, vp, scale, gen){
      textLayer.innerHTML = '';
      textLayer.style.setProperty('--scale-factor', String(scale));  // pdf.js 3.x の文字サイズ基準
      var tc;
      // 取得失敗(例外)は「文字なし」と別物として覚える→「ありません」と断定する嘘バナーを防ぐ(頁送りごとに再評価)
      st.textFetchFailed = false;
      try { tc = await page.getTextContent(); } catch(_) { tc = { items: [] }; st.textFetchFailed = true; }
      if (gen !== st.renderGen) return;   // 追い越された旧呼び出しは span を書き込まない(新旧頁のゴースト混在防止)
      var divs = [];
      try {
        st.textTask = L.renderTextLayer({ textContentSource: tc, container: textLayer, viewport: vp, textDivs: divs });
        await st.textTask.promise;
      } catch(e){ /* テキスト無し等は無視 */ }
      st.textTask = null;
      if (gen !== st.renderGen) return;   // キャンセルされた旧呼び出しは pageHasText/バナー/モードを触らない
      // 空白だけの span は「文字あり」に数えない(クリック側 rectFromSpan が弾く残骸spanしか無いページで、バナーも rect 矯正も出ず全クリック無反応のまま詰むのを防ぐ)
      var spans = textLayer.querySelectorAll('span');
      st.pageHasText = false;
      for (var si = 0; si < spans.length; si++){
        if (spans[si].textContent.trim() !== ''){ st.pageHasText = true; break; }
      }
      // 文字データ無しページは見た目で誘導(ホバー無効化 + バナー表示)。頁送りごとに再評価されるので混在PDFでも頁単位で正しく出る。
      wrap.classList.toggle('no-text', !st.pageHasText);
      var _bn = document.getElementById('redactNoTextBanner');
      if (_bn){
        // 読取失敗時は「ありません」と断定しない文言へ(毎頁で再設定するので前頁の文言を引きずらない)
        _bn.textContent = st.textFetchFailed
          ? '⬚ このページの文字データを読み取れませんでした。「自由に四角」で隠したい所を囲ってください。'
          : '⬚ このページは文字データがありません(スキャン画像/CAD出力など)。「自由に四角」で隠したい所を囲ってください。';
        _bn.classList.toggle('show', !st.pageHasText);
      }
      // 希望モードを再適用(文字有りページなら text に復帰、無ければ rect 矯正)
      setMode(st.prefMode);
    }

    // ---- クリックで一発黒塗り (text モード) + 移動量ガード ----
    // ドラッグ(範囲選択)は commitTextSelection に任せ、純クリックだけここで span 全体を黒塗り。
    // 二重発火は『直近 mousedown→click のポインタ移動量 < CLICK_MOVE_PX なら純クリック』で判定(setTimeout 順序や isCollapsed に依存しない)。
    st.suppressNextCommit = false;
    var CLICK_MOVE_PX = 6;
    var _downXY = null;
    textLayer.addEventListener('mousedown', function(e){ _downXY = { x:e.clientX, y:e.clientY }; st.suppressNextCommit = false; });  // 実ジェスチャ開始で残留フラグを掃除: mousedown無しの合成click(支援技術/自動化)が立てた保険は対のmouseupが来ず消費されないまま残り、次の正当なドラッグ選択commitを1回握り潰すため、新しい操作の起点で必ず白紙に戻す
    function rectFromSpan(span){
      var cw = wrap.getBoundingClientRect();
      if (cw.width === 0 || cw.height === 0) return null;
      var rc = span.getBoundingClientRect();
      if (rc.width < 2 || rc.height < 2) return null;       // 空白/潰れ span は無視
      var padY = rc.height * 0.12;                          // ドラッグ側と同じ12%余白でグリフ完全被覆
      return { x:(rc.left-cw.left)/cw.width, y:(rc.top-cw.top-padY)/cw.height, w:rc.width/cw.width, h:(rc.height+padY*2)/cw.height };
    }
    textLayer.addEventListener('click', function(e){
      if (st.mode !== 'text' || !st.pageHasText) return;    // rectモードは pointer-events:none、文字無しは触らせない
      // ドラッグだったら降りる(移動量で判定)。これがドラッグ後 click の二重発火を止める要。
      if (_downXY){
        var dx = e.clientX - _downXY.x, dy = e.clientY - _downXY.y;
        if ((dx*dx + dy*dy) > (CLICK_MOVE_PX*CLICK_MOVE_PX)){ _downXY = null; return; }
      }
      _downXY = null;
      var span = e.target.closest('span');                  // ★closest('span'): 入れ子ノードに強い。container ではなく span を掴む
      if (!span || !textLayer.contains(span)) return;
      var r = rectFromSpan(span);
      if (!r) return;
      pushRect(r.x, r.y, r.w, r.h);                         // pushRect 内で退化矩形の足切り/clamp 済み
      dedupeRects(st.pageIndex);                            // 既存セルと重なれば即 union(二重黒塗り防止)
      var sel = window.getSelection(); if (sel) sel.removeAllRanges();
      st.suppressNextCommit = true;                         // 保険: 直後の mouseup commit を1回スキップ
      renderCells();
      e.preventDefault(); e.stopPropagation();
    });

    // ---- 黒塗りセル(確定分)を描画。× は常にクリック可 ----
    function renderCells(){
      cellsLayer.innerHTML = '';
      var list = st.rects[st.pageIndex] || [];
      list.forEach(function(r, ri){
        var cell = document.createElement('div');
        cell.className = 'redact-cell';
        cell.style.left=(r.x*100)+'%'; cell.style.top=(r.y*100)+'%';
        cell.style.width=(r.w*100)+'%'; cell.style.height=(r.h*100)+'%';
        var del = document.createElement('button');
        del.className='redact-cell-delete'; del.type='button'; del.textContent='×';
        del.setAttribute('aria-label','この黒塗りを削除');
        del.addEventListener('pointerdown', function(e){ e.stopPropagation(); });
        // ×はセル右上の外側へ10pxはみ出すため、text モードで隣の語や直上の行を
        // 塗ろうとしたクリックを横取りすることがある。確認なしで splice すると
        // 既存の黒塗りが黙って消え、気付かず出力すると秘密が露出する(漏れ方向)。
        // confirm を1枚挟んで誤爆を遮断する(キャンセル=何も変更しない)。
        del.addEventListener('click', function(e){
          e.stopPropagation();
          if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
          if (!confirm('この黒塗りを削除しますか?')) return;
          list.splice(ri,1); renderCells();
        });
        cell.appendChild(del);
        cellsLayer.appendChild(cell);
      });
    }

    function pushRect(x,y,w,h){
      // 出力中の追加は出力ループに届かない(矩形配列の参照を捕捉済み)ため入口で遮断。クリック/なぞり/四角の全追加経路をここ1箇所で塞ぐ
      if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
      if (st.rendering) return;   // 頁描画中も確定禁止: 旧頁の見た目で取った座標が st.pageIndex(新頁)に保存され「塗ったはずの頁が出力で素通し」になる事故を防ぐ
      // 非有限値(NaN/Infinity)は保存しない(wrap 高さ0等の異常系で 0除算した値を黙って弾く)
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return;
      // ページ範囲[0,1]との交差で切り取る(移動クランプだとページ外スパン由来の矩形が幅0ゴースト/位置ズレ黒塗りになる)
      var x2=Math.min(1,x+w), y2=Math.min(1,y+h);
      x=Math.max(0,x); y=Math.max(0,y);
      w=x2-x; h=y2-y;
      // 足切りは canvas px 基準の退化矩形(見えないゴミ)のみ、交差後の実寸で判定。
      // 旧 MIN_PCT=0.008 はページ比率固定のため大判ほど実寸の足切りが膨張し(A1横で幅約6.7mm/高約4.8mm未満が全滅)、
      // ホバーは光るのにクリック無反応・なぞった断片が無言で欠けて出力に文字が残る事故になっていた。
      if (w * canvas.width < MIN_PX || h * canvas.height < MIN_PX) return;
      if (!st.rects[st.pageIndex]) st.rects[st.pageIndex]=[];
      st.rects[st.pageIndex].push({x:x,y:y,w:w,h:h});
    }

    // ---- 重複黒塗りの自動マージ(dedup) — EDGE-GAP 方式(唯一の実装) ----
    // rect は {x,y,w,h} すべて 0..1。X方向は微小ギャップ(EPS_X)まで接触扱いで断片(fill+stroke二度描き・複数clientRects)を畳む。
    // Y方向は EPS_Y=0(交差必須)。text モードが行ごとに上下12%余白を足す設計に乗り、別行の誤統合を防ぐ。
    // union は必ずバウンディングボックス=元矩形を完全包含 → 黒塗り漏れ(露出)は起きない。出力 fillRect は冪等なので結果不変。
    var DEDUPE_EPS_X = 0.004;   // 約0.4%幅まで横の隙間を『接触』とみなす(カーニング/サブピクセル境界を繋ぐ)
    var DEDUPE_EPS_MAX_PT = 2.4; // EPS_Xの物理上限(pt)。2.4pt≒0.85mm=A4縦での従来値と同等。比率のままだと大判(A1/A0)で3〜5mmの実ギャップまで『接触』になり別の語/枠を巻き込むため実寸でクランプ
    var DEDUPE_EPS_Y = 0.0;     // 縦は交差必須(別行を守る)
    function rectsOverlap(a, b){
      // 実効EPS_X: ページ実幅が取れていれば物理上限を比率に換算してクランプ(min を取るだけなので従来より緩むことは無い=漏れ方向の変化ゼロ)
      var epsX = DEDUPE_EPS_X;
      if (st.pageWidthPt > 0){
        var cap = DEDUPE_EPS_MAX_PT / st.pageWidthPt;   // A4縦(595pt)では 0.00403>0.004 でクランプ不発=従来どおり
        if (cap < epsX) epsX = cap;
      }
      var oxRaw = Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x); // 正=交差,0=接点,負=隙間
      var oyRaw = Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
      return (oxRaw >= -epsX) && (oyRaw >= -DEDUPE_EPS_Y);
    }
    function unionRect(a, b){
      var x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
      var x2 = Math.max(a.x+a.w, b.x+b.w), y2 = Math.max(a.y+a.h, b.y+b.h);
      return { x:x1, y:y1, w:x2-x1, h:y2-y1 };
    }
    // ページ pi の矩形配列を、重なる/接触するものどうし union で統合。union が第三の矩形を呼び込む連鎖も収束まで反復。
    function dedupeRects(pi){
      var src = st.rects[pi];
      if (!src || src.length < 2) return;            // 0/1個は不要(早期return)
      var rects = src.slice();
      var safety = rects.length + 4;                 // 無限ループ保険
      for (var pass = 0; pass < safety; pass++){
        var merged = false, out = [], used = new Array(rects.length);
        for (var i = 0; i < rects.length; i++){
          if (used[i]) continue;
          var cur = rects[i];
          for (var j = i + 1; j < rects.length; j++){
            if (used[j]) continue;
            if (rectsOverlap(cur, rects[j])){ cur = unionRect(cur, rects[j]); used[j] = true; merged = true; }
          }
          out.push(cur);
        }
        rects = out;
        if (!merged) break;                          // 統合ゼロ=収束
      }
      st.rects[pi] = rects;
    }

    // ---- 文字選択 → 黒塗り (text モード) ----
    function commitTextSelection(){
      if (st.mode !== 'text') return;
      if (st.suppressNextCommit){ st.suppressNextCommit = false; return; } // 保険: クリック黒塗り直後の1回を握りつぶす(主役は move-guard 側)
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      // 選択がテキストレイヤー内か確認
      if (!textLayer.contains(range.startContainer) && !textLayer.contains(range.commonAncestorContainer)) return;
      var cw = wrap.getBoundingClientRect();
      if (cw.width === 0) return;
      var rects = range.getClientRects();
      var added = 0;
      for (var i=0;i<rects.length;i++){
        var rc = rects[i];
        if (rc.width < 2 || rc.height < 2) continue;
        var padY = rc.height * 0.12;   // 行の上下に少し余白(グリフ完全被覆)
        var x = (rc.left - cw.left) / cw.width;
        var y = (rc.top - cw.top - padY) / cw.height;
        var w = rc.width / cw.width;
        var h = (rc.height + padY*2) / cw.height;
        pushRect(x,y,w,h); added++;
      }
      sel.removeAllRanges();
      if (added){ dedupeRects(st.pageIndex); renderCells(); }  // ★renderCells の前に重複マージ
    }
    document.addEventListener('mouseup', function(){ if (st.pdf && st.mode==='text') setTimeout(commitTextSelection, 0); });
    // ---- タッチ端末の選択確定 (selectionchange 監視) ----
    // タブレットの長押し選択はブラウザがジェスチャを乗っ取るため互換 mouseup が発火せず、
    // 上の mouseup 経路だけだと選択が永遠に未確定(青いまま=黒塗りされない)で残る。
    // そこで selectionchange を監視し、選択の変化が止まって 800ms 経ったら自動確定する。
    // ・マウス操作: ボタン押下中(_mouseHeld)は確定しない=ドラッグ途中の静止で選択が勝手に確定するのを防ぐ。
    //   離した時は上の mouseup 確定→removeAllRanges→collapsed 通知でタイマー解除されるので二重確定しない
    // ・レイヤー外の選択: commitTextSelection 冒頭の contains 判定が弾く(他タブの選択は消さない)
    var selChangeTimer = null;
    var _mouseHeld = false;
    document.addEventListener('mousedown', function(){ _mouseHeld = true; });
    document.addEventListener('mouseup', function(){ _mouseHeld = false; });
    document.addEventListener('touchstart', function(){ _mouseHeld = false; }, { passive: true });  // 長押し選択は互換mouseupが来ずフラグが残るため、実タッチ開始で必ず白紙に
    document.addEventListener('selectionchange', function(){
      if (selChangeTimer){ clearTimeout(selChangeTimer); selChangeTimer = null; }
      if (_mouseHeld || !st.pdf || st.mode !== 'text') return;
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      selChangeTimer = setTimeout(function(){ selChangeTimer = null; commitTextSelection(); }, 800);
    });

    // ---- 自由に四角 (rect モード, overlay 上でドラッグ) ----
    var draw = null;
    overlay.addEventListener('pointerdown', function(e){
      if (st.mode !== 'rect') return;
      var r = overlay.getBoundingClientRect();
      draw = { x0:(e.clientX-r.left)/r.width, y0:(e.clientY-r.top)/r.height, el:null, rect:r };
      try{ overlay.setPointerCapture(e.pointerId); }catch(_){ }
      e.preventDefault();
    });
    overlay.addEventListener('pointermove', function(e){
      if (!draw) return;
      var x=Math.max(0,Math.min(1,(e.clientX-draw.rect.left)/draw.rect.width));
      var y=Math.max(0,Math.min(1,(e.clientY-draw.rect.top)/draw.rect.height));
      var lx=Math.min(draw.x0,x), ly=Math.min(draw.y0,y), w=Math.abs(x-draw.x0), h=Math.abs(y-draw.y0);
      if (!draw.el){ draw.el=document.createElement('div'); draw.el.className='redact-cell'; draw.el.style.pointerEvents='none'; overlay.appendChild(draw.el); }
      draw.el.style.left=(lx*100)+'%'; draw.el.style.top=(ly*100)+'%'; draw.el.style.width=(w*100)+'%'; draw.el.style.height=(h*100)+'%';
    });
    function endDraw(e){
      if (!draw) return;
      try{ overlay.releasePointerCapture(e.pointerId); }catch(_){ }
      var x=Math.max(0,Math.min(1,(e.clientX-draw.rect.left)/draw.rect.width));
      var y=Math.max(0,Math.min(1,(e.clientY-draw.rect.top)/draw.rect.height));
      var lx=Math.min(draw.x0,x), ly=Math.min(draw.y0,y), w=Math.abs(x-draw.x0), h=Math.abs(y-draw.y0);
      if (draw.el) draw.el.remove();
      draw = null;
      pushRect(lx,ly,w,h); dedupeRects(st.pageIndex); renderCells();
    }
    overlay.addEventListener('pointerup', endDraw);
    overlay.addEventListener('pointercancel', endDraw);

    // ウィンドウ幅が変わったら表示倍率を取り直して再フィット(黒塗り矩形は比率保持なので残る)
    var _redactResizeTimer = null;
    window.addEventListener('resize', function(){
      if (!st.pdf || st.exporting) return;
      if (!wrap.offsetParent) return;   // 黒塗りタブ非表示中は再描画しない(隠れたパネルは幅0で誤フィットするため)
      if (_redactResizeTimer) clearTimeout(_redactResizeTimer);
      _redactResizeTimer = setTimeout(function(){ renderPage(st.pageIndex); }, 200);
    });

    // ---- ボタン配線 ----
    if (modeTextBtn) modeTextBtn.addEventListener('click', function(){ setMode('text'); });
    if (modeRectBtn) modeRectBtn.addEventListener('click', function(){ setMode('rect'); });
    prevBtn.addEventListener('click', function(){ renderPage(st.pageIndex-1); });
    nextBtn.addEventListener('click', function(){ renderPage(st.pageIndex+1); });
    clearBtn.addEventListener('click', function(){
      if (st.exporting){ rdStatus('出力中は編集できません。完了までお待ちください。', true); return; }
      if (st.rendering) return;   // 描画中は st.pageIndex が移動先を指すため、見えていない頁の黒塗りを誤って消すのを防ぐ
      if (st.rects[st.pageIndex] && st.rects[st.pageIndex].length){ st.rects[st.pageIndex]=[]; renderCells(); }
    });
    resetBtn.addEventListener('click', function(){
      // 出力中にリセットすると st.numPages=0 で出力ループが即脱出し、先頭数ページだけの
      // 切り詰めPDFが「✓ 出力しました」付きで保存されてしまうため遮断
      if (st.exporting){ rdStatus('出力中は別のPDFを開けません。完了までお待ちください。', true); return; }
      // 進行中の描画/文字レイヤータスクを止め、飛行中の renderPage も世代更新で無効化(旧PDFの描き残し防止)
      if (st.renderTask){ try{ st.renderTask.cancel(); }catch(_){ } st.renderTask=null; }
      if (st.textTask){ try{ st.textTask.cancel(); }catch(_){ } st.textTask=null; }
      st.renderGen++; st.rendering = false;
      st.pdf=null; st.bytes=null; st.rects={}; st.pageIndex=0; st.numPages=0;
      textLayer.innerHTML=''; cellsLayer.innerHTML='';
      // 前のPDFの残像と「文字なし」表示を後始末(次のPDF読込中に旧ページ画像や嘘バナーが見えるのを防ぐ)
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      st.pageHasText = true;   // 仮置き。次の buildTextLayer が頁ごとに必ず再評価する(falseのままだと下の setMode が rect 矯正+文字無しヒントを再注入してしまう)
      wrap.classList.remove('no-text');
      var _bn = document.getElementById('redactNoTextBanner');
      if (_bn) _bn.classList.remove('show');
      setMode(st.prefMode);    // ヒント文言とモード表示を希望モードへ戻す(文字無し頁での rect 矯正を解除)
      editor.classList.remove('active'); upload.style.display=''; fileInput.value='';
    });

    upload.addEventListener('click', function(){ fileInput.click(); });
    fileInput.addEventListener('change', function(e){ if (e.target.files[0]) loadPdf(e.target.files[0]); });
    upload.addEventListener('dragover', function(e){ e.preventDefault(); upload.classList.add('dragover'); });
    upload.addEventListener('dragleave', function(){ upload.classList.remove('dragover'); });
    upload.addEventListener('drop', function(e){ e.preventDefault(); upload.classList.remove('dragover'); if (e.dataTransfer.files && e.dataTransfer.files[0]) loadPdf(e.dataTransfer.files[0]); });

    // ===== 出力エンジン (本物の不可逆消去) — v3.8.0 Phase2 =====
    function rdStatus(msg, isErr){
      var note = document.getElementById('redactExportNote');
      if (note){ note.textContent = msg || ''; note.style.color = isErr ? 'var(--warn, #cc5520)' : ''; }
    }
    function rdTriggerDownload(blob, name){
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ try{ URL.revokeObjectURL(a.href); }catch(_){ } }, 1500);
    }
    function rdTotalRects(){ var n=0; for (var k in st.rects){ if (st.rects[k]) n += st.rects[k].length; } return n; }
    function rdAffectedPages(){ return Object.keys(st.rects).filter(function(k){ return st.rects[k] && st.rects[k].length; }); }

    // 影響ページを高DPIラスタ化(canvasで黒焼き=テキスト物理消滅)、非影響はベクター温存
    async function generateRedactedPdf(){
      var PDFLib = window.PDFLib;
      var srcDoc = await PDFLib.PDFDocument.load(st.bytes);   // 暗号化PDFはここでthrow→runExportでハンドル
      var outDoc = await PDFLib.PDFDocument.create();
      var affected = [];
      var RDPI = 200;
      for (var i = 0; i < st.numPages; i++){
        var rects = st.rects[i] || [];
        if (rects.length){
          affected.push(i);
          rdStatus('黒塗りページを画像化中… (ページ ' + (i+1) + ')');
          await new Promise(function(r){ setTimeout(r, 0); });   // 進捗をUIへ反映
          var page = await st.pdf.getPage(i+1);
          var vp = page.getViewport({ scale: RDPI / 72 });
          var cv = document.createElement('canvas');
          cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          // ★黒は必ず canvas の fillRect でのみ焼く。pdf-lib drawRectangle で被せる
          //   「偽リダクション(下の文字が残る)」は構造的に作らない。
          ctx.fillStyle = '#000';
          for (var j = 0; j < rects.length; j++){
            var r = rects[j];
            ctx.fillRect(Math.round(r.x*cv.width), Math.round(r.y*cv.height),
                         Math.round(r.w*cv.width), Math.round(r.h*cv.height));
          }
          var jpg = cv.toDataURL('image/jpeg', 0.85);
          var bytes = Uint8Array.from(atob(jpg.split(',')[1]), function(c){ return c.charCodeAt(0); });
          var img = await outDoc.embedJpg(bytes);
          var vp1 = page.getViewport({ scale: 1 });   // 出力ページは元のpt寸法(回転適用後)
          var op = outDoc.addPage([vp1.width, vp1.height]);
          op.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
          cv.width = 0; cv.height = 0;   // 大きいcanvasを解放
        } else {
          var copied = await outDoc.copyPages(srcDoc, [i]);   // ベクター温存コピー
          outDoc.addPage(copied[0]);
        }
      }
      // create() ベースなので元の作成者/タイトル等は乗らない。updateMetadata:false で
      // pdf-lib の Producer/ModDate 再注入も防ぐ。
      var outBytes = await outDoc.save({ updateMetadata: false });
      return { outBytes: outBytes, affected: affected };
    }

    // ★出力前の本物消去検証(fail-safe): 影響ページのテキストがゼロである事を機械確認。
    //   1文字でも残っていたらDLさせない。
    async function verifyRedaction(outBytes, affected){
      if (!affected.length) return { ok: true };
      var doc = await L.getDocument({ data: outBytes.slice(0) }).promise;
      for (var k = 0; k < affected.length; k++){
        var page = await doc.getPage(affected[k] + 1);
        var tc = await page.getTextContent();
        var len = 0; for (var m = 0; m < tc.items.length; m++){ len += (tc.items[m].str || '').length; }
        if (len > 0) return { ok: false, page: affected[k] + 1, residual: len };
      }
      return { ok: true };
    }

    async function runExport(){
      if (!st.pdf) return;
      if (rdTotalRects() === 0){ alert('黒塗りが1つもありません。隠したい所をなぞる、または四角で囲ってください。'); return; }
      var affN = rdAffectedPages().length;
      var ok = confirm(
        affN + ' ページが画像に変換されます。\n\n' +
        '・そのページは文字のコピー/検索ができなくなり、解像度はやや下がります(情報を物理的に消すための仕様です)\n' +
        '・黒塗りの無いページは高画質のまま残ります\n\n' +
        '出力しますか?'
      );
      if (!ok) return;
      var btn = document.getElementById('redactExportBtn');
      if (btn) btn.disabled = true;
      try {
        rdStatus('処理を開始しています…');
        var gen = await generateRedactedPdf();
        rdStatus('本当に消えたか検証中…');
        var v = await verifyRedaction(gen.outBytes, gen.affected);
        if (!v.ok){
          rdStatus('❌ ページ' + v.page + ' に文字が残っていました。安全のため出力を中止しました(不具合報告をお願いします)。', true);
          if (btn) btn.disabled = false;
          return;
        }
        var blob = new Blob([gen.outBytes], { type: 'application/pdf' });
        if (window.PdfSanitize){ try { blob = await window.PdfSanitize.process(blob); } catch(_){ } }  // 設定のメタ除去/透かしも適用
        var now = new Date();
        var ymd = '' + now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
        rdTriggerDownload(blob, '墨消し_' + ymd + '.pdf');
        rdStatus('✓ 出力しました(' + gen.affected.length + 'ページを画像化して文字を物理消去)。配布前に必ず中身をご確認ください。');
      } catch(e){
        console.error('redact export failed', e);
        var enc = e && /encrypt/i.test(String(e.message || e));
        rdStatus('❌ ' + (enc ? '暗号化されたPDFは黒塗りできません(パスワードを解除してから読み込んでください)。'
                              : '出力に失敗しました: ' + (e && e.message ? e.message : e)), true);
        if (btn) btn.disabled = false;
        return;
      }
      if (btn) btn.disabled = false;
    }
    var _rdExportBtn = document.getElementById('redactExportBtn');
    // ★出力中の編集ロック(入口): 出力ループはページ矩形の配列参照を反復冒頭で1回だけ捕捉するため、
    //   出力中に追加/削除/リセットすると「画面は黒いのに成果物に反映されない」黒塗り漏れになる。
    //   runExport 本体は実機実証済みのため非改変とし、呼び出し側で st.exporting を立てて編集系で弾く。
    //   完了・失敗・confirmキャンセルのどの経路でも finally で必ず下ろす。
    if (_rdExportBtn){ _rdExportBtn.disabled = false; _rdExportBtn.addEventListener('click', async function(){
      if (st.exporting) return;                    // 二重起動の保険
      st.exporting = true;
      try { await runExport(); } finally { st.exporting = false; }
    }); }
    setMode('text');                 // 初期は文字選択モード
    window.__redactState = st;
  })();

  /* ===== 設定モーダル wiring (success-modal と同じ開閉作法) ===== */
  var PDFC_SETTINGS_KEY = 'pdfc_settings_v1';
  var PDFC_SETTINGS_DEFAULTS = {
    stripMetadata: true,      // rank1: 出力PDFのメタデータを消す (既定ON)
    watermark: false,         // rank2 (v3.7.0): 透かし ON/OFF (既定OFF / opt-in)
    watermarkText: '社外秘'   // rank2: 焼く文言 (既定はプリセット先頭)
  };
  var pdfcSettings = (function loadPdfcSettings() {
    var s = {};
    for (var k in PDFC_SETTINGS_DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(PDFC_SETTINGS_DEFAULTS, k)) s[k] = PDFC_SETTINGS_DEFAULTS[k];
    }
    try {
      var raw = localStorage.getItem(PDFC_SETTINGS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (var key in s) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) s[key] = parsed[key];
          }
        }
      }
    } catch (e) { console.debug('pdfc settings load failed, using defaults:', e); }
    return s;
  })();
  function savePdfcSettings() {
    try { localStorage.setItem(PDFC_SETTINGS_KEY, JSON.stringify(pdfcSettings)); }
    catch (e) { console.warn('pdfc settings save failed:', e); }
  }
  /* M13対策: 別タブでの設定変更を反映する。storage イベントは「他タブが書いた時」
     だけ発火する(自タブの savePdfcSettings では発火しない)。これが無いと各タブが
     起動時スナップショットを抱え続け、古いタブの全量上書き保存で設定が無言で巻き戻る。 */
  function reloadPdfcSettingsFromStorage() {
    try {
      var raw = localStorage.getItem(PDFC_SETTINGS_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      for (var k in PDFC_SETTINGS_DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(PDFC_SETTINGS_DEFAULTS, k)) continue;
        pdfcSettings[k] = (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, k))
          ? parsed[k] : PDFC_SETTINGS_DEFAULTS[k];
      }
    } catch (e) { console.debug('pdfc settings reload failed:', e); }
  }
  window.addEventListener('storage', function (e) {
    if (e.key !== null && e.key !== PDFC_SETTINGS_KEY) return;   // key=null は clear() による全消し
    reloadPdfcSettingsFromStorage();
    // 設定モーダルを開いていたらトグル・チップ・プレビュー表示も即同期する
    var modal = document.getElementById('settingsModal');
    if (modal && modal.classList.contains('open')) syncSettingsUiFromState();
  });
  /* グローバル公開: 各モードIIFE / window.PdfSanitize から設定を読む唯一の窓口 */
  window.PdfSanitizeSettings = {
    get: function (key) { return pdfcSettings[key]; },
    all: function () { var c = {}; for (var k in pdfcSettings) c[k] = pdfcSettings[k]; return c; },
    metadataEnabled: function () { return pdfcSettings.stripMetadata !== false; },
    watermarkEnabled: function () { return pdfcSettings.watermark === true; },
    watermarkText: function () {
      var t = (pdfcSettings.watermarkText || '').trim();
      return t || '社外秘';   // 空保存でも helper 側がコケない保険
    }
  };
  /* 透かしプリセット定義 (HTML のチップ value と一致させる) */
  var WM_PRESETS = ['社外秘', '複製禁止', 'DRAFT'];

  /* 絵文字(サロゲートペア=U+10000以上)は透かしフォント(NotoSansJP)にグリフが無く、
     プレビューでは見えても出力PDFで欠落する。UI側の保存/プレビュー経路で除去する (M14) */
  function wmStripUnsupported(t) {
    return String(t == null ? '' : t).replace(/[\u{10000}-\u{10FFFF}]/gu, '');
  }
  /* 除去が起きた時だけ入力欄下の注記を表示する */
  function wmShowEmojiNote(show) {
    var note = document.getElementById('setWatermarkEmojiNote');
    if (note) note.hidden = !show;
  }

  /* いま焼かれる実効テキスト (カスタム選択中はテキスト欄の値) */
  function wmEffectiveText() {
    var customChecked = document.querySelector('.wm-chip-input[data-custom]:checked');
    if (customChecked) {
      var inp = document.getElementById('setWatermarkText');
      return inp ? wmStripUnsupported(inp.value).trim() : '';
    }
    var presetChecked = document.querySelector('.wm-chip-input[data-preset]:checked');
    return presetChecked ? presetChecked.value : '';
  }

  /* プレビュー更新: 空なら警告表示に切替 */
  function wmRenderPreview() {
    var box = document.getElementById('setWatermarkPreview');
    var sample = document.getElementById('setWatermarkPreviewSample');
    if (!box || !sample) return;
    var customChecked = document.querySelector('.wm-chip-input[data-custom]:checked');
    var txt = wmEffectiveText();
    if (!txt) {
      box.classList.add('is-empty');
      sample.textContent = customChecked ? '文字を入れてください' : '—';
    } else {
      box.classList.remove('is-empty');
      sample.textContent = txt;
    }
  }

  /* state(watermarkText) → UI。開くたび正しいチップを選び直す */
  function syncWatermarkUi() {
    var on   = document.getElementById('setWatermark');
    var wrap = document.getElementById('setWatermarkTextWrap');
    var customWrap = document.getElementById('setWatermarkCustomWrap');
    var inp  = document.getElementById('setWatermarkText');
    if (!on || !wrap) return;

    var enabled = (pdfcSettings.watermark === true);
    on.checked = enabled;
    wrap.hidden = !enabled;

    var saved = (pdfcSettings.watermarkText || '').trim();
    var isPreset = WM_PRESETS.indexOf(saved) !== -1;
    var targetVal = isPreset ? saved : '__custom__';
    if (!saved) targetVal = '社外秘';            // 初回(空)はプリセット先頭

    var chips = document.querySelectorAll('.wm-chip-input');
    for (var i = 0; i < chips.length; i++) {
      chips[i].checked = (chips[i].value === targetVal);
    }
    var custom = (targetVal === '__custom__');
    if (customWrap) customWrap.hidden = !custom;
    if (inp) inp.value = custom ? wmStripUnsupported(saved) : '';   // 旧保存の絵文字も表示前に除去 (M14)
    wmShowEmojiNote(false);   // 開き直し/同期時は注記をリセット

    wmRenderPreview();
  }

  function syncSettingsUiFromState() {
    var meta = document.getElementById('setMetaStrip');
    if (meta) meta.checked = (pdfcSettings.stripMetadata !== false);
    syncWatermarkUi();   // 透かしUIの状態復元 (rank2)
  }
  function openSettings() {
    var modal = document.getElementById('settingsModal');
    if (!modal) { console.error('settingsModal missing'); return; }
    markSettingsSeen();
    syncSettingsUiFromState();
    modal.classList.add('open');
  }
  function closeSettings() {
    var modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('open');
  }
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  /* 設定の新機能コーチマーク (v3.7.1): 一度開いたら二度と出さない */
  var SETTINGS_SEEN_KEY = 'pdfCompact.settingsSeen';
  function markSettingsSeen() {
    try { localStorage.setItem(SETTINGS_SEEN_KEY, '1'); } catch(_) {}
    document.body.classList.remove('settings-unseen');
    var cm = document.getElementById('settingsCoachmark'); if (cm) cm.classList.remove('show');
  }
  function initSettingsHint() {
    var seen = false; try { seen = localStorage.getItem(SETTINGS_SEEN_KEY) === '1'; } catch(_) {}
    if (seen) return;
    document.body.classList.add('settings-unseen');
    var closeBtn = document.getElementById('settingsCoachClose');
    if (closeBtn && !closeBtn.__bound) { closeBtn.__bound = true; closeBtn.addEventListener('click', markSettingsSeen); }
    if (window.innerWidth >= 720) {
      var btn = document.getElementById('settingsBtn'); var cm = document.getElementById('settingsCoachmark');
      if (btn && cm) {
        var r = btn.getBoundingClientRect();
        cm.style.top = (r.bottom + 10) + 'px';
        cm.style.right = Math.max(8, (window.innerWidth - r.right)) + 'px';
        cm.classList.add('show');
        setTimeout(function(){ cm.classList.remove('show'); }, 12000);
      }
    }
  }
  /* トグル変更 → 即 state 反映 + 即保存 (おっちゃんが「保存」を押し忘れても効く) */
  /* 透かしUI 変更 → state へ即保存 (閉じ忘れても効く) */
  function bindWatermarkControls() {
    var on  = document.getElementById('setWatermark');
    var inp = document.getElementById('setWatermarkText');
    var customWrap = document.getElementById('setWatermarkCustomWrap');
    var wrap = document.getElementById('setWatermarkTextWrap');

    if (on) {
      on.addEventListener('change', function () {
        pdfcSettings.watermark = !!on.checked;
        if (wrap) wrap.hidden = !on.checked;
        if (on.checked) {
          if (!(pdfcSettings.watermarkText || '').trim()) {
            pdfcSettings.watermarkText = '社外秘';   // 初回ONでプリセット先頭
          }
          syncWatermarkUi();
        }
        savePdfcSettings();
      });
    }

    var chipGroup = document.querySelector('.wm-chips');
    if (chipGroup) {
      chipGroup.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('wm-chip-input')) return;
        var custom = !!t.getAttribute('data-custom');
        if (customWrap) customWrap.hidden = !custom;
        if (custom) {
          if (inp) {
            if (WM_PRESETS.indexOf((pdfcSettings.watermarkText || '').trim()) !== -1) inp.value = '';
            inp.focus();
          }
        }
        pdfcSettings.watermarkText = wmEffectiveText();
        wmRenderPreview();
        savePdfcSettings();
      });
    }

    if (inp) {
      inp.addEventListener('input', function () {
        // 絵文字は透かしに焼けない → 入力時点で除去し、除去が起きた時だけ注記を出す (M14)
        var cleaned = wmStripUnsupported(inp.value);
        if (cleaned !== inp.value) {
          inp.value = cleaned;
          wmShowEmojiNote(true);
        } else {
          wmShowEmojiNote(false);
        }
        pdfcSettings.watermarkText = cleaned.trim();
        wmRenderPreview();
        savePdfcSettings();
      });
    }
  }

  (function bindSettingsControls() {
    var meta = document.getElementById('setMetaStrip');
    if (meta) {
      meta.addEventListener('change', function () {
        pdfcSettings.stripMetadata = !!meta.checked;
        savePdfcSettings();
      });
    }
    bindWatermarkControls();   // 透かしUIバインド (rank2)。1回だけ
  })();
  /* 閉じる作法: 背景クリック + ESC (success-modal と同一パターン) */
  (function bindSettingsClose() {
    var modal = document.getElementById('settingsModal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target.id === 'settingsModal') closeSettings();
      });
    }
    document.addEventListener('keydown', function (e) {
      var m = document.getElementById('settingsModal');
      if (e.key === 'Escape' && m && m.classList.contains('open')) closeSettings();
    });
  })();
