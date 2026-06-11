// サニタイズ基盤(透かし/メタ除去)のスモークテスト。
// v3.7.5「無言失敗の根絶」と隠れバグ(透かし単独ON)の回帰防止。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, pdfTexts } = require('./helpers');

/** 画像→PDF で 1枚生成して出力を捕捉(サニタイズ経路の最短テストドライバ) */
async function generateOnePdf(page) {
  await gotoTab(page, '画像');
  await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200;
    cv.getContext('2d').fillStyle = '#ccc'; cv.getContext('2d').fillRect(0, 0, 300, 200);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
    const inp = document.getElementById('imgFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'one.jpg', { type: 'image/jpeg' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(b => /PDF作成/.test(b.textContent) && b.offsetParent), null, { timeout: 20_000 });
  await armCapture(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => /PDF作成/.test(b.textContent) && b.offsetParent).click();
  });
  return await waitCapture(page, '%PDF');
}

test.describe('サニタイズ基盤', () => {

  test('透かし単独ON(メタ除去OFF)でも透かしが入り、メタデータは温存される', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      localStorage.setItem('pdfc_settings_v1', JSON.stringify({ stripMetadata: false, watermark: true, watermarkText: '社外秘' }));
    });
    await page.reload();
    await page.waitForFunction(() => window.PDFLib && window.pdfjsLib, null, { timeout: 60_000 });
    await page.evaluate(() => { window.confirm = () => true; window.alert = () => {}; });

    const idx = await generateOnePdf(page);
    const texts = await pdfTexts(page, idx);
    expect(texts[0]).toContain('社外秘');   // 透かし適用
    const producer = await page.evaluate(async (i) => {
      const rd = await window.pdfjsLib.getDocument({ data: window.__caps[i].bytes.slice(0) }).promise;
      const m = await rd.getMetadata().catch(() => null);
      return m && m.info ? m.info.Producer : null;
    }, idx);
    expect(producer).toBeTruthy();          // メタ除去OFFの設定を尊重(Producerが残る)
  });

  test('透かしフォント取得失敗: 警告トースト表示+透かし無しで出力は継続', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      localStorage.setItem('pdfc_settings_v1', JSON.stringify({ stripMetadata: false, watermark: true, watermarkText: '社外秘' }));
    });
    await page.reload();
    await page.waitForFunction(() => window.PDFLib && window.pdfjsLib, null, { timeout: 60_000 });
    await page.evaluate(() => {
      window.confirm = () => true; window.alert = () => {};
      // オフライン/プロキシ遮断の再現: 透かしフォントの fetch だけ落とす
      const orig = window.fetch.bind(window);
      window.fetch = (url, opts) => String(url).includes('NotoSansJP')
        ? Promise.reject(new TypeError('Failed to fetch (simulated offline)'))
        : orig(url, opts);
    });

    const idx = await generateOnePdf(page);
    // トーストが実表示される(無言スキップしない)
    await page.waitForFunction(() => {
      const t = document.getElementById('pdfcSanitizeWarn');
      return t && t.style.display === 'block' && /透かしを入れられませんでした/.test(t.textContent);
    }, null, { timeout: 15_000 });
    // 出力は継続し、透かしは入っていない
    const texts = await pdfTexts(page, idx);
    expect(texts[0]).not.toContain('社外秘');
  });

  test('透かしカスタム文字: 絵文字は入力時に除去され注記が出る', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(() => {
      const inp = document.getElementById('setWatermarkText');
      const note = document.getElementById('setWatermarkEmojiNote');
      inp.value = '極秘🔥注意';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return { value: inp.value, noteShown: !note.hidden };
    });
    expect(r.value).toBe('極秘注意');
    expect(r.noteShown).toBe(true);
  });

});
