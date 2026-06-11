// 軽量化モードのスモークテスト。v3.7.6 の M2(再クリック偽完了)の回帰防止+基本動作。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab } = require('./helpers');

test.describe('軽量化', () => {

  test('圧縮完了 → 再クリックで全件リセットして再処理される(偽完了の回帰防止)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '軽量化');
    await page.evaluate(async () => {
      const { PDFDocument, StandardFonts } = window.PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const p = doc.addPage([595, 842]);
      p.drawText('COMPRESS-ME body text for doc mode', { x: 60, y: 700, size: 14, font });
      const bytes = await doc.save();
      const inp = document.querySelector('#modeCompress input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'tiny.pdf', { type: 'application/pdf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 1回目: 開始 → 完了(行に「エラー」が出ないこと)
    const startBtn = () => page.evaluate(() => document.getElementById('compressBtn').click());
    await page.waitForFunction(() => { const b = document.getElementById('compressBtn'); return b && !b.disabled && b.offsetParent; }, null, { timeout: 20_000 });
    await startBtn();
    await page.waitForFunction(() => !document.getElementById('compressBtn').disabled && /削減|完了|→/.test(document.getElementById('modeCompress').textContent), null, { timeout: 60_000 });

    // 2回目: 再クリック直後に「全件が done でなくなる(=リセットされた)」瞬間を捕捉
    // (M2修正が無いと done のまま一切処理されず、この条件は永遠に成立しない)
    await page.evaluate(() => {
      window.__wasReset = false;
      const tick = () => {
        const cards = document.querySelectorAll('#modeCompress .file-row, #modeCompress [class*="row"]');
        // done表示が消えた(待機中/処理中に戻った)瞬間を拾う
        if (/待機中|処理中|圧縮中|解析/.test(document.getElementById('modeCompress').textContent)) window.__wasReset = true;
        if (!window.__wasReset) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await startBtn();
    await page.waitForFunction(() => window.__wasReset === true, null, { timeout: 15_000 });   // リセット経由 = 再処理された
    await page.waitForFunction(() => !document.getElementById('compressBtn').disabled, null, { timeout: 60_000 });
    const hasError = await page.evaluate(() => /エラー:/.test(document.getElementById('modeCompress').textContent));
    expect(hasError).toBe(false);
  });

});
