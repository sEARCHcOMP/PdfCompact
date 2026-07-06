// 黒塗り(墨消し)のスモークテスト — 安全の本丸。
// 最重要は「出力の本物消去」(生バイト走査で秘密ゼロ)。これが落ちたら絶対に配布しない。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, rawScan, pdfTexts, probePdfPixels } = require('./helpers');

/** 黒塗りタブに合成PDFを読み込み、テキスト層の準備まで待つ */
async function loadRedactPdf(page, builderBody) {
  await gotoTab(page, 'redact');
  await page.evaluate(async (body) => {
    const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // builderBody は (doc, font, rgb, degrees) を使ってページを組み立てる関数本体
    await (new Function('doc', 'font', 'rgb', 'degrees', '"use strict";' + body))(doc, font, rgb, degrees);
    const bytes = await doc.save();
    const inp = document.getElementById('redactFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'test.pdf', { type: 'application/pdf' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, builderBody);
}

/** テキスト層の span が現れるまで待つ */
async function waitSpans(page, min = 1) {
  await page.waitForFunction((m) => {
    const tl = document.querySelector('#redactCanvasWrap .redact-textlayer');
    return tl && [...tl.querySelectorAll('span')].filter(s => (s.textContent || '').trim()).length >= m;
  }, min, { timeout: 30_000 });
}

/** span をクリック黒塗り(mousedown→mouseup→click 合成) */
const clickSpanFn = `(span) => {
  const r = span.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
  span.dispatchEvent(new MouseEvent('mousedown', o));
  span.dispatchEvent(new MouseEvent('mouseup', o));
  span.dispatchEvent(new MouseEvent('click', o));
}`;

test.describe('黒塗り', () => {

  test('クリック黒塗り: 重複は1枚にマージ・離れた語は別々', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([595, 842]);
      p.drawText('SECRET-X', { x: 60,   y: 700, size: 24, font, color: rgb(0,0,0) });
      p.drawText('SECRET-X', { x: 60.5, y: 700, size: 24, font, color: rgb(0,0,0) });  // 二度描き(重複の再現)
      p.drawText('FARAWAY',  { x: 420,  y: 700, size: 24, font, color: rgb(0,0,0) });
    `);
    await waitSpans(page, 3);
    const r = await page.evaluate((clickSrc) => {
      const click = eval('(' + clickSrc + ')');
      const cells = () => document.querySelector('#redactCanvasWrap .redact-cells').children.length;
      const spans = [...document.querySelectorAll('#redactCanvasWrap .redact-textlayer span')].filter(s => (s.textContent || '').trim());
      const secrets = spans.filter(s => /SECRET/.test(s.textContent));
      const far = spans.find(s => /FARAWAY/.test(s.textContent));
      const log = [cells()];
      click(secrets[0]); log.push(cells());
      click(secrets[1]); log.push(cells());   // 同位置の二度描き → マージで増えない
      click(far);        log.push(cells());   // 離れた語 → 別セル
      return log;
    }, clickSpanFn);
    expect(r).toEqual([0, 1, 1, 2]);
  });

  test('出力の本物消去: 生バイトに秘密ゼロ + 影響ページの文字消滅', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([595, 842]);
      p.drawText('TOP-SECRET-7', { x: 60, y: 700, size: 22, font, color: rgb(0,0,0) });
    `);
    await waitSpans(page, 1);
    await page.evaluate((clickSrc) => {
      const click = eval('(' + clickSrc + ')');
      const span = [...document.querySelectorAll('#redactCanvasWrap .redact-textlayer span')]
        .find(s => /TOP-SECRET/.test(s.textContent));
      click(span);
    }, clickSpanFn);
    await page.waitForFunction(() => document.querySelector('#redactCanvasWrap .redact-cells').children.length === 1);
    await armCapture(page);
    await page.evaluate(() => document.getElementById('redactExportBtn').click());
    const idx = await waitCapture(page, '%PDF');
    // 生バイト走査: 秘密文字列が1バイトも残っていないこと(偽リダクション検査)
    expect(await rawScan(page, idx, 'TOP-SECRET-7')).toBe(false);
    // 影響ページの文字レイヤーが空(透かしOFF設定なので完全ゼロ)
    const texts = await pdfTexts(page, idx);
    expect(texts[0]).toBe('');
    // UI 上も成功表示
    await expect(page.locator('#redactExportNote')).toContainText('出力しました');
  });

  test('背景色で消す(v4.1.0): 塗り跡が黒でなく紙の色に馴染む+本物消去は同等', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([595, 842]);
      // 紙をやや黄ばんだ色にして「固定の白」でなく「周囲の推察色」で塗ることを検証する
      p.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.96, 0.94, 0.86) });
      p.drawText('PAPER-SECRET-9', { x: 60, y: 700, size: 22, font, color: rgb(0,0,0) });
    `);
    await waitSpans(page, 1);
    await page.evaluate((clickSrc) => {
      document.getElementById('redactFillPaper').click();   // 背景色モードへ切替
      const click = eval('(' + clickSrc + ')');
      const span = [...document.querySelectorAll('#redactCanvasWrap .redact-textlayer span')]
        .find(s => /PAPER-SECRET/.test(s.textContent));
      click(span);
    }, clickSpanFn);
    await page.waitForFunction(() => document.querySelector('#redactCanvasWrap .redact-cells').children.length === 1);
    // 仮表示も背景色モードの見た目(fill-paper クラス)になり、出力ボタンの文言も切り替わる
    const ui = await page.evaluate(() => ({
      fillPaper: document.getElementById('redactCanvasWrap').classList.contains('fill-paper'),
      btnText: document.getElementById('redactExportBtn').textContent,
      paperActive: document.getElementById('redactFillPaper').classList.contains('active'),
      blackActive: document.getElementById('redactFillBlack').classList.contains('active'),
    }));
    expect(ui.fillPaper).toBe(true);
    expect(ui.btnText).toContain('背景色で消して出力');
    expect(ui.paperActive).toBe(true);
    expect(ui.blackActive).toBe(false);
    await armCapture(page);
    await page.evaluate(() => document.getElementById('redactExportBtn').click());
    const idx = await waitCapture(page, '%PDF');
    // 安全性は黒塗りと同一: 生バイトに秘密ゼロ + 文字レイヤー消滅
    expect(await rawScan(page, idx, 'PAPER-SECRET-9')).toBe(false);
    const texts = await pdfTexts(page, idx);
    expect(texts[0]).toBe('');
    // 塗った場所(文字中心付近)のピクセル検証: 黒くない+真っ白でもなく黄ばみに馴染む
    // 文字は x60..~230pt, ベースライン y700(下基準) → 中心はページ左上基準で約 (0.24, 0.16)
    const probe = await probePdfPixels(page, idx, [['c', 0.24, 0.16]]);
    const p = probe.px.c;
    expect(p.r).toBeGreaterThan(215);                     // 黒く塗られていない
    expect(p.g).toBeGreaterThan(210);
    expect(p.b).toBeGreaterThan(170);
    expect(p.b).toBeLessThan(243);                        // 真っ白(255)ではなく黄ばみ(≈219)に寄っている
    await expect(page.locator('#redactExportNote')).toContainText('出力しました');
  });

  test('文字データ無しページ: バナー表示+四角モードへ矯正', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([595, 842]);
      p.drawRectangle({ x: 100, y: 600, width: 300, height: 120, color: rgb(0.7, 0.7, 0.7) });  // 図形のみ
    `);
    await page.waitForFunction(() => {
      const w = document.getElementById('redactCanvasWrap');
      const b = document.getElementById('redactNoTextBanner');
      return w && b && b.classList.contains('show') && w.classList.contains('mode-rect');
    }, null, { timeout: 30_000 });
  });

  test('A3横: ステージ幅にフィット(横スクロール無し)+高DPIレンダ', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([1190.55, 841.89]);  // A3横
      for (let i = 0; i < 10; i++) p.drawText('ROW-' + i, { x: 30, y: 780 - i * 60, size: 12, font, color: rgb(0,0,0) });
    `);
    await waitSpans(page, 5);
    const r = await page.evaluate(() => {
      const wrap = document.getElementById('redactCanvasWrap');
      const stage = wrap.closest('.redact-stage');
      const canvas = wrap.querySelector('canvas');
      const cssW = canvas.getBoundingClientRect().width;
      return {
        overflow: stage.scrollWidth - stage.clientWidth,
        oversample: canvas.width / cssW,
        brVisible: [...wrap.querySelectorAll('.redact-textlayer br')].filter(b => b.getBoundingClientRect().height > 0).length,
      };
    });
    expect(r.overflow).toBeLessThanOrEqual(0);   // 画面内に収まる
    expect(r.oversample).toBeGreaterThanOrEqual(1.4);  // 縮小表示でも高DPI
    expect(r.brVisible).toBe(0);                 // 行間brは不可視(選択の縦線アーティファクト対策)
  });

  test('×削除は confirm キャンセルで残り、OKで消える', async ({ page }) => {
    await openApp(page);
    await loadRedactPdf(page, `
      const p = doc.addPage([595, 842]);
      p.drawText('DELME', { x: 60, y: 700, size: 24, font, color: rgb(0,0,0) });
    `);
    await waitSpans(page, 1);
    const r = await page.evaluate((clickSrc) => {
      const click = eval('(' + clickSrc + ')');
      const cells = () => document.querySelector('#redactCanvasWrap .redact-cells').children.length;
      const span = [...document.querySelectorAll('#redactCanvasWrap .redact-textlayer span')].find(s => /DELME/.test(s.textContent));
      click(span);
      const made = cells();
      window.confirm = () => false;   // キャンセル
      document.querySelector('#redactCanvasWrap .redact-cell-delete').click();
      const afterCancel = cells();
      window.confirm = () => true;    // OK
      document.querySelector('#redactCanvasWrap .redact-cell-delete').click();
      const afterOk = cells();
      return [made, afterCancel, afterOk];
    }, clickSpanFn);
    expect(r).toEqual([1, 1, 0]);
  });

});
