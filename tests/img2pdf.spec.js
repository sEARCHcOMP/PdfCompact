// 画像→PDF モードのスモークテスト。v3.7.6 の H3(画像合わせ縦化け)/H4(EXIF無圧縮)の回帰防止。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, probePdfPixels, dark } = require('./helpers');

/** 生成ボタンの出現を待ってクリック */
async function clickGenerate(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(b => /PDF作成/.test(b.textContent) && b.offsetParent), null, { timeout: 20_000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => /PDF作成/.test(b.textContent) && b.offsetParent).click();
  });
}

test.describe('画像→PDF', () => {

  test('用紙「画像合わせ」: 横長写真が横長ページになり右端まで画像が載る', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '画像');
    await page.evaluate(async () => {
      const cv = document.createElement('canvas'); cv.width = 800; cv.height = 600;
      cv.getContext('2d').fillStyle = '#999'; cv.getContext('2d').fillRect(0, 0, 800, 600);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
      const inp = document.getElementById('imgFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'landscape.jpg', { type: 'image/jpeg' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#modeImgToPdf [data-size]')].some(b => b.dataset.size === 'fit'), null, { timeout: 15_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('#modeImgToPdf [data-size]')].find(b => b.dataset.size === 'fit').click();
    });
    await armCapture(page);
    await clickGenerate(page);
    const idx = await waitCapture(page, '%PDF');
    const r = await probePdfPixels(page, idx, [['rightEdge', 0.95, 0.5]]);
    expect(r.vpW).toBeGreaterThan(r.vpH);                       // 横長ページ(旧コードは縦に化けた)
    expect(Math.abs(r.vpW / r.vpH - 800 / 600)).toBeLessThan(0.05);  // 縦横比維持
    const p = r.px.rightEdge;
    expect(p.r + p.g + p.b).toBeGreaterThan(300);               // 右端まで画像(灰色)が載る = 右欠けなし
    expect(p.r + p.g + p.b).toBeLessThan(600);
  });

  test('無圧縮 + EXIF回転(Orientation=6)写真が正立して出力される', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '画像');
    await page.evaluate(async () => {
      // 200x100(左=赤・右=青)のJPEGに Orientation=6 の EXIF APP1 を注入
      // → ブラウザ表示は90度CW回転で 100x200・上=赤・下=青 が正
      const cv = document.createElement('canvas'); cv.width = 200; cv.height = 100;
      const x = cv.getContext('2d');
      x.fillStyle = '#dd0000'; x.fillRect(0, 0, 100, 100);
      x.fillStyle = '#0000dd'; x.fillRect(100, 0, 100, 100);
      const jb = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.95));
      const jbytes = new Uint8Array(await jb.arrayBuffer());
      const exif = new Uint8Array([
        0xFF, 0xE1, 0x00, 0x22,                                  // APP1, len=34
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,                      // "Exif\0\0"
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,          // TIFF(II), IFD@8
        0x01, 0x00,                                              // entries=1
        0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,  // Orientation=6
        0x00, 0x00, 0x00, 0x00,                                  // next IFD
      ]);
      const withExif = new Uint8Array(2 + exif.length + (jbytes.length - 2));
      withExif.set(jbytes.slice(0, 2), 0);
      withExif.set(exif, 2);
      withExif.set(jbytes.slice(2), 2 + exif.length);
      const inp = document.getElementById('imgFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([withExif], { type: 'image/jpeg' })], 'phone.jpg', { type: 'image/jpeg' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#modeImgToPdf [data-q]')].some(b => b.dataset.q === 'original'), null, { timeout: 15_000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('#modeImgToPdf [data-q]')].find(b => b.dataset.q === 'original').click();   // 無圧縮
      [...document.querySelectorAll('#modeImgToPdf [data-size]')].find(b => b.dataset.size === 'fit').click();  // 画像合わせ
    });
    await armCapture(page);
    await clickGenerate(page);
    const idx = await waitCapture(page, '%PDF');
    const r = await probePdfPixels(page, idx, [['top', 0.5, 0.25], ['bottom', 0.5, 0.75]]);
    expect(r.vpH).toBeGreaterThan(r.vpW);          // 縦長(正立)。旧コードは横倒しだった
    expect(r.px.top.r).toBeGreaterThan(150);       // 上=赤
    expect(r.px.top.b).toBeLessThan(100);
    expect(r.px.bottom.b).toBeGreaterThan(150);    // 下=青
    expect(r.px.bottom.r).toBeLessThan(100);
  });

});
