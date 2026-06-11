// 変換モードのスモークテスト。v3.7.6 の H5(透過黒化け)/H6(同名消失)/M6(巨大画像全滅)の回帰防止。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, probePdfPixels, white } = require('./helpers');

test.describe('変換', () => {

  test('透過PNG→PDF: 背景が白になる(黒化けしない)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '変換');
    await page.evaluate(async () => {
      const cv = document.createElement('canvas'); cv.width = 300; cv.height = 200;
      const x = cv.getContext('2d');
      x.fillStyle = '#dd0000'; x.beginPath(); x.arc(150, 100, 60, 0, 7); x.fill();   // 赤丸+透明背景
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      const inp = document.getElementById('convFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'logo.png', { type: 'image/png' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#modeConvert [data-format]')].some(b => b.dataset.format === 'pdf'), null, { timeout: 15_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('#modeConvert [data-format]')].find(b => b.dataset.format === 'pdf').click();
    });
    // サムネ生成完了を待ってから実行
    await page.waitForFunction(() => !/読込中/.test(document.querySelector('#modeConvert')?.textContent || ''), null, { timeout: 20_000 });
    await armCapture(page);
    await page.evaluate(() => document.getElementById('convGenerateBtn').click());
    const idx = await waitCapture(page, '%PDF');
    const r = await probePdfPixels(page, idx, [['corner', 0.05, 0.05], ['center', 0.5, 0.5]]);
    expect(white(r.px.corner)).toBe(true);          // 透明だった所 = 白(旧コードは黒)
    expect(r.px.center.r).toBeGreaterThan(150);     // 赤丸は維持
  });

  test('同名2枚+9000px巨大画像 → ZIPに3枚とも(連番付与・全滅しない)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '変換');
    await page.evaluate(async () => {
      const mk = async (w, h, color, type = 'image/jpeg') => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
        return await new Promise(r => c.toBlob(r, type, 0.9));
      };
      const red = await mk(200, 150, '#cc0000');
      const blue = await mk(200, 150, '#0000cc');
      const big = await mk(9000, 80, '#00aa00', 'image/png');   // canvas上限ガード(8192px縮小)の検証
      const inp = document.getElementById('convFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([red], 'photo.jpg', { type: 'image/jpeg' }));
      dt.items.add(new File([blue], 'photo.jpg', { type: 'image/jpeg' }));   // 同名・別内容
      dt.items.add(new File([big], 'big.png', { type: 'image/png' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#modeConvert [data-format]')].some(b => b.dataset.format === 'jpg'), null, { timeout: 20_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('#modeConvert [data-format]')].find(b => b.dataset.format === 'jpg').click();
    });
    await page.waitForFunction(() => !/読込中/.test(document.querySelector('#modeConvert')?.textContent || ''), null, { timeout: 30_000 });
    await armCapture(page);
    await page.evaluate(() => document.getElementById('convGenerateBtn').click());
    const idx = await waitCapture(page, 'PK', 60_000);   // 複数出力は自動ZIP
    const names = await page.evaluate(async (i) => {
      const jz = await window.JSZip.loadAsync(window.__caps[i].bytes.buffer);
      return Object.keys(jz.files);
    }, idx);
    expect(names.sort()).toEqual(['big.jpg', 'photo (2).jpg', 'photo.jpg'].sort());  // 連番+巨大も完走
  });

});
