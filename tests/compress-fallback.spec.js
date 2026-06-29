// 軽量化の自動フォールバック(spec: pdfcompact-autocompress-fallback-spec.md §8 受け入れ基準)。
// 書類モードで縮まないPDFを auto で投入したとき、写真モードへ自動フォールバックして
// 確実に縮むこと / ベクタや手動docでは勝手に画像化しないこと を固定する。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, pdfTexts } = require('./helpers');

// 軽量化タブにPDFを作って投入。withImage=true なら「doc判定されるが再圧縮不能な
// 大きいノイズPNG」を埋め込む(= FlateDecode画像、書類モードでは縮まない)。
// 戻り値: 投入PDFのバイト数(origSize 比較用)
async function loadCompressPdf(page, withImage) {
  return await page.evaluate(async (withImage) => {
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    // detectBestMode が 'doc' を返すよう 200字/頁 超のテキストを描く
    const line = 'This PDF has enough searchable text to be auto-detected as document mode. ';
    for (let i = 0; i < 14; i++) {
      p.drawText(line, { x: 40, y: 800 - i * 22, size: 9, font, color: rgb(0, 0, 0) });
    }
    if (withImage) {
      // 大きいノイズPNG(FlateDecodeで圧縮が効かない=書類モードで縮まない大物)
      const cv = document.createElement('canvas'); cv.width = 700; cv.height = 500;
      const cx = cv.getContext('2d');
      const im = cx.createImageData(700, 500);
      for (let i = 0; i < im.data.length; i += 4) {
        im.data[i] = Math.random() * 256; im.data[i + 1] = Math.random() * 256;
        im.data[i + 2] = Math.random() * 256; im.data[i + 3] = 255;
      }
      cx.putImageData(im, 0, 0);
      const pngBlob = await new Promise(r => cv.toBlob(r, 'image/png'));
      const png = await doc.embedPng(new Uint8Array(await pngBlob.arrayBuffer()));
      p.drawImage(png, { x: 40, y: 300, width: 350, height: 250 });
    }
    const bytes = await doc.save();
    const inp = document.querySelector('#modeCompress input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'c.pdf', { type: 'application/pdf' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return bytes.length;
  }, withImage);
}

async function runCompressAndGetNote(page) {
  await page.waitForFunction(() => {
    const b = document.getElementById('compressBtn');
    return b && !b.disabled && b.offsetParent;
  }, null, { timeout: 20_000 });
  await armCapture(page);
  await page.evaluate(() => document.getElementById('compressBtn').click());
  await page.waitForFunction(
    () => /✓ 完了/.test(document.querySelector('#modeCompress')?.textContent || ''),
    null, { timeout: 120_000 });
  return await page.evaluate(() => {
    const el = document.querySelector('#modeCompress .status.done');
    return el ? el.textContent : '';
  });
}

// 完了後に DL ボタンを押して出力PDFを捕捉、index を返す
async function captureOutput(page) {
  await page.evaluate(() => {
    const dl = [...document.querySelectorAll('#modeCompress button')].find(b => b.textContent.trim() === 'DL');
    dl.click();
  });
  return await waitCapture(page, '%PDF');
}

test.describe('軽量化フォールバック', () => {

  test('E-1: auto + 非JPEG画像で縮まない → 写真フォールバックで縮む(ページ画像化)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '軽量化');
    const origSize = await loadCompressPdf(page, true);
    const note = await runCompressAndGetNote(page);
    // F1ガード: フォールバックで画像化したらモードタグも「写真モード」になる(「書類モード」のままにしない)
    const modeTag = await page.evaluate(() => {
      const el = document.querySelector('#modeCompress .mode-tag');
      return el ? el.textContent : '';
    });
    const idx = await captureOutput(page);
    const texts = await pdfTexts(page, idx);
    const outSize = await page.evaluate((i) => window.__caps[i].size, idx);

    expect(note, 'note は写真フォールバック').toMatch(/画像化/);   // PHOTO_FALLBACK
    expect(modeTag, 'モードタグは写真(F1: 書類タグと矛盾させない)').toBe('写真モード');
    expect(texts[0], '出力はラスタ化され検索テキストが消える').toBe('');
    expect(outSize, '出力は元より小さい').toBeLessThan(origSize);
  });

  test('E-4: auto + 画像なし(ベクタ/テキスト)→ フォールバックせずテキスト維持', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '軽量化');
    await loadCompressPdf(page, false);
    const note = await runCompressAndGetNote(page);
    const idx = await captureOutput(page);
    const texts = await pdfTexts(page, idx);

    expect(note, 'note は画像なし(ベクタ)').toMatch(/画像なし|ベクタ/);   // DOC_NO_IMAGE
    expect(texts[0], 'ラスタ化されずテキストが残る(画質劣化なし)').toContain('searchable text');
  });

  test('E-6: 手動「書類モード」+ 縮まない画像 → フォールバックせず理由提示(テキスト維持)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, '軽量化');
    // 手動で「書類」モードを選択(auto を外す)
    await page.evaluate(() => {
      const btn = document.querySelector('#modes .mode-btn[data-mode="doc"]');
      btn.click();
    });
    await loadCompressPdf(page, true);
    const note = await runCompressAndGetNote(page);
    const idx = await captureOutput(page);
    const texts = await pdfTexts(page, idx);

    // D-1 の契約=手動docは絶対に画像化しない(テキスト維持)。これが本質。
    // note は doc結果が縮んだか(DOC_INEFFECTIVE_MANUAL)縮まなかったか(最終ガードで
    // ALREADY_OPTIMIZED)で変わるが、いずれも「写真フォールバックしていない」点が重要。
    expect(texts[0], '手動docは画像化しないのでテキストが残る').toContain('searchable text');
    expect(note, '写真フォールバックの note ではない').not.toMatch(/画像化/);
  });

});
