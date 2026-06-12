// 座標写像のゴールデンテスト — リファクタ前に現挙動を固定する(Phase 2 の防波堤)。
// 原理: 配置/黒塗りのオーバーレイは viewport 比率(%)で描かれる。出力PDFを pdf.js viewport
// (回転・CropBox 適用後)でレンダすれば、同じ比率の位置に画像/黒が居るはずである。
// これが崩れる = プレビューと出力の不一致 = このプロジェクトで最も事故が多かったバグ族。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture, rawScan, pdfTexts } = require('./helpers');

/** 出力PDF(capIndex)を viewport でレンダし、比率指定の点のRGB和を返す */
async function probeRatios(page, capIndex, ratioPoints) {
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
    const out = {};
    for (const [name, fx, fy] of pts) {
      const d = ctx.getImageData(Math.round(vp.width * fx), Math.round(vp.height * fy), 1, 1).data;
      out[name] = d[0] + d[1] + d[2];
    }
    return out;
  }, { idx: capIndex, pts: ratioPoints });
}

// ============================================================
// imgPlace: 回転 {0,90,180,270} × CropBox {無,有} の8ケース
// ============================================================
for (const rot of [0, 90, 180, 270]) {
  for (const crop of [false, true]) {
    const label = `画像配置: 回転${rot}° ${crop ? '+CropBox' : ''} で配置位置がプレビューと出力で一致`;
    test(label, async ({ page }) => {
      await openApp(page);
      await gotoTab(page, '配置');
      // ベースPDF: A4縦相当 + 指定回転 (+CropBox)
      await page.evaluate(async ({ r, c }) => {
        const { PDFDocument, StandardFonts, degrees } = window.PDFLib;
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const p = doc.addPage([595, 842]);
        p.drawText('GEO-' + r + (c ? '-CROP' : ''), { x: 100, y: 700, size: 14, font });
        if (c) p.setCropBox(40, 60, 480, 700);   // 原点(40,60) 480x700 = MediaBoxと非一致
        if (r) p.setRotation(degrees(r));
        const bytes = await doc.save();
        const inp = document.getElementById('imgPlacePdfInput');
        const dt = new DataTransfer();
        dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'geo.pdf', { type: 'application/pdf' }));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }, { r: rot, c: crop });
      // 黒画像をライブラリへ → dblclick で中央配置
      await page.waitForFunction(() => !!document.getElementById('imgPlaceLibInput'), null, { timeout: 20_000 });
      await page.evaluate(async () => {
        const cv = document.createElement('canvas'); cv.width = 200; cv.height = 100;
        cv.getContext('2d').fillStyle = '#000'; cv.getContext('2d').fillRect(0, 0, 200, 100);
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        const inp = document.getElementById('imgPlaceLibInput');
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'black.png', { type: 'image/png' }));
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForSelector('.imgplace-lib-item', { state: 'attached', timeout: 20_000 });
      // ライブラリ画像のサムネが読み込まれる(naturalWidth>0)まで待つ。placeAtCenter は
      // imageLibrary のメタを使うので、これを待たないと dblclick が空振りする。
      await page.waitForFunction(() => {
        const img = document.querySelector('.imgplace-lib-item img');
        return img && img.complete && img.naturalWidth > 0;
      }, null, { timeout: 20_000 });
      // placement が出るまで dblclick を再試行(合成イベントの取りこぼし対策)
      await page.waitForFunction(() => {
        if (document.querySelector('.imgplace-placement')) return true;
        const it = document.querySelector('.imgplace-lib-item');
        if (it) it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        return false;
      }, null, { timeout: 15_000, polling: 500 });
      // プレビューのオーバーレイ位置を canvas 比率で読む(これが「期待値」)
      const exp = await page.evaluate(() => {
        const cv = document.getElementById('imgPlaceCanvas').getBoundingClientRect();
        const pl = document.querySelector('.imgplace-placement').getBoundingClientRect();
        return {
          x: (pl.left - cv.left) / cv.width, y: (pl.top - cv.top) / cv.height,
          w: pl.width / cv.width, h: pl.height / cv.height,
        };
      });
      // 出力
      await armCapture(page);
      await page.evaluate(() => document.getElementById('imgPlaceExportPdfBtn').click());
      const idx = await waitCapture(page, '%PDF', 60_000);
      // 出力 viewport の同じ比率位置に黒が居るか(中心+内側2点=黒 / 外側4点=白)
      const cx = exp.x + exp.w / 2, cy = exp.y + exp.h / 2;
      const probes = [
        ['center', cx, cy],
        ['inTL', exp.x + exp.w * 0.2, exp.y + exp.h * 0.2],
        ['inBR', exp.x + exp.w * 0.8, exp.y + exp.h * 0.8],
        ['outL', exp.x / 2, cy],
        ['outR', exp.x + exp.w + (1 - exp.x - exp.w) / 2, cy],
        ['outT', cx, exp.y / 2],
        ['outB', cx, exp.y + exp.h + (1 - exp.y - exp.h) / 2],
      ];
      const px = await probeRatios(page, idx, probes);
      expect(px.center, 'center black').toBeLessThan(150);
      expect(px.inTL, 'inner-TL black').toBeLessThan(150);
      expect(px.inBR, 'inner-BR black').toBeLessThan(150);
      expect(px.outL, 'left outside white').toBeGreaterThan(600);
      expect(px.outR, 'right outside white').toBeGreaterThan(600);
      expect(px.outT, 'top outside white').toBeGreaterThan(600);
      expect(px.outB, 'bottom outside white').toBeGreaterThan(600);
    });
  }
}

// ============================================================
// 黒塗り: 回転90° と CropBox — redact は入出力とも viewport 空間で完結する
// (写像実装が無い)ため構造的に整合するはず。それを証明して固定する。
// ============================================================
for (const variant of ['rot90', 'cropbox']) {
  test(`黒塗り: ${variant === 'rot90' ? '回転90°' : 'CropBox付き'} PDF でセル位置どおりに黒が焼かれ秘密が消える`, async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'redact');
    await page.evaluate(async (v) => {
      const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const p = doc.addPage([595, 842]);
      p.drawText('GEOSECRET-99', { x: 120, y: 600, size: 22, font, color: rgb(0, 0, 0) });
      if (v === 'rot90') p.setRotation(degrees(90));
      if (v === 'cropbox') p.setCropBox(40, 60, 480, 700);
      const bytes = await doc.save();
      const inp = document.getElementById('redactFileInput');
      const dt = new DataTransfer();
      dt.items.add(new File([new Blob([bytes], { type: 'application/pdf' })], 'geo.pdf', { type: 'application/pdf' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, variant);
    // テキスト層→クリック黒塗り
    await page.waitForFunction(() => {
      const tl = document.querySelector('#redactCanvasWrap .redact-textlayer');
      return tl && [...tl.querySelectorAll('span')].some(s => /GEOSECRET/.test(s.textContent));
    }, null, { timeout: 30_000 });
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('#redactCanvasWrap .redact-textlayer span')]
        .find(s => /GEOSECRET/.test(s.textContent));
      const r = span.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
      span.dispatchEvent(new MouseEvent('mousedown', o));
      span.dispatchEvent(new MouseEvent('mouseup', o));
      span.dispatchEvent(new MouseEvent('click', o));
    });
    await page.waitForFunction(() => document.querySelector('#redactCanvasWrap .redact-cells').children.length === 1);
    // セルの viewport 比率(%)を style から直読 = 期待位置
    const cell = await page.evaluate(() => {
      const c = document.querySelector('#redactCanvasWrap .redact-cells').children[0];
      return {
        x: parseFloat(c.style.left) / 100, y: parseFloat(c.style.top) / 100,
        w: parseFloat(c.style.width) / 100, h: parseFloat(c.style.height) / 100,
      };
    });
    await armCapture(page);
    await page.evaluate(() => document.getElementById('redactExportBtn').click());
    const idx = await waitCapture(page, '%PDF', 60_000);
    // 本物消去(生バイト+文字レイヤー)
    expect(await rawScan(page, idx, 'GEOSECRET-99')).toBe(false);
    expect((await pdfTexts(page, idx))[0]).toBe('');
    // セル位置どおりに黒(中心=黒、左右の外側=白)
    const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
    const px = await probeRatios(page, idx, [
      ['center', cx, cy],
      ['outL', cell.x / 2, cy],
      ['outR', cell.x + cell.w + (1 - cell.x - cell.w) / 2, cy],
    ]);
    expect(px.center, 'cell center black').toBeLessThan(150);
    expect(px.outL, 'left of cell white').toBeGreaterThan(600);
    expect(px.outR, 'right of cell white').toBeGreaterThan(600);
  });
}
