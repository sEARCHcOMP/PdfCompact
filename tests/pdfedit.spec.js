// PDF編集モードのスモークテスト。v3.7.4 の movePage 死亡修正と v3.7.5 の読込失敗まとめ表示の回帰防止。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, pdfTexts } = require('./helpers');

test.describe('PDF編集', () => {

  test('単一PDFのページ並び替え → 正しい順序で出力(旧movePage死の回帰防止)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'PDF編集');
    await page.evaluate(async () => {
      const { PDFDocument, StandardFonts } = window.PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (const t of ['P-ONE', 'P-TWO', 'P-THREE']) {
        const p = doc.addPage([300, 300]);
        p.drawText(t, { x: 40, y: 150, size: 20, font });
      }
      const bytes = await doc.save();
      const inp = document.getElementById('editFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'reorder.pdf', { type: 'application/pdf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // サムネ3枚を待つ
    await page.waitForFunction(
      () => document.querySelectorAll('#editPageGrid .edit-page-card').length === 3, null, { timeout: 30_000 });
    // 3枚目を先頭へ(合成ドラッグ)
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#editPageGrid .edit-page-card')];
      const dt = new DataTransfer();
      cards[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      cards[2].dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await armCapture(page);
    await page.evaluate(() => document.getElementById('editGenerateBtn').click());
    const idx = await waitCapture(page, '%PDF');
    expect(await pdfTexts(page, idx)).toEqual(['P-THREE', 'P-ONE', 'P-TWO']);
  });

  test('壊れたPDF混在: 消えないまとめ表示+正常分は読込される', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'PDF編集');
    await page.evaluate(async () => {
      const { PDFDocument, StandardFonts } = window.PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (const t of ['G-1', 'G-2']) {
        const p = doc.addPage([300, 300]);
        p.drawText(t, { x: 40, y: 150, size: 20, font });
      }
      const good = await doc.save();
      const garbage = new Uint8Array(2000);
      for (let i = 0; i < 2000; i++) garbage[i] = (i * 37 + 11) % 256;
      const inp = document.getElementById('editFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([good], { type: 'application/pdf' })], 'good.pdf', { type: 'application/pdf' }));
      dt.items.add(new File([new Blob([garbage], { type: 'application/pdf' })], 'broken.pdf', { type: 'application/pdf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // まとめ表示が「残る」+ 正常分2頁が読込済み
    await page.waitForFunction(() => {
      const st = document.getElementById('editStatusMsg')?.textContent || '';
      const cards = document.querySelectorAll('#editPageGrid .edit-page-card').length;
      return /読み込めませんでした/.test(st) && /broken\.pdf/.test(st) && cards === 2;
    }, null, { timeout: 30_000 });
    // 1秒後も消えていない(旧バグ: setStatus('') で即消し)
    await page.waitForTimeout(1000);
    await expect(page.locator('#editStatusMsg')).toContainText('broken.pdf');
  });

});
