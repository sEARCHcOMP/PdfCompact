// 図面変換(PDF→DXF)のテスト。仕様: docs/plans/pdf2dxf-spec.md §9
// 測定の根拠に使う機能なので、寸法は「実寸±0.5mm」で固定する。PDFはすべてテスト内で自作(実物件の図面は使わない)。
const { test } = require('@playwright/test');
const { expect, openApp, gotoTab, armCapture, waitCapture } = require('./helpers');

const MM = 72 / 25.4;
const pt100 = (mm) => mm / 100 * MM;   // 1/100 図面の実寸mm → 用紙上のpt
const K100 = 25.4 / 72 * 100;          // 1/100 の係数 [実寸mm / pt]

/** pdf-lib でPDFを作って図面変換タブに読み込む。body は (doc, font, PL) を使う関数本体 */
async function loadP2d(page, body) {
  await gotoTab(page, 'pdf2dxf');
  await page.evaluate(async (b) => {
    const PL = window.PDFLib;
    const doc = await PL.PDFDocument.create();
    const font = await doc.embedFont(PL.StandardFonts.Helvetica);
    await (new Function('doc', 'font', 'PL', '"use strict";' + b))(doc, font, PL);
    const bytes = await doc.save();
    const inp = document.getElementById('p2dFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'test.pdf', { type: 'application/pdf' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, body);
  await waitReady(page);
  await scrollSettled(page);
}
/** 読み込んだ直後は、操作欄が見える位置までなめらかにスクロールする。位置を使う操作の前に、スクロールが止まるのを待つ(8コマ続けて動かなければ止まったとみなす) */
async function scrollSettled(page) {
  await page.evaluate(() => new Promise((resolve) => {
    let last = window.scrollY, same = 0;
    const tick = () => {
      const y = window.scrollY;
      same = y === last ? same + 1 : 0;
      last = y;
      if (same >= 8) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}
/** 要素の全体が、画面(ビューポート)の中に見えているか */
const inViewport = (page, sel) => page.evaluate((s) => {
  const rc = document.querySelector(s).getBoundingClientRect();
  return rc.height > 0 && rc.top >= 0 && rc.bottom <= window.innerHeight;
}, sel);
async function waitReady(page) {
  await page.waitForFunction(() => {
    const s = window.__p2dState;
    return s && s.pdf && !s.rendering && s.pages[s.pageIndex] && s.pages[s.pageIndex].geom;
  }, null, { timeout: 30_000 });
}
async function setPreset(page, den) {
  await page.evaluate((d) => {
    document.getElementById('p2dModePreset').click();
    document.getElementById('p2dPreset').value = String(d);
    document.getElementById('p2dApplyPreset').click();
  }, den);
}
async function exportDxf(page) {
  await setOutFmt(page, 'dxf');   // このタブの既定は JWW。DXF を確かめるテストでは、先に形式を切り替える
  await armCapture(page);
  await page.evaluate(() => document.getElementById('p2dExportBtn').click());
  return await waitCapture(page, '0\r\nS');   // DXF は「0 / SECTION」で始まる
}
/** 保存する形式を選ぶ('jww' / 'dxf') */
const setOutFmt = (page, f) => page.evaluate((v) => document.getElementById(v === 'jww' ? 'p2dFmtJww' : 'p2dFmtDxf').click(), f);
/** 捕捉したDXFを「0」区切りのレコードに分解(どのセクションに属するか付き) */
async function parseDxf(page, idx) {
  return await page.evaluate((i) => {
    const b = window.__caps[i].bytes;
    let s = '';
    for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]);
    const L = s.split('\r\n');
    const recs = [];
    let cur = null, section = null;
    for (let k = 0; k + 1 < L.length; k += 2) {
      const c = L[k].trim(), v = L[k + 1];
      if (c === '0') { if (cur) recs.push(cur); cur = { type: v, section, g: {} }; continue; }
      if (c === '2' && cur && cur.type === 'SECTION') section = v;
      if (cur) (cur.g[c] = cur.g[c] || []).push(v);
    }
    if (cur) recs.push(cur);
    return recs;
  }, idx);
}
const ents = (recs, type) => recs.filter((r) => r.section === 'ENTITIES' && r.type === type);
const num = (r, c) => parseFloat(r.g[c][0]);
const lenOf = (l) => Math.hypot(num(l, '11') - num(l, '10'), num(l, '21') - num(l, '20'));

// ---- 精度のテスト用(第1段 A: docs/plans/pdf2dxf-stage1-spec.md) ----
/**
 * 600dpi のプリンタ経由PDFと同じく、座標を 0.12pt 刻みに丸めた 1/100 の図(pdf-lib の本体)。shrink = 用紙上の縮小率(1 = 原寸で出力)。
 * 寸法線は y=520(10,920)・y=490(3,640)・y=460(910)。ほかに通り芯に見立てた縦線13本・横線9本(刻みの推定に足りる本数)。
 * ctm = 出来上がったPDFを、後から丸ごと縮めた形にする倍率(省略可)。座標の刻みが 0.12 × ctm になり、アプリの知っている刻みのどれにも乗らなくなる
 */
const gridDrawing = (shrink, ctm) => `
  const Q = 72 / 600, R = (v) => Math.round(v / Q) * Q;
  const U = ${MM} / 100 * ${shrink};
  const p = doc.addPage([842, 595]);
  ${ctm ? `p.pushOperators(PL.pushGraphicsState(), PL.scale(${ctm}, ${ctm}));` : ''}
  const LN = (x1, y1, x2, y2) => p.drawLine({ start: { x: R(x1), y: R(y1) }, end: { x: R(x2), y: R(y2) }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
  LN(60, 520, 60 + 10920 * U, 520);
  LN(60, 490, 60 + 3640 * U, 490);
  LN(60, 460, 60 + 910 * U, 460);
  for (let i = 0; i <= 12; i++) LN(60 + i * 910 * U, 60, 60 + i * 910 * U, 60 + (3640 + i * 455) * U);
  for (let j = 0; j <= 8; j++) LN(420 + j * 7, 330 + j * 9, 420 + j * 7 + (1900 + j * 455) * U, 330 + j * 9);
  ${ctm ? 'p.pushOperators(PL.popGraphicsState());' : ''}
`;
/** 図面上の点(pt・上向きY)を順にクリックする。off = 画面上でわざとずらす量(px) */
async function clickPts(page, pts, off) {
  await page.evaluate(({ ps, o }) => {
    const st = window.__p2dState, pg = st.pages[st.pageIndex];
    const layer = document.getElementById('p2dPickLayer');
    const rc = layer.getBoundingClientRect();
    for (const p of ps) {
      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse',
        clientX: rc.left + p.x * st.ds + o.dx, clientY: rc.top + (pg.geom.vpH - p.y) * st.ds + o.dy }));
    }
  }, { ps: pts, o: off || { dx: 0, dy: 0 } });
}
/** 高さ y(pt)にある横線のうち、いちばん長いものの両端 */
async function hLineAt(page, y) {
  return await page.evaluate((yy) => {
    const st = window.__p2dState, ls = st.pages[st.pageIndex].geom.lines;
    const l = ls.filter((v) => Math.abs(v.y1 - v.y2) < 1e-6 && Math.abs(v.y1 - yy) < 1).sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1))[0];
    return [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }];
  }, y);
}
/** x(pt)にある縦線のうち、いちばん長いものの両端 */
async function vLineAt(page, x) {
  return await page.evaluate((xx) => {
    const st = window.__p2dState, ls = st.pages[st.pageIndex].geom.lines;
    const l = ls.filter((v) => Math.abs(v.x1 - v.x2) < 1e-6 && Math.abs(v.x1 - xx) < 1).sort((a, b) => Math.abs(b.y2 - b.y1) - Math.abs(a.y2 - a.y1))[0];
    return [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }];
  }, x);
}
/**
 * CADから直接出力したPDFに見立てた、線の位置が細かい図(pdf-lib の本体)。座標は小数3桁(刻み 0.001pt)。
 * y=520 に短い線(80pt = 用紙の長辺の 9.5%)、y=480 に 1/100 の 10,920mm(309.543pt)
 */
const fineDrawing = `
  const p = doc.addPage([842, 595]);
  const LN = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
  LN(60, 520, 140, 520);
  LN(60, 480, 369.543, 480);
  for (let i = 0; i < 24; i++) LN(70.123 + i * 9.417, 60.251, 75.377 + i * 9.417, 91.584 + i * 7.319);
`;
/** 図面の上のラベル(2点のまん中の上)の文字の色を数える。green = 確かめ中の色(緑)、caution = 注意の色(茶) */
const labelPixels = (page) => page.evaluate(() => {
  const st = window.__p2dState, pg = st.pages[st.pageIndex], cv = document.getElementById('p2dPickLayer');
  const s = st.ds * st.dpr, r = st.dpr, a = st.picks[0], b = st.picks[1];
  const mx = (a.x + b.x) / 2 * s, my = (pg.geom.vpH - (a.y + b.y) / 2) * s - 14 * r;
  const d = cv.getContext('2d').getImageData(Math.round(mx - 30 * r), Math.round(my - 11 * r), Math.round(60 * r), Math.round(18 * r)).data;
  const out = { green: 0, caution: 0 };
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    if (d[i + 3] < 200) continue;
    if (G > 100 && R < 100 && G - R > 50) out.green++;
    else if (R > 100 && R < 190 && G < 100 && B < 80 && R - G > 40) out.caution++;
  }
  return out;
});
async function calibrateBy(page, pts, real) {
  await clickPts(page, pts);
  await page.fill('#p2dRealLen', String(real));
  await page.click('#p2dApplyDim');
}
const calState = (page) => page.evaluate(() => {
  const s = window.__p2dState, pg = s.pages[s.pageIndex];
  return { k: pg.k, cal: pg.cal, kFrom: pg.kFrom, picks: s.picks.length, calibrating: s.calibrating };
});
// ---- 吸着のルーペと選び直しのテスト用(第1段 B) ----
/**
 * 通り芯の交点 (100,150) のすぐ右(1pt = 画面で 2px)に柱の角 (101,150) がある図。用紙が 400×300pt なので、画面は 2 倍で表示される。
 * 離れた所に、ほかの点と紛れない線 (250,60)-(350,60) を1本置く
 */
const cornerDrawing = `
  const p = doc.addPage([400, 300]);
  const LN = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: PL.rgb(0, 0, 0) });
  LN(100, 20, 100, 280);
  LN(20, 150, 380, 150);
  p.drawRectangle({ x: 101, y: 150, width: 12, height: 12, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
  LN(250, 60, 350, 60);
`;
/** 図面上の点(pt・上向きY)→ 図面の層の左上からの画面px。off = わざとずらす量(px) */
const layerPos = async (page, pt, off) => page.evaluate(({ p, o }) => {
  const st = window.__p2dState, pg = st.pages[st.pageIndex];
  return { x: p.x * st.ds + o.dx, y: (pg.geom.vpH - p.y) * st.ds + o.dy };
}, { p: pt, o: off || { dx: 0, dy: 0 } });
/** ルーペの画素を数える。box = [x0, y0, x1, y1](ルーペの左上からの画面px)。橙 = 合わせ中の色、緑 = 確かめ中の色、dark = 線の色、ink = 白以外 */
const loupePixels = (page, box) => page.evaluate((b) => {
  const cv = document.getElementById('p2dLoupe'), r = window.__p2dState.dpr;
  const x0 = Math.max(0, Math.round(b[0] * r)), y0 = Math.max(0, Math.round(b[1] * r));
  const w = Math.min(cv.width, Math.round(b[2] * r)) - x0, h = Math.min(cv.height, Math.round(b[3] * r)) - y0;
  const d = cv.getContext('2d').getImageData(x0, y0, w, h).data;
  const out = { orange: 0, green: 0, dark: 0, ink: 0, total: w * h };
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    if (R > 180 && G > 40 && G < 150 && B < 90) out.orange++;
    else if (G > 100 && R < 100 && B < 120 && G - R > 50) out.green++;
    else if (Math.max(R, G, B) < 160) out.dark++;
    if (Math.min(R, G, B) < 225) out.ink++;
  }
  return out;
}, box);
const p2dState = (page) => page.evaluate(() => {
  const s = window.__p2dState, c = s.chooser;
  return { picks: s.picks, hover: s.hover, ds: s.ds, dpr: s.dpr, chooser: c ? { mag: c.mag, sel: c.sel, view: c.view } : null };
});

// ---- 検証つきの円弧のテスト用(第1段 C) ----
/**
 * 関数 ARCS を用意する(pdf-lib の本体): 中心 (cx, cy)・半径 r の円・円弧を、n 本のベジェ(1本あたり per 度)で、rot 度の向きから反時計回りに描く。
 * 座標は全部 R() で丸める(R と p は、前に置く本体が用意する)。プリンタ経由のPDFは、端点だけでなく制御点も目盛りに丸められる
 */
const arcsHelper = `
  const ARCS = (cx, cy, r, rot, n, per) => {
    const ops = [PL.setLineWidth(0.3)];
    for (let i = 0; i < n; i++) {
      const a = (rot + per * i) * Math.PI / 180, b = (rot + per * (i + 1)) * Math.PI / 180, k = 4 / 3 * Math.tan((b - a) / 4) * r;
      const ax = cx + r * Math.cos(a), ay = cy + r * Math.sin(a), bx = cx + r * Math.cos(b), by = cy + r * Math.sin(b);
      if (i === 0) ops.push(PL.moveTo(R(ax), R(ay)));
      ops.push(PL.appendBezierCurve(R(ax - k * Math.sin(a)), R(ay + k * Math.cos(a)), R(bx + k * Math.sin(b)), R(by - k * Math.cos(b)), R(bx), R(by)));
    }
    ops.push(PL.stroke());
    p.pushOperators(...ops);
  };
`;

/** DXF の横線のうち、高さが yPt(pt)のもの */
const dxfLineAtY = (lines, yPt, k) => lines.find((l) => Math.abs(num(l, '20') - num(l, '21')) < 1e-6 && Math.abs(num(l, '20') - yPt * k) < k);

test.describe('図面変換(PDF→DXF)', () => {

  test('1/100: 3640×2730 の四角が実寸±0.5mmの LINE になり、TABLES(線種・画層)が必ず入る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      p.drawRectangle({ x: 60, y: 500, width: ${pt100(3640)}, height: ${pt100(2730)}, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
    `);
    await setPreset(page, 100);
    const recs = await parseDxf(page, await exportDxf(page));
    // Jw_cad 実機で確定: TABLES が無いと全線が補助線種になる(回帰の番犬)
    const hdr = recs.find((r) => r.type === 'SECTION' && r.g['2'] && r.g['2'][0] === 'HEADER');   // HEADER の値は SECTION レコードにぶら下がる
    expect(hdr.g['9']).toContain('$ACADVER');
    expect(hdr.g['1']).toContain('AC1009');
    const ltypes = recs.filter((r) => r.section === 'TABLES' && r.type === 'LTYPE').map((r) => r.g['2'][0]);
    expect(ltypes).toEqual(['CONTINUOUS', 'DASHED', 'CENTER']);
    const layers = recs.filter((r) => r.section === 'TABLES' && r.type === 'LAYER').map((r) => r.g['2'][0]);
    expect(layers).toEqual(expect.arrayContaining(['0', 'SEN', 'EN', 'MOJI']));
    const lines = ents(recs, 'LINE');
    expect(lines.length).toBe(4);
    const lens = lines.map(lenOf).sort((a, b) => a - b);
    for (const [got, want] of [[lens[0], 2730], [lens[1], 2730], [lens[2], 3640], [lens[3], 3640]]) {
      expect(Math.abs(got - want)).toBeLessThan(0.5);
    }
    for (const l of lines) { expect(l.g['6'][0]).toBe('CONTINUOUS'); expect(l.g['62'][0]).toBe('7'); expect(l.g['8'][0]).toBe('SEN'); }
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100');
  });

  test('「用紙に合わせる」で97%に縮んだPDFでも、寸法2点で合わせると実寸に戻る+検算が出る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      p.drawRectangle({ x: 80, y: 400, width: ${pt100(3640) * 0.97}, height: ${pt100(2730) * 0.97}, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
    `);
    // 画面上の点をクリックする(吸着で線の端に乗る)
    const clickPts = async (pts) => {
      await page.evaluate((ps) => {
        const st = window.__p2dState, pg = st.pages[st.pageIndex];
        const layer = document.getElementById('p2dPickLayer');
        const rc = layer.getBoundingClientRect();
        for (const p of ps) {
          const o = { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse',
            clientX: rc.left + p.x * st.ds + 2, clientY: rc.top + (pg.geom.vpH - p.y) * st.ds - 2 };   // わざと2pxずらす(吸着の確認)
          layer.dispatchEvent(new PointerEvent('pointerdown', o));
        }
      }, pts);
    };
    const edges = await page.evaluate(() => {
      const st = window.__p2dState, ls = st.pages[st.pageIndex].geom.lines;
      const horiz = ls.filter((l) => Math.abs(l.y1 - l.y2) < 1e-6).sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1))[0];
      const vert = ls.filter((l) => Math.abs(l.x1 - l.x2) < 1e-6)[0];
      return { h: [{ x: horiz.x1, y: horiz.y1 }, { x: horiz.x2, y: horiz.y2 }], v: [{ x: vert.x1, y: vert.y1 }, { x: vert.x2, y: vert.y2 }] };
    });
    await clickPts(edges.h);
    await page.fill('#p2dRealLen', '3640');
    await page.click('#p2dApplyDim');
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/103');   // 97%に縮んだ1/100図面は紙の上で1/103相当(1/100と偽らない)
    await clickPts(edges.v);                                                  // 検算: 縦の辺
    await expect(page.locator('#p2dCheckResult')).toContainText('2,730');
    const recs = await parseDxf(page, await exportDxf(page));
    const lens = ents(recs, 'LINE').map(lenOf).sort((a, b) => a - b);
    expect(Math.abs(lens[0] - 2730)).toBeLessThan(0.5);
    expect(Math.abs(lens[3] - 3640)).toBeLessThan(0.5);
  });

  test('円は CIRCLE、半円は ARC になる(折れ線にしない=Jw_cad で中心が取れる)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      p.drawCircle({ x: 200, y: 300, size: 40, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
      p.drawSvgPath('M 0 0 A 50 50 0 0 1 100 0', { x: 300, y: 600, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
    `);
    await setPreset(page, 100);
    const recs = await parseDxf(page, await exportDxf(page));
    expect(ents(recs, 'LINE').length).toBe(0);
    const c = ents(recs, 'CIRCLE');
    expect(c.length).toBe(1);
    expect(Math.abs(num(c[0], '10') - 200 * K100)).toBeLessThan(0.5);
    expect(Math.abs(num(c[0], '20') - 300 * K100)).toBeLessThan(0.5);
    expect(Math.abs(num(c[0], '40') - 40 * K100)).toBeLessThan(0.5);
    const a = ents(recs, 'ARC');
    expect(a.length).toBe(1);
    expect(Math.abs(num(a[0], '10') - 350 * K100)).toBeLessThan(0.5);
    expect(Math.abs(num(a[0], '20') - 600 * K100)).toBeLessThan(0.5);
    expect(Math.abs(num(a[0], '40') - 50 * K100)).toBeLessThan(0.5);
    // 上半分の半円: 0°→180°(反時計回り)
    const a1 = num(a[0], '50'), a2 = num(a[0], '51');
    expect(Math.min(Math.abs(a1), Math.abs(a1 - 360))).toBeLessThan(0.1);
    expect(Math.abs(a2 - 180)).toBeLessThan(0.1);
  });

  test('破線は DASHED、一点鎖線は CENTER、色は DXF色番号(赤1・青5・黒灰7)になる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      p.drawLine({ start: { x: 50, y: 700 }, end: { x: 300, y: 700 }, thickness: 0.5, color: PL.rgb(0.9, 0.1, 0.1), dashArray: [6, 3] });
      p.drawLine({ start: { x: 50, y: 650 }, end: { x: 300, y: 650 }, thickness: 0.5, color: PL.rgb(0.1, 0.2, 0.8), dashArray: [8, 3, 2, 3] });
      p.drawLine({ start: { x: 50, y: 600 }, end: { x: 300, y: 600 }, thickness: 0.5, color: PL.grayscale(0.5) });
    `);
    await setPreset(page, 100);
    const lines = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    const byY = (y) => lines.find((l) => Math.abs(num(l, '20') - y * K100) < 1);
    expect(byY(700).g['6'][0]).toBe('DASHED');
    expect(byY(700).g['62'][0]).toBe('1');
    expect(byY(650).g['6'][0]).toBe('CENTER');
    expect(byY(650).g['62'][0]).toBe('5');
    expect(byY(600).g['6'][0]).toBe('CONTINUOUS');
    expect(byY(600).g['62'][0]).toBe('7');
  });

  test('塗りつぶしの面と切り抜き枠は線にしない(描いた線だけ出る)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      p.drawRectangle({ x: 50, y: 50, width: 100, height: 60, color: PL.rgb(0.8, 0.8, 0.8) });
      p.pushOperators(PL.pushGraphicsState(), PL.rectangle(200, 50, 80, 40), PL.clip(), PL.endPath(), PL.popGraphicsState());
      p.drawLine({ start: { x: 50, y: 250 }, end: { x: 350, y: 250 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    await setPreset(page, 1);
    const recs = await parseDxf(page, await exportDxf(page));
    expect(ents(recs, 'LINE').length).toBe(1);
    expect(ents(recs, 'CIRCLE').length + ents(recs, 'ARC').length).toBe(0);
  });

  test('文字は TEXT(高さ=実寸)になり、日本語は Shift-JIS で書かれる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      p.drawText('ROOM-A', { x: 100, y: 400, size: 10, font });
      p.drawLine({ start: { x: 100, y: 390 }, end: { x: 200, y: 390 }, thickness: 0.5, color: PL.rgb(0, 0, 0) });
    `);
    await setPreset(page, 100);
    const t = ents(await parseDxf(page, await exportDxf(page)), 'TEXT');
    expect(t.length).toBe(1);
    expect(t[0].g['1'][0]).toBe('ROOM-A');
    expect(t[0].g['8'][0]).toBe('MOJI');
    expect(Math.abs(num(t[0], '40') - 10 * K100)).toBeLessThan(1);
    expect(Math.abs(num(t[0], '10') - 100 * K100)).toBeLessThan(1);
    // 符号化(Jw_cad は CP932)。～(U+FF5E)は Windows 由来のPDFに多いので別名で拾えること
    const enc = await page.evaluate(() => {
      const f = window.__p2dTest.encodeCP932;
      const a = f('洋室 3640' + String.fromCodePoint(0xD7) + '2730' + String.fromCodePoint(0xFF5E)), b = f('A' + String.fromCodePoint(0x1F600) + 'B');
      return { a: Array.from(a.bytes), badA: a.bad, b: Array.from(b.bytes), badB: b.bad };
    });
    expect(enc.a).toEqual([0x97, 0x6D, 0x8E, 0xBA, 0x20, 0x33, 0x36, 0x34, 0x30, 0x81, 0x7E, 0x32, 0x37, 0x33, 0x30, 0x81, 0x60]);
    expect(enc.badA).toBe(0);
    expect(enc.b).toEqual([0x41, 0x3F, 0x42]);   // 表せない文字は「?」+件数
    expect(enc.badB).toBe(1);
  });

  test('スキャン画像だけのPDFは理由を表示して保存させない', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    await page.evaluate(async () => {
      const PL = window.PDFLib;
      const cv = document.createElement('canvas'); cv.width = 200; cv.height = 140;
      const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 140);
      x.strokeStyle = '#000'; x.strokeRect(20, 20, 160, 100);   // 画像の中に「線の絵」があっても線データではない
      const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const doc = await PL.PDFDocument.create();
      const img = await doc.embedPng(await png.arrayBuffer());
      doc.addPage([400, 280]).drawImage(img, { x: 0, y: 0, width: 400, height: 280 });
      const dt = new DataTransfer();
      dt.items.add(new File([await doc.save()], 'scan.pdf', { type: 'application/pdf' }));
      const inp = document.getElementById('p2dFileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitReady(page);
    await setPreset(page, 100);
    await expect(page.locator('#p2dBanner')).toContainText('スキャン');
    await expect(page.locator('#p2dBanner')).toBeVisible();
    expect(await page.locator('#p2dExportBtn').isDisabled()).toBe(true);
  });

  test('90度回転したページは、画面で見えている向きのまま出力される', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 200]);
      p.setRotation(PL.degrees(90));
      p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    await setPreset(page, 1);
    const l = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    const k = 25.4 / 72;
    expect(l.length).toBe(1);
    // 表示上は縦線: X = 150pt の位置、長さ 300pt
    expect(Math.abs(num(l[0], '10') - num(l[0], '11'))).toBeLessThan(0.01);
    expect(Math.abs(num(l[0], '10') - 150 * k)).toBeLessThan(0.01);
    expect(Math.abs(lenOf(l[0]) - 300 * k)).toBeLessThan(0.01);
  });

  test('縮尺が未設定のうちは保存できない(理由を表示)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    expect(await page.locator('#p2dExportBtn').isDisabled()).toBe(true);
    await expect(page.locator('#p2dExportNote')).toContainText('縮尺');
    await expect(page.locator('#p2dScaleStatus')).toContainText('未設定');
  });

  test('実物に近いPDF(Chromium の印刷で作成): 四角・円・円弧・日本語がそれぞれ正しく取れる', async ({ page, context }) => {
    // CAD の出力器と同じく「本物のPDF生成器」が吐いたPDFで確かめる(pdf-lib 以外の癖に対する保険)
    const gen = await context.newPage();
    await gen.setContent(`<html><head><style>@page { size: A4; margin: 0 } html, body { margin: 0 }</style></head><body>
      <svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="150mm" viewBox="0 0 200 150">
        <rect x="10" y="10" width="36.4" height="27.3" fill="none" stroke="#000" stroke-width="0.3"/>
        <circle cx="100" cy="40" r="15" fill="none" stroke="#f00" stroke-width="0.3"/>
        <path d="M 130 60 A 20 20 0 0 1 170 60" fill="none" stroke="#00f" stroke-width="0.3"/>
        <text x="12" y="60" font-size="5" font-family="Yu Gothic, Meiryo, MS Gothic, sans-serif">洋室</text>
      </svg></body></html>`);
    const pdf = await gen.pdf({ format: 'A4', margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    await gen.close();
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    await page.evaluate(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u], 'chromium.pdf', { type: 'application/pdf' }));
      const inp = document.getElementById('p2dFileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, pdf.toString('base64'));
    await waitReady(page);
    await setPreset(page, 100);
    const idx = await exportDxf(page);
    const recs = await parseDxf(page, idx);
    const lens = ents(recs, 'LINE').map(lenOf).sort((a, b) => b - a);
    expect(Math.abs(lens[0] - 3640)).toBeLessThan(0.5);
    expect(Math.abs(lens[2] - 2730)).toBeLessThan(0.5);
    const c = ents(recs, 'CIRCLE');
    expect(c.length).toBe(1);
    expect(Math.abs(num(c[0], '40') - 1500)).toBeLessThan(0.5);
    const a = ents(recs, 'ARC');
    expect(a.length).toBe(1);
    expect(Math.abs(num(a[0], '40') - 2000)).toBeLessThan(0.5);
    // 「洋室」が CP932 のバイト列でファイルに入っている
    const hasYoushitsu = await page.evaluate((i) => {
      const b = window.__caps[i].bytes, n = [0x97, 0x6D, 0x8E, 0xBA];
      for (let k = 0; k + 3 < b.length; k++) if (b[k] === n[0] && b[k + 1] === n[1] && b[k + 2] === n[2] && b[k + 3] === n[3]) return true;
      return false;
    }, idx);
    expect(hasYoushitsu).toBe(true);
  });


  test('複数ページ: 縮尺を全ページに使ってZIPで保存できる+精度の目安の推定が正しい', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      for (let i = 0; i < 2; i++) {
        const p = doc.addPage([400, 300]);
        p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
      }
    `);
    await setPreset(page, 100);
    await expect(page.locator('#p2dApplyAll')).toBeVisible();
    await page.click('#p2dApplyAll');
    await expect(page.locator('#p2dScaleNote')).toContainText('1 ページ');   // 結果は、押したボタンのそば(縮尺の欄)に出る
    await setOutFmt(page, 'dxf');   // 既定は JWW。ここは DXF の ZIP を確かめる
    await armCapture(page);
    await page.click('#p2dExportAllBtn');
    const zi = await waitCapture(page, 'PK');
    const names = await page.evaluate(async (i) => {
      const z = await window.JSZip.loadAsync(window.__caps[i].bytes);
      return Object.keys(z.files).sort();
    }, zi);
    expect(names.length).toBe(2);
    expect(names[0]).toMatch(/_01[.]dxf$/);
    expect(names[1]).toMatch(/_02[.]dxf$/);
    // 精度の目安: 600dpi のプリンタ経由PDF(座標の刻み 0.12pt)を見分ける。候補の倍数(400dpi = 0.18pt)も見逃さない。
    // どの刻みにも乗らない座標は「細かい」と言わず、推定できなかった(unknown)と返す
    const q = await page.evaluate(() => {
      const f = window.__p2dTest.estimateQuantum;
      const coarse = Array.from({ length: 200 }, (_, i) => (i % 37 + 1) * (72 / 600));
      const dpi400 = Array.from({ length: 200 }, (_, i) => (i % 41 + 1) * (72 / 400));
      const fine = Array.from({ length: 200 }, (_, i) => ((i * 7919) % 100000 + 1) * 0.001);
      const odd = Array.from({ length: 200 }, (_, i) => (i + 1) * 0.3141593);
      return { coarse: f(coarse), dpi400: f(dpi400), fine: f(fine), odd: f(odd), few: f([1, 2, 3]) };
    });
    expect(q.coarse.q).toBeCloseTo(0.12, 6);
    expect(q.coarse.unknown).toBe(false);
    expect(q.dpi400.q).toBeCloseTo(0.18, 6);
    expect(q.fine.q).toBeCloseTo(0.001, 9);
    expect(q.odd.unknown).toBe(true);
    expect(q.odd.q).toBe(null);
    expect(q.few).toBe(null);   // 標本が少なすぎる時は推定しない
  });
  test('用紙の外・切り抜きの外の線は、見えている範囲だけ出る(CropBox も同じ)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      // 用紙の外へはみ出す線(-50〜450) → 0〜400 だけ
      p.drawLine({ start: { x: -50, y: 250 }, end: { x: 450, y: 250 }, thickness: 1, color: PL.rgb(0, 0, 0) });
      // 四角の切り抜き(x 100〜200)の中で描いた線(50〜350) → 100〜200 だけ
      p.pushOperators(PL.pushGraphicsState(), PL.rectangle(100, 100, 100, 100), PL.clip(), PL.endPath(),
        PL.moveTo(50, 150), PL.lineTo(350, 150), PL.stroke(), PL.popGraphicsState());
      // 切り抜きは Q で元に戻る: この線は全長
      p.drawLine({ start: { x: 50, y: 50 }, end: { x: 350, y: 50 }, thickness: 1, color: PL.rgb(0, 0, 0) });
      // 用紙の外の円と文字は出さない
      p.drawCircle({ x: 600, y: 150, size: 20, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
      p.drawText('OUTSIDE', { x: -300, y: 100, size: 10, font });
      p.drawText('INSIDE', { x: 20, y: 20, size: 10, font });
    `);
    await setPreset(page, 1);
    const k = 25.4 / 72;
    const recs = await parseDxf(page, await exportDxf(page));
    const lines = ents(recs, 'LINE');
    const byY = (y) => lines.find((l) => Math.abs(num(l, '20') - y * k) < 0.1);
    const span = (l) => [Math.min(num(l, '10'), num(l, '11')) / k, Math.max(num(l, '10'), num(l, '11')) / k];
    expect(lines.length).toBe(3);
    expect(span(byY(250))[0]).toBeCloseTo(0, 1);
    expect(span(byY(250))[1]).toBeCloseTo(400, 1);
    expect(span(byY(150))[0]).toBeCloseTo(100, 1);
    expect(span(byY(150))[1]).toBeCloseTo(200, 1);
    expect(span(byY(50))[0]).toBeCloseTo(50, 1);
    expect(span(byY(50))[1]).toBeCloseTo(350, 1);
    expect(ents(recs, 'CIRCLE').length + ents(recs, 'ARC').length).toBe(0);
    expect(ents(recs, 'TEXT').map((t) => t.g['1'][0])).toEqual(['INSIDE']);

    // CropBox で見えている範囲を狭めたページ: 見えている部分だけ、見えている範囲の左下を原点に出る
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      p.setCropBox(100, 100, 200, 100);
      p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    await setPreset(page, 1);
    const l2 = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    expect(l2.length).toBe(1);
    expect(Math.abs(lenOf(l2[0]) - 200 * k)).toBeLessThan(0.01);
  });

  test('注釈(電子印・書き込み)の線は、画面に見えている位置に出る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      const ctx = doc.context;
      // 外観の枠 0,0〜100,50 を、注釈の枠 100,100〜300,200(2倍)に当てはめて表示される
      const ap = ctx.register(ctx.stream('0 0 m 100 50 l S', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50] }));
      const an = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 300, 200], F: 4, AP: { N: ap } }));
      p.node.set(PL.PDFName.of('Annots'), ctx.obj([an]));
      p.drawLine({ start: { x: 20, y: 20 }, end: { x: 60, y: 20 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    await setPreset(page, 1);
    const k = 25.4 / 72;
    const lines = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    expect(lines.length).toBe(2);
    const d = lines.find((l) => Math.abs(num(l, '20') - num(l, '21')) > 1);   // 斜めの線 = 注釈
    const xs = [num(d, '10'), num(d, '11')].map((v) => v / k).sort((a, b) => a - b);
    const ys = [num(d, '20'), num(d, '21')].map((v) => v / k).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(100, 1);
    expect(xs[1]).toBeCloseTo(300, 1);
    expect(ys[0]).toBeCloseTo(100, 1);
    expect(ys[1]).toBeCloseTo(200, 1);
  });

  test('非表示レイヤの線と文字は出さない(フォーム単位の非表示は、文字が残りうることを表示)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const ctx = doc.context;
      const ocOff = ctx.register(ctx.obj({ Type: 'OCG', Name: PL.PDFString.of('HIDDEN') }));
      const ocOn = ctx.register(ctx.obj({ Type: 'OCG', Name: PL.PDFString.of('SHOWN') }));
      doc.catalog.set(PL.PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocOff, ocOn], D: { Order: [ocOff, ocOn], OFF: [ocOff] } }));
      const B = (n) => PL.PDFOperator.of('BDC', [PL.PDFName.of('OC'), PL.PDFName.of(n)]);
      const E = () => PL.PDFOperator.of('EMC');
      // 1ページ目: ページの中の印(BDC /OC)で非表示
      const p = doc.addPage([400, 300]);
      p.node.Resources().set(PL.PDFName.of('Properties'), ctx.obj({ ocH: ocOff, ocS: ocOn }));
      p.drawText('VISIBLE', { x: 50, y: 250, size: 10, font });
      p.pushOperators(B('ocH'));
      p.drawText('HIDDENTEXT', { x: 50, y: 200, size: 10, font });
      p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1 });
      p.pushOperators(E(), B('ocS'));
      p.drawText('SHOWNTEXT', { x: 50, y: 100, size: 10, font });
      p.drawLine({ start: { x: 50, y: 50 }, end: { x: 350, y: 50 }, thickness: 1 });
      p.pushOperators(E());
      // 2ページ目: フォーム(XObject)ごと非表示
      const q = doc.addPage([400, 300]);
      q.drawText('PRE', { x: 50, y: 280, size: 10, font });
      const fonts = q.node.Resources().lookup(PL.PDFName.of('Font'), PL.PDFDict);
      const fn = Array.from(fonts.keys())[0].asString();
      const form = ctx.register(ctx.flateStream('BT ' + fn + ' 10 Tf 50 200 Td (FORMTEXT) Tj ET 50 150 m 350 150 l S',
        { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Resources: ctx.obj({ Font: fonts }), OC: ocOff }));
      q.node.Resources().set(PL.PDFName.of('XObject'), ctx.obj({ Fm1: form }));
      q.pushOperators(PL.PDFOperator.of('Do', [PL.PDFName.of('Fm1')]));
      q.drawLine({ start: { x: 50, y: 50 }, end: { x: 350, y: 50 }, thickness: 1 });
    `);
    const g1 = await page.evaluate(() => { const s = window.__p2dState, g = s.pages[s.pageIndex].geom; return { ys: g.lines.map((l) => Math.round(l.y1)), texts: g.texts.map((t) => t.s) }; });
    expect(g1.ys).toEqual([50]);
    expect(g1.texts.sort()).toEqual(['SHOWNTEXT', 'VISIBLE']);
    await expect(page.locator('#p2dInfo')).toContainText('非表示');
    await expect(page.locator('#p2dInfo')).not.toContainText('可能性');

    await page.click('#p2dNext');
    await page.waitForFunction(() => { const s = window.__p2dState; return s.pageIndex === 1 && !s.rendering && s.pages[1] && s.pages[1].geom; });
    const g2 = await page.evaluate(() => { const s = window.__p2dState, g = s.pages[s.pageIndex].geom; return { ys: g.lines.map((l) => Math.round(l.y1)) }; });
    expect(g2.ys).toEqual([50]);   // 非表示フォームの線は出ない
    await expect(page.locator('#p2dInfo')).toContainText('文字は含まれている可能性');
  });

  test('UserUnit 付きのページ: 縮尺を選ぶと実際の用紙の大きさで換算される', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      p.node.set(PL.PDFName.of('UserUnit'), PL.PDFNumber.of(2));
      p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
    `);
    const unit = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.unit; });
    expect(unit).toBe(2);
    await setPreset(page, 100);
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100');
    const l = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    expect(l.length).toBe(1);
    expect(Math.abs(lenOf(l[0]) - 300 * 2 * K100)).toBeLessThan(0.5);   // 座標300 × UserUnit 2 = 用紙上600pt
  });

  test('縮尺の表示: 分母が整数でない時は「約」を付け、1/100 と言い切らない', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const f = window.__p2dTest.scaleLabel, k = 25.4 / 72;
      return { a: f(k * 100.02), b: f(k * 100.46), c: f(k * 99.3), d: f(k * 2 * 50, 2) };
    });
    expect(r.a).toBe('1/100');
    expect(r.b).toBe('約 1/100.5');
    expect(r.c).toBe('約 1/99.3');
    expect(r.d).toBe('1/50');   // UserUnit 2 のページ
  });

  test('「全ページに使う」は同じ用紙サイズのページだけ。ZIP保存時にほかのページの縮尺を使ったページを明示', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const sizes = [[595, 842], [842, 595], [842, 1191]];   // A4縦・A4横(同じ用紙)・A3
      for (const s of sizes) {
        const p = doc.addPage(s);
        p.drawLine({ start: { x: 50, y: 150 }, end: { x: 350, y: 150 }, thickness: 1, color: PL.rgb(0, 0, 0) });
      }
    `);
    await setPreset(page, 100);
    await page.click('#p2dApplyAll');
    await expect(page.locator('#p2dScaleNote')).toContainText('2 ページ目');
    await expect(page.locator('#p2dScaleNote')).toContainText('用紙サイズが違う 3 ページ目');
    const ks = await page.evaluate(() => { const s = window.__p2dState; return [0, 1, 2].map((i) => s.pages[i] ? s.pages[i].k : null); });
    expect(ks[1]).toBeCloseTo(ks[0], 9);
    expect(ks[2]).toBe(null);
    await armCapture(page);
    await page.click('#p2dExportAllBtn');
    await waitCapture(page, 'PK');
    await expect(page.locator('#p2dExportNote')).toContainText('2 ページ目は、ほかのページで合わせた縮尺');
    await expect(page.locator('#p2dExportNote')).toContainText('3 ページ目は、縮尺が未設定のため保存していません。');   // 保存しなかったページは、理由を文で知らせる
  });

  test('通り芯の交点をねらうと、近くの柱の角ではなく交点に吸い付く', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([400, 300]);
      const L = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: PL.rgb(0, 0, 0) });
      L(100, 20, 100, 280);   // 縦の通り芯
      L(20, 150, 380, 150);   // 横の通り芯
      // 交点のすぐ右上にある柱(角 = 102.5, 152.5)
      p.drawRectangle({ x: 102.5, y: 152.5, width: 10, height: 10, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
    `);
    const pick = await page.evaluate(() => {
      const st = window.__p2dState, pg = st.pages[st.pageIndex];
      const layer = document.getElementById('p2dPickLayer'), rc = layer.getBoundingClientRect();
      const p = { x: 101, y: 151 };   // 交点(100,150)の近く。柱の角(102.5,152.5)よりも交点に近い
      layer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse',
        clientX: rc.left + p.x * st.ds, clientY: rc.top + (pg.geom.vpH - p.y) * st.ds }));
      return st.picks[0];
    });
    expect(pick.snapped).toBe(true);
    expect(pick.x).toBeCloseTo(100, 3);
    expect(pick.y).toBeCloseTo(150, 3);
  });

  test('PDFが漢字を「部首用の別の文字コード」で記録していても、元の字に戻して書き出す(「文」「戸」「長」が「?」にならない)', async ({ page, context }) => {
    // Chromium+游ゴシック/メイリオ で作ったPDFは「文・高・長・戸・黒…」など約230字を部首用の文字コード(U+2F42 等)で記録する。
    // JIS の全文字をPDFにして読み戻す全数調査で確認済み(Jw_cad 実機で「縦の文字」が「縦の?字」になって発覚)
    const WORDS = ['縦の文字', '引戸', '長さ', '高さ', '黒', '西面', '青', '黄', '金物', '土台', '木工事', '水', '入口', '立面', '見付', '歯', '竜', '亀', '民', '母', '虎', '鬼', '麦', '斉'];
    const gen = await context.newPage();
    await gen.setContent('<html><head><meta charset="utf-8"><style>@page { size: A4; margin: 10mm } body { margin: 0; font-family: "Yu Gothic", "YuGothic", "Meiryo", sans-serif; font-size: 14px; } div { height: 24px; }</style></head><body>' +
      WORDS.map((w) => '<div>' + w + '</div>').join('') +
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20"><line x1="5" y1="10" x2="95" y2="10" stroke="#000" stroke-width="0.3"/></svg></body></html>');
    const pdf = await gen.pdf({ format: 'A4' });
    await gen.close();
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    await page.evaluate(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u], 'kanji.pdf', { type: 'application/pdf' }));
      const inp = document.getElementById('p2dFileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, pdf.toString('base64'));
    await waitReady(page);
    await setPreset(page, 100);
    const idx = await exportDxf(page);
    // DXF を Shift-JIS として読み戻し、TEXT の中身を集める(Jw_cad と同じ読み方)
    const texts = await page.evaluate((i) => {
      const s = new TextDecoder('shift_jis').decode(window.__caps[i].bytes);
      const L = s.split(String.fromCharCode(13, 10));
      const out = [];
      let inText = false;
      for (let k = 0; k + 1 < L.length; k += 2) {
        const c = L[k].trim(), v = L[k + 1];
        if (c === '0') inText = v === 'TEXT';
        else if (c === '1' && inText) out.push(v);
      }
      return out;
    }, idx);
    const all = texts.join('');
    expect(all).not.toContain('?');
    for (const ch of Array.from(WORDS.join(''))) expect(all, '「' + ch + '」が書き出されている').toContain(ch);
    await expect(page.locator('#p2dExportNote')).not.toContainText('置き換え');

    // 符号化の単体確認: 部首用コード → 元の字と同じバイト列。NFKC では旧字体になる 戸・黒 も新字体に戻す
    const enc = await page.evaluate(() => {
      const f = window.__p2dTest.encodeCP932, cp = (n) => String.fromCodePoint(n);
      const same = (a, b) => { const x = f(a), y = f(b); return x.bad === 0 && y.bad === 0 && x.bytes.length === y.bytes.length && x.bytes.every((v, k) => v === y.bytes[k]); };
      return {
        bun: same(cp(0x2F42), '文'), to: same(cp(0x2F3E), '戸'), kuro: same(cp(0x2FCA), '黒'), naga: same(cp(0x2ED1), '長'),
        colon: same(cp(0xFE13), '：'), sq: same('m' + cp(0xB2), 'm2'), badEmoji: f(cp(0x1F600)).bad,
        long: f(cp(0x3300).repeat(3000)).bad,   // 1文字が複数文字に広がる場合でも壊れない(バッファの取り方の確認)
      };
    });
    expect(enc).toEqual({ bun: true, to: true, kuro: true, naga: true, colon: true, sq: true, badEmoji: 1, long: 0 });
  });

  test('画像が用紙の多くを占めるページ(Excel に図の絵を貼ったPDFなど)は、画像の部分が変換されないことを知らせる', async ({ page }) => {
    // 実データで発覚: 罫線と文字だけが変換され、肝心の図(貼り付けた絵)が無言で抜けていた
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const load = async (imgW, imgH) => {
      await page.evaluate(async ({ w, h }) => {
        const PL = window.PDFLib;
        const cv = document.createElement('canvas'); cv.width = 200; cv.height = 150;
        const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 150); x.strokeStyle = '#000'; x.strokeRect(20, 20, 160, 110);
        const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
        const doc = await PL.PDFDocument.create();
        const img = await doc.embedPng(await png.arrayBuffer());
        const p = doc.addPage([400, 300]);
        p.drawImage(img, { x: 50, y: 100, width: w, height: h });
        p.drawLine({ start: { x: 50, y: 50 }, end: { x: 350, y: 50 }, thickness: 1, color: PL.rgb(0, 0, 0) });
        const dt = new DataTransfer();
        dt.items.add(new File([await doc.save()], 'pasted.pdf', { type: 'application/pdf' }));
        const inp = document.getElementById('p2dFileInput');
        window.__prevPdf = window.__p2dState.pdf;
        inp.files = dt.files;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }, { w: imgW, h: imgH });
      await page.waitForFunction(() => { const s = window.__p2dState; return s && s.pdf && s.pdf !== window.__prevPdf && !s.rendering && s.pages[0] && s.pages[0].geom; }, null, { timeout: 30_000 });
    };
    // 200×150 の画像 = 用紙(400×300)の 25%
    await load(200, 150);
    await expect(page.locator('#p2dInfo')).toContainText('画像が 1 枚');
    await expect(page.locator('#p2dInfo')).toContainText('約 25%');
    await expect(page.locator('#p2dBanner')).not.toBeVisible();   // 線もあるので「スキャン画像のため変換できません」ではない
    await setPreset(page, 1);
    const recs = await parseDxf(page, await exportDxf(page));
    expect(ents(recs, 'LINE').length).toBe(1);                     // 線は変換できる
    await expect(page.locator('#p2dExportNote')).toContainText('画像の部分は含まれていません');
    // ロゴ程度の小さな画像(1%未満)では騒がない
    await page.click('#p2dResetBtn');
    await load(20, 15);
    await expect(page.locator('#p2dInfo')).not.toContainText('画像');
  });

  // ===================== 第1段 A: 精度のモデル(docs/plans/pdf2dxf-stage1-spec.md の A と E1〜E8) =====================

  test('精度E1: 600dpi 相当の 1/100 図面を 10,920 で合わせると「標準の縮尺ちょうど」を採用し、残る誤差は床(±4.3mm)だけになる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    const q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.q).toBeCloseTo(0.12, 6);   // 直線の端点の差から 600dpi の刻みが取れている
    await expect(page.locator('#p2dDimHint')).toContainText('いちばん長い寸法');
    await clickPts(page, await hLineAt(page, 520));
    await expect(page.locator('#p2dShortWarn')).toBeHidden();   // 長い寸法なので「短い寸法です」は出ない
    await page.fill('#p2dRealLen', '10920');
    await page.click('#p2dApplyDim');
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100(寸法 10,920mm で確認。標準の縮尺ちょうどを採用)');
    const s = await calState(page);
    expect(s.cal.adopted).toBe(true);
    expect(s.cal.nominal).toBe(100);
    expect(s.cal.snapped).toBe(true);
    expect(Math.abs(s.cal.denMeasured - 100)).toBeGreaterThan(0.001);   // 測った値そのものは 1/100 ちょうどではない(丸めのぶんだけずれる)
    expect(s.k).toBeCloseTo(K100, 12);                                  // それでも標準値ちょうどを採用する
    await expect(page.locator('#p2dCalNote')).toBeHidden();
    await expect(page.locator('#p2dPrecision')).toContainText('線の位置が実寸で約 4.2mm きざみに記録されています');
    await expect(page.locator('#p2dPrecision2')).toContainText('長さによらず 約 ±4.2mm');
    const lines = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    expect(Math.abs(lenOf(dxfLineAtY(lines, 520, s.k)) - 10920)).toBeLessThanOrEqual(4.3);
    expect(Math.abs(lenOf(dxfLineAtY(lines, 490, s.k)) - 3640)).toBeLessThanOrEqual(4.3);
  });

  test('精度E2: 97% に縮んだPDFは標準の縮尺を採用せず「約 1/103.1」と表示し、DXF の長さは ±0.1% 以内。一致しない理由をPDFのせいと言い切らない(1/150 の原寸の図面でも同じ表示)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(0.97));
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    // 縮尺の行は事実だけ。理由と次の一手は、下の注意の行に出す(点の取り違え・一覧に無い縮尺でも同じ表示になるため)
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/103.1(寸法 10,920mm で測った値)');
    await expect(page.locator('#p2dScaleStatus')).not.toContainText('原寸で出力されたPDFではない');
    await expect(page.locator('#p2dCalNote')).toContainText('標準の縮尺(1/100 など)とは一致しませんでした。まず、クリックした2点と入力した寸法をお確かめください。どちらも正しければ、用紙に合わせて縮小されたPDFか、標準以外の縮尺(1/150 など)の図面と考えられます。');
    await expect(page.locator('#p2dCalNote')).toContainText('測った値のまま、実寸に合わせて変換します');
    const s = await calState(page);
    expect(s.cal.adopted).toBe(false);
    expect(s.cal.kind).toBe('measured');
    await expect(page.locator('#p2dCalToggle')).toBeHidden();
    await expect(page.locator('#p2dPrecision2')).toContainText('10m の長さで');
    const lines = ents(await parseDxf(page, await exportDxf(page)), 'LINE');
    expect(Math.abs(lenOf(dxfLineAtY(lines, 520, s.k)) / 10920 - 1)).toBeLessThanOrEqual(0.001);
    const vert = lines.filter((l) => Math.abs(num(l, '10') - num(l, '11')) < 1e-6).map(lenOf).sort((a, b) => b - a);
    expect(Math.abs(vert[0] / 9100 - 1)).toBeLessThanOrEqual(0.001);    // いちばん長い通り芯(3640 + 12×455 = 9,100)
    expect(Math.abs(vert[1] / 8645 - 1)).toBeLessThanOrEqual(0.001);

    // 原寸で出力した 1/150 の図面(縮尺の一覧に無い)。縮小されたPDFではないので、「原寸で出力されたPDFではない」と言ってはいけない
    await loadP2d(page, gridDrawing(100 / 150));
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    await expect(page.locator('#p2dScaleStatus')).toHaveText(/約 1[/]1(49[.]9|50[.]0)[0-9]?[(]寸法 10,920mm で測った値[)]/);   // 両端の丸めのぶん、150 ちょうどにはならない
    await expect(page.locator('#p2dScaleStatus')).not.toContainText('原寸で出力されたPDFではない');
    await expect(page.locator('#p2dCalNote')).toContainText('標準以外の縮尺(1/150 など)の図面と考えられます');
    expect((await calState(page)).cal.kind).toBe('measured');
  });

  test('精度E3: 99.5% に縮んだPDFを 10,920 で合わせても、標準の縮尺とは取り違えない', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(0.995));
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/100.5(寸法 10,920mm で測った値)');
    await expect(page.locator('#p2dScaleStatus')).not.toContainText('標準の縮尺ちょうど');
    const s = await calState(page);
    expect(s.cal.adopted).toBe(false);
    expect(s.cal.kind).toBe('measured');
    expect(s.k).toBeCloseTo(s.cal.real / s.cal.d, 12);
    expect(Math.abs(s.k / K100 - 1)).toBeGreaterThan(0.004);   // 標準値に丸められていない
    await expect(page.locator('#p2dCalToggle')).toBeHidden();
  });

  test('精度E4: 短い寸法(910)で合わせると、標準の縮尺かどうかは判定せず、長い寸法を案内する', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await clickPts(page, await hLineAt(page, 460));
    await expect(page.locator('#p2dShortWarn')).toBeVisible();            // 2点を取った時点でその場に知らせる
    // これ以上長い寸法が無い図面でも迷わないよう、このままでよいことも伝える
    await expect(page.locator('#p2dShortWarn')).toHaveText('短い寸法です。図面にもっと長い寸法があれば、そちらで合わせると誤差が小さくなります(このままでも合わせられます)。');
    await page.fill('#p2dRealLen', '910');
    expect(await page.locator('#p2dApplyDim').isDisabled()).toBe(false);  // 確定は止めない
    await page.click('#p2dApplyDim');
    await expect(page.locator('#p2dCalNote')).toContainText('寸法が短いため、標準の縮尺かどうか判定できません。もっと長い寸法で合わせると、誤差が小さくなります');
    await expect(page.locator('#p2dScaleStatus')).toContainText('寸法 910mm で測った値');
    await expect(page.locator('#p2dScaleStatus')).not.toContainText('標準の縮尺ちょうど');
    const s = await calState(page);
    expect(s.cal.adopted).toBe(false);
    expect(s.cal.kind).toBe('short');
    expect(s.cal.u).toBeGreaterThan(0.0015);
    await expect(page.locator('#p2dCalToggle')).toBeHidden();
    await expect(page.locator('#p2dShortWarn')).toBeHidden();
  });

  test('精度E5: 標準の縮尺を採用した後に「測った値を使う」で戻せて、「標準の縮尺を使う」でもう一度採用できる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    const toggle = page.locator('#p2dCalToggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('測った値(約 1/');
    // ふつうは押す必要のないリンクなので、押すと何が起きるかを添える
    await expect(toggle).toHaveAttribute('title', '標準の縮尺ではなく、クリックした2点と寸法から計算した縮尺で変換します(ふつうは押す必要はありません)');
    await toggle.click();
    await expect(page.locator('#p2dScaleStatus')).toContainText('寸法 10,920mm で測った値');
    await expect(page.locator('#p2dScaleStatus')).not.toContainText('標準の縮尺ちょうど');
    await expect(page.locator('#p2dPrecision2')).toContainText('10m の長さで');
    let s = await calState(page);
    expect(s.cal.adopted).toBe(false);
    expect(s.k).toBeCloseTo(s.cal.real / s.cal.d, 12);
    await expect(toggle).toHaveText('標準の縮尺(1/100)を使う');
    await toggle.click();
    await expect(page.locator('#p2dScaleStatus')).toContainText('標準の縮尺ちょうどを採用');
    await expect(page.locator('#p2dPrecision2')).toContainText('長さによらず');
    s = await calState(page);
    expect(s.cal.adopted).toBe(true);
    expect(s.k).toBeCloseTo(K100, 12);
  });

  test('精度E6: 検算に誤差の目安が出る。図面に書いてある寸法と一致・不一致を判定し、不一致からその寸法で合わせ直せる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await setPreset(page, 100);
    const dim = await hLineAt(page, 490);
    await clickPts(page, dim);
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 3,640');
    await expect(page.locator('#p2dCheckResult')).toContainText('誤差の目安 ±4.2mm');   // 600dpi・1/100 の1目盛り = 4.2mm
    await expect(page.locator('#p2dCheckVerdict')).toBeHidden();
    await page.fill('#p2dCheckLen', '3640');
    await expect(page.locator('#p2dCheckVerdict')).toContainText('図面の寸法と一致しました(差 ');
    await expect(page.locator('#p2dCheckVerdict')).toHaveClass(/ok/);
    await expect(page.locator('#p2dRecal')).toBeHidden();
    await page.fill('#p2dCheckLen', '3700');
    // 合わない時は、縮尺やPDFを疑う前に、まず点と寸法を確かめてもらう(いちばん多い原因は、点の取り違えと打ち間違い)
    await expect(page.locator('#p2dCheckVerdict')).toContainText('mm 合いません。まず、クリックした2点と入力した寸法をお確かめください。それでも合わない時は、縮尺が違うか、用紙に合わせて縮小されたPDFの可能性があります');
    await expect(page.locator('#p2dCheckVerdict')).toHaveClass(/ng/);
    await expect(page.locator('#p2dRecal')).toBeVisible();
    await expect(page.locator('#p2dRecal')).toHaveClass(/ghost/);   // 副ボタン(注意の文より目立たせない)
    await page.click('#p2dRecal');
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/101.');
    await expect(page.locator('#p2dScaleStatus')).toContainText('測った値');
    const s = await calState(page);
    expect(s.cal.real).toBe(3700);
    expect(s.cal.adopted).toBe(false);
    expect(s.k).toBeCloseTo(3700 / s.cal.d, 12);
    expect(s.picks).toBe(0);
    expect(await page.inputValue('#p2dCheckLen')).toBe('');
    await expect(page.locator('#p2dCheckVerdict')).toBeHidden();
    await expect(page.locator('#p2dPrecision2')).toContainText('10m の長さで');
    await expect(page.locator('#p2dPrecision2')).toHaveClass(/caution/);   // 短めの寸法で合わせた縮尺は相対誤差が 0.05% を超える
    await clickPts(page, dim);
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 3,700');
  });

  test('精度E7: 吸着していない点で合わせた注意は、確定後・保存後・ほかのページへ写した後も残る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, 'for (let n = 0; n < 2; n++) {' + gridDrawing(1) + '}');
    await clickPts(page, [{ x: 400, y: 560 }, { x: 700, y: 560 }]);   // 近くに線の端も交点も無い所
    await expect(page.locator('#p2dPickInfo')).toContainText('吸い付いていない点があります');
    await page.fill('#p2dRealLen', '10000');
    await page.click('#p2dApplyDim');
    const CAUTION = '線の端や交点に吸い付いていない点で合わせています';
    const SAVED_CAUTION = '線の端や交点に吸い付いていない点で合わせたため、誤差が大きい可能性があります';   // 保存後は、結果どうなるかまで書く
    await expect(page.locator('#p2dCalNote')).toBeVisible();
    await expect(page.locator('#p2dCalNote')).toContainText(CAUTION);
    let s = await calState(page);
    expect(s.cal.snapped).toBe(false);
    expect(s.cal.adopted).toBe(false);
    await exportDxf(page);
    await expect(page.locator('#p2dExportNote')).toContainText('保存しました');
    await expect(page.locator('#p2dExportNote .p2d-note-caution')).toHaveText('縮尺は、' + SAVED_CAUTION + '。');   // 成功の文の末尾に続けず、注意色の別の行
    await expect(page.locator('#p2dCalNote')).toContainText(CAUTION);
    // 検算で別の2点を取っても、縮尺の下の注意は消えない
    await clickPts(page, await hLineAt(page, 490));
    await expect(page.locator('#p2dCalNote')).toContainText(CAUTION);
    // 同じ用紙サイズのページへ写すと、合わせ方の記録(cal)も写る
    await page.click('#p2dApplyAll');
    await expect(page.locator('#p2dScaleNote')).toContainText('1 ページ');
    await armCapture(page);
    await page.click('#p2dExportAllBtn');
    await waitCapture(page, 'PK');
    await expect(page.locator('#p2dExportNote .p2d-note-caution')).toHaveText('1・2 ページ目の縮尺は、' + SAVED_CAUTION + '。');
    await page.click('#p2dNext');
    await page.waitForFunction(() => { const st = window.__p2dState; return st.pageIndex === 1 && !st.rendering && st.pages[1] && st.pages[1].geom; });
    s = await calState(page);
    expect(s.kFrom).toBe(1);
    expect(s.cal.snapped).toBe(false);
    await expect(page.locator('#p2dCalNote')).toContainText(CAUTION);
  });

  test('精度E8: 座標の刻みは直線の端点だけで判定する(曲線が格子に乗らないPDFでも取れる)。minDiff を返し、細かさを4つに分類する', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const f = window.__p2dTest.estimateQuantum, pc = window.__p2dTest.precisionClass;
      const Q = 72 / 600, K = 25.4 / 72 * 100;
      const lineD = Array.from({ length: 60 }, (_, i) => (i % 37 + 2) * Q);
      const curveD = Array.from({ length: 200 }, (_, i) => (i + 1) * 0.3141593);
      const fine = Array.from({ length: 200 }, (_, i) => ((i * 7919) % 100000 + 1) * 0.001);
      return {
        split: f(lineD, curveD),                 // 直線は格子に乗り、曲線は乗らない
        mixed: f(lineD.concat(curveD)),          // 混ぜて渡すと(従来の判定)推定できない
        few: f(lineD.slice(0, 10), curveD),      // 直線が20個に満たない時だけ、曲線も足して判定する
        none: f(lineD.slice(0, 10), []),
        fine: f(fine),
        cls: [pc(null, K), pc({ q: Q, unknown: false, minDiff: Q }, K), pc({ q: 0.001, unknown: false, minDiff: 0.001 }, K),
          pc({ q: null, unknown: true, minDiff: 0.0007 }, K), pc({ q: null, unknown: true, minDiff: 0.9 }, K), pc({ q: null, unknown: true, minDiff: null }, K)],
      };
    });
    expect(r.split.q).toBeCloseTo(0.12, 6);
    expect(r.split.unknown).toBe(false);
    expect(r.split.minDiff).toBeCloseTo(0.24, 6);
    expect(r.mixed.unknown).toBe(true);
    expect(r.few.unknown).toBe(true);
    expect(r.few.minDiff).toBeCloseTo(0.24, 6);
    expect(r.none).toBe(null);
    expect(r.fine.minDiff).toBeCloseTo(0.001, 9);
    expect(r.cls).toEqual(['few', 'grid', 'fine', 'fine', 'unknown', 'unknown']);

    // 実際のPDFで: 直線は 600dpi の格子、円(ベジェ曲線)の端点は格子に乗らない → それでも刻みが取れる
    await loadP2d(page, gridDrawing(1) + `
      p.drawCircle({ x: 600.0317, y: 200.0211, size: 30.0173, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.3 });
    `);
    const g = await page.evaluate(() => { const s = window.__p2dState, gm = s.pages[s.pageIndex].geom; return { q: gm.quantum, circles: gm.circles.length }; });
    expect(g.circles).toBe(1);
    expect(g.q.unknown).toBe(false);
    expect(g.q.q).toBeCloseTo(0.12, 6);
    expect(g.q.minDiff).toBeGreaterThan(0);
    await setPreset(page, 100);
    await expect(page.locator('#p2dPrecision')).toHaveText('精度の目安: このPDFは、線の位置が実寸で約 4.2mm きざみに記録されています(測った長さは最大 ±4.2mm ずれます。斜めの線では約1.4倍)。');
    await expect(page.locator('#p2dPrecision')).not.toHaveClass(/caution/);
  });

  test('精度: 座標の細かさを推定できないPDFでは、測った値が標準の縮尺と一致しても自動では採用せず、誤差の目安も言い切らない', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([842, 595]);
      const LN = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
      LN(60, 520, 60 + ${pt100(10920)}, 520);
      for (let i = 0; i < 24; i++) LN(70 + i * 9.4247779, 60, 70 + i * 9.4247779, 60 + 31.41593 + i * 7.3141593);   // どの刻みにも乗らない座標
    `);
    const q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.unknown).toBe(true);
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    const s = await calState(page);
    expect(s.cal.kind).toBe('unknown');
    expect(s.cal.adopted).toBe(false);
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/100.0(寸法 10,920mm で測った値)');
    await expect(page.locator('#p2dCalNote')).toContainText('標準の縮尺(1/100)ちょうどかどうかは判定していません');
    await expect(page.locator('#p2dCalToggle')).toBeHidden();
    await expect(page.locator('#p2dCalNote')).toContainText('このPDFは線の位置の細かさを調べられないため');
    await expect(page.locator('#p2dCalNote')).toContainText('下の「確かめる」で、図面の寸法と合うかをお確かめください');
    await expect(page.locator('#p2dPrecision')).toContainText('線の位置の細かさを調べられませんでした。図面の寸法文字と突き合わせて確かめてください');
    await expect(page.locator('#p2dPrecision')).toHaveClass(/caution/);
    await expect(page.locator('#p2dPrecision2')).toBeHidden();
    await clickPts(page, await hLineAt(page, 520));
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 10,920mm(誤差の目安は計算できません)');
  });

  test('精度: ルールRと誤差の目安は、乱数の総当たりでも「等倍の取りこぼし 0・縮小PDFの誤採用 0・実際の誤差は目安以内」を守る', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const T = window.__p2dTest, PT2MM = 25.4 / 72;
      const nominals = Array.from(document.getElementById('p2dPreset').options).map((o) => parseFloat(o.value));
      let seed = 20260920;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const out = { nominals: nominals.length, judged: 0, tooShort: 0, shortNotRefused: 0, missed: 0, falseAdopt: 0, overErr: 0, worst: 0 };
      for (let t = 0; t < 60000; t++) {
        const q = 72 / [300, 400, 600, 1200][t % 4];
        const N = [50, 100, 200][Math.floor(rnd() * 3)];
        const exact = t % 2 === 0;
        const shrink = exact ? 1 : (rnd() < 0.5 ? 0.90 + rnd() * 0.095 : 1.005 + rnd() * 0.095);   // 縮小・拡大は 0.5% 以上
        const real = 1000 + rnd() * 19000, th = [0, Math.PI / 2, rnd() * Math.PI][t % 3];
        const dTrue = real / (PT2MM * N) * shrink;
        const x0 = rnd() * 50, y0 = rnd() * 50, x1 = x0 + dTrue * Math.cos(th), y1 = y0 + dTrue * Math.sin(th);
        const R = (v) => Math.round(v / q) * q;
        const dx = R(x1) - R(x0), dy = R(y1) - R(y0), d = Math.hypot(dx, dy);
        const u = q / d;
        const dec = T.nominalDecision({ den: (real / d) / PT2MM, u, classUnknown: false, nominals });
        if (u > 0.0015) { out.tooShort++; if (dec.kind !== 'short') out.shortNotRefused++; continue; }
        out.judged++;
        if (exact && !(dec.kind === 'adopt' && dec.nominal === N)) out.missed++;
        if (!exact && dec.kind === 'adopt') out.falseAdopt++;
        if (exact) {   // 標準の縮尺ちょうどを採用した時に残る誤差 = 両端の丸めだけ。目安(床)を超えないこと
          const k = PT2MM * N, err = Math.abs(d * k - real);
          const est = T.measureError({ q, k, theta: Math.atan2(dy, dx), relScale: 0, unsnappedCount: 0, ds: 1, len: d * k }).total;
          out.worst = Math.max(out.worst, err / est);
          if (err > est + 0.05) out.overErr++;   // 0.05mm = 丸めが線に直角な向きへ働くぶん(2次の微小量)の余裕
        }
      }
      const K = PT2MM * 100, me = T.measureError, nd = (den, u, cu) => T.nominalDecision({ den, u, classUnknown: !!cu, nominals }).kind;
      out.floor0 = me({ q: 0.12, k: K, theta: 0, relScale: 0, unsnappedCount: 0, ds: 1.5, len: 5000 }).total;
      out.floor45 = me({ q: 0.12, k: K, theta: Math.PI / 4, relScale: 0, unsnappedCount: 0, ds: 1.5, len: 5000 }).total;
      out.loose2 = me({ q: 0.12, k: K, theta: 0, relScale: 0, unsnappedCount: 2, ds: 1.5, len: 5000 }).total;
      out.scaled = me({ q: 0.12, k: K, theta: 0, relScale: 0.001, unsnappedCount: 0, ds: 1.5, len: 10000 });
      out.noGrid = me({ q: 0, k: K, theta: 1, relScale: 0, unsnappedCount: 0, ds: 1.5, len: 10000 }).total;
      out.kinds = [nd(100.01, 0.0016), nd(100.14, 0.001), nd(100.16, 0.001), nd(100.02, 0), nd(100.04, 0), nd(100.02, 0, true), nd(103.1, 0.0004), nd(49.99, 0.0004)];
      out.kindsUnknown = [nd(100.2, 0, true), nd(100.3, 0, true), nd(103.1, 0, true)];   // 刻みが分からないPDF: 0.225% までは「一致しない」とも言い切らない
      return out;
    });
    expect(r.nominals).toBe(10);
    expect(r.judged).toBeGreaterThan(20000);
    expect(r.tooShort).toBeGreaterThan(1000);
    expect(r.shortNotRefused).toBe(0);
    expect(r.missed).toBe(0);
    expect(r.falseAdopt).toBe(0);
    expect(r.overErr).toBe(0);
    const K = 25.4 / 72 * 100;
    expect(r.floor0).toBeCloseTo(0.12 * K, 9);
    expect(r.floor45).toBeCloseTo(0.12 * K * Math.SQRT2, 9);
    expect(r.loose2).toBeCloseTo(0.12 * K + 2 * K / 1.5, 9);
    expect(r.scaled.scale).toBeCloseTo(10, 9);
    expect(r.scaled.total).toBeCloseTo(0.12 * K + 10, 9);
    expect(r.noGrid).toBe(0);
    expect(r.kinds).toEqual(['short', 'adopt', 'measured', 'adopt', 'measured', 'unknown', 'measured', 'adopt']);
    expect(r.kindsUnknown).toEqual(['unknown', 'measured', 'measured']);
  });

  // ===================== 第1段 B: 吸着のルーペと選び直し(docs/plans/pdf2dxf-stage1-spec.md の B と E9〜E10) =====================

  test('ルーペE9: カーソルを動かすと取り出した線と吸い付く点を 8 倍で表示し、外すと消える。ルーペに見えている点がクリックで取れる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, cornerDrawing);
    const layer = page.locator('#p2dPickLayer'), loupe = page.locator('#p2dLoupe');
    expect((await p2dState(page)).ds).toBe(2);
    await expect(loupe).toBeHidden();
    await expect(loupe).toHaveCSS('pointer-events', 'none');   // ルーペはクリックを邪魔しない

    // 線の端 (250,60) から画面で右へ 3px・上へ 2px ずらした所にカーソルを置く
    const pos = await layerPos(page, { x: 250, y: 60 }, { dx: 3, dy: -2 });
    await layer.hover({ position: pos });
    await expect(loupe).toBeVisible();
    await page.waitForFunction(() => { const h = window.__p2dState.hover; return h && h.snapped; });
    let s = await p2dState(page);
    expect(s.hover.x).toBeCloseTo(250, 6);
    expect(s.hover.y).toBeCloseTo(60, 6);
    // ルーペの中心 = カーソル。8 倍なので、吸い付く点は中心から左へ 24px・下へ 16px の (60,100) に、橙(合わせ中の色)の輪と十字で描かれる
    const ring = await loupePixels(page, [46, 86, 74, 114]);
    expect(ring.orange).toBeGreaterThan(60);
    expect((await loupePixels(page, [0, 0, 168, 168])).green).toBe(0);
    // 取り出した線(ラスタ画像ではなく線データ)が、端から右へ延びている。線の無い所は白
    const lineBox = await loupePixels(page, [100, 97, 160, 103]);
    expect(lineBox.dark).toBeGreaterThan(40);
    expect(lineBox.ink).toBeGreaterThanOrEqual(60);
    expect((await loupePixels(page, [100, 20, 160, 80])).ink).toBe(0);
    expect((await loupePixels(page, [4, 97, 40, 103])).ink).toBe(0);   // 端より左に線は無い
    // 置き場所: カーソルの右上に 24px 離す
    const lb = await layer.boundingBox(), b1 = await loupe.boundingBox();
    expect(b1.width).toBeCloseTo(168, 0);
    expect(b1.height).toBeCloseTo(168, 0);
    expect(Math.abs(b1.x - (lb.x + pos.x + 24))).toBeLessThanOrEqual(1);
    expect(Math.abs(b1.y + b1.height - (lb.y + pos.y - 24))).toBeLessThanOrEqual(1);
    // ルーペに見えている「吸い付く点」= 同じ場所のクリックで取れる点
    await layer.click({ position: pos });
    s = await p2dState(page);
    expect(s.picks.length).toBe(1);
    expect(s.picks[0]).toEqual({ x: s.hover.x, y: s.hover.y, snapped: true });
    await expect(page.locator('#p2dChooser')).toBeHidden();   // 近くに紛らわしい点が無ければ、小窓は開かない

    // 近くに線の端も交点も無い所: 吸い付かず、カーソルの位置に灰色の十字だけ
    await layer.hover({ position: await layerPos(page, { x: 300, y: 250 }) });
    await page.waitForFunction(() => { const h = window.__p2dState.hover; return h && !h.snapped; });
    await expect(loupe).toBeVisible();
    const empty = await loupePixels(page, [0, 0, 168, 168]);
    expect(empty.orange).toBe(0);
    expect(empty.green).toBe(0);
    expect((await loupePixels(page, [88, 82, 98, 86])).ink).toBeGreaterThan(5);   // 十字の右の腕

    // 用紙の右上の端では、反対側(左下)へ逃がす
    const edge = { x: Math.round(lb.width) - 20, y: 20 };
    await layer.hover({ position: edge });
    await page.waitForFunction((x) => { const c = window.__p2dState.cursor; return c && Math.abs(c.x - x) < 2; }, lb.x + edge.x);
    await page.waitForTimeout(100);
    const b2 = await loupe.boundingBox(), lb2 = await layer.boundingBox();
    expect(b2.x + b2.width).toBeLessThanOrEqual(lb2.x + edge.x - 24 + 1);
    expect(b2.y).toBeGreaterThanOrEqual(lb2.y + edge.y + 24 - 1);

    // 確かめ中(縮尺を決めた後)は緑
    await setPreset(page, 100);
    await layer.hover({ position: await layerPos(page, { x: 350, y: 60 }, { dx: -3, dy: 2 }) });
    await page.waitForFunction(() => { const h = window.__p2dState.hover; return h && h.snapped && Math.abs(h.x - 350) < 1e-6; });
    const ring2 = await loupePixels(page, [94, 54, 122, 82]);   // 吸い付く点は中心から右へ 24px・上へ 16px
    expect(ring2.green).toBeGreaterThan(60);
    expect(ring2.orange).toBe(0);

    // カーソルを図面から外すと消える
    await page.locator('#p2dSummary').hover();
    await expect(loupe).toBeHidden();
    expect((await p2dState(page)).hover).toBe(null);

    // タッチ: 押している間だけ指の上側に出す。点を取るのは指を離した時
    const touch = (type, at) => page.evaluate(({ t, a }) => {
      const el = document.getElementById('p2dPickLayer'), rc = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 7, pointerType: 'touch',
        clientX: rc.left + a.x, clientY: rc.top + a.y }));
    }, { t: type, a: at });
    await page.locator('#p2dPickLayer').scrollIntoViewIfNeeded();
    const tp = await layerPos(page, { x: 250, y: 60 }, { dx: 4, dy: 3 });
    await touch('pointerdown', tp);
    await expect(loupe).toBeVisible();
    expect((await p2dState(page)).picks.length).toBe(0);   // 押しただけでは点を取らない
    const lb3 = await layer.boundingBox(), b3 = await loupe.boundingBox();
    expect(Math.abs(b3.x + b3.width / 2 - (lb3.x + tp.x))).toBeLessThanOrEqual(1);   // 指の真上
    expect(b3.y + b3.height).toBeLessThanOrEqual(lb3.y + tp.y - 40);
    await touch('pointermove', { x: tp.x - 2, y: tp.y - 1 });
    await touch('pointerup', { x: tp.x - 2, y: tp.y - 1 });
    await expect(loupe).toBeHidden();
    s = await p2dState(page);
    expect(s.picks.length).toBe(1);
    expect(s.picks[0].snapped).toBe(true);
    expect(s.picks[0].x).toBeCloseTo(250, 6);
    expect(s.picks[0].y).toBeCloseTo(60, 6);
  });

  test('ルーペ: 格子の索引で取った吸着の候補点は総当たりと一致し、線が10万本あっても1コマの処理は 8ms 以内', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([1191, 842]);
      p.drawLine({ start: { x: 100, y: 100 }, end: { x: 500, y: 100 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
    `);
    // 取り出した後の図形データを差し替えて調べる(PDFを経由すると10万本の用意に時間が掛かるため)。索引は作り直させる
    const r = await page.evaluate(async () => {
      const st = window.__p2dState, pg = st.pages[0], g = pg.geom, T = window.__p2dTest, W = g.vpW, H = g.vpH;
      let seed = 20260920;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      // --- 1. 索引の正しさ: 線(短い・長い・斜め・軸に平行)、円、円弧を混ぜ、総当たりの結果と突き合わせる ---
      const lines = [], circles = [], arcs = [];
      for (let i = 0; i < 400; i++) {
        const x = rnd() * W, y = rnd() * H, len = i % 5 === 0 ? 200 + rnd() * 600 : 3 + rnd() * 60, th = i % 3 === 0 ? 0 : (i % 3 === 1 ? Math.PI / 2 : rnd() * Math.PI * 2);
        const cl = (v, m) => Math.max(0, Math.min(m, v));
        lines.push({ x1: x, y1: y, x2: cl(x + len * Math.cos(th), W), y2: cl(y + len * Math.sin(th), H) });
      }
      for (let i = 0; i < 40; i++) { const r = 2 + rnd() * (i % 4 === 0 ? 150 : 20); circles.push({ cx: r + rnd() * (W - 2 * r), cy: r + rnd() * (H - 2 * r), r }); }
      for (let i = 0; i < 40; i++) { const r = 2 + rnd() * (i % 4 === 0 ? 150 : 20); arcs.push({ cx: r + rnd() * (W - 2 * r), cy: r + rnd() * (H - 2 * r), r, a1: rnd() * 360, a2: rnd() * 360 }); }
      g.lines = lines; g.circles = circles; g.arcs = arcs; pg.index = null;
      const brute = (p, rad) => {
        const pts = [];
        const add = (x, y) => { if (Math.hypot(x - p.x, y - p.y) <= rad && !pts.some((q) => Math.hypot(q.x - x, q.y - y) <= 0.01)) pts.push({ x, y }); };
        for (const l of lines) { add(l.x1, l.y1); add(l.x2, l.y2); }
        for (const c of circles) { add(c.cx, c.cy); add(c.cx + c.r, c.cy); add(c.cx - c.r, c.cy); add(c.cx, c.cy + c.r); add(c.cx, c.cy - c.r); }
        for (const a of arcs) {
          const a1 = a.a1 * Math.PI / 180, a2 = a.a2 * Math.PI / 180;
          add(a.cx, a.cy); add(a.cx + a.r * Math.cos(a1), a.cy + a.r * Math.sin(a1)); add(a.cx + a.r * Math.cos(a2), a.cy + a.r * Math.sin(a2));
        }
        for (let i = 0; i < lines.length; i++) {
          for (let j = i + 1; j < lines.length; j++) {
            const a = lines[i], b = lines[j];
            const rx = a.x2 - a.x1, ry = a.y2 - a.y1, sx = b.x2 - b.x1, sy = b.y2 - b.y1, den = rx * sy - ry * sx;
            if (Math.abs(den) <= 1e-9 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) continue;
            const qx = b.x1 - a.x1, qy = b.y1 - a.y1, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            add(a.x1 + t * rx, a.y1 + t * ry);
          }
        }
        return pts;
      };
      // 調べる位置: 図形の吸着点のすぐそば(端・中心・四分点・円弧の端)と、でたらめな位置
      const probes = [];
      const nearTo = (x, y) => probes.push({ x: x + (rnd() - 0.5) * 8, y: y + (rnd() - 0.5) * 8 });
      for (let i = 0; i < 120; i++) { const l = lines[i]; nearTo(l.x1, l.y1); nearTo(l.x2, l.y2); nearTo((l.x1 + l.x2) / 2, (l.y1 + l.y2) / 2); }
      for (const c of circles) { nearTo(c.cx, c.cy); nearTo(c.cx + c.r, c.cy); nearTo(c.cx, c.cy - c.r); }
      for (const a of arcs) { nearTo(a.cx, a.cy); nearTo(a.cx + a.r * Math.cos(a.a2 * Math.PI / 180), a.cy + a.r * Math.sin(a.a2 * Math.PI / 180)); }
      for (let i = 0; i < 200; i++) probes.push({ x: rnd() * W, y: rnd() * H });
      const out = { probes: probes.length, found: 0, mismatch: 0, unsorted: 0 };
      for (const p of probes) {
        const rad = 6 + rnd() * 20, got = T.snapCandidates(p, rad), want = brute(p, rad);
        out.found += want.length;
        if (got.length !== want.length || !want.every((w) => got.some((c) => Math.hypot(c.x - w.x, c.y - w.y) < 1e-6))) out.mismatch++;
        for (let i = 1; i < got.length; i++) if (got[i].d < got[i - 1].d - 0.02) out.unsorted++;
      }
      // --- 2. 速さ: 線10万本。本番と同じく、1コマ(requestAnimationFrame)に1回だけ動かす ---
      const many = [];
      for (let i = 0; i < 100000; i++) {
        const x = rnd() * W, y = rnd() * H, len = i % 500 === 0 ? 300 + rnd() * 700 : 2 + rnd() * 25, hz = rnd() < 0.5, dg = rnd() < 0.2;
        many.push({ x1: x, y1: y, x2: Math.min(W, x + (hz || dg ? len : 0)), y2: Math.min(H, y + (!hz || dg ? len : 0)) });
      }
      g.lines = many; g.circles = []; g.arcs = []; pg.index = null;
      const rc = document.getElementById('p2dPickLayer').getBoundingClientRect();
      T.hoverAt(rc.left + 100, rc.top + 100);   // 1回目は索引を作る(ページごとに一度だけ)
      const ts = [];
      for (let i = 0; i < 90; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const t = performance.now();
        T.hoverAt(rc.left + 40 + (i * 97) % (rc.width - 80), rc.top + 40 + (i * 61) % (rc.height - 80));
        ts.push(performance.now() - t);
      }
      ts.sort((a, b) => a - b);
      out.median = ts[45];
      return out;
    });
    expect(r.probes).toBeGreaterThan(600);
    expect(r.found).toBeGreaterThan(600);   // 突き合わせた候補点の総数(空振りのテストになっていないこと)
    expect(r.mismatch).toBe(0);
    expect(r.unsorted).toBe(0);
    expect(r.median).toBeLessThan(8);
  });

  test('選び直しE10: 画面で 2px しか離れていない2点の近くをクリックすると、確定せずに小窓を開く。選んだ点が入り、Esc・外側・× で取り消せる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, cornerDrawing);
    const chooser = page.locator('#p2dChooser'), layer = page.locator('#p2dPickLayer');
    const near = [{ x: 100.2, y: 150.1 }];   // 交点 (100,150) と柱の角 (101,150) の近く(交点のほうが近い)
    await expect(chooser).toBeHidden();
    await expect(chooser).toHaveCSS('transition-duration', '0.12s');   // 開閉は 120ms のフェード

    // 本物のマウスでクリックする: ボタンを離す時には、もう小窓がカーソルの下に開いている。その「離す」で候補が選ばれてしまわないこと
    await layer.click({ position: await layerPos(page, near[0]) });
    await expect(chooser).toBeVisible();
    await expect(page.locator('#p2dChooserTitle')).toHaveText('近くに点が複数あります。合わせたい点を選んでください。');
    await expect(chooser).toBeFocused();
    await expect(page.locator('#p2dLoupe')).toBeHidden();
    let s = await p2dState(page);
    expect(s.picks.length).toBe(0);   // まだ確定していない
    expect(s.chooser.view.length).toBe(2);
    const vA = s.chooser.view.find((v) => Math.abs(v.x - 100) < 1e-6), vB = s.chooser.view.find((v) => Math.abs(v.x - 101) < 1e-6);
    expect(Math.abs(vA.y - 150)).toBeLessThan(1e-6);
    expect(Math.abs(vB.y - 150)).toBeLessThan(1e-6);
    // 倍率: 候補点どうしの最小間隔(画面で 2px)が 44px になる 22 倍。下限 8・上限 96 の間
    expect(s.chooser.mag).toBeCloseTo(22, 6);
    expect(Math.hypot(vA.vx - vB.vx, vA.vy - vB.vy)).toBeGreaterThanOrEqual(44 - 1e-6);
    expect(s.chooser.view[s.chooser.sel].x).toBeCloseTo(100, 6);   // はじめは、クリックした位置にいちばん近い点が選ばれた状態
    // Tab は小窓の中(拡大図 ⇔ ×)で回る。外の「別のPDFを開く」などへ抜けない(抜けると、小窓が開いたまま Enter で別の操作になる)
    await page.keyboard.press('Tab');
    await expect(page.locator('#p2dChooserClose')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(chooser).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#p2dChooserClose')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(chooser).toBeFocused();
    await expect(chooser).toBeVisible();
    const cb = await page.locator('#p2dChooserCanvas').boundingBox();
    expect(cb.width).toBeCloseTo(320, 0);
    expect(cb.height).toBeCloseTo(320, 0);

    // Esc で取り消し
    await page.keyboard.press('Escape');
    await expect(chooser).toBeHidden();
    expect((await p2dState(page)).picks.length).toBe(0);

    // 小窓の外(図面の上)をクリック: 取り消すだけで、点は取らない
    await clickPts(page, near);
    await expect(chooser).toBeVisible();
    await layer.click({ position: await layerPos(page, { x: 330, y: 250 }) });
    await expect(chooser).toBeHidden();
    expect((await p2dState(page)).picks.length).toBe(0);

    // × で取り消し
    await clickPts(page, near);
    await expect(chooser).toBeVisible();
    await page.click('#p2dChooserClose');
    await expect(chooser).toBeHidden();
    expect((await p2dState(page)).picks.length).toBe(0);

    // 点を選ぶ: 丸の中心から 15px ほど外れた所を押しても、当たり判定(半径 22px)に入っていれば選べる
    await clickPts(page, near);
    await expect(chooser).toBeVisible();
    await page.locator('#p2dChooserCanvas').click({ position: { x: vB.vx + 12, y: vB.vy + 9 } });
    await expect(chooser).toBeHidden();
    s = await p2dState(page);
    expect(s.picks.length).toBe(1);
    expect(s.picks[0].snapped).toBe(true);
    expect(s.picks[0].x).toBeCloseTo(101, 6);   // いちばん近い交点ではなく、選んだ柱の角が入る
    expect(s.picks[0].y).toBeCloseTo(150, 6);
    await expect(page.locator('#p2dPickInfo')).toContainText('2点目をクリックしてください');

    // 2点目はキーボードで: 矢印で選ぶ点を動かし、Enter で確定。合わせ中の2点目なので、閉じた後は実寸の入力欄へ
    await clickPts(page, near);
    await expect(chooser).toBeVisible();
    await page.keyboard.press('ArrowRight');
    expect((await p2dState(page)).chooser.sel).toBe(1);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(chooser).toBeHidden();
    s = await p2dState(page);
    expect(s.picks.length).toBe(2);
    expect(s.picks[1].x).toBeCloseTo(100, 6);
    expect(s.picks[1].y).toBeCloseTo(150, 6);
    await expect(page.locator('#p2dRealLen')).toBeFocused();

    // 動きを減らす設定の時は、フェードなしで開閉する
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(chooser).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('#p2dLoupe')).toHaveCSS('transition-duration', '0s');
    await clickPts(page, near);
    await expect(chooser).toBeVisible();
    expect((await p2dState(page)).picks.length).toBe(2);   // 取り消せるよう、選び終わるまで前の2点は残しておく
    await page.keyboard.press('Escape');
    await expect(chooser).toBeHidden();
    expect((await p2dState(page)).picks.length).toBe(2);
  });

  test('円弧E11: 600dpi 相当に丸めたPDFでも、ベジェ4本の小さい円は CIRCLE 1個、ベジェ2本の半円は ARC 1個になる。元の曲線から用紙上 0.05mm を超えてずれる曲線は ARC にせず折れ線にする', async ({ page }) => {
    await openApp(page);
    // [中心x, 中心y, 半径, 描き始めの向き(度), ベジェの本数]。中心はわざと目盛りに乗らない位置に置く。
    // 半径 1.42pt = 用紙上 0.5mm。斜めの向きから描き始めた円と、8本に分かれた円も混ぜる(1本ごとに出した中心が大きくばらつく形)
    const circles = [[450.37, 250.41, 2.83, 0, 4], [480.11, 250.23, 1.42, 0, 4], [520.23, 250.31, 5.67, 27, 4], [570.11, 250.47, 11.34, 10, 8], [680.31, 180.19, 42.52, 0, 4]];
    const half = { cx: 520.4, cy: 120.3, r: 8.5, rot: 33 };   // 半円(90°のベジェ2本)
    await loadP2d(page, gridDrawing(1) + arcsHelper + `
      for (const c of ${JSON.stringify(circles)}) ARCS(c[0], c[1], c[2], c[3], c[4], 360 / c[4]);
      ARCS(${half.cx}, ${half.cy}, ${half.r}, ${half.rot}, 2, 90);
    `);
    // この注意は「精度の目安」の下に出す(縮尺を決めた拍子に、縮尺の欄の上に現れて図面が下へずれないように)
    const info = page.locator('#p2dPrecision3');
    await expect(info).toBeHidden();   // 縮尺が決まるまでは、1目盛りの実寸が分からない
    await setPreset(page, 100);
    // 1目盛り = 0.12pt = 実寸 約4.2mm(1mm 以上)の粗いPDF → 円の中心と半径は目安だと知らせる
    await expect(info).toHaveText('このPDFは線の位置が粗く記録されている(実寸で約 4.2mm きざみ)ため、円の中心と半径は目安です。');
    await expect(page.locator('#p2dInfo')).not.toContainText('円の中心と半径');
    const recs = await parseDxf(page, await exportDxf(page));
    expect(ents(recs, 'LINE').length).toBe(25);   // 図の直線だけ(曲線が折れ線になっていない)
    const cs = ents(recs, 'CIRCLE');
    expect(cs.length).toBe(circles.length);       // 円1つにつき CIRCLE 1個(4本の円弧に割れていない)
    const G = 72 / 600 * K100;                    // 1目盛りの実寸(mm)
    for (const c of circles) {
      const hit = cs.filter((e) => Math.hypot(num(e, '10') - c[0] * K100, num(e, '20') - c[1] * K100) <= G);
      expect(hit.length).toBe(1);                                                  // 中心は1目盛り以内
      expect(Math.abs(num(hit[0], '40') - c[2] * K100)).toBeLessThanOrEqual(G);    // 半径も1目盛り以内
    }
    const as = ents(recs, 'ARC');
    expect(as.length).toBe(1);
    // 半円の両端は、PDF に書かれた端点(丸めた後の座標)から用紙上 0.05mm 以内 = 1/100 の実寸で 5mm 以内
    const Rn = (v) => Math.round(v / (72 / 600)) * (72 / 600);
    const srcEnds = [half.rot, half.rot + 180].map((d) => ({ x: Rn(half.cx + half.r * Math.cos(d * Math.PI / 180)) * K100, y: Rn(half.cy + half.r * Math.sin(d * Math.PI / 180)) * K100 }));
    const arcEnds = ['50', '51'].map((c) => ({ x: num(as[0], '10') + num(as[0], '40') * Math.cos(num(as[0], c) * Math.PI / 180), y: num(as[0], '20') + num(as[0], '40') * Math.sin(num(as[0], c) * Math.PI / 180) }));
    for (let i = 0; i < 2; i++) expect(Math.hypot(arcEnds[i].x - srcEnds[i].x, arcEnds[i].y - srcEnds[i].y)).toBeLessThanOrEqual(5.01);   // 反時計回りに描いたので、ARC の始まり = 描き始め
    let sweep = num(as[0], '51') - num(as[0], '50');
    if (sweep < 0) sweep += 360;
    expect(Math.abs(sweep - 180)).toBeLessThan(3);

    // 細かいPDF(丸めなし): 円弧にするかどうかは「元の曲線から用紙上 0.05mm 以内に収まる円があるか」だけで決まる
    await loadP2d(page, `
      const p = doc.addPage([595, 842]);
      const K = 4 * (Math.sqrt(2) - 1) / 3;
      const QUARTER = (cx, cy, a, b) => p.pushOperators(PL.setLineWidth(0.3), PL.moveTo(cx + a, cy),
        PL.appendBezierCurve(cx + a, cy + K * b, cx + K * a, cy + b, cx, cy + b), PL.stroke());
      QUARTER(150, 600, 100, 101);   // ほぼ円弧(いちばん合う円とのずれは用紙上 約0.02mm)
      QUARTER(350, 600, 100, 103);   // いちばん合う円でも 約0.06mm ずれる(以前の判定は半径の 0.3% まで許していたので、円弧として出していた)
      QUARTER(150, 300, 100, 60);    // 楕円の4分の1(円弧ではない)
    `);
    await setPreset(page, 100);
    await expect(info).toBeHidden();
    const recs2 = await parseDxf(page, await exportDxf(page));
    expect(ents(recs2, 'CIRCLE').length).toBe(0);
    const a2 = ents(recs2, 'ARC');
    expect(a2.length).toBe(1);
    expect(Math.hypot(num(a2[0], '10') - 150 * K100, num(a2[0], '20') - 600 * K100)).toBeLessThan(1.5 * K100);
    expect(Math.abs(num(a2[0], '40') - 100.5 * K100)).toBeLessThan(1 * K100);
    // 折れ線になった2本: 頂点はどれも元の曲線(楕円)の上にあり、十分に細かく刻まれている
    const onEllipse = (l, cx, cy, a, b) => ['10', '11'].every((c, i) => {
      const x = num(l, c) / K100 - cx, y = num(l, i === 0 ? '20' : '21') / K100 - cy;
      return Math.abs(Math.hypot(x / a, y / b) - 1) < 0.0005;
    });
    const lines2 = ents(recs2, 'LINE');
    const upper = lines2.filter((l) => num(l, '20') > 500 * K100), lower = lines2.filter((l) => num(l, '20') <= 500 * K100);
    expect(upper.length).toBeGreaterThanOrEqual(8);
    expect(lower.length).toBeGreaterThanOrEqual(8);
    expect(upper.every((l) => onEllipse(l, 350, 600, 100, 103))).toBe(true);
    expect(lower.every((l) => onEllipse(l, 150, 300, 100, 60))).toBe(true);
  });

  test('円弧: 乱数の総当たりでも、600dpi 相当に丸めた円は必ず CIRCLE 1個(中心・半径は1目盛り以内)、円弧はほぼ必ず ARC 1個になり、出した円・円弧は元の曲線から離れない', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const fit = window.__p2dTest.fitCurves;
      const Q = 72 / 600, TOL = 0.05 / (25.4 / 72);   // 1目盛り(pt)と、用紙上 0.05mm(pt)
      let seed = 20260920;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const R = (v) => Math.round(v / Q) * Q;
      const P = (x, y) => ({ x: R(x), y: R(y) });
      // 中心 (cx, cy)・半径 r の円弧を、th0(ラジアン)から n 本のベジェ(1本あたり per ラジアン)で描いた列。端点も制御点も目盛りに丸める
      const arcRun = (cx, cy, r, th0, per, n) => {
        const run = [];
        for (let i = 0; i < n; i++) {
          const a = th0 + per * i, b = a + per, k = 4 / 3 * Math.tan(per / 4) * r;
          const ax = cx + r * Math.cos(a), ay = cy + r * Math.sin(a), bx = cx + r * Math.cos(b), by = cy + r * Math.sin(b);
          run.push({ t: 'C', a: P(ax, ay), c1: P(ax - k * Math.sin(a), ay + k * Math.cos(a)), c2: P(bx + k * Math.sin(b), by - k * Math.cos(b)), b: P(bx, by) });
        }
        return run;
      };
      const bez = (s, t) => {
        const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
        return { x: a * s.a.x + b * s.c1.x + c * s.c2.x + e * s.b.x, y: a * s.a.y + b * s.c1.y + c * s.c2.y + e * s.b.y };
      };
      // 出てきた円・円弧から、元の曲線の上の点(t = 1/step 刻み)までの離れの最大
      const worst = (run, shapes, step) => {
        let w = 0;
        for (const s of run) for (let i = 0; i <= step; i++) {
          const p = bez(s, i / step);
          let best = Infinity;
          for (const c of shapes) best = Math.min(best, Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r));
          if (best > w) w = best;
        }
        return w;
      };
      const out = { circles: 0, circleOk: 0, maxCenter: 0, maxRadius: 0, arcs: 0, arcOne: 0, worstAtCheck: 0, worstFine: 0 };
      // (1) 円: 4本(軸に沿った向き・斜めの向き)は半径 0.5〜300pt、6本・8本は半径 2〜300pt。
      // (6本・8本に分けた円は、半径が 1.3pt = 用紙上 0.5mm ほどより小さいと、丸めで1本が一直線につぶれて円弧と短い線で出ることがある。
      //  どちらで出ても元の曲線から 0.05mm 以内なので、ここでは対象にしない)
      for (let i = 0; i < 4000; i++) {
        const n = [4, 4, 6, 8][i % 4], rMin = n === 4 ? 0.5 : 2;
        const rr = Math.exp(Math.log(rMin) + rnd() * Math.log(300 / rMin)), cx = 200 + rnd() * 50, cy = 300 + rnd() * 50;
        const th0 = i % 4 === 0 ? 0 : rnd() * 2 * Math.PI;
        const run = arcRun(cx, cy, rr, th0, 2 * Math.PI / n, n), o = fit(run, Q);
        out.circles++;
        if (o.circles.length !== 1 || o.arcs.length || o.lines.length) continue;
        out.circleOk++;
        out.maxCenter = Math.max(out.maxCenter, Math.hypot(o.circles[0].cx - cx, o.circles[0].cy - cy));
        out.maxRadius = Math.max(out.maxRadius, Math.abs(o.circles[0].r - rr));
        out.worstAtCheck = Math.max(out.worstAtCheck, worst(run, o.circles, 8));
        out.worstFine = Math.max(out.worstFine, worst(run, o.circles, 64));
      }
      // (2) 円弧: 半径 2〜300pt、1〜4本、1本あたり 20〜85°
      for (let i = 0; i < 4000; i++) {
        const rr = Math.exp(Math.log(2) + rnd() * Math.log(150)), cx = 200 + rnd() * 50, cy = 300 + rnd() * 50;
        const n = 1 + i % 4, per = (20 + rnd() * 65) * Math.PI / 180;
        const run = arcRun(cx, cy, rr, rnd() * 2 * Math.PI, per, n), o = fit(run, Q);
        out.arcs++;
        if (o.arcs.length === 1 && !o.circles.length && !o.lines.length) out.arcOne++;
        if (o.lines.length) continue;   // 折れ線が混ざった時は、どの区間が円弧かの対応が要るので、離れの確認からは外す
        out.worstAtCheck = Math.max(out.worstAtCheck, worst(run, o.arcs.concat(o.circles), 8));
        out.worstFine = Math.max(out.worstFine, worst(run, o.arcs.concat(o.circles), 64));
      }
      return { out, Q, TOL };
    });
    const { out, Q, TOL } = r;
    expect(out.circleOk).toBe(out.circles);                       // 円は1つ残らず CIRCLE 1個(4本の円弧に割れない)
    expect(out.maxCenter).toBeLessThanOrEqual(Q);                 // 中心は1目盛り以内
    expect(out.maxRadius).toBeLessThanOrEqual(Q);                 // 半径も1目盛り以内
    expect(out.arcOne / out.arcs).toBeGreaterThanOrEqual(0.99);   // 円弧も、ほぼ必ず ARC 1個にまとまる
    expect(out.worstAtCheck).toBeLessThanOrEqual(TOL + 1e-9);     // 検証に使う点(t = 1/8 刻み)では、必ず用紙上 0.05mm 以内
    expect(out.worstFine).toBeLessThanOrEqual(TOL * 1.2);         // 検証の点の間まで細かくたどっても 0.06mm 以内
  });

  test('円・円弧は、描いた時点の切り抜きと非表示レイヤに従う(円・円弧の確定は、座標の刻みが分かる抽出の最後にまとめて行うため)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const ctx = doc.context;
      const ocOff = ctx.register(ctx.obj({ Type: 'OCG', Name: PL.PDFString.of('HIDDEN') }));
      doc.catalog.set(PL.PDFName.of('OCProperties'), ctx.obj({ OCGs: [ocOff], D: { Order: [ocOff], OFF: [ocOff] } }));
      const p = doc.addPage([400, 300]);
      p.node.Resources().set(PL.PDFName.of('Properties'), ctx.obj({ ocH: ocOff }));
      const CIRCLE = (x, y, r) => p.drawCircle({ x, y, size: r, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.5 });
      // 四角の切り抜き(x 100〜200・y 100〜200)の中で描いた円3つ: 全部入る円 / 右半分が切れる円 / 全部外の円
      p.pushOperators(PL.pushGraphicsState(), PL.rectangle(100, 100, 100, 100), PL.clip(), PL.endPath());
      CIRCLE(150, 150, 20);
      CIRCLE(200, 150, 30);
      CIRCLE(300, 150, 20);
      p.pushOperators(PL.popGraphicsState());
      // 切り抜きは Q で元に戻る: この円は全周
      CIRCLE(300, 60, 20);
      // 非表示レイヤの中の円は出さない。レイヤを抜けた後の円は出す
      p.pushOperators(PL.PDFOperator.of('BDC', [PL.PDFName.of('OC'), PL.PDFName.of('ocH')]));
      CIRCLE(60, 250, 20);
      p.pushOperators(PL.PDFOperator.of('EMC'));
      CIRCLE(340, 250, 20);
    `);
    await setPreset(page, 1);
    const k = 25.4 / 72;
    const recs = await parseDxf(page, await exportDxf(page));
    const centers = ents(recs, 'CIRCLE').map((c) => [Math.round(num(c, '10') / k), Math.round(num(c, '20') / k)]).sort((a, b) => a[0] - b[0]);
    expect(centers).toEqual([[150, 150], [300, 60], [340, 250]]);
    expect(ents(recs, 'ARC').length).toBe(0);
    // 右半分が切れた円は、見えている左半分だけが折れ線で出る(切り抜きの右端 x=200 を越えない)
    const lines = ents(recs, 'LINE');
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const l of lines) {
      for (const [cx, cy] of [['10', '20'], ['11', '21']]) {
        const x = num(l, cx) / k, y = num(l, cy) / k;
        expect(x).toBeLessThanOrEqual(200.02);
        expect(x).toBeGreaterThanOrEqual(169.98);
        expect(Math.abs(Math.hypot(x - 200, y - 150) - 30)).toBeLessThan(0.15);   // 用紙上 0.05mm(0.14pt)以内
      }
    }
    await expect(page.locator('#p2dInfo')).toContainText('非表示');
  });

  // ===================== 第1段の検証で見つかった不具合の再発防止 =====================

  test('精度: 座標の細かさが分からないPDF(後から縮めたPDF・線の少ないPDF)では、正しい寸法を確かめても「合いません」と言わない。明らかに大きい差だけを知らせる', async ({ page }) => {
    await openApp(page);
    const verdict = page.locator('#p2dCheckVerdict');
    const expectNoVerdict = async (pts, real) => {
      await clickPts(page, pts);
      await expect(page.locator('#p2dCheckResult')).toContainText('誤差の目安は計算できません');
      await page.fill('#p2dCheckLen', String(real));
      await expect(verdict).toContainText('図面の寸法との差は ');
      await expect(verdict).toContainText('このPDFは線の位置の細かさが分からないため、一致したかどうかは判定できません');
      await expect(verdict).not.toContainText('合いません');
      await expect(verdict).toHaveClass(/na/);
      await expect(page.locator('#p2dRecal')).toBeHidden();
    };
    // (1) 600dpi・1/100 の図を、後から PDF ごと 70.71% に縮めた形(座標の刻みが 0.12 × 0.7071pt になり、アプリの知っている刻みのどれにも乗らない)
    const S = 0.7071;
    await loadP2d(page, gridDrawing(1, S));
    let q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.unknown).toBe(true);
    await calibrateBy(page, await hLineAt(page, 520 * S), 10920);
    await expect(page.locator('#p2dPrecision')).toContainText('線の位置の細かさを調べられませんでした');
    await expectNoVerdict(await hLineAt(page, 490 * S), 3640);
    await expectNoVerdict(await hLineAt(page, 460 * S), 910);
    // 差が明らかに大きい時(通り芯の交点と壁の角の取り違え = 約60mm)は、これまでどおり知らせて、合わせ直せる
    await page.fill('#p2dCheckLen', '970');
    await expect(verdict).toContainText('mm 合いません。まず、クリックした2点と入力した寸法をお確かめください');
    await expect(verdict).toHaveClass(/ng/);
    await expect(page.locator('#p2dRecal')).toBeVisible();

    // (2) 線が6本だけの 600dpi・1/100・原寸のPDF(線が少なくて刻みを調べられない)
    await loadP2d(page, `
      const Q = 72 / 600, R = (v) => Math.round(v / Q) * Q, U = ${MM} / 100;
      const p = doc.addPage([842, 595]);
      [10920, 3640, 5460, 7280, 1820, 2730].forEach((len, i) => p.drawLine({ start: { x: R(60.05), y: R(520 - i * 40) }, end: { x: R(60.05 + len * U), y: R(520 - i * 40) }, thickness: 0.3, color: PL.rgb(0, 0, 0) }));
    `);
    q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q).toBe(null);
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    await expect(page.locator('#p2dPrecision')).toContainText('線が少ないため計算できません');
    await expectNoVerdict(await hLineAt(page, 480), 3640);
    await expectNoVerdict(await hLineAt(page, 400), 7280);

    // (3) 乱数の総当たり: 刻みの分からないPDFで、正しい寸法が「合いません」になることは無い。60mm の取り違えと、3% 縮んだPDFは必ず拾う
    const r = await page.evaluate(() => {
      const T = window.__p2dTest, PT2MM = 25.4 / 72;
      let seed = 20260921;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const out = { n: 0, ngCorrect: 0, okCorrect: 0, missMispick: 0, missShrunk: 0 };
      for (let t = 0; t < 40000; t++) {
        const s = [0.7071, 0.97, 1][t % 3], qq = 72 / 600 * s, kTrue = PT2MM * 100 / s;
        const R = (v) => Math.round(v / qq) * qq;
        const x0 = rnd() * 50, k = 10920 / (R(x0 + 10920 / kTrue) - R(x0));          // 10,920 の通し寸法で合わせた縮尺(測った値のまま)
        const want = [910, 1820, 2730, 3640, 5460, 7280, 10920][Math.floor(rnd() * 7)], th = [0, Math.PI / 2, rnd() * Math.PI][Math.floor(rnd() * 3)];
        const ax = rnd() * 50, ay = rnd() * 50, bx = ax + want / kTrue * Math.cos(th), by = ay + want / kTrue * Math.sin(th);
        const real = Math.hypot(R(bx) - R(ax), R(by) - R(ay)) * k;
        const v = T.verdictOf({ real, want, e: 0, known: false, k });
        out.n++;
        if (v.state === 'ng') out.ngCorrect++;
        if (v.state === 'ok') out.okCorrect++;
        if (T.verdictOf({ real: real + 60, want, e: 0, known: false, k }).state !== 'ng') out.missMispick++;
        if (T.verdictOf({ real: real * 0.97, want, e: 0, known: false, k }).state !== 'ng') out.missShrunk++;
      }
      // 刻みの分かるPDFの判定は、これまでと同じ(誤差の目安 + 0.5mm)
      out.known = [T.verdictOf({ real: 3640.7, want: 3640, e: 4.2, known: true, k: 35 }).state, T.verdictOf({ real: 3644.8, want: 3640, e: 4.2, known: true, k: 35 }).state];
      return out;
    });
    expect(r.n).toBe(40000);
    expect(r.ngCorrect).toBe(0);
    expect(r.okCorrect).toBe(0);      // 分からないPDFでは「一致しました」とも言い切らない
    expect(r.missMispick).toBe(0);
    expect(r.missShrunk).toBe(0);
    expect(r.known).toEqual(['ok', 'ng']);
  });

  test('精度: 座標の刻みの推定は外れ値に強い。プリンタ経由の図面に小数そのままの線が混ざっても「十分に細かいPDF」と言い切らず、塗りつぶしの面は刻みの判定に使わない', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const f = window.__p2dTest.estimateQuantum, pc = window.__p2dTest.precisionClass;
      const Q = 72 / 600, K = 25.4 / 72 * 100;
      let seed = 4242;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const grid = (n, q) => Array.from({ length: n }, () => (1 + Math.floor(rnd() * 3000)) * q);
      const dec = (n, digits) => Array.from({ length: n }, () => Math.round((0.002 + rnd() * 80) * digits) / digits);   // 小数そのままの差(digits = 10000 なら小数4桁)
      const res = { mixed: [] };
      // 600dpi の格子 + 小数4桁の線が 2〜30%(うち1つは 0.0005pt。以前は、この1つだけを見て「十分に細かい」と言い切っていた)
      for (const frac of [0.02, 0.1, 0.2, 0.3]) {
        for (const total of [420, 5000]) {
          const e = f(grid(Math.round(total * (1 - frac)), Q).concat(dec(Math.round(total * frac), 10000), [0.0005]));
          res.mixed.push({ q: e.q, mixed: e.mixed, cls: pc(e, K) });
        }
      }
      res.dec3 = f(grid(2400, Q).concat(dec(600, 1000)));   // 外れが小数3桁: 以前は 0.001pt 刻みの「十分に細かいPDF」になっていた
      res.dec3many = f(grid(1500, Q).concat(dec(1500, 1000)));   // 小数3桁の線のほうが多い(手書きの細かい折れ線など): 全体は 0.001pt 刻みに乗るが、図面の線は 600dpi のまま
      res.dec3manyCls = pc(res.dec3many, K);
      res.cad = f(dec(3000, 10000).concat([0.0004, 0.0007]));   // CAD から直接出力したPDF風(全部が小数そのまま)
      res.cadCls = pc(res.cad, K);
      res.dpi1200 = f(Array.from({ length: 3000 }, () => (1 + Math.floor(rnd() * 1500)) * (rnd() < 0.5 ? 2 : 1) * (72 / 1200)));   // 1200dpi で、偶数の差が多い(約75%)
      res.small = f(grid(25, Q).concat(dec(23, 10000), [0.0005]));   // 線が少なく、半分が小数の線
      res.smallCls = pc(res.small, K);
      res.pure = f(grid(3000, Q));
      return res;
    });
    for (const m of r.mixed) {
      expect(m.q).toBeCloseTo(0.12, 6);
      expect(m.mixed).toBe(true);
      expect(m.cls).toBe('grid');
    }
    expect(r.dec3.q).toBeCloseTo(0.12, 6);
    expect(r.dec3many.q).toBe(null);
    expect(r.dec3many.bulkQ).toBeGreaterThanOrEqual(0.12 - 1e-9);
    expect(r.dec3manyCls).toBe('unknown');         // 「十分に細かいPDF」とは言わない
    expect(r.cad.unknown).toBe(true);
    expect(r.cad.bulkQ).toBe(null);
    expect(r.cadCls).toBe('fine');                 // 全部が小数そのままのPDFは、これまでどおり「十分に細かい」
    expect(r.dpi1200.q).toBeCloseTo(0.06, 6);      // 偶数の差が多いだけの 1200dpi を、600dpi と取り違えない
    expect(r.dpi1200.mixed).toBe(false);
    expect(r.small.q).toBe(null);
    expect(r.small.bulkQ).toBeGreaterThanOrEqual(0.12 - 1e-9);
    expect(r.smallCls).toBe('unknown');            // 多数決でも決められない時は、細かいとは言わず「推定できませんでした」
    expect(r.pure.q).toBeCloseTo(0.12, 6);
    expect(r.pure.mixed).toBe(false);

    // 画面で: 600dpi・1/100 の図 + 小数そのままの線5本(1組の dx は 0.0005pt)+ 塗りつぶしの細い長方形(幅 0.8pt)
    const overlay = (n) => `
      for (let i = 0; i < ${n}; i++) p.drawLine({ start: { x: 300.1234 + i * 17.3571, y: 100.4321 + i * 3.1379 }, end: { x: 300.1239 + i * 19.0113, y: 131.7717 + i * 5.4143 }, thickness: 0.3, color: PL.rgb(1, 0, 0) });
      p.drawRectangle({ x: 700.3, y: 500.2, width: 0.8, height: 40, color: PL.rgb(0, 0, 0) });
    `;
    await loadP2d(page, gridDrawing(1) + overlay(5));
    let q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.q).toBeCloseTo(0.12, 6);   // 塗りの長方形(0.8 = 0.04 × 20)に引きずられて 0.04 にならない。小数の線は多数決で外れる
    expect(q.mixed).toBe(true);
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    expect((await calState(page)).cal.adopted).toBe(true);
    await expect(page.locator('#p2dPrecision')).toContainText('線の位置が実寸で約 4.2mm きざみに記録されています');
    await expect(page.locator('#p2dPrecision2')).toContainText('長さによらず 約 ±4.2mm');
    await clickPts(page, await hLineAt(page, 490));
    await page.fill('#p2dCheckLen', '3640');
    await expect(page.locator('#p2dCheckVerdict')).toContainText('図面の寸法と一致しました');

    // 小数の線が半分近くを占める時は、多数決でも決められない。それでも「十分に細かいPDF(±1mm未満)」とは言わない
    await loadP2d(page, gridDrawing(1) + overlay(12));
    q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.q).toBe(null);
    expect(q.minDiff).toBeLessThan(0.001);
    expect(q.bulkQ).toBeGreaterThan(0);
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    await expect(page.locator('#p2dPrecision')).toContainText('線の位置の細かさを調べられませんでした');
    await expect(page.locator('#p2dPrecision')).not.toContainText('十分に細か');
    expect((await calState(page)).cal.adopted).toBe(false);
    await clickPts(page, await hLineAt(page, 490));
    await page.fill('#p2dCheckLen', '3640');
    await expect(page.locator('#p2dCheckVerdict')).not.toContainText('合いません');
  });

  test('選び直し: 狭い窓(1000×700・取説を右に開いたまま)で横向きの図面を開いても、小窓の下が切れず、画面の中に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openApp(page);
    await page.waitForFunction(() => document.body.classList.contains('guide-docked'), null, { timeout: 15_000 });   // 取説は、この幅では自動で右に開く
    await loadP2d(page, cornerDrawing);
    await page.evaluate(() => document.getElementById('p2dCanvasWrap').scrollIntoView({ block: 'center' }));
    await page.locator('#p2dPickLayer').click({ position: await layerPos(page, { x: 100.2, y: 150.1 }) });
    const chooser = page.locator('#p2dChooser');
    await expect(chooser).toBeVisible();
    await expect(chooser).toHaveCSS('opacity', '1');
    const g = await page.evaluate(() => {
      const el = document.getElementById('p2dChooser'), ch = el.getBoundingClientRect();
      const wrap = document.getElementById('p2dCanvasWrap').getBoundingClientRect();
      const probe = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && el.contains(hit); };
      return { chH: ch.height, top: ch.top, bottom: ch.bottom, left: ch.left, right: ch.right, wrapH: wrap.height, wrapBottom: wrap.bottom, innerH: window.innerHeight, innerW: window.innerWidth,
        hitBottom: probe(ch.left + ch.width / 2, ch.bottom - 5), hitCorner: probe(ch.left + 12, ch.bottom - 12), overflowY: getComputedStyle(el.closest('.redact-stage')).overflowY };
    });
    expect(g.wrapH).toBeLessThan(g.chH);              // 前提: 用紙の表示の高さが、小窓より低い
    expect(g.bottom).toBeGreaterThan(g.wrapBottom);   // 小窓は用紙の下へはみ出す
    expect(g.overflowY).toBe('visible');              // 図面欄は小窓を切らない
    expect(g.hitBottom).toBe(true);                   // 下端まで小窓が見えていて、押せる(以前は下の注意書きの欄に当たり、押すと取り消しになった)
    expect(g.hitCorner).toBe(true);
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.innerH);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.right).toBeLessThanOrEqual(g.innerW);
    // 小窓の下のほうにある候補も選べる
    const s = await p2dState(page);
    const vB = s.chooser.view.find((v) => Math.abs(v.x - 101) < 1e-6);
    await page.locator('#p2dChooserCanvas').click({ position: { x: vB.vx, y: vB.vy + 15 } });
    await expect(chooser).toBeHidden();
    expect((await p2dState(page)).picks[0].x).toBeCloseTo(101, 6);

    // 取説を閉じる・開くと図面欄の幅が変わる(この時は window の resize が来ない)。図面欄は横にスクロールしないので、図面はそのたびに図面欄の幅に収まり直す
    const fit = () => page.evaluate(() => ({ w: document.getElementById('p2dCanvasWrap').getBoundingClientRect().width, s: document.querySelector('#modePdf2Dxf .redact-stage').clientWidth }));
    const docked = await fit();
    expect(docked.w).toBeLessThanOrEqual(docked.s);
    await page.evaluate(() => window.closeGuide());
    await expect.poll(async () => (await fit()).w).toBeGreaterThan(docked.w + 100);
    const wide = await fit();
    expect(wide.w).toBeLessThanOrEqual(wide.s);
    await page.evaluate(() => window.openGuide());
    await expect.poll(async () => { const f = await fit(); return f.w <= f.s; }).toBe(true);
    await waitReady(page);
  });

  test('縮尺の欄と図面の上の操作の結果・エラーは、縮尺の欄の中(画面に見える所)に出る。2点が近すぎる時は、その場で知らせて確定させない', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, 'for (let n = 0; n < 2; n++) {' + gridDrawing(1) + '}');
    const note = page.locator('#p2dScaleNote');
    const inView = () => page.evaluate(() => { const rc = document.getElementById('p2dScaleNote').getBoundingClientRect(); return rc.height > 0 && rc.top >= 0 && rc.bottom <= window.innerHeight; });
    await expect(note).toBeHidden();
    // 同じ点を2回取る → 「短い寸法です」の場所に理由を出し、寸法を入れても確定のボタンは押せない
    const dim = await hLineAt(page, 520);
    await clickPts(page, [dim[0], dim[0]]);
    await expect(page.locator('#p2dShortWarn')).toBeVisible();
    await expect(page.locator('#p2dShortWarn')).toHaveText('2点が近すぎます。もっと離れた2点を選んでください。');
    await page.fill('#p2dRealLen', '10920');
    expect(await page.locator('#p2dApplyDim').isDisabled()).toBe(true);
    // 「縮尺を選ぶ」のまま、縮尺が未設定の図面をクリック → 縮尺の欄に理由が出る(保存ボタンの横ではない)
    await page.click('#p2dModePreset');
    await clickPts(page, [dim[0]]);
    await expect(note).toHaveText('先に縮尺を決めてください。上の「この縮尺にする」を押すか、「図面の寸法で合わせる」に切り替えて、長さの分かっている線の両端をクリックしてください。');
    await expect(note).toHaveClass(/error/);
    await expect.poll(inView).toBe(true);
    await expect(page.locator('#p2dExportNote')).toHaveText('縮尺を合わせると保存できます。');
    // ほかのページへ写した結果も、押したボタンのすぐ下に出る。もう一度押した時の結果も同じ場所
    await page.click('#p2dApplyPreset');
    await expect(note).toBeHidden();
    await page.click('#p2dApplyAll');
    await expect(note).toContainText('縮尺が未設定だった 1 ページ(2 ページ目)に、このページの縮尺を設定しました');
    await expect(note).toHaveClass(/done/);
    await expect.poll(inView).toBe(true);
    const gap = await page.evaluate(() => document.getElementById('p2dScaleNote').getBoundingClientRect().top - document.getElementById('p2dApplyAll').getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(24);
    await page.click('#p2dApplyAll');
    await expect(note).toContainText('縮尺が未設定のページはありません');
    await expect(page.locator('#p2dExportNote')).toHaveText('Jw_cad の「ファイル」→「開く」でそのまま開けます。');   // 既定の形式は JWW
    // 確かめていない縮尺(選んだ縮尺・写した縮尺)の誤差の目安には、前提を添える
    await expect(page.locator('#p2dPrecision2')).toContainText('長さによらず 約 ±4.2mm(選んだ縮尺が正しい場合)');
    await page.click('#p2dNext');
    await page.waitForFunction(() => { const st = window.__p2dState; return st.pageIndex === 1 && !st.rendering && st.pages[1] && st.pages[1].geom; });
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100(1ページ目から写した縮尺)');
    await expect(page.locator('#p2dPrecision2')).toContainText('(写した縮尺が、このページにも合っている場合)');
    await expect(note).toBeHidden();   // ページを移ると消える
  });

  test('精度: 吸着していない点で合わせた時は、どれだけ長い寸法でも標準の縮尺を採用しない(線の途中のクリックで、0.5% 縮んだPDFを 1/100 ちょうどと取り違えない)', async ({ page }) => {
    await openApp(page);
    const LONG = 'LN(60, 550, 60 + 24800 * U, 550);';   // 用紙幅の8割を超える通し線(24,800mm)。吸着なしでも u が 0.15% を切る長さ
    // 線の両端から 14px 上(吸着範囲 10px の外)を、左右あわせて wide px だけ広めにクリックして、24,800 で合わせる
    const calibrateLoose = async (wide) => {
      await page.click('#p2dModeDim');
      const ends = await hLineAt(page, 550), ds = (await p2dState(page)).ds;
      const xs = ends.map((e) => e.x).sort((a, b) => a - b);
      await clickPts(page, [{ x: xs[0] - wide / 2 / ds, y: ends[0].y + 14 / ds }, { x: xs[1] + wide / 2 / ds, y: ends[0].y + 14 / ds }]);
      await expect(page.locator('#p2dPickInfo')).toContainText('吸い付いていない点があります');
      await expect(page.locator('#p2dShortWarn')).toBeHidden();
      await page.fill('#p2dRealLen', '24800');
      await page.click('#p2dApplyDim');
      return await calState(page);
    };
    const expectNotJudged = async (s) => {
      expect(s.cal.snapped).toBe(false);
      expect(s.cal.u).toBeLessThan(0.0015);   // 前提: 「寸法が短い」では止まらない長さ
      expect(s.cal.adopted).toBe(false);
      expect(s.cal.kind).toBe('loose');
      expect(s.k).toBeCloseTo(s.cal.real / s.cal.d, 12);   // 測った値のまま
      await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/');
      await expect(page.locator('#p2dScaleStatus')).toContainText('寸法 24,800mm で測った値');
      await expect(page.locator('#p2dScaleStatus')).not.toContainText('標準の縮尺ちょうど');
      await expect(page.locator('#p2dCalNote')).toContainText('線の端や交点に吸い付いていない点で合わせています。このため、標準の縮尺かどうか判定できません。線の端や交点をクリックして合わせ直すと、誤差が小さくなります');
      await expect(page.locator('#p2dCalNote')).not.toContainText('一致しませんでした');
      await expect(page.locator('#p2dCalToggle')).toBeHidden();
      // 誤差の目安は「長さによらず」と言い切らない(保存後の「誤差が大きい可能性があります」と食い違わない)
      await expect(page.locator('#p2dPrecision2')).toContainText('10m の長さで');
      await expect(page.locator('#p2dPrecision2')).not.toContainText('長さによらず');
      await expect(page.locator('#p2dPrecision2')).toHaveClass(/caution/);
    };
    // (1) 99.5% に縮んだPDF(本当の縮尺は 1/100.5)。3〜4px 広めに取ると、測った値が 1/100 のすぐそばに来る(以前は「1/100 ちょうど」を採用していた)
    await loadP2d(page, gridDrawing(0.995) + LONG);
    for (const wide of [3, 3.5, 4]) {
      const s = await calibrateLoose(wide);
      expect(Math.abs(s.cal.denMeasured / 100 - 1)).toBeLessThan(0.001);   // 前提: 吸着していれば採用される近さ(許容 max(1.5u, 0.03%) の内)
      await expectNotJudged(s);
    }
    // (2) 原寸のPDFを、線の途中のクリックで合わせた時も判定しない(一致したとも、しないとも言わない)
    await loadP2d(page, gridDrawing(1) + LONG);
    await expectNotJudged(await calibrateLoose(0));
    await expectNotJudged(await calibrateLoose(7));   // 手のずれで 1% 近く外れても、「一致しませんでした。…縮小されたPDFです」とは言わない
    // (3) 同じ線を、端に吸い付かせて合わせ直せば、標準の縮尺ちょうどを採用する
    await page.click('#p2dModeDim');
    await calibrateBy(page, await hLineAt(page, 550), 24800);
    const s = await calState(page);
    expect(s.cal.snapped).toBe(true);
    expect(s.cal.adopted).toBe(true);
    expect(s.k).toBeCloseTo(K100, 12);
    await expect(page.locator('#p2dCalNote')).toBeHidden();
    await expect(page.locator('#p2dPrecision2')).toContainText('長さによらず 約 ±4.2mm');
  });

  test('選び直し: 狭い窓(1000×700)で、用紙の上のほうだけが画面の下端に見えている時も、小窓と選ぶ点が画面の中に出る', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await openApp(page);
    await page.waitForFunction(() => document.body.classList.contains('guide-docked'), null, { timeout: 15_000 });
    // 10,920 の寸法線の左端のすぐ右(画面で 1px 足らず)に、寸法線と交わる短い縦線を足す(線の端・交点・縦線の両端が取り違えやすい候補になる)
    await loadP2d(page, gridDrawing(1) + 'LN(61.2, 514, 61.2, 526);');
    await setPreset(page, 100);   // 縮尺を決めると縮尺の欄が伸び、図面は下へ押し出される
    // 寸法線の左端が、画面の下端から 5px 上に来る位置までスクロールする(用紙は、上のほうの帯だけが見えている)
    const pos = await page.evaluate(() => {
      const st = window.__p2dState, pg = st.pages[st.pageIndex];
      const at = () => { const rc = document.getElementById('p2dPickLayer').getBoundingClientRect(); return { x: rc.left + 60 * st.ds, y: rc.top + (pg.geom.vpH - 520) * st.ds, top: rc.top }; };
      window.scrollBy(0, at().y - (window.innerHeight - 5));
      return at();
    });
    expect(Math.abs(pos.y - 695)).toBeLessThan(1.5);
    await page.mouse.click(pos.x, pos.y);
    const chooser = page.locator('#p2dChooser');
    await expect(chooser).toBeVisible();
    await expect(chooser).toHaveCSS('opacity', '1');
    const g = await page.evaluate(() => {
      const el = document.getElementById('p2dChooser'), ch = el.getBoundingClientRect();
      const cv = document.getElementById('p2dChooserCanvas'), cr = cv.getBoundingClientRect();
      const wrap = document.getElementById('p2dCanvasWrap').getBoundingClientRect();
      return { top: ch.top, bottom: ch.bottom, chH: ch.height, innerH: window.innerHeight, paperStrip: window.innerHeight - wrap.top,
        cands: window.__p2dState.chooser.view.map((v) => ({ x: v.x, y: v.y, sx: cr.left + v.vx, sy: cr.top + v.vy, hit: document.elementFromPoint(cr.left + v.vx, cr.top + v.vy) === cv })) };
    });
    expect(g.paperStrip).toBeLessThan(g.chH);   // 前提: 用紙の見えている高さは、小窓より低い(用紙の中には置けない)
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.innerH);   // 以前は用紙の上端に張り付いて画面の下へはみ出し、選ぶ点が1つも見えなかった
    expect(g.cands.length).toBeGreaterThanOrEqual(2);
    for (const c of g.cands) {
      expect(c.sy).toBeGreaterThan(0);
      expect(c.sy).toBeLessThan(g.innerH);
      expect(c.hit).toBe(true);   // 縮尺の欄の上に重なっても、小窓が手前にあって押せる
    }
    // 見えている候補(寸法線と縦線の交点)を、本物のマウスで選べる
    const cross = g.cands.find((c) => Math.abs(c.x - 61.2) < 0.01 && Math.abs(c.y - 520) < 0.1);
    expect(cross).toBeTruthy();
    await page.mouse.click(cross.sx, cross.sy);
    await expect(chooser).toBeHidden();
    const s = await p2dState(page);
    expect(s.picks.length).toBe(1);
    expect(s.picks[0].snapped).toBe(true);
    expect(s.picks[0].x).toBeCloseTo(61.2, 6);
  });

  test('精度: 一致しなかった時の注意は、測った値にいちばん近い標準の縮尺を例に出す。ほかのページから写した縮尺では「クリックした2点」を確かめさせない', async ({ page }) => {
    await openApp(page);
    // 1/50 の図面を 97% に縮めたPDF(用紙上の長さは 1/100 の 1.94 倍)が2ページ
    await loadP2d(page, 'for (let n = 0; n < 2; n++) {' + gridDrawing(1.94) + '}');
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    const s = await calState(page);
    expect(s.cal.kind).toBe('measured');
    expect(s.cal.nominal).toBe(50);
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/51.5(寸法 10,920mm で測った値)');
    await expect(page.locator('#p2dCalNote')).toContainText('標準の縮尺(1/50 など)とは一致しませんでした。まず、クリックした2点と入力した寸法をお確かめください。');
    await expect(page.locator('#p2dCalNote')).not.toContainText('1/100');
    await page.click('#p2dApplyAll');
    await expect(page.locator('#p2dScaleNote')).toContainText('1 ページ');
    await page.click('#p2dNext');
    await page.waitForFunction(() => { const st = window.__p2dState; return st.pageIndex === 1 && !st.rendering && st.pages[1] && st.pages[1].geom; });
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/51.5(1ページ目から写した縮尺)');
    // 写した先のページでは何もクリックしていない。確かめる相手は、このページの図面の寸法
    await expect(page.locator('#p2dCalNote')).toContainText('1ページ目で合わせた時に、標準の縮尺(1/50 など)とは一致しなかった縮尺です。測った値のまま、実寸に合わせて変換します。このページの図面にも合っているか、下の「確かめる」でお確かめください。');
    await expect(page.locator('#p2dCalNote')).not.toContainText('クリックした2点');
  });

  test('精度: 検算から「この寸法で合わせ直す」で縮尺を上書きしても、「前の縮尺に戻す」で元に戻せる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await calibrateBy(page, await hLineAt(page, 520), 10920);
    await expect(page.locator('#p2dScaleStatus')).toContainText('標準の縮尺ちょうどを採用');
    expect(await page.inputValue('#p2dRealLen')).toBe('');   // 合わせた寸法を残さない(次に合わせ直す時、別の線の寸法のまま確定できてしまうため)
    const undo = page.locator('#p2dRecalUndo');
    await expect(undo).toBeHidden();
    const dim = await hLineAt(page, 490);
    await clickPts(page, dim);
    await page.fill('#p2dCheckLen', '3700');   // 3,640 の打ち間違い
    await expect(page.locator('#p2dRecal')).toBeVisible();
    // 判定の行が出ている時に次の1点目を取っても、2点目を取るまでは縮尺の欄の高さが変わらない(図面が上へずれて、2点目のねらいが狂わないように)
    const boxH = () => page.evaluate(() => document.querySelector('#modePdf2Dxf .p2d-scale').getBoundingClientRect().height);
    const hVerdict = await boxH();
    await clickPts(page, [dim[0]]);
    await expect(page.locator('#p2dCheckVerdict')).toBeHidden();
    expect(Math.abs(await boxH() - hVerdict)).toBeLessThan(1);
    await clickPts(page, [dim[1]]);
    expect(await boxH()).toBeLessThan(hVerdict - 20);
    await page.fill('#p2dCheckLen', '3700');
    await page.click('#p2dRecal');
    await expect(page.locator('#p2dScaleStatus')).toContainText('約 1/101.');
    await expect(undo).toBeVisible();
    await expect(undo).toHaveText('前の縮尺(1/100)に戻す');
    await expect(undo).toBeFocused();
    // 検算を続けても、戻すリンクは残る
    await clickPts(page, dim);
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 3,700');
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100(寸法 10,920mm で確認。標準の縮尺ちょうどを採用)');
    await expect(page.locator('#p2dScaleNote')).toHaveText('前の縮尺(1/100)に戻しました。');
    await expect(undo).toBeHidden();
    const s = await calState(page);
    expect(s.k).toBeCloseTo(K100, 12);
    expect(s.cal.adopted).toBe(true);
    expect(s.cal.real).toBe(10920);
    await expect(page.locator('#p2dCalToggle')).toBeVisible();   // 採用と測った値の切り替えも、元どおり使える
    await clickPts(page, dim);
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 3,640');
    // 縮尺を合わせ直したら(新しい縮尺を自分で決めたら)、戻すリンクは消える
    await clickPts(page, dim);
    await page.fill('#p2dCheckLen', '3700');
    await page.click('#p2dRecal');
    await expect(undo).toBeVisible();
    await setPreset(page, 100);
    await expect(undo).toBeHidden();
  });

  // ===================== 第1段の仕上げ: 画面の低い窓・入力中の判定・表示の見直し(docs/plans/pdf2dxf-stage1-spec.md G) =====================

  test('画面の低い窓(1366×650): 読み込むと操作欄が画面の上端に来る。2点目を取ると実寸の入力欄が、縮尺を決めると縮尺の行が、画面の中に入る', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 650 });
    await openApp(page);
    await page.waitForFunction(() => document.body.classList.contains('guide-docked'), null, { timeout: 15_000 });   // ノートパソコンのふつうの状態(取説を右に開いたまま)
    await loadP2d(page, gridDrawing(1));
    const tb = await page.evaluate(() => document.querySelector('#modePdf2Dxf .redact-toolbar').getBoundingClientRect().top);
    expect(tb).toBeGreaterThanOrEqual(0);
    expect(tb).toBeLessThan(40);
    // 図面の上端が画面の上端に来るまでスクロールする(縮尺の欄は、全部が画面の上へ出る)
    await page.evaluate(() => window.scrollBy(0, document.getElementById('p2dPickLayer').getBoundingClientRect().top - 8));
    expect(await inViewport(page, '#p2dRealLen')).toBe(false);   // 前提: 入力欄は画面の外
    const dim = await hLineAt(page, 520);
    await clickPts(page, [dim[0]]);
    await scrollSettled(page);
    expect(await inViewport(page, '#p2dRealLen')).toBe(false);   // 1点目では動かさない(2点目をねらっている最中)
    await clickPts(page, [dim[1]]);
    await expect(page.locator('#p2dRealLen')).toBeFocused();
    await expect.poll(() => inViewport(page, '#p2dRealLen')).toBe(true);   // 以前は画面の外のまま(フォーカスだけが移り、どこに入力するのか見えなかった)
    await scrollSettled(page);
    expect(await inViewport(page, '#p2dPickInfo')).toBe(true);
    expect(await inViewport(page, '#p2dApplyDim')).toBe(true);
    const rowTop = await page.evaluate(() => document.getElementById('p2dRealLen').closest('.p2d-row').getBoundingClientRect().top);
    expect(rowTop).toBeGreaterThanOrEqual(15);   // 画面の端に張り付けず、16px の余白を取る

    // 入力して Enter で確定 → 入力欄と説明が隠れて縮尺の欄が縮む。縮尺の行(いまの状態)が画面の中に入る
    // (以前は縮尺の行が画面の上へ出て、先頭に見える行が「測った値を使う」のリンクになり、いまの状態のように読めた)
    // 入力欄が画面の上端に掛かる位置から始める(画面の外の入力欄に打ち始めると、ブラウザはこの位置までしか動かさない。以前はこの位置で確定することになった)
    await page.evaluate(() => window.scrollBy(0, document.getElementById('p2dRealLen').getBoundingClientRect().top + 8));
    await page.keyboard.type('10920');
    await page.keyboard.press('Enter');
    await expect(page.locator('#p2dScaleStatus')).toContainText('標準の縮尺ちょうどを採用');
    await expect.poll(() => inViewport(page, '#p2dScaleStatus')).toBe(true);
    await scrollSettled(page);
    expect(await inViewport(page, '#p2dScaleStatus')).toBe(true);

    // 「測った値を使う」のリンクが画面の先頭に来る位置で押しても、縮尺の行が見える所へ戻る
    await page.evaluate(() => window.scrollBy(0, document.getElementById('p2dCalToggle').getBoundingClientRect().top - 4));
    expect(await inViewport(page, '#p2dScaleStatus')).toBe(false);
    await page.evaluate(() => document.getElementById('p2dCalToggle').click());
    await expect(page.locator('#p2dScaleStatus')).toContainText('測った値');
    await expect.poll(() => inViewport(page, '#p2dScaleStatus')).toBe(true);
  });

  test('確かめる欄: 入力の途中では判定を出さず、縮尺の欄の高さも変えない。入力が止まってから(約0.6秒)・Enter・欄を離れた時に判定する', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await setPreset(page, 100);
    await clickPts(page, await hLineAt(page, 490));
    await expect(page.locator('#p2dCheckResult')).toContainText('この2点の実寸: 3,640');
    // 画面の中で記録する: 1文字ごとの時刻と縮尺の欄の高さ、判定の行・合わせ直しのボタンが見えた時刻
    await page.evaluate(() => {
      const v = document.getElementById('p2dCheckVerdict'), b = document.getElementById('p2dRecal'), len = document.getElementById('p2dCheckLen');
      const box = document.querySelector('#modePdf2Dxf .p2d-scale');
      const log = window.__judgeLog = { h0: box.getBoundingClientRect().height, inputs: [], shown: [], enter: [] };
      len.addEventListener('input', () => log.inputs.push({ t: performance.now(), value: len.value, h: box.getBoundingClientRect().height, verdict: v.textContent, recal: !b.hidden }));
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') log.enter.push(performance.now()); }, true);
      const rec = () => { if (v.textContent || !b.hidden) log.shown.push({ t: performance.now(), value: len.value, verdict: v.textContent, recal: !b.hidden }); };
      new MutationObserver(rec).observe(v, { childList: true, characterData: true, subtree: true });
      new MutationObserver(rec).observe(b, { attributes: true });
    });
    const log = () => page.evaluate(() => window.__judgeLog);
    const verdict = page.locator('#p2dCheckVerdict');
    await page.click('#p2dCheckLen');
    await page.keyboard.type('3640', { delay: 90 });   // 1文字ずつ
    await expect(verdict).toContainText('図面の寸法と一致しました');
    let g = await log();
    expect(g.inputs.map((i) => i.value)).toEqual(['3', '36', '364', '3640']);
    for (const i of g.inputs) {
      expect(i.verdict).toBe('');                        // 「3」「36」「364」の時点で「合いません」と言わない
      expect(i.recal).toBe(false);
      expect(Math.abs(i.h - g.h0)).toBeLessThan(1);      // 縮尺の欄の高さが、1文字ごとに跳ねない(以前は 96px)
    }
    expect(g.shown.length).toBeGreaterThan(0);
    for (const s of g.shown) expect(s.value).toBe('3640');   // 判定が出るのは、入力が終わってから
    expect(g.shown[0].t - g.inputs[3].t).toBeGreaterThanOrEqual(550);   // 最後の1文字から約 0.6 秒
    expect(g.shown.some((s) => s.recal)).toBe(false);

    // 打ち直す間は、出ていた判定を隠し、欄の高さは保つ。Enter を押すと、待たずに判定する
    await page.evaluate(() => { window.__judgeLog.inputs = []; window.__judgeLog.shown = []; window.__judgeLog.enter = []; });
    const hOk = await page.evaluate(() => document.querySelector('#modePdf2Dxf .p2d-scale').getBoundingClientRect().height);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3700', { delay: 60 });
    await page.keyboard.press('Enter');
    await expect(verdict).toContainText('mm 合いません');
    await expect(page.locator('#p2dRecal')).toBeVisible();
    g = await log();
    for (const i of g.inputs) {
      expect(i.verdict).toBe('');
      expect(i.recal).toBe(false);
      expect(Math.abs(i.h - hOk)).toBeLessThan(1);
    }
    const ng = g.shown.find((s) => s.value === '3700');
    expect(ng.t - g.enter[0]).toBeLessThan(100);   // Enter のその場で判定する(0.6 秒を待たない)

    // 欄を離れた時(Tab)も、待たずに判定する
    await page.evaluate(() => { window.__judgeLog.shown = []; });
    const left = await page.evaluate(() => {
      const len = document.getElementById('p2dCheckLen'), v = document.getElementById('p2dCheckVerdict');
      len.focus();
      len.value = '3640';
      len.dispatchEvent(new Event('input', { bubbles: true }));
      const before = v.textContent;
      len.blur();
      return { before, after: v.textContent };
    });
    expect(left.before).toBe('');
    expect(left.after).toContain('図面の寸法と一致しました');
    // 次の2点を取り始めたら、入力途中の値と判定の予約は捨てる(遅れて判定が出ない)
    await page.click('#p2dCheckLen');
    await page.keyboard.type('12');
    await clickPts(page, [(await hLineAt(page, 520))[0]]);
    await page.waitForTimeout(800);
    await expect(verdict).toBeHidden();
    expect(await page.inputValue('#p2dCheckLen')).toBe('');
  });

  test('確かめる: 図面の寸法と合わない時は、実寸の行と図面の上のラベルを成功の色(緑)で見せない。緑は「一致しました」の判定だけ', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, gridDrawing(1));
    await setPreset(page, 100);
    await clickPts(page, await hLineAt(page, 490));
    const colors = () => page.evaluate(() => {
      const cs = (el) => getComputedStyle(el).color;
      return { result: cs(document.getElementById('p2dCheckResult')), verdict: cs(document.getElementById('p2dCheckVerdict')),
        ink: cs(document.querySelector('#p2dCheck .p2d-check-text')), success: cs(document.getElementById('p2dScaleStatus')) };
    });
    let c = await colors();
    expect(c.success).not.toBe(c.ink);      // 前提: 縮尺の行(設定済み)は成功の色
    expect(c.result).toBe(c.ink);           // 実寸の行は、ふつうの文字色(測った値は、合っているとも合っていないとも言っていない)
    await expect.poll(async () => (await labelPixels(page)).green).toBeGreaterThan(20);   // 確かめ中のラベルは緑(モードの色)
    expect((await labelPixels(page)).caution).toBe(0);
    await page.click('#p2dCheckLen');
    await page.keyboard.type('3700');
    await page.keyboard.press('Enter');
    await expect(page.locator('#p2dCheckVerdict')).toHaveClass(/ng/);
    c = await colors();
    expect(c.result).toBe(c.ink);
    expect(c.verdict).not.toBe(c.success);
    await expect.poll(async () => (await labelPixels(page)).caution).toBeGreaterThan(20);   // 合わない時のラベルは注意の色
    expect((await labelPixels(page)).green).toBe(0);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3640');
    await page.keyboard.press('Enter');
    await expect(page.locator('#p2dCheckVerdict')).toHaveClass(/ok/);
    c = await colors();
    expect(c.verdict).toBe(c.success);      // 緑は「一致しました」だけ
    expect(c.result).toBe(c.ink);
    await expect.poll(async () => (await labelPixels(page)).green).toBeGreaterThan(20);
    expect((await labelPixels(page)).caution).toBe(0);
  });

  test('「短い寸法です」の注意は、縮尺の精度が実際に落ちる時だけ出す(線の位置のきざみが分かるPDFは u = q÷d > 0.05%、分からないPDFは用紙の長辺の 15% 未満)', async ({ page }) => {
    await openApp(page);
    const warn = page.locator('#p2dShortWarn');
    const pick = async (pts) => { await page.click('#p2dModeDim'); await clickPts(page, pts); await expect(page.locator('#p2dPickInfo')).toContainText('2点間: 図面上'); };
    // (1) 600dpi・1/100 の図: 8,190mm(232pt)は u = 0.12÷232 = 0.052% で注意を出し、8,645mm(245pt)は 0.049% で出さない(以前は「用紙の長辺の 25% = 210pt 未満」で決めていた)
    await loadP2d(page, gridDrawing(1));
    const U = MM / 100;
    await pick(await vLineAt(page, 60 + 10 * 910 * U));
    await expect(warn).toBeVisible();
    await expect(warn).toHaveText('短い寸法です。図面にもっと長い寸法があれば、そちらで合わせると誤差が小さくなります(このままでも合わせられます)。');
    await pick(await vLineAt(page, 60 + 11 * 910 * U));
    await expect(warn).toBeHidden();
    // (2) 線の位置が細かいPDF(刻み 0.001pt): 用紙の長辺の 9.5% しかない寸法でも、縮尺の精度は落ちないので出さない
    await loadP2d(page, fineDrawing);
    const q = await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; });
    expect(q.q).toBeCloseTo(0.001, 9);
    await pick(await hLineAt(page, 520));
    await expect(warn).toBeHidden();
    // (3) 線の位置の細かさが分からないPDF: 用紙の長辺(842pt)の 15% を境にする(150pt = 17.9% は出さず、100pt = 11.9% は出す)
    await loadP2d(page, `
      const p = doc.addPage([842, 595]);
      const LN = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
      LN(60, 520, 60 + 150.3141593, 520);
      LN(60, 480, 60 + 100.2718282, 480);
      for (let i = 0; i < 24; i++) LN(70 + i * 9.4247779, 60, 70 + i * 9.4247779, 60 + 31.41593 + i * 7.3141593);
    `);
    expect((await page.evaluate(() => { const s = window.__p2dState; return s.pages[s.pageIndex].geom.quantum; })).q).toBe(null);
    await pick(await hLineAt(page, 520));
    await expect(warn).toBeHidden();
    await pick(await hLineAt(page, 480));
    await expect(warn).toBeVisible();
  });

  test('ルーペは、クリックで点が取れる時だけ出す(「縮尺を選ぶ」で縮尺が未設定のうちは出さない。決めたら出る)', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, cornerDrawing);
    const layer = page.locator('#p2dPickLayer'), loupe = page.locator('#p2dLoupe');
    const pos = await layerPos(page, { x: 250, y: 60 }, { dx: 3, dy: -2 });
    const hovered = () => page.waitForFunction(() => { const s = window.__p2dState; return s.cursor && s.hover && s.hover.snapped; });
    await layer.hover({ position: pos });
    await hovered();
    await expect(loupe).toBeVisible();      // 合わせ中(縮尺は未設定でも、クリックで点が取れる)
    await page.click('#p2dModePreset');
    await expect(loupe).toBeHidden();
    await layer.hover({ position: pos });
    await hovered();
    await page.waitForTimeout(200);
    await expect(loupe).toBeHidden();       // クリックしても点は取れないので、ルーペも出さない
    await layer.click({ position: pos });
    await expect(page.locator('#p2dScaleNote')).toContainText('先に縮尺を決めてください');
    expect((await p2dState(page)).picks.length).toBe(0);
    await page.click('#p2dApplyPreset');
    await layer.hover({ position: pos });
    await hovered();
    await expect(loupe).toBeVisible();      // 縮尺が決まった後(確かめ中)
  });

  test('「測った値を使う」のリンクは、測った値の表示が標準の縮尺と同じになる時(約 1/100.0 と 1/100)は出さない', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, fineDrawing);
    await calibrateBy(page, await hLineAt(page, 480), 10920);
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/100(寸法 10,920mm で確認。標準の縮尺ちょうどを採用)');
    const s = await calState(page);
    expect(s.cal.adopted).toBe(true);
    expect(s.cal.denMeasured.toFixed(1)).toBe('100.0');
    await expect(page.locator('#p2dCalToggle')).toBeHidden();
    await expect(page.locator('#p2dPrecision')).toHaveText('精度の目安: 線の位置は十分に細かく記録されたPDFです(実寸で 0.05mm 未満のきざみ)。');
  });

  test('座標の刻みの推定: mm の格子の候補(用紙上 0.1mm・0.01mm)は倍数へ広げない(5mm・10mm の切りのよい寸法で設計した図面を、粗く記録されたPDFと言わない)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const f = window.__p2dTest.estimateQuantum, pc = window.__p2dTest.precisionClass, MMPT = 72 / 25.4, K = 25.4 / 72 * 100;
      let seed = 1105;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
      const mod = (n, stepMm) => Array.from({ length: n }, () => (1 + Math.floor(rnd() * 400)) * stepMm * MMPT);   // 用紙上 stepMm の倍数の差
      const res = { m10: f(mod(600, 0.1)), m20: f(mod(600, 0.2)), m50: f(mod(600, 0.5)), m5: f(mod(600, 0.05)), m1: f(mod(600, 0.01)),
        dpi400: f(Array.from({ length: 600 }, () => (1 + Math.floor(rnd() * 400)) * (72 / 400))) };
      res.m5g = res.m5.q * K;
      res.m5cls = pc(res.m5, K);
      return res;
    });
    const MMPT = 72 / 25.4;
    // 1/100 で実寸 10mm の倍数(用紙上 0.1mm の倍数)に揃った図面: 刻みは、用紙上 0.1mm まで(20mm・50mm の倍数に揃っていても、それ以上には広げない)
    expect(r.m10.q).toBeCloseTo(0.1 * MMPT, 9);
    expect(r.m20.q).toBeCloseTo(0.1 * MMPT, 9);   // 以前は 0.2mm(実寸 20mm きざみ)と言っていた
    expect(r.m50.q).toBeCloseTo(0.1 * MMPT, 9);   // 50mm の倍数に揃っていても同じ
    // 実寸 5mm の倍数(用紙上 0.05mm): 0.01mm の候補のまま。0.05mm(実寸 5mm きざみ)とは言わない
    expect(r.m5.q).toBeCloseTo(0.01 * MMPT, 9);
    expect(r.m5.unknown).toBe(false);
    expect(r.m5g).toBeCloseTo(1, 6);
    expect(r.m5cls).toBe('grid');
    expect(r.m1.q).toBeCloseTo(0.01 * MMPT, 9);
    // dpi の候補は、これまでどおり倍数も探す(400dpi = 0.18pt = 0.06pt の3倍)
    expect(r.dpi400.q).toBeCloseTo(0.18, 6);
  });
});

// ---- 第2段: JWW 書き出し(Jw_cad の線色1〜8・線種1〜8をそのまま持つ図面ファイル) ----
test.describe('図面変換: JWW 書き出し', () => {

  /** いまのページを JWW にして、読み直した中身を返す(保存の操作を通さずに中身だけ見る) */
  const jwwDoc = (page) => page.evaluate(() => {
    const r = window.__p2dTest.buildJww();
    const doc = window.P2D.jwwWriter.parseJww(r.bytes);
    const idx = doc.header.index;
    const kinds = {}, pens = {}, styles = {}, layers = {};
    for (const e of doc.entities) {
      kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      pens[e.pen_color] = (pens[e.pen_color] || 0) + 1;
      layers[e.glayer + '-' + e.layer] = (layers[e.glayer + '-' + e.layer] || 0) + 1;
      if (e.kind === 'line' || e.kind === 'arc') styles[e.pen_style] = (styles[e.pen_style] || 0) + 1;
    }
    const names = [];
    for (let g = 0; g < 16; g++) for (const v of idx.get('lay_names_' + g).vals) if (v) names.push(v);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of doc.entities) {
      const xs = [], ys = [];
      if (e.kind === 'line' || e.kind === 'text') { xs.push(e.x1, e.x2); ys.push(e.y1, e.y2); }
      else if (e.kind === 'arc') { xs.push(e.cx - e.radius, e.cx + e.radius); ys.push(e.cy - e.radius, e.cy + e.radius); }
      for (const v of xs) { x0 = Math.min(x0, v); x1 = Math.max(x1, v); }
      for (const v of ys) { y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
    }
    return {
      bytes: r.bytes.length, version: doc.header.version, trailing: doc.trailingBytes, entities: doc.entities.length,
      kinds, pens, styles, layers, names, bbox: [x0, y0, x1, y1],
      paper: idx.get('paper_size').vals[0], scale0: idx.get('scale_0').vals[0], scale15: idx.get('scale_15').vals[0],
      bairitsu: idx.get('bairitsu').vals[0], genten: idx.get('genten').vals, memo: idx.get('memo').vals[0],
      palette1: (() => { const c = idx.get('pen_color_1').vals[0]; return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]; })(),
      info: { paperCode: r.info.paperCode, headerScale: r.info.headerScale, colorMode: r.info.colorMode },
      texts: doc.entities.filter((e) => e.kind === 'text').map((e) => ({ s: e.text, pen: e.pen_color })),
    };
  });
  const setColor = (page, v) => page.evaluate((m) => {
    const s = document.getElementById('p2dColorMode');
    s.value = m; s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  /** ひな形の登録と同じ道すじ(file input へ流し込む) */
  const feedTemplate = (page, name) => page.evaluate((n) => {
    const dt = new DataTransfer();
    dt.items.add(new File([window.__tmplBytes], n, { type: 'application/octet-stream' }));
    const inp = document.getElementById('p2dTmplInput');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, name);

  test('JWWで保存すると、Ver700・読み残し0で、線色1〜8・線種・レイヤ名「線」「円」「文字」・用紙A3・縮尺1/100 ちょうどが入る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([1191, 842]);
      const g = (n) => Math.round(n / 0.12) * 0.12;   // 600dpi の格子に乗せる
      const L = (x1, y1, x2, y2, col, d) => p.drawLine({ start: { x: g(x1), y: g(y1) }, end: { x: g(x2), y: g(y2) }, thickness: 0.3, color: col || PL.rgb(0, 0, 0), dashArray: d });
      const X = 120, Y = 120, W = 283.44, H = 226.8;
      L(X, Y, X + W, Y); L(X, Y + H, X + W, Y + H); L(X, Y, X, Y + H); L(X + W, Y, X + W, Y + H);
      L(X + 40, Y, X + 40, Y + H, PL.rgb(1, 0, 0));                 // 赤 → 線色8
      L(X + 80, Y, X + 80, Y + H, PL.rgb(0, 0, 1));                 // 青 → 線色6
      L(X, Y + 60, X + W, Y + 60, PL.rgb(0, 0.75, 0.75), [4, 2]);   // 水色の破線 → 線色5・線種3
      L(X, Y + 90, X + W, Y + 90, PL.rgb(1, 1, 0));                 // 黄の実線 → 線色2
      for (let i = 1; i < 9; i++) L(X + i * 30, Y, X + i * 30, Y + 12);       // 目盛り(座標の刻みを推定できるだけの線の数にする)
      for (let i = 1; i < 7; i++) L(X, Y + i * 30, X + 12, Y + i * 30);
      p.drawCircle({ x: g(X + 100), y: g(Y + 100), size: g(12), borderWidth: 0.3, borderColor: PL.rgb(0, 0, 0) });
      p.drawText('LDK', { x: g(X + 20), y: g(Y + 150), size: 7, font, color: PL.rgb(0, 0, 0) });
    `);
    await setOutFmt(page, 'jww');
    await calibrateBy(page, [{ x: 120, y: 120 }, { x: 403.44, y: 120 }], 10000);   // 1/100 ちょうどを採用する寸法
    expect((await calState(page)).cal.adopted).toBe(true);
    const d = await jwwDoc(page);
    expect(d.version).toBe(700);
    expect(d.trailing).toBe(0);                       // 読み残し 0 バイト
    expect(d.paper).toBe(3);                          // A3
    expect(d.scale0).toBe(100);                       // 99.99999… ではなく 100 ちょうど
    expect(d.scale15).toBe(100);                      // レイヤグループ 16 個すべてに入る
    expect(d.bairitsu).toBe(1);                       // 開いた時に用紙全体が見える
    expect(d.genten).toEqual([0, 0]);
    expect(d.names).toEqual(['線', '円', '文字']);
    expect(d.layers['0-1']).toBe(1);                  // 円はレイヤ0-1
    expect(d.layers['0-2']).toBe(1);                  // 文字はレイヤ0-2
    // 線色(白背景用の対応表): 赤→8、青→6、水色の破線→5、黄の実線→2。1〜8 の外(SXF色・補助線色)は使わない
    expect(d.pens['8']).toBe(1);
    expect(d.pens['6']).toBe(1);
    expect(d.pens['5']).toBe(1);
    expect(Object.keys(d.pens).every((p) => Number(p) >= 1 && Number(p) <= 8)).toBe(true);
    expect(d.styles['3']).toBe(1);                    // 破線 = 線種3
    expect(Object.keys(d.styles).every((s) => Number(s) >= 1 && Number(s) <= 8)).toBe(true);
    expect(d.kinds.arc).toBe(1);                      // 円は円のデータ(折れ線にしない)
    expect(d.texts.length).toBe(1);
    expect(d.texts[0].s).toBe('LDK');
    expect(d.texts[0].pen).toBe(2);                   // 文字は常に線色2
    // 図寸: 四角の横 = 実寸 10,000mm ÷ 100 = 100mm。ぴったり 100 にならないのは、クリックした2点が用紙上 283.44pt = 99.991mm しか離れていないため
    //   (標準の縮尺ちょうどを採用するので、縮尺の側ではなく、座標の丸めの分 0.9mm が実寸に残る。第1段の「精度の目安」で出している床そのもの)
    expect(d.bbox[2] - d.bbox[0]).toBeCloseTo(99.991, 2);
    // 用紙(A3 = 420×297)の中に入る
    expect(d.bbox[0]).toBeGreaterThanOrEqual(-210);
    expect(d.bbox[2]).toBeLessThanOrEqual(210);
    expect(d.bbox[1]).toBeGreaterThanOrEqual(-148.5);
    expect(d.bbox[3]).toBeLessThanOrEqual(148.5);
  });

  test('縦向きのページは一回り大きい用紙になる(Jw_cad の用紙は横置きしか無い)。図形は用紙からはみ出さない', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([595.28, 841.89]);   // A4 縦(210×297mm)
      const L = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
      L(6, 6, 589, 6); L(6, 836, 589, 836); L(6, 6, 6, 836); L(589, 6, 589, 836);   // 用紙いっぱいに近い枠
      L(6, 420, 589, 420);
    `);
    await setOutFmt(page, 'jww');
    await setPreset(page, 100);
    const d = await jwwDoc(page);
    expect(d.paper).toBe(3);        // A4縦(210×297)は A4(297×210)に入らない → A3(420×297)
    expect(d.entities).toBe(5);
    expect(d.bbox[0]).toBeGreaterThanOrEqual(-210);
    expect(d.bbox[2]).toBeLessThanOrEqual(210);
    expect(d.bbox[1]).toBeGreaterThanOrEqual(-148.5);
    expect(d.bbox[3]).toBeLessThanOrEqual(148.5);
    // 用紙の選び方そのもの(幅と高さを入れ替えない。入れ替えていた時は A4縦に A4 を選び、必ず検査で止まっていた)
    const codes = await page.evaluate(() => {
      const P = window.P2D.primsToJww;
      return [P.choosePaperCode(297, 210), P.choosePaperCode(210, 297), P.choosePaperCode(420, 297), P.choosePaperCode(297, 420), P.choosePaperCode(1189, 841)];
    });
    expect(codes).toEqual([4, 3, 3, 2, 0]);
  });

  test('線の色は2種類から選べる。「元の図面に近い色」にすると、黄・緑・水色が元の色の線色になる。選んだ色は覚えている', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([1191, 842]);
      const L = (x1, y1, x2, y2, col) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.3, color: col });
      L(100, 100, 400, 100, PL.rgb(1, 1, 0));        // 黄
      L(100, 130, 400, 130, PL.rgb(0, 1, 0));        // 緑
      L(100, 160, 400, 160, PL.rgb(0, 0.75, 0.75));  // 水色
      L(100, 190, 400, 190, PL.rgb(1, 0, 0));        // 赤
    `);
    await setOutFmt(page, 'jww');
    await setPreset(page, 100);
    const white = await jwwDoc(page);
    expect(white.info.colorMode).toBe('white');
    expect(white.pens['2']).toBe(3);     // 黄・緑・水色の実線 → 全部 線色2(黒)
    expect(white.pens['8']).toBe(1);     // 赤 → 線色8
    await setColor(page, 'original');
    const orig = await jwwDoc(page);
    expect(orig.info.colorMode).toBe('original');
    expect(orig.pens['4']).toBe(1);      // 黄 → 線色4
    expect(orig.pens['3']).toBe(1);      // 緑 → 線色3
    expect(orig.pens['1']).toBe(1);      // 水色 → 線色1
    expect(orig.pens['8']).toBe(1);      // 赤 → 線色8
    await page.reload();
    await page.waitForFunction(() => window.PDFLib && window.pdfjsLib);
    await gotoTab(page, 'pdf2dxf');
    expect(await page.evaluate(() => document.getElementById('p2dColorMode').value)).toBe('original');
  });

  test('ひな形を登録すると、その図面のメモ・レイヤ名は持ち越さず、線色の設定だけが入る。Ver700 以外は理由を付けて断る', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([1191, 842]);
      p.drawLine({ start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
    `);
    await setOutFmt(page, 'jww');
    await setPreset(page, 100);
    // 「利用者が自分の Jw_cad で保存した図面」に見立てたファイルを作る(現場名のメモ・レイヤ名・自分の画面の線色つき)
    const made = await page.evaluate(() => {
      const W = window.P2D.jwwWriter, T = window.P2D.jwwTemplate;
      const t = W.loadTemplate(T.builtinTemplate());
      const patch = new Map();
      patch.set('memo', ['現場名: ○○邸 新築工事']);
      const names = t.index.get('lay_names_0').vals.slice();
      names[0] = '通り芯'; names[1] = '仕上げ';
      patch.set('lay_names_0', names);
      patch.set('pen_color_1', [0x00070707]);   // 線色1 の画面色を変える(登録側の設定が生きているかの目印)
      window.__tmplBytes = W.buildJww(t, patch, [], { stringUnicode: false, classSchema: 700 });
      return window.__tmplBytes.length;
    });
    expect(made).toBeGreaterThan(14000);
    await feedTemplate(page, 'watashi_no_settei.jww');
    await expect(page.locator('#p2dTmplState')).toContainText('watashi_no_settei.jww');
    await expect(page.locator('#p2dTmplClear')).toBeVisible();
    const d = await jwwDoc(page);
    expect(d.names).toEqual(['線']);                     // 登録した図面のレイヤ名(通り芯・仕上げ)は入らない
    expect(d.memo).toBe(String.fromCharCode(13, 10));    // メモ(現場名)も入らない
    expect(d.palette1).toEqual([7, 7, 7]);               // 登録したひな形の画面の線色は、そのまま書き出しに入る
    // 標準に戻す
    await page.evaluate(() => document.getElementById('p2dTmplClear').click());
    await expect(page.locator('#p2dTmplState')).toContainText('いまのひな形: 標準');
    expect((await jwwDoc(page)).palette1).toEqual([0, 192, 192]);
    // Ver700 でないファイルは断る(断った後も、いまの設定は壊さない)
    await page.evaluate(() => {
      const bad = new Uint8Array(200), magic = 'JwwData.';
      for (let i = 0; i < 8; i++) bad[i] = magic.charCodeAt(i);
      bad[8] = 0x6C; bad[9] = 0x02;   // Ver620
      window.__tmplBytes = bad;
    });
    await feedTemplate(page, 'furui.jww');
    await expect(page.locator('#p2dExportNote')).toContainText('ひな形にできません');
    await expect(page.locator('#p2dTmplState')).toContainText('いまのひな形: 標準');
  });

  test('保存: ファイル名は .jww、形式の選択は覚えていて、全ページ保存(ZIP)も .jww になる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      for (let i = 0; i < 2; i++) {
        const p = doc.addPage([1191, 842]);
        p.drawLine({ start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
        p.drawLine({ start: { x: 100, y: 100 }, end: { x: 100, y: 300 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
      }
    `);
    await setOutFmt(page, 'jww');
    await setPreset(page, 100);
    expect(await page.locator('#p2dExportBtn').textContent()).toContain('JWWに変換して保存');
    await armCapture(page);
    const name = await page.evaluate(() => {
      const prev = HTMLAnchorElement.prototype.click;
      let got = '';
      HTMLAnchorElement.prototype.click = function () { got = this.download || ''; };
      document.getElementById('p2dExportBtn').click();
      HTMLAnchorElement.prototype.click = prev;
      return got;
    });
    expect(name).toMatch(/^JWW変換_[0-9]{8}_01[.]jww$/);
    const i = await waitCapture(page, 'JwwD');   // JWW は「JwwData.」で始まる
    expect(await page.evaluate((k) => window.__caps[k].size, i)).toBeGreaterThan(14000);
    await expect(page.locator('#p2dExportNote')).toContainText('用紙 A3 ・ 縮尺 1/100 ・ レイヤは');
    // 全ページ(ZIP)の中身も .jww
    await page.evaluate(() => document.getElementById('p2dApplyAll').click());
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('p2dExportAllBtn').click());
    const zi = await waitCapture(page, 'PK');
    const files = await page.evaluate(async (k) => {
      const z = await window.JSZip.loadAsync(window.__caps[k].bytes);
      return Object.keys(z.files).sort();
    }, zi);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith('.jww'))).toBe(true);
    // 形式は覚えている
    await page.reload();
    await page.waitForFunction(() => window.PDFLib && window.pdfjsLib);
    await gotoTab(page, 'pdf2dxf');
    expect(await page.locator('#p2dFmtJww').getAttribute('class')).toContain('active');
    expect(await page.locator('#p2dExportBtn').textContent()).toContain('JWWに変換して保存');
  });

  test('DXF を選べば今までどおり DXF が出て、説明も切り替わる', async ({ page }) => {
    await openApp(page);
    await loadP2d(page, `
      const p = doc.addPage([1191, 842]);
      p.drawLine({ start: { x: 100, y: 100 }, end: { x: 400, y: 100 }, thickness: 0.3, color: PL.rgb(0, 0, 0) });
    `);
    await setOutFmt(page, 'dxf');
    await expect(page.locator('#p2dJwwOpts')).toBeHidden();
    await expect(page.locator('#p2dFmtHint')).toContainText('SXF対応拡張線色');
    await setPreset(page, 100);
    expect(await page.locator('#p2dExportBtn').textContent()).toContain('DXFに変換して保存');
    const idx = await exportDxf(page);
    expect(await page.evaluate((k) => window.__caps[k].size, idx)).toBeGreaterThan(200);
    await setOutFmt(page, 'jww');
    await expect(page.locator('#p2dJwwOpts')).toBeVisible();
    await expect(page.locator('#p2dFmtHint')).toContainText('線色1〜8');
  });

  test('このブラウザの Shift_JIS の表が Python の cp932 と同じ(違えば書き出しを止める)', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    const r = await page.evaluate(() => {
      const W = window.P2D.jwwWriter;
      return { ok: W.cp932SelfCheck(), fp: W.cp932Fingerprint(), want: W.CP932_FINGERPRINT };
    });
    expect(r.ok).toBe(true);
    expect(r.fp).toBe(r.want);
  });
});

// ---- 第3段: DXF を入力にする(メーカー提供の DXF を、そのまま Jw_cad で開ける形に) ----
test.describe('図面変換: DXF の読み込み', () => {
  const NL2 = String.fromCharCode(13, 10);
  /** テスト用の小さな DXF(外形の四角・破線・円・円弧・文字・自由曲線・楕円)。実寸 1000×600mm */
  function makeDxf() {
    const o = [];
    const P = (c, v) => { o.push(String(c)); o.push(String(v)); };
    P(0, 'SECTION'); P(2, 'ENTITIES');
    P(0, 'LINE'); P(8, 'OUTER'); P(62, 1); P(10, 0); P(20, 0); P(11, 1000); P(21, 0);
    P(0, 'LINE'); P(8, 'OUTER'); P(62, 1); P(10, 1000); P(20, 0); P(11, 1000); P(21, 600);
    P(0, 'LINE'); P(8, 'OUTER'); P(62, 1); P(10, 1000); P(20, 600); P(11, 0); P(21, 600);
    P(0, 'LINE'); P(8, 'OUTER'); P(62, 1); P(10, 0); P(20, 600); P(11, 0); P(21, 0);
    P(0, 'LINE'); P(8, 'HIDDEN'); P(62, 5); P(6, 'DASHED'); P(10, 0); P(20, 300); P(11, 1000); P(21, 300);
    P(0, 'CIRCLE'); P(8, 'PARTS'); P(62, 3); P(10, 250); P(20, 300); P(40, 120);
    P(0, 'ARC'); P(8, 'PARTS'); P(62, 3); P(10, 750); P(20, 300); P(40, 120); P(50, 0); P(51, 90);
    P(0, 'TEXT'); P(8, 'MOJI'); P(62, 7); P(10, 100); P(20, 480); P(40, 40); P(1, 'TEST');
    // 自由曲線(3次・制御点4個)と楕円。どちらも Jw_cad はそのままでは読めない
    P(0, 'SPLINE'); P(8, 'OUTER'); P(62, 1); P(70, 8); P(71, 3); P(72, 8); P(73, 4); P(74, 0);
    for (const k of [0, 0, 0, 0, 1, 1, 1, 1]) P(40, k);
    for (const c of [[100, 100], [300, 250], [700, 40], [900, 200]]) { P(10, c[0]); P(20, c[1]); }
    P(0, 'ELLIPSE'); P(8, 'PARTS'); P(62, 3); P(10, 500); P(20, 150); P(11, 150); P(21, 0); P(40, 0.5); P(41, 0); P(42, 6.283185307179586);
    P(0, 'ENDSEC'); P(0, 'EOF');
    return o.join(NL2) + NL2;
  }
  /** DXF を図面変換タブに読み込ませる */
  async function loadDxfIn(page, text, name) {
    await gotoTab(page, 'pdf2dxf');
    await page.evaluate((a) => {
      const b = new Uint8Array(a.t.length);
      for (let i = 0; i < a.t.length; i++) b[i] = a.t.charCodeAt(i) & 0xFF;
      const inp = document.getElementById('p2dFileInput'), dt = new DataTransfer();
      dt.items.add(new File([b], a.n, { type: 'application/octet-stream' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, { t: text, n: name || 'part.dxf' });
    await page.waitForFunction(() => { const s = window.__p2dState; return s && s.pdf && !s.rendering && s.pages[0] && s.pages[0].geom; }, null, { timeout: 60_000 });
    await page.waitForTimeout(300);
  }
  const jwwOf = (page) => page.evaluate(() => {
    const doc = window.P2D.jwwWriter.parseJww(window.__lastJww);
    const idx = doc.header.index, pens = {}, kinds = {}, styles = {};
    for (const e of doc.entities) {
      pens[e.pen_color] = (pens[e.pen_color] || 0) + 1;
      kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      if (e.kind === 'line' || e.kind === 'arc') styles[e.pen_style] = (styles[e.pen_style] || 0) + 1;
    }
    const names = [];
    for (let g = 0; g < 16; g++) for (const v of idx.get('lay_names_' + g).vals) if (v) names.push(v);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of doc.entities) {
      if (e.kind !== 'line') continue;
      x0 = Math.min(x0, e.x1, e.x2); x1 = Math.max(x1, e.x1, e.x2);
      y0 = Math.min(y0, e.y1, e.y2); y1 = Math.max(y1, e.y1, e.y2);
    }
    return { version: doc.header.version, trailing: doc.trailingBytes, entities: doc.entities.length,
      paper: idx.get('paper_size').vals[0], scale: idx.get('scale_0').vals[0], pens, kinds, styles, names,
      lineBox: [x0, y0, x1, y1] };
  });
  /** 保存ボタンを押して、出たバイト列を window.__lastJww に取り込む */
  async function saveAndGrab(page, fmt) {
    await setOutFmt(page, fmt);
    await page.evaluate(() => {
      window.__lastJww = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (b) { b.arrayBuffer().then((buf) => { window.__lastJww = new Uint8Array(buf); }); return orig(b); };
      HTMLAnchorElement.prototype.click = function () {};
      document.getElementById('p2dExportBtn').click();
    });
    await page.waitForFunction(() => !!window.__lastJww, null, { timeout: 30_000 });
  }

  test('DXFを読み込むと、実寸のまま取り込んで縮尺を自動で決める。縮尺を合わせる手順は出さない', async ({ page }) => {
    await openApp(page);
    await loadDxfIn(page, makeDxf());
    // 縮尺を合わせる手順(寸法2点)は出さない。DXF 用の案内と、縮尺のプルダウンだけ
    await expect(page.locator('#p2dDxfHint')).toBeVisible();
    await expect(page.locator('#p2dDxfHint')).toContainText('実寸のデータなので、縮尺を合わせる必要はありません');
    expect(await page.evaluate(() => document.getElementById('p2dModeDim').parentElement.hidden)).toBe(true);
    await expect(page.locator('#p2dPresetHint')).toBeHidden();   // 縮んだPDFの話は DXF には出さない
    // 1000×600mm が A3(図枠つきなので余白3mm)に収まる最小の分母 = 5。プルダウンに無い値でも選べるように足す
    expect(await page.evaluate(() => window.__p2dTest.dxfIn().den)).toBe(5);
    expect(await page.evaluate(() => document.getElementById('p2dPreset').value)).toBe('5');
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/5');
    // 精度の目安は DXF 用の文(線の位置の丸めが無い)
    await expect(page.locator('#p2dPrecision')).toContainText('DXFは実寸の図形データなので、線の位置の読み取り誤差はありません');
    await expect(page.locator('#p2dPrecision2')).toContainText('曲線を円弧や折れ線に置き換えた分');
    // Jw_cad が読めない曲線(自由曲線・楕円)は、細かい線に置き換わっている
    const g = await page.evaluate(() => { const gg = window.__p2dState.pages[0].geom; return { lines: gg.lines.length, circles: gg.circles.length, arcs: gg.arcs.length, texts: gg.texts.length }; });
    expect(g.lines).toBeGreaterThan(500);
    expect(g.circles).toBe(1);
    expect(g.arcs).toBe(1);
    expect(g.texts).toBe(1);
    const r = await page.evaluate(() => window.__p2dTest.dxfIn().report);
    expect(r.curves).toBe(2);                       // SPLINE と ELLIPSE
    expect(r.worstDeviation).toBeLessThan(0.006);   // 置き換えのズレは 0.006mm 未満
    expect(Object.keys(r.skipped).length).toBe(0);
    // 複数ページの操作は出さない(DXF は1枚)
    await expect(page.locator('#p2dExportAllBtn')).toBeHidden();
    await expect(page.locator('#p2dApplyAll')).toBeHidden();
  });

  test('DXF由来のJWW: 元のレイヤ名がそのまま入り、用紙A3・自動で決めた縮尺・線色1〜8になる', async ({ page }) => {
    await openApp(page);
    await loadDxfIn(page, makeDxf());
    await saveAndGrab(page, 'jww');
    const d = await jwwOf(page);
    expect(d.version).toBe(700);
    expect(d.trailing).toBe(0);
    expect(d.paper).toBe(3);                      // A3
    expect(d.scale).toBe(5);                      // 自動で決めた 1/5
    expect(d.names).toEqual(['OUTER', 'HIDDEN', 'PARTS', 'MOJI']);   // 元の図面のレイヤ名を、出てきた順に
    expect(Object.keys(d.pens).every((p) => Number(p) >= 1 && Number(p) <= 8)).toBe(true);
    expect(d.pens['8']).toBeGreaterThan(0);       // 赤 → 線色8
    expect(d.styles['3']).toBe(1);                // 破線 → 線種3
    expect(d.kinds.text).toBe(1);
    // 図寸: 1000mm ÷ 5 = 200mm。用紙(A3 = 420×297)の中に収まる
    expect(d.lineBox[2] - d.lineBox[0]).toBeCloseTo(200, 1);
    expect(d.lineBox[0]).toBeGreaterThanOrEqual(-210);
    expect(d.lineBox[2]).toBeLessThanOrEqual(210);
    expect(d.lineBox[1]).toBeGreaterThanOrEqual(-148.5);
    expect(d.lineBox[3]).toBeLessThanOrEqual(148.5);
    await expect(page.locator('#p2dExportNote')).toContainText('用紙 A3 ・ 縮尺 1/5 ・ レイヤは元の図面のレイヤ名のまま');
    await expect(page.locator('#p2dExportNote')).toContainText('Jw_cad が読めない曲線');
  });

  test('DXF由来のDXF保存: 実寸のまま出て、Jw_cad が読めない曲線は線に置き換わっている', async ({ page }) => {
    await openApp(page);
    await loadDxfIn(page, makeDxf());
    await saveAndGrab(page, 'dxf');
    const r = await page.evaluate(() => {
      const b = window.__lastJww;
      let s = '';
      for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      const L = s.split(String.fromCharCode(13, 10));
      const kinds = {};
      for (let i = 0; i + 1 < L.length; i += 2) if (L[i].trim() === '0') kinds[L[i + 1]] = (kinds[L[i + 1]] || 0) + 1;
      // 実寸のまま: 外形の右下の角(1000, 0)がそのまま入っている
      return { kinds, hasSpline: /SPLINE/.test(s), hasEllipse: /ELLIPSE/.test(s), real: s.indexOf('1000.0') >= 0 || s.indexOf(String.fromCharCode(13, 10) + '1000' + String.fromCharCode(13, 10)) >= 0, size: b.length };
    });
    expect(r.hasSpline).toBe(false);     // 自由曲線は残さない(Jw_cad が黙って飛ばすため)
    expect(r.hasEllipse).toBe(false);
    expect(r.kinds.LINE).toBeGreaterThan(500);
    expect(r.kinds.CIRCLE).toBe(1);
    expect(r.kinds.ARC).toBe(1);
    expect(r.kinds.TEXT).toBe(1);
    expect(r.real).toBe(true);
    await expect(page.locator('#p2dExportNote')).toContainText('実寸のまま、Jw_cad の「ファイル」→「DXFファイルを開く」で開けます');
  });

  test('縮尺を選び直すと、用紙の中の大きさが変わる(画面の表示と保存の中身がずれない)', async ({ page }) => {
    await openApp(page);
    await loadDxfIn(page, makeDxf());
    await page.evaluate(() => {
      document.getElementById('p2dPreset').value = '10';
      document.getElementById('p2dApplyPreset').click();
    });
    await page.waitForFunction(() => window.__p2dTest.dxfIn().den === 10 && !window.__p2dState.rendering, null, { timeout: 30_000 });
    await expect(page.locator('#p2dScaleStatus')).toContainText('1/10');
    await saveAndGrab(page, 'jww');
    const d = await jwwOf(page);
    expect(d.scale).toBe(10);
    expect(d.lineBox[2] - d.lineBox[0]).toBeCloseTo(100, 1);   // 1000mm ÷ 10 = 100mm
  });

  test('DXFでないファイル・壊れたDXFは、理由を表示して断る', async ({ page }) => {
    await openApp(page);
    await gotoTab(page, 'pdf2dxf');
    await page.evaluate(() => {
      const b = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);   // ZIP の先頭(DXF ではない)
      const inp = document.getElementById('p2dFileInput'), dt = new DataTransfer();
      dt.items.add(new File([b], 'not-a-drawing.dxf', { type: 'application/octet-stream' }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#p2dLoadMsg')).toContainText('DXFの読み込みに失敗しました');
    await expect(page.locator('#p2dEditor')).not.toHaveClass(/active/);
  });
});
