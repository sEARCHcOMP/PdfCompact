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
