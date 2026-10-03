// 検証者VUX(画面の目視確認)の一時スペック。終わったら削除する。図面はすべてテスト内で自作。VUX_SHOTS が無い時は何も定義しない
const { test } = require('@playwright/test');
const { openApp, gotoTab, armCapture } = require('./helpers');
const fs = require('fs');

const SHOTS = process.env.VUX_SHOTS;
const ONLY = process.env.VUX_ONLY || '';
const MM = 72 / 25.4;
const NL = String.fromCharCode(10);

const planBody = (o) => {
  o = o || {};
  const shrink = o.shrink || 1, PW = o.pw || 1191, PH = o.ph || 842, den = o.den || 100, dpi = o.dpi || 600;
  return `
  {
    const Q = 72 / ${dpi}, R = (v) => ${o.fine ? 'v' : 'Math.round(v / Q) * Q'};
    const U = ${MM} / ${den} * ${shrink};
    const p = doc.addPage([${PW}, ${PH}]);
    const K = PL.rgb(0, 0, 0);
    const LN = (x1, y1, x2, y2, t) => p.drawLine({ start: { x: R(x1), y: R(y1) }, end: { x: R(x2), y: R(y2) }, thickness: t || 0.3, color: K });
    const X0 = ${o.x0 || 200}, Y0 = ${o.y0 || 200}, BW = ${o.bw || 10920}, BH = 7280;
    const NX = Math.round(BW / 910), NY = 8;
    const Yd1 = Y0 + (BH + 1500) * U, Yd2 = Y0 + (BH + 1000) * U, Yb = Y0 - 900 * U, Xd = X0 - 1500 * U;
    for (let i = 0; i <= NX; i++) LN(X0 + i * 910 * U, Yb - 400 * U, X0 + i * 910 * U, Yd1 + 400 * U, 0.12);
    for (let j = 0; j <= NY; j++) LN(Xd - 400 * U, Y0 + j * 910 * U, X0 + (BW + 500) * U, Y0 + j * 910 * U, 0.12);
    const BOX = (a, b, c, d, t) => { LN(a, b, c, b, t); LN(c, b, c, d, t); LN(c, d, a, d, t); LN(a, d, a, b, t); };
    BOX(X0 - 60 * U, Y0 - 60 * U, X0 + (BW + 60) * U, Y0 + (BH + 60) * U, 0.5);
    BOX(X0 + 60 * U, Y0 + 60 * U, X0 + (3640 - 60) * U, Y0 + (3640 - 60) * U, 0.5);
    BOX(X0 + (3640 + 60) * U, Y0 + 60 * U, X0 + (BW - 60) * U, Y0 + (3640 - 60) * U, 0.5);
    BOX(X0 + 60 * U, Y0 + (3640 + 60) * U, X0 + (BW - 60) * U, Y0 + (BH - 60) * U, 0.5);
    LN(X0, Yd1, X0 + BW * U, Yd1);
    for (let s = 0; s < 3; s++) LN(X0 + s * 3640 * U, Yd2, X0 + (s + 1) * 3640 * U, Yd2);
    for (let s = 0; s < 4; s++) LN(X0 + s * 910 * U, Yb, X0 + (s + 1) * 910 * U, Yb);
    LN(Xd, Y0, Xd, Y0 + BH * U);
    p.drawText('10,920', { x: X0 + BW * U / 2 - 9, y: Yd1 + 2, size: 5, font, color: K });
    for (let s = 0; s < 3; s++) p.drawText('3,640', { x: X0 + (s + 0.5) * 3640 * U - 7, y: Yd2 + 2, size: 5, font, color: K });
    for (let s = 0; s < 4; s++) p.drawText('910', { x: X0 + (s + 0.5) * 910 * U - 4, y: Yb + 2, size: 4, font, color: K });
    ${o.noCircle ? '' : `
    const cx = X0 + 5005 * U, cy = Y0 + 1365 * U, r = 300 * U, ops = [PL.setLineWidth(0.3)];
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2, b = (i + 1) * Math.PI / 2, k = 4 / 3 * Math.tan((b - a) / 4) * r;
      const ax = cx + r * Math.cos(a), ay = cy + r * Math.sin(a), bx = cx + r * Math.cos(b), by = cy + r * Math.sin(b);
      if (i === 0) ops.push(PL.moveTo(R(ax), R(ay)));
      ops.push(PL.appendBezierCurve(R(ax - k * Math.sin(a)), R(ay + k * Math.cos(a)), R(bx + k * Math.sin(b)), R(by - k * Math.cos(b)), R(bx), R(by)));
    }
    ops.push(PL.stroke());
    p.pushOperators(...ops);`}
  }`;
};
const geo = (o) => {
  o = o || {};
  const U = MM / (o.den || 100) * (o.shrink || 1), X0 = o.x0 || 200, Y0 = o.y0 || 200, BW = o.bw || 10920, BH = 7280;
  return { U, X0, Y0, BW, BH, Yd1: Y0 + (BH + 1500) * U, Yd2: Y0 + (BH + 1000) * U, Yb: Y0 - 900 * U, Xd: X0 - 1500 * U };
};

async function waitReady(page) {
  await page.waitForFunction(() => {
    const s = window.__p2dState;
    return s && s.pdf && !s.rendering && s.pages[s.pageIndex] && s.pages[s.pageIndex].geom;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(250);
}
async function loadBody(page, body) {
  await gotoTab(page, 'pdf2dxf');
  await page.evaluate(async (b) => {
    const PL = window.PDFLib;
    const doc = await PL.PDFDocument.create();
    const font = await doc.embedFont(PL.StandardFonts.Helvetica);
    await (new Function('doc', 'font', 'PL', '"use strict";' + b))(doc, font, PL);
    const bytes = await doc.save();
    const inp = document.getElementById('p2dFileInput');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'plan.pdf', { type: 'application/pdf' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, body);
  await waitReady(page);
  await page.waitForTimeout(900);   // 読み込み後のスクロール(なめらか)が止まるまで
}
const nearestEnd = (page, pt) => page.evaluate((p) => {
  const st = window.__p2dState, ls = st.pages[st.pageIndex].geom.lines;
  let best = null, bd = 1e9;
  for (const l of ls) for (const e of [[l.x1, l.y1], [l.x2, l.y2]]) { const d = Math.hypot(e[0] - p.x, e[1] - p.y); if (d < bd) { bd = d; best = { x: e[0], y: e[1] }; } }
  return best;
}, pt);
const clientOf = (page, pt) => page.evaluate((p) => {
  const st = window.__p2dState, pg = st.pages[st.pageIndex], rc = document.getElementById('p2dPickLayer').getBoundingClientRect();
  return { x: rc.left + p.x * st.ds, y: rc.top + (pg.geom.vpH - p.y) * st.ds, ds: st.ds };
}, pt);
// 利用者が「その点が見える所まで」スクロールした状態をまねる(見えていれば動かさない)。at = 画面の中の置き場所(0〜1。既定はまん中)
async function ensureVisible(page, pt, at) {
  let c = await clientOf(page, pt);
  const vh = page.viewportSize().height;
  if (at !== undefined || c.y < 70 || c.y > vh - 70) {
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'instant' }), c.y - vh * (at === undefined ? 0.5 : at));
    await page.waitForTimeout(150);
    c = await clientOf(page, pt);
  }
  return c;
}
// 利用者が図面の全体を見ようとして、図面を画面のまん中へスクロールした状態
async function centerDrawing(page) {
  await page.evaluate(() => document.getElementById('p2dCanvasWrap').scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(200);
}
async function pick(page, pt, off, at) {
  const c = await ensureVisible(page, pt, at);
  const x = c.x + (off ? off.dx : 0), y = c.y + (off ? off.dy : 0);
  await page.mouse.move(x - 3, y + 3);
  await page.mouse.move(x, y);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(220);
  const open = await page.evaluate(() => !!window.__p2dState.chooser);
  if (open) {
    const v = await page.evaluate((p) => {
      const c2 = window.__p2dState.chooser; let b = null, bd = 1e9;
      for (const q of c2.view) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; b = q; } }
      const rc = document.getElementById('p2dChooserCanvas').getBoundingClientRect();
      return { x: rc.left + b.vx, y: rc.top + b.vy };
    }, pt);
    await page.mouse.move(v.x, v.y); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(250);
  }
  return open;
}
const IDS = ['p2dSummary', 'p2dBanner', 'p2dInfo', 'p2dDimHint', 'p2dPickInfo', 'p2dShortWarn', 'p2dScaleStatus', 'p2dCalNote', 'p2dCalToggle', 'p2dRecalUndo', 'p2dCheck', 'p2dCheckResult', 'p2dCheckVerdict', 'p2dRecal', 'p2dPrecision', 'p2dPrecision2', 'p2dPrecision3', 'p2dApplyAll', 'p2dScaleNote', 'p2dExportNote', 'p2dLoadMsg', 'p2dApplyDim', 'p2dRealLen', 'p2dCheckLen', 'p2dModeDim', 'p2dModePreset', 'p2dApplyPreset', 'p2dPreset', 'p2dExportBtn', 'p2dExportAllBtn', 'p2dResetBtn', 'p2dPrev', 'p2dNext'];
const dump = (page) => page.evaluate((ids) => {
  const out = { els: {}, issues: [] };
  const vis = [];
  for (const id of ids) {
    const el = document.getElementById(id); if (!el) continue;
    const rc = el.getBoundingClientRect();
    if (!(rc.width && rc.height)) continue;
    const cs = getComputedStyle(el);
    const text = (el.innerText || el.value || '').trim();
    const inView = rc.top >= 0 && rc.bottom <= window.innerHeight;
    out.els[id] = { text, h: Math.round(rc.height), top: Math.round(rc.top), bottom: Math.round(rc.bottom), left: Math.round(rc.left), w: Math.round(rc.width), color: cs.color, inView };
    if (text && rc.bottom > 8 && rc.top < window.innerHeight && id !== 'p2dCheck') vis.push({ id, top: Math.round(rc.top), text: text.slice(0, 40) });
  }
  vis.sort((a, b) => a.top - b.top);
  out.firstVisible = vis.slice(0, 3);
  const panel = document.querySelector('#modePdf2Dxf .p2d-scale');
  if (panel) {
    const prc = panel.getBoundingClientRect();
    out.panel = { top: Math.round(prc.top), bottom: Math.round(prc.bottom), h: Math.round(prc.height), w: Math.round(prc.width), minH: panel.style.minHeight };
    for (const el of panel.querySelectorAll('*')) {
      const rc = el.getBoundingClientRect();
      if (!(rc.width && rc.height)) continue;
      if (rc.right > prc.right + 1 || rc.left < prc.left - 1) out.issues.push('はみ出し: ' + (el.id || el.className));
      if (el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') out.issues.push('横あふれ: ' + (el.id || el.className));
    }
  }
  const wrap = document.getElementById('p2dCanvasWrap');
  if (wrap) { const w = wrap.getBoundingClientRect(); out.wrap = { top: Math.round(w.top), bottom: Math.round(w.bottom), h: Math.round(w.height), w: Math.round(w.width) }; }
  const lp = document.getElementById('p2dLoupe');
  if (lp) { const r = lp.getBoundingClientRect(); out.loupe = { show: lp.classList.contains('show'), x: Math.round(r.left), y: Math.round(r.top) }; }
  out.docScrollX = document.documentElement.scrollWidth > window.innerWidth + 1;
  out.active = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null;
  out.scrollY = Math.round(window.scrollY); out.innerH = window.innerHeight; out.innerW = window.innerWidth;
  out.docked = document.body.classList.contains('guide-docked');
  return out;
}, IDS);

// 小さな画像を縦に並べた1枚にする(1文字ごとの画面を見比べるため)
async function montage(context, items, outPath, width) {
  const pg = await context.newPage();
  await pg.setViewportSize({ width: width + 24, height: 400 });
  let html = '<body style="margin:12px;font:600 13px sans-serif;background:#fff;color:#111">';
  for (const it of items) html += '<div style="margin:0 0 4px">' + it.cap + '</div><img style="display:block;margin:0 0 12px;border:1px solid #999;max-width:' + width + 'px" src="data:image/png;base64,' + it.buf.toString('base64') + '">';
  await pg.setContent(html + '</body>');
  await pg.waitForTimeout(200);
  await pg.screenshot({ path: outPath, fullPage: true });
  await pg.close();
}

function suite(tag, vp, dockOpen, full) {
  test.describe('VUX ' + tag, () => {
    test.use({ viewport: vp });
    let log = {};
    const P = (name) => SHOTS + '/' + tag + '_' + name + '.png';
    const settle = (page) => page.waitForTimeout(750);
    const shot = async (page, name) => { await page.screenshot({ path: P(name) }); log[name] = await dump(page); };
    const panelClip = async (page) => {
      const r = await page.evaluate(() => { const b = document.querySelector('#modePdf2Dxf .p2d-scale').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, vh: window.innerHeight, vw: window.innerWidth }; });
      const y0 = Math.max(0, r.y - 6), y1 = Math.min(r.vh, r.y + r.h + 6);
      return page.screenshot({ clip: { x: Math.max(0, r.x - 6), y: y0, width: Math.min(r.vw - Math.max(0, r.x - 6), r.w + 12), height: Math.max(20, y1 - y0) } });
    };
    test.beforeEach(async ({ page }) => {
      log = {};
      await page.addInitScript((closed) => {
        try { localStorage.setItem('pdfCompact.settingsSeen', '1'); } catch (_) {}
        try { if (closed) sessionStorage.setItem('pdfCompact.guideAutoOpenDismissed', '1'); } catch (_) {}
      }, !dockOpen);
    });
    test.afterEach(async ({}, info) => { fs.writeFileSync(SHOTS + '/' + tag + '_log_' + info.title.slice(0, 2) + '.json', JSON.stringify(log, null, 1)); });
    const start = async (page, body) => {
      await openApp(page);
      if (dockOpen) await page.waitForFunction(() => document.body.classList.contains('guide-docked'), null, { timeout: 15000 });
      await page.waitForTimeout(500);
      await loadBody(page, body);
    };

    test('01 読み込み・2点・採用・確かめる', async ({ page, context }) => {
      await start(page, planBody());
      await shot(page, '01_loaded');
      const g = geo();
      const A = await nearestEnd(page, { x: g.X0, y: g.Yd1 }), B = await nearestEnd(page, { x: g.X0 + g.BW * g.U, y: g.Yd1 });
      await centerDrawing(page);
      await pick(page, A);
      if (full) await shot(page, '02a_one_point');
      await pick(page, B);
      await settle(page);
      await shot(page, '02_two_points');
      await page.keyboard.type('10920');
      await page.keyboard.press('Enter');
      await settle(page);
      await shot(page, '03_adopted');
      if (full) {
        // 縮尺の欄の全体(文言をまとめて読むため)
        await page.evaluate(() => document.querySelector('#modePdf2Dxf .redact-toolbar').scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(200);
        fs.writeFileSync(P('03p_adopted_panel'), await panelClip(page));
        await page.click('#p2dCalToggle'); await settle(page);
        log.toggled = await dump(page);
        await page.click('#p2dCalToggle'); await settle(page);
      }
      // 確かめる: 3,640 の寸法線
      const s1 = await nearestEnd(page, { x: g.X0, y: g.Yd2 }), s2 = await nearestEnd(page, { x: g.X0 + 3640 * g.U, y: g.Yd2 });
      await centerDrawing(page);
      await pick(page, s1); await pick(page, s2);
      await settle(page);
      await shot(page, '04_check_two_points');
      await page.click('#p2dCheckLen');
      await page.waitForTimeout(400);
      const items = [], t0 = Date.now();
      log.typing = [];
      const before = await page.evaluate(() => ({ h: document.querySelector('#modePdf2Dxf .p2d-scale').offsetHeight, y: Math.round(window.scrollY) }));
      log.typing.push(Object.assign({ ch: '(前)' }, before));
      items.push({ cap: tag + ' 入力前(panel h=' + before.h + ')', buf: await panelClip(page) });
      for (const ch of ['3', '6', '4', '0']) {
        await page.keyboard.type(ch);
        const m = await page.evaluate(() => ({ h: document.querySelector('#modePdf2Dxf .p2d-scale').offsetHeight, verdict: document.getElementById('p2dCheckVerdict').innerText, recalHidden: document.getElementById('p2dRecal').hidden, y: Math.round(window.scrollY), val: document.getElementById('p2dCheckLen').value }));
        m.ch = ch; m.ms = Date.now() - t0;
        log.typing.push(m);
        items.push({ cap: tag + ' 「' + m.val + '」まで入力(panel h=' + m.h + '・判定「' + m.verdict + '」・合わせ直しボタン ' + (m.recalHidden ? '無し' : '有り') + '・' + m.ms + 'ms)', buf: await panelClip(page) });
      }
      await montage(context, items, P('05_typing_montage'), Math.min(1300, vp.width));
      await page.waitForTimeout(900);
      await shot(page, '06_check_after_pause');
      // 合わない寸法を入れて Enter(その場で判定)
      await page.click('#p2dCheckLen');
      await page.keyboard.press('Control+a');
      await page.keyboard.type('3700');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(80);
      log.afterEnterImmediate = await page.evaluate(() => ({ verdict: document.getElementById('p2dCheckVerdict').innerText, recalHidden: document.getElementById('p2dRecal').hidden }));
      await settle(page);
      await shot(page, '07_check_mismatch');
      // 図面の上のラベル(色)
      const mid = { x: (s1.x + s2.x) / 2, y: s1.y };
      const c = await ensureVisible(page, mid, 0.4);
      await page.mouse.move(c.x + 300, c.y + 160);
      await page.waitForTimeout(300);
      await page.screenshot({ path: P('07b_mismatch_label'), clip: { x: Math.max(0, c.x - 220), y: Math.max(0, c.y - 60), width: 440, height: 120 } });
      if (full) {
        await page.click('#p2dRecal'); await settle(page);
        await shot(page, '08_recal');
        await page.click('#p2dRecalUndo'); await settle(page);
        await shot(page, '08b_recal_undone');
      }
    });

    test('02 97%・短い寸法・吸着なし', async ({ page }) => {
      test.skip(!full, '縮小セットでは省く');
      await start(page, planBody({ shrink: 0.97 }));
      const g = geo({ shrink: 0.97 });
      const A = await nearestEnd(page, { x: g.X0, y: g.Yd1 }), B = await nearestEnd(page, { x: g.X0 + g.BW * g.U, y: g.Yd1 });
      await centerDrawing(page);
      await pick(page, A); await pick(page, B); await settle(page);
      await page.keyboard.type('10920'); await page.keyboard.press('Enter'); await settle(page);
      await shot(page, '10_97_not_adopted');
      // 短い寸法(910)
      await page.click('#p2dResetBtn'); await page.waitForTimeout(300);
      await loadBody(page, planBody());
      const g1 = geo();
      const a = await nearestEnd(page, { x: g1.X0, y: g1.Yb }), b = await nearestEnd(page, { x: g1.X0 + 910 * g1.U, y: g1.Yb });
      await centerDrawing(page);
      await pick(page, a); await pick(page, b); await settle(page);
      await shot(page, '11_short_two_points');
      await page.keyboard.type('910'); await page.keyboard.press('Enter'); await settle(page);
      await shot(page, '12_short_after_enter');
      // 吸着なしの2点(図の何も無い所)
      await page.click('#p2dModeDim'); await page.waitForTimeout(200);
      const u1 = { x: g1.X0 + 3, y: g1.Yd1 + 60 }, u2 = { x: g1.X0 + g1.BW * g1.U - 3, y: g1.Yd1 + 60 };
      await centerDrawing(page);
      await pick(page, u1); await pick(page, u2); await settle(page);
      await shot(page, '13_unsnapped_two_points');
      await page.keyboard.type('10920'); await page.keyboard.press('Enter'); await settle(page);
      await shot(page, '14_unsnapped_after_enter');
    });

    test('03 ルーペ・小窓', async ({ page }) => {
      await start(page, planBody());
      const g = geo();
      const corner = { x: g.X0, y: g.Y0 + g.BH * g.U };   // 建物の左上の角(通り芯の交点の 60mm 隣に壁の角)
      let c = await ensureVisible(page, corner);
      await page.mouse.move(c.x - 30, c.y - 30); await page.mouse.move(c.x + 1, c.y - 1);
      await page.waitForTimeout(350);
      if (full) {
        await shot(page, '20_loupe_corner');
        const l = log['20_loupe_corner'].loupe;
        await page.screenshot({ path: P('20b_loupe_zoom'), clip: { x: Math.max(0, l.x - 60), y: Math.max(0, l.y - 20), width: 320, height: 260 } });
      }
      // 小窓
      await page.mouse.down(); await page.mouse.up();
      await page.waitForTimeout(450);
      const info = () => page.evaluate(() => {
        const s = window.__p2dState.chooser; if (!s) return null;
        const el = document.getElementById('p2dChooser'), r = el.getBoundingClientRect(), cv = document.getElementById('p2dChooserCanvas'), cr = cv.getBoundingClientRect();
        const cb = document.getElementById('p2dChooserClose').getBoundingClientRect();
        return { n: s.view.length, mag: Math.round(s.mag), rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }, vh: window.innerHeight, vw: window.innerWidth,
          fully: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
          closeReach: document.elementFromPoint(cb.left + cb.width / 2, cb.top + cb.height / 2) === document.getElementById('p2dChooserClose'),
          cands: s.view.map((v) => { const x = cr.left + v.vx, y = cr.top + v.vy; return { x: Math.round(x), y: Math.round(y), reach: y >= 0 && y <= window.innerHeight && document.elementFromPoint(x, y) === cv }; }) };
      });
      log.chooser = await info();
      await shot(page, '21_chooser');
      await page.keyboard.press('Escape'); await page.waitForTimeout(350);
      log.afterEsc = await page.evaluate(() => ({ chooser: !!window.__p2dState.chooser, docked: document.body.classList.contains('guide-docked'), picks: window.__p2dState.picks.length }));
      if (full && vp.height <= 700) {
        // 角が画面の下端の近く/上端の近くにある時(小窓が逃げる向き)
        const low = { x: g.X0, y: g.Y0 };   // 建物の左下の角
        c = await ensureVisible(page, low, 0.93);
        await page.mouse.move(c.x - 20, c.y - 20); await page.mouse.move(c.x + 1, c.y - 1);
        await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(450);
        log.chooserLow = await info();
        await shot(page, '22_chooser_near_bottom');
        await page.keyboard.press('Escape'); await page.waitForTimeout(350);
        c = await ensureVisible(page, corner, 0.06);
        await page.mouse.move(c.x - 20, c.y + 20); await page.mouse.move(c.x + 1, c.y + 1);
        await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(450);
        log.chooserHigh = await info();
        await shot(page, '23_chooser_near_top');
        await page.keyboard.press('Escape'); await page.waitForTimeout(350);
      }
    });

    test('04 縮尺を選ぶ・複数ページ・ZIP', async ({ page }) => {
      await start(page, planBody() + planBody({ bw: 9100 }) + planBody({ pw: 842, ph: 595, x0: 120, y0: 120, bw: 7280 }));
      const g = geo();
      // 縮尺を選ぶ(まだ決めていない)で図面をクリック
      await page.click('#p2dModePreset'); await page.waitForTimeout(250);
      const room = { x: g.X0 + 1800 * g.U, y: g.Y0 + 5400 * g.U };
      const c = await ensureVisible(page, room);
      await page.mouse.move(c.x - 20, c.y - 20); await page.mouse.move(c.x, c.y);
      await page.waitForTimeout(350);
      log.presetHover = await dump(page);
      if (full) await shot(page, '30_preset_hover_no_loupe');
      await page.mouse.down(); await page.mouse.up();
      await settle(page);
      await shot(page, '31_preset_click_no_scale');
      if (!full) return;
      await page.click('#p2dApplyPreset'); await settle(page);
      await shot(page, '32_preset_applied');
      await page.click('#p2dApplyAll'); await page.waitForTimeout(900);
      await shot(page, '33_apply_all');
      await page.click('#p2dNext'); await waitReady(page); await page.waitForTimeout(400);
      await shot(page, '34_page2');
      await armCapture(page);
      await page.click('#p2dExportAllBtn'); await page.waitForTimeout(1600);
      await page.locator('#modePdf2Dxf .redact-actions').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, '35_zip_saved');
    });

    test('05 ゆっくり打つ人', async ({ page, context }) => {
      test.skip(!(full && vp.height <= 700 && dockOpen), 'ノートの画面・取説ありだけ');
      await start(page, planBody());
      const g = geo();
      const A = await nearestEnd(page, { x: g.X0, y: g.Yd1 }), B = await nearestEnd(page, { x: g.X0 + g.BW * g.U, y: g.Yd1 });
      await centerDrawing(page);
      await pick(page, A); await pick(page, B); await settle(page);
      await page.keyboard.type('10920'); await page.keyboard.press('Enter'); await settle(page);
      const s1 = await nearestEnd(page, { x: g.X0, y: g.Yd2 }), s2 = await nearestEnd(page, { x: g.X0 + 3640 * g.U, y: g.Yd2 });
      await pick(page, s1); await pick(page, s2); await settle(page);
      await page.click('#p2dCheckLen'); await page.waitForTimeout(300);
      const items = [];
      log.slow = [];
      for (const ch of ['3', '6', '4', '0']) {
        await page.keyboard.type(ch);
        await page.waitForTimeout(1000);   // 1秒に1文字(図面と手元を見比べながら打つ人)
        const m = await page.evaluate(() => ({ h: document.querySelector('#modePdf2Dxf .p2d-scale').offsetHeight, verdict: document.getElementById('p2dCheckVerdict').innerText.slice(0, 30), recalHidden: document.getElementById('p2dRecal').hidden, val: document.getElementById('p2dCheckLen').value, y: Math.round(window.scrollY) }));
        log.slow.push(m);
        items.push({ cap: '1秒に1文字: 「' + m.val + '」の1秒後(panel h=' + m.h + '・判定「' + m.verdict + '」・合わせ直しボタン ' + (m.recalHidden ? '無し' : '有り') + ')', buf: await panelClip(page) });
      }
      await montage(context, items, P('40_slow_typing_montage'), Math.min(1300, vp.width));
    });
  });
}

const ON = !!SHOTS;
const want = (t) => ON && (!ONLY || ONLY.split(',').indexOf(t) >= 0);
if (want('Lo')) suite('Lo', { width: 1366, height: 650 }, true, true);
if (want('Lc')) suite('Lc', { width: 1366, height: 650 }, false, true);
if (want('Do')) suite('Do', { width: 1400, height: 900 }, true, true);
if (want('No')) suite('No', { width: 1000, height: 700 }, true, true);
if (want('Dc')) suite('Dc', { width: 1400, height: 900 }, false, false);
if (want('Nc')) suite('Nc', { width: 1000, height: 700 }, false, false);

(want('T') ? test.describe : () => {})('VUX 指で操作する端末', () => {
  test.use({ viewport: { width: 1000, height: 700 }, hasTouch: true, isMobile: true });
  test('99 リンクとボタンの高さ', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('pdfCompact.settingsSeen', '1'); sessionStorage.setItem('pdfCompact.guideAutoOpenDismissed', '1'); } catch (_) {} });
    await openApp(page);
    await loadBody(page, planBody() + planBody({ bw: 9100 }));
    await page.click('#p2dModePreset'); await page.click('#p2dApplyPreset'); await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const o = { coarse: matchMedia('(pointer: coarse)').matches, els: {} };
      for (const el of document.querySelectorAll('#modePdf2Dxf .p2d-linkbtn, #modePdf2Dxf .p2d-btn, #modePdf2Dxf .p2d-chooser-close, #modePdf2Dxf .redact-modebtn, #modePdf2Dxf .redact-navbtn')) {
        const rc = el.getBoundingClientRect(); if (!(rc.width && rc.height)) continue;
        o.els[el.id || el.className] = { w: Math.round(rc.width), h: Math.round(rc.height) };
      }
      return o;
    });
    fs.writeFileSync(SHOTS + '/T_touch_sizes.json', JSON.stringify(r, null, 1));
    await page.evaluate(() => document.querySelector('#modePdf2Dxf .redact-toolbar').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: SHOTS + '/T_touch_panel.png' });
  });
});
