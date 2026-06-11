// テスト共通部品: 実証済みの検証パターン(docs/plans/refactoring-handoff.md §3)の移植。
// 方針: 判定ロジックは page.evaluate 内で完結させ、小さなJSONだけ返す(blob転送を避ける)。
const { expect } = require('@playwright/test');

/** アプリを開いて CDN ライブラリの読込完了まで待ち、ダイアログを潰す */
async function openApp(page) {
  await page.goto('/pdf_compact_bundle.html');
  await page.waitForFunction(
    () => window.PDFLib && window.pdfjsLib && window.JSZip,
    null, { timeout: 60_000 }
  );
  await page.evaluate(() => {
    window.confirm = () => true;   // 出力確認・削除確認を自動OK
    window.alert = () => {};
    // テストは素の状態で: 透かし/メタ除去は明示テスト以外OFF
    localStorage.setItem('pdfc_settings_v1', JSON.stringify({ stripMetadata: false, watermark: false }));
  });
}

/** モードタブへ切替(ラベル部分一致 or data-mode 一致) */
async function gotoTab(page, key) {
  await page.evaluate((k) => {
    const tab = [...document.querySelectorAll('.mode-tab')]
      .find(t => t.getAttribute('data-mode') === k || (t.textContent || '').includes(k));
    if (!tab) throw new Error('tab not found: ' + k);
    tab.click();
  }, key);
  await page.waitForTimeout(300);
}

/**
 * ダウンロード捕捉を仕込む。URL.createObjectURL をフックし、blob を即
 * 永続コピー(detach対策: handoff §3)+マジックバイト分類で window.__caps に積む。
 * <a>.click() は無効化(実DLさせない)。
 */
async function armCapture(page) {
  await page.evaluate(() => {
    window.__caps = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) {
      if (b && b.arrayBuffer) {
        b.arrayBuffer().then(buf => {
          const u = new Uint8Array(buf);
          const magic = String.fromCharCode(...u.slice(0, 4));
          window.__caps.push({ magic, size: u.length, bytes: u });
        });
      }
      return orig(b);
    };
    HTMLAnchorElement.prototype.click = function () {};
  });
}

/** magic先頭一致で捕捉済みバイト列を待つ('%PDF' / 'PK' 等)。page側に残し、indexを返す */
async function waitCapture(page, magicPrefix, timeoutMs = 30_000) {
  await page.waitForFunction(
    (m) => (window.__caps || []).some(c => c.magic.startsWith(m)),
    magicPrefix, { timeout: timeoutMs }
  );
  return await page.evaluate(
    (m) => (window.__caps || []).findIndex(c => c.magic.startsWith(m)),
    magicPrefix
  );
}

/** 捕捉済みPDF(index)を page 内の pdf.js でレンダし、指定点のRGBを返す。回転/CropBox込みの viewport 基準 */
async function probePdfPixels(page, capIndex, points) {
  return await page.evaluate(async ({ idx, pts }) => {
    const bytes = window.__caps[idx].bytes;
    const rd = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const pg = await rd.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const out = { vpW: Math.round(vp.width), vpH: Math.round(vp.height), rotate: pg.rotate, px: {} };
    for (const [name, fx, fy] of pts) {
      const d = ctx.getImageData(Math.round(vp.width * fx), Math.round(vp.height * fy), 1, 1).data;
      out.px[name] = { r: d[0], g: d[1], b: d[2] };
    }
    return out;
  }, { idx: capIndex, pts: points });
}

/** 捕捉済みバイト列(index)に文字列が生バイトとして含まれるか(偽リダクション検査: handoff §0法則5) */
async function rawScan(page, capIndex, needle) {
  return await page.evaluate(({ idx, s }) => {
    const b = window.__caps[idx].bytes;
    const n = [...s].map(c => c.charCodeAt(0));
    for (let i = 0; i <= b.length - n.length; i++) {
      let ok = true;
      for (let j = 0; j < n.length; j++) if (b[i + j] !== n[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }, { idx: capIndex, s: needle });
}

/** 捕捉済みPDF(index)の各ページ文字列を返す */
async function pdfTexts(page, capIndex) {
  return await page.evaluate(async (idx) => {
    const bytes = window.__caps[idx].bytes;
    const rd = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const out = [];
    for (let i = 1; i <= rd.numPages; i++) {
      const tc = await (await rd.getPage(i)).getTextContent();
      out.push(tc.items.map(it => it.str).join(''));
    }
    return out;
  }, capIndex);
}

const dark = (p) => p.r + p.g + p.b < 150;
const white = (p) => p.r + p.g + p.b > 700;

module.exports = { expect, openApp, gotoTab, armCapture, waitCapture, probePdfPixels, rawScan, pdfTexts, dark, white };
