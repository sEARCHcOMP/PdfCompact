  // ============================================================
  // モード: 図面変換 (PDF→DXF) — v4.5.0
  //   CAD出力のベクタPDFから 線・円・円弧・文字 を取り出し、Jw_cad で開ける DXF(R12・Shift-JIS)に変換する。
  //   書式は Jw_cad 実機で確定したものに厳密に従う(docs/plans/pdf2dxf-spec.md §1)。
  //   ★ TABLES(LTYPE・LAYER)が無いと Jw_cad で全線が「補助線種」(印刷されない線)になる。絶対に省かない。
  //   既存の extractPageLines(画像配置の罫線スナップ用)は目的が違うので触らず、変換専用の抽出器を持つ。
  // ============================================================
  (function pdf2dxfModule() {
    'use strict';
    const L = window.pdfjsLib;
    const $ = (id) => document.getElementById(id);
    const panel = $('modePdf2Dxf');
    const upload = $('p2dUpload');
    const fileInput = $('p2dFileInput');
    const loadMsg = $('p2dLoadMsg');
    const editor = $('p2dEditor');
    const pageInfo = $('p2dPageInfo');
    const prevBtn = $('p2dPrev');
    const nextBtn = $('p2dNext');
    const summary = $('p2dSummary');
    const showLines = $('p2dShowLines');
    const banner = $('p2dBanner');
    const infoEl = $('p2dInfo');
    const modeDimBtn = $('p2dModeDim');
    const modePresetBtn = $('p2dModePreset');
    const dimBody = $('p2dDimBody');
    const presetBody = $('p2dPresetBody');
    const pickInfo = $('p2dPickInfo');
    const dimHint = $('p2dDimHint');
    const realLen = $('p2dRealLen');
    const applyDimBtn = $('p2dApplyDim');
    const presetSel = $('p2dPreset');   // 「よく使う縮尺」の近道。標準の縮尺の一覧(ルールR)もここから取る
    const denInput = $('p2dDen');       // 縮尺の分母。自分で打てる(1/150・1/60 など)。こちらが本当の値
    const denWarn = $('p2dDenWarn');
    const applyPresetBtn = $('p2dApplyPreset');
    const dxfHint = $('p2dDxfHint');
    const presetHint = $('p2dPresetHint');
    const scaleStatus = $('p2dScaleStatus');
    const dimNote = $('p2dDimNote');
    const dimText = $('p2dDimText');
    const dimBtn = $('p2dDimBtn');
    const checkBox = $('p2dCheck');
    const checkResult = $('p2dCheckResult');
    const precisionEl = $('p2dPrecision');
    const precision2El = $('p2dPrecision2');
    const shortWarn = $('p2dShortWarn');
    const calNote = $('p2dCalNote');
    const calToggle = $('p2dCalToggle');
    const checkLen = $('p2dCheckLen');
    const checkVerdict = $('p2dCheckVerdict');
    const recalBtn = $('p2dRecal');
    const applyAllBtn = $('p2dApplyAll');
    const scaleNoteEl = $('p2dScaleNote');
    const recalUndoBtn = $('p2dRecalUndo');
    const precision3El = $('p2dPrecision3');
    const scaleBox = $('p2dScaleBox');
    const wrap = $('p2dCanvasWrap');
    const canvas = $('p2dCanvas');
    const vecLayer = $('p2dVecLayer');
    const pickLayer = $('p2dPickLayer');
    const loupe = $('p2dLoupe');
    const chooser = $('p2dChooser');
    const chooserCanvas = $('p2dChooserCanvas');
    const chooserClose = $('p2dChooserClose');
    const fmtJwwBtn = $('p2dFmtJww');
    const fmtDxfBtn = $('p2dFmtDxf');
    const fmtHint = $('p2dFmtHint');
    const jwwOpts = $('p2dJwwOpts');
    const colorSel = $('p2dColorMode');
    const tmplPickBtn = $('p2dTmplPick');
    const tmplClearBtn = $('p2dTmplClear');
    const tmplInput = $('p2dTmplInput');
    const tmplState = $('p2dTmplState');
    const exportBtn = $('p2dExportBtn');
    const exportAllBtn = $('p2dExportAllBtn');
    const exportNote = $('p2dExportNote');
    const resetBtn = $('p2dResetBtn');
    if (!panel || !upload || !canvas || !vecLayer || !pickLayer || !exportBtn || !checkLen || !calToggle || !recalBtn ||
      !loupe || !chooser || !chooserCanvas || !chooserClose || !scaleNoteEl || !recalUndoBtn || !scaleBox ||
      !fmtJwwBtn || !fmtDxfBtn || !jwwOpts || !colorSel || !tmplPickBtn || !tmplInput || !tmplState || !denInput) return;

    const PT2MM = 25.4 / 72;            // 1pt = 0.3528mm(用紙上)
    const FLAT_TOL = 0.05 / PT2MM;      // 円弧にならない曲線を折れ線にする時の許容誤差: 用紙上0.05mm
    const SNAP_PX = 10;                 // 線の端に吸い付く距離(画面px)
    const AMBIG_PX = 6;                 // 吸い付く点からこの距離(画面px)以内に別の候補点があれば、確定せずに選び直しの小窓を開く
    const MERGE_PT = 0.01;              // この距離(pt)以内の候補点は同じ点としてまとめる
    const LOUPE_PX = 168, LOUPE_MAG = 8, LOUPE_GAP = 24, LOUPE_TOUCH_GAP = 56;   // ルーペ: 大きさ(画面px)・倍率(画面表示に対して)・カーソル/指からの離れ
    // 入力が DXF の時の控え。null なら PDF。画面の組み立てより先に読まれる必要があるので、ここで持つ
    let dxfIn = null;   // { name, bytes, primsDoc, report, den }
    const isDxf = () => !!dxfIn;

    // 保存の設定(形式・線の色・ひな形)。中身は下の「3.6 JWW の書き出し」。画面の組み立てより先に読まれる必要があるので、ここで持つ
    const FMT_KEY = 'p2dOutFormat', COLOR_KEY = 'p2dColorMode';
    const TMPL_DB = 'pdfCompactP2D', TMPL_STORE = 'template', TMPL_KEY = 'jww';
    const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
    let outFmt = lsGet(FMT_KEY, 'jww') === 'dxf' ? 'dxf' : 'jww';
    let colorMode = lsGet(COLOR_KEY, 'white') === 'original' ? 'original' : 'white';
    let userTmpl = null;   // 登録したひな形 { bytes, name, at }。null なら内蔵ひな形

    const CHOOSER_PX = 320, CHOOSER_DOT = 7, CHOOSER_HIT = 22, CHOOSER_GAP = 44;  // 選び直しの小窓: 大きさ・候補点の丸の半径・当たり判定の半径・候補点どうしに確保する間隔(画面px)
    const CHOOSER_MAG_MIN = 8, CHOOSER_MAG_MAX = 96;                              // 選び直しの小窓の倍率の下限・上限

    const st = {
      pdf: null, occ: null, numPages: 0, pageIndex: 0,   // occ: レイヤ(OCG)の表示設定
      pages: {},            // ページ番号(0始まり) -> { geom, k, kLabel, kFrom(ほかのページの縮尺を使った時の元ページ), cal(縮尺の合わせ方の記録), index(格子の索引) }
      mode: 'dim',          // 'dim'(寸法で合わせる) | 'preset'(縮尺を選ぶ)
      calibrating: true,    // true: クリックは縮尺合わせの2点 / false: 検算の2点
      picks: [], hover: null,
      cursor: null,         // ポインタのいまの位置 { x, y(画面の座標), touch }。図面の上に無い時は null
      aim: null,            // 指で押してねらっている最中のポインタ番号(タッチは、指を離した時に点を取る)
      chooser: null,        // 選び直しの小窓を開いている間の状態 { p, cands, center, mag, view, sel, down, prevFocus }
      checkTyping: false,   // 確かめる欄(図面に書いてある寸法)に入力している最中。判定は、入力が止まってから出す
      ds: 1, dpr: 1,        // 表示倍率(画面px / pt)と devicePixelRatio
      rendering: false, renderGen: 0, busy: false,
      note: null,           // 出力欄(保存ボタンの横)に出す直近の結果メッセージ { text, type, caution }
      scaleNote: null,      // 縮尺の欄に出す直近の結果・エラー { text, type }(縮尺の欄と図面の上の操作から出る文)
    };
    window.__p2dState = st;

    // ===================== 1. 抽出(pdf.js の描画命令から線・円・円弧・文字) =====================
    const mul = (m1, m2) => [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
    const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const nang = (v) => { while (v <= -Math.PI) v += 2 * Math.PI; while (v > Math.PI) v -= 2 * Math.PI; return v; };
    const deg = (rad) => ((rad * 180 / Math.PI) % 360 + 360) % 360;

    // 破線の並び → DXF線種(Jw_cad 実機で DASHED=破線、CENTER=一点鎖線 を確認済み)
    function linetypeOf(dash) {
      if (!dash || dash.length === 0 || dash.every((v) => !(v > 0))) return 'CONTINUOUS';
      return dash.length >= 4 ? 'CENTER' : 'DASHED';
    }
    // 線の色(RGB 0〜255) → DXF色番号。1赤 2黄 3緑 4水 5青 6紫 は Jw_cad でそのまま通る(実機確認済み)。黒・灰・白は 7
    function aciOf(rgb) {
      if (!rgb) return 7;
      const r = rgb[0], g = rgb[1], b = rgb[2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (mx < 48 || d < 64) return 7;
      let h;
      if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      return [1, 2, 3, 4, 5, 6][Math.round(h / 60) % 6];
    }

    function bez(p0, p1, p2, p3, t) {
      const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      return { x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y };
    }
    function circle3(a, b, c) {
      const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
      if (Math.abs(d) < 1e-9) return null;
      const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
      const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
      const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
      return { x, y, r: Math.hypot(a.x - x, a.y - y) };
    }
    // 中心 = 両端点での法線(接線に垂直な線)の交点。PDF生成器は端点を円上に、制御点を接線上に正確に置くので、
    // ここから出した中心・半径は近似曲線の膨らみ(中点のずれ)の影響を受けない。法線が平行(半円を1本で描いた等)なら null
    function centerFromTangents(p0, p1, p2, p3) {
      const n0x = -(p1.y - p0.y), n0y = p1.x - p0.x, n3x = -(p3.y - p2.y), n3y = p3.x - p2.x;
      const l0 = Math.hypot(n0x, n0y), l3 = Math.hypot(n3x, n3y);
      if (l0 < 1e-9 || l3 < 1e-9) return null;
      const det = -n0x * n3y + n3x * n0y;
      if (Math.abs(det) < 1e-6 * l0 * l3) return null;
      const dx = p3.x - p0.x, dy = p3.y - p0.y;
      const sK = (-dx * n3y + n3x * dy) / det;
      return { x: p0.x + sK * n0x, y: p0.y + sK * n0y };
    }
    // ---- 検証つきの円弧(docs/plans/pdf2dxf-stage1-spec.md C) ----
    // 円・円弧として出してよい条件は1つだけ:
    //   「当てはめた円と、元の曲線の上の点(1本あたり t = 1/8 刻みの9点)のずれが、用紙上 0.05mm(FLAT_TOL)以内」。
    // 満たさない曲線は折れ線にする(折れ線も元の曲線から 0.05mm 以内)。どちらで出ても、元の図から 0.05mm を超えて離れない。
    // 以前は半径に比例する許容(半径の 0.3%)と接線の向きで判定していたため、大きい円弧では 0.05mm を超えるずれを見逃し、
    // 座標が丸められたPDF(プリンタ経由)では、接線の向きが狂って小さい円が円弧にならなかった
    const ARC_STEPS = 8;
    function curvePoints(s) {
      const pts = [];
      for (let i = 0; i <= ARC_STEPS; i++) pts.push(bez(s.a, s.c1, s.c2, s.b, i / ARC_STEPS));
      return pts;
    }
    // 円 c と点の列のずれ(半径方向)の最大(pt)
    function maxDeviation(c, pts) {
      let m = 0;
      for (const p of pts) { const d = Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.r); if (d > m) m = d; }
      return m;
    }
    // 点の列が円の中心のまわりを回る角度の合計(ラジアン。反時計回りが正)。途中で逆戻りする曲線は円弧ではないので null
    function sweepOf(c, pts) {
      let sum = 0, fwd = false, back = false;
      let prev = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
      for (let i = 1; i < pts.length; i++) {
        const a = Math.atan2(pts[i].y - c.y, pts[i].x - c.x), d = nang(a - prev);
        if (d > 1e-9) fwd = true; else if (d < -1e-9) back = true;
        sum += d; prev = a;
      }
      return fwd && back ? null : sum;
    }
    // 3次ベジェ1本が円弧か判定する。円弧なら中心・半径・回転量と、検証に使った曲線上の点を返す
    function fitArc(s) {
      const p0 = s.a, p3 = s.b;
      if (dist(p0, p3) < 1e-6) return null;
      const pts = curvePoints(s);
      // 円の候補は3つ。上から順に試し、どれも同じ検証(ずれ 0.05mm 以内)に通った時だけ使う。
      //   (1) 端点+接線から出した円: 生成器が端点と制御点を正確に置いたPDFなら、近似曲線の膨らみの影響を受けず正確
      //   (2) 両端と中点を通る円: 座標が丸められて接線の向きが狂ったPDFでも安定
      //   (3) 曲線上の9点への最小二乗: 半径の大きい円弧は、近似曲線の膨らみ(半径の約0.03%)だけで (1)(2) が 0.05mm を超える。膨らみの中ほどを通る円なら収まる
      const cands = [];
      const ct = centerFromTangents(p0, s.c1, s.c2, p3);
      if (ct) cands.push({ x: ct.x, y: ct.y, r: (dist(ct, p0) + dist(ct, p3)) / 2 });
      const c3 = circle3(p0, pts[ARC_STEPS / 2], p3);
      if (c3) cands.push(c3);
      const lsq = fitCircleLS(pts);
      if (lsq) cands.push(lsq);
      for (const c of cands) {
        if (!(c.r > 1e-3) || c.r > 1e6 || maxDeviation(c, pts) > FLAT_TOL) continue;
        const sweep = sweepOf(c, pts);
        if (sweep === null || Math.abs(sweep) < 0.02 || Math.abs(sweep) > Math.PI * 1.01) continue;   // ほぼ直線 or 1本で半周超は円弧扱いしない
        return { cx: c.x, cy: c.y, r: c.r, sweep, p0, p3, pts };
      }
      return null;
    }
    // 円弧にならない曲線は折れ線にする(用紙上0.05mm以内)。out は抽出器の受け口(用紙・切り抜きで切ってから記録する)
    function flatten(s, lt, col, out) {
      const pts = [s.a];
      (function rec(p0, p1, p2, p3, depth) {
        const dx = p3.x - p0.x, dy = p3.y - p0.y, L2 = dx * dx + dy * dy;
        const off = (p) => (L2 < 1e-12 ? dist(p, p0) : Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) / Math.sqrt(L2));
        if (depth >= 16 || (off(p1) <= FLAT_TOL && off(p2) <= FLAT_TOL)) { pts.push(p3); return; }
        const m01 = mid(p0, p1), m12 = mid(p1, p2), m23 = mid(p2, p3), m012 = mid(m01, m12), m123 = mid(m12, m23), m = mid(m012, m123);
        rec(p0, m01, m012, m, depth + 1);
        rec(m, m123, m23, p3, depth + 1);
      })(s.a, s.c1, s.c2, s.b, 0);
      for (let i = 1; i < pts.length; i++) {
        if (dist(pts[i - 1], pts[i]) > 1e-6) out.line({ x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y, lt, col });
      }
    }
    // 円の当てはめ(最小二乗)。生成器が正確に置いたPDFなら端点は円の上に正確に乗っているので、端点が3つ以上あれば中心・半径が正確に決まる。
    // 座標が丸められたPDFでも、1本ごとの当てはめより、端点全部を使うほうが丸めの影響が平均されて安定する
    function fitCircleLS(pts) {
      const n = pts.length;
      let mx = 0, my = 0;
      for (const p of pts) { mx += p.x; my += p.y; }
      mx /= n; my /= n;
      let Suu = 0, Suv = 0, Svv = 0, Suz = 0, Svz = 0, Sz = 0;
      for (const p of pts) {
        const u = p.x - mx, v = p.y - my, z = u * u + v * v;
        Suu += u * u; Suv += u * v; Svv += v * v; Suz += u * z; Svz += v * z; Sz += z;
      }
      const det = Suu * Svv - Suv * Suv;
      if (!(Math.abs(det) > 1e-12 * (Suu + Svv) * (Suu + Svv))) return null;   // 一直線に並んでいる
      const D = (-Suz * Svv + Svz * Suv) / det, E = (-Svz * Suu + Suz * Suv) / det, F = -Sz / n;
      const r2 = (D * D + E * E) / 4 - F;
      return r2 > 0 ? { x: mx - D / 2, y: my - E / 2, r: Math.sqrt(r2) } : null;
    }
    // まとめた区間(2本以上の曲線)の円: 端点全部で最小二乗の当てはめをやり直し、全区間の点で「ずれ 0.05mm 以内」を確かめる。
    // 端点の当てはめが通らない時は、曲線上の点全部への当てはめ(半径の大きい円むけ。fitArc の (3) と同じ理由)、1本ごとの円の平均の順に確かめる。
    // どれも通らなければ null(まとめない)
    function mergedCircle(arcs) {
      const ends = [arcs[0].p0].concat(arcs.map((a) => a.p3));
      if (dist(ends[0], ends[ends.length - 1]) < 1e-6) ends.pop();   // 閉じている(終点 = 始点)。同じ点を二重に数えない
      const all = [];
      let sx = 0, sy = 0, sr = 0;
      for (const a of arcs) { sx += a.cx; sy += a.cy; sr += a.r; for (const p of a.pts) all.push(p); }
      const cands = [];
      const ls = ends.length >= 3 ? fitCircleLS(ends) : null;
      if (ls) cands.push(ls);
      const lsAll = fitCircleLS(all);
      if (lsAll) cands.push(lsAll);
      cands.push({ x: sx / arcs.length, y: sy / arcs.length, r: sr / arcs.length });
      for (const c of cands) {
        if (maxDeviation(c, all) > FLAT_TOL) continue;
        const sweep = sweepOf(c, all);
        if (sweep !== null) return { c, sweep };
      }
      return null;
    }
    // 連続する曲線 → 同じ円に乗る区間をまとめて CIRCLE(全周)/ARC(部分)。それ以外は折れ線。
    // q = 座標の刻み(pt。分からない時は 0)。座標が丸められたPDFでは、1本ごとに出した中心・半径が丸めのぶんばらつくので、
    // 「同じ円」とみなす許容を刻みに合わせて広げる(広げないと、小さい円が4本の円弧に割れる)。許容は2段:
    //   (1) 中心・半径の差 ≤ max(0.1pt, 半径の0.5%, 2q) → 同じ円(まとめた後に、全区間で「ずれ 0.05mm 以内」を確かめる)
    //   (2) (1) を外れても、丸めで起こりうるばらつき 2q ÷(1 − cos(回転量 ÷ 2))の内なら、まとめた円が検証に通る時だけ同じ円とみなす。
    //       1本ごとの中心は、浅い円弧ほど丸めに振り回される(90°で 刻みの約7倍、45°で 約26倍)。斜めの向きから描いた円や
    //       8本に分けた円は (1) だけでは半分近くが割れたまま残った(乱数の試算で確認)。細かいPDF(q が 0 に近い)では (2) は働かない
    const MERGE_TRY_MAX = 64;   // (2) を試すのは、この本数までの区間(1回の検証は区間の長さに比例するので、長大な連続曲線で遅くならないように)
    function emitCurves(run, lt, col, out, q) {
      let grp = null;
      const emitArc = (c, start, end, sweep) => {
        if (Math.abs(sweep) >= 2 * Math.PI - 0.05) { out.circle({ cx: c.x, cy: c.y, r: c.r, lt, col }); return; }
        const a0 = Math.atan2(start.y - c.y, start.x - c.x), aE = Math.atan2(end.y - c.y, end.x - c.x);
        const s0 = sweep > 0 ? a0 : aE, s1 = sweep > 0 ? aE : a0;   // DXF の ARC は反時計回り
        out.arc({ cx: c.x, cy: c.y, r: c.r, a1: deg(s0), a2: deg(s1), lt, col });
      };
      const flush = () => {
        if (!grp) return;
        const arcs = grp.arcs; grp = null;
        const m = arcs.length > 1 ? mergedCircle(arcs) : null;
        if (m) { emitArc(m.c, arcs[0].p0, arcs[arcs.length - 1].p3, m.sweep); return; }
        // 1本だけの時と、まとめた円が検証に通らない時は、1本ずつの円弧(それぞれ検証済み)で出す
        for (const a of arcs) emitArc({ x: a.cx, y: a.cy, r: a.r }, a.p0, a.p3, a.sweep);
      };
      for (const s of run) {
        const a = fitArc(s);
        if (!a) { flush(); flatten(s, lt, col, out); continue; }
        if (grp) {
          const n = grp.arcs.length, last = grp.arcs[n - 1], qq = q > 0 ? q : 0;
          const tolC = Math.max(0.1, a.r * 0.005, 2 * qq);
          const tolNoise = 2 * qq / (1 - Math.cos(Math.min(Math.abs(a.sweep), Math.abs(last.sweep)) / 2));
          const dC = Math.hypot(a.cx - grp.sx / n, a.cy - grp.sy / n), dR = Math.abs(a.r - grp.sr / n);
          const joined = Math.sign(a.sweep) === Math.sign(last.sweep) && dist(a.p0, last.p3) <= tolC;
          const near = dC <= tolC && dR <= tolC;
          const same = joined && (near || (dC <= tolNoise && dR <= tolNoise && n < MERGE_TRY_MAX && mergedCircle(grp.arcs.concat([a])) !== null));
          if (same) { grp.sx += a.cx; grp.sy += a.cy; grp.sr += a.r; grp.arcs.push(a); continue; }
          flush();
        }
        grp = { sx: a.cx, sy: a.cy, sr: a.r, arcs: [a] };
      }
      flush();
    }
    // 座標の刻み幅(pt)を推定: 隣り合う頂点の差が何の倍数に乗っているか。平行移動に左右されないよう差で見る。
    // 本当の刻みが候補の整数倍のこともある(400dpi = 0.18pt = 0.06pt の3倍 等)ので、0.75pt までの倍数も試して最大を採る(mm の格子の候補は除く。下の「倍数を試すのは…」)。
    // どの候補にも乗らない時は「細かい」とは言わず、推定できなかったと返す(甘い表示にしない)。
    // 判定に使うのは直線の端点の差だけ。曲線の端点は格子に乗らないPDFがあり(Chromium 製)、細かいPDFなのに「推定できません」になっていた。
    // 直線の差が20個に満たない時だけ、曲線の差も足して判定する。minDiff = 判定に使った差のうち最小のもの(pt)
    //
    // 外れ値に強くする(多数決): プリンタ経由の図面に、後から別の道具で線を重ねたPDF(手書き・朱書き・重ねた枠や記号)は、小数そのままの線が混ざる。
    // 「99% が乗る刻み」だけを探していた時は、こういうPDFの刻みが取れず、混ざった線の細かさだけを見て「十分に細かいPDF」と言い切っていた(実際は ±4mm なのに「±1mm未満」)。
    // そこで、差の 2/3 以上が乗る、いちばん粗い刻みを採る(測る相手は図面の線なので、粗いほうに合わせるのが安全側)。
    //   ・2/3 以上 90% 未満しか乗らない候補は、外れた差の大半(2/3 以上)がその 1/2〜1/5 の刻みに乗るなら採らない(1200dpi の図で偶数の差が多いだけなのに、600dpi と取り違えないため)
    //   ・倍数を試す時は、元の候補に乗っていた差を(1% を超えて)失わない倍数だけを採る(多数決で採った候補は、偶然乗っていた外れの分として2個までの余裕を見る)
    //   ・mm の格子(0.1mm・0.01mm)だけは、これまでどおり 99% を求める(設計の寸法が切りのよい mm に揃っているだけの細かいPDFでも、多数が乗ってしまうため)
    //   ・細かい刻みに全部が乗っていても、差のかなりの部分(20% 以上)がずっと粗い候補に乗っている時は、刻みを決めない(粗い図面に小数3桁の線が多く重なったPDF。
    //     全体は 0.001pt 刻みに乗るが、図面の線は 600dpi のまま)
    // 返り値の mixed = 刻みに乗らない線が 1% を超えて混ざっている。bulkQ = 刻みは決められないが、差の 20% 以上が乗っている粗い候補(pt。無ければ null)
    function estimateQuantum(lineDiffs, curveDiffs) {
      const diffs = lineDiffs.length >= 20 ? lineDiffs : lineDiffs.concat(curveDiffs || []);
      const N = diffs.length;
      if (N < 20) return null;
      let minDiff = Infinity;
      for (const d of diffs) if (d > 0 && d < minDiff) minDiff = d;
      if (!isFinite(minDiff)) minDiff = null;
      const MMPT = 72 / 25.4;
      const MM_CANDS = [0.1 * MMPT, 0.01 * MMPT];
      const CANDS = [1, 0.5, 72 / 300, 72 / 600, 0.1, 72 / 1200, 0.05, 72 / 2400, 0.01, 0.001].concat(MM_CANDS).sort((a, b) => b - a);
      const allow = Math.floor(N * 0.01);   // 1% までは外れてよい(文字の飾り等)
      const third = Math.floor(N / 3);      // 多数決: 外れは 1/3 まで
      // q の格子に乗らない差の数。limit を超えたら、そこで数えるのをやめる(超えたことだけ分かればよい)
      const misses = (q, limit) => {
        let bad = 0;
        for (const d of diffs) {
          const r = d / q;
          if (Math.abs(r - Math.round(r)) >= 0.01 && ++bad > limit) break;
        }
        return bad;
      };
      // 差のかなりの部分(20% 以上。差が40個に満たない時は、偶然の偏りと見分けるため 1/3 以上)が乗っている、floor より粗い候補(mm の格子は除く)。
      // floor の刻みに乗るデータは、その k 倍の候補にも偶然 1/k の割合で乗るので、その3倍を超える時だけ数える。
      // badFloor = floor を多数決で採った時の、外れの数(99% が乗っている時は 0)。多数決で採った時は、もう1つ見る: 半分以上が乗っている粗い候補があり、
      // その外れを floor の刻みで説明できない(外れが 1/3 以下に減らない)なら、本当の刻みは粗いほうかもしれない(外れが 1/3 前後の時に、外れの一部が偶然乗った細かい候補を採ってしまうのを防ぐ)
      const bulkOver = (floor, badFloor) => {
        const half = Math.floor(N / 2);
        for (const c of CANDS) {
          if (c <= floor * 1.000001) break;
          if (MM_CANDS.includes(c)) continue;
          const need = Math.max(N >= 40 ? 0.2 : 1 / 3, 3 * floor / c), lim = N - Math.ceil(N * need);
          if (need < 1 && misses(c, lim) <= lim) return c;
          if (badFloor > 0) { const b = misses(c, half); if (b <= half && badFloor * 3 > b) return c; }
        }
        return null;
      };
      for (const q of CANDS) {
        const limit = MM_CANDS.includes(q) ? allow : third;
        const bad = misses(q, limit);
        if (bad > limit) continue;
        if (bad > allow && bad > N * 0.1) {
          const few = Math.max(allow, Math.floor(bad / 3));
          let finer = false;
          for (let m = 2; m <= 5 && !finer; m++) finer = misses(q / m, few) <= few;
          if (finer) continue;   // 外れた差のほとんどは、もっと細かい刻みに乗っている(本当の刻みはそちら。このあとの候補で拾う)
        }
        const keep = bad > allow ? bad + Math.max(allow, 2) : allow;
        let best = q, badBest = bad;
        // 倍数を試すのは、dpi の候補と小数の pt の候補だけ。mm の格子(用紙上 0.1mm・0.01mm)の倍数は試さない。
        // 5mm・10mm の切りのよい寸法で設計した図面は、線の位置が用紙上 0.05mm・0.1mm の倍数に揃う。これは設計の寸法の揃い方であって、PDFに記録する時の丸めの刻みではない
        // (倍数まで広げていた時は、細かく記録されたCADのPDFを「実寸で約 20mm きざみに記録されています」のように、粗いPDFと言っていた)
        if (!MM_CANDS.includes(q)) for (let m = 2; q * m <= 0.75; m++) { const b = misses(q * m, keep); if (b <= keep) { best = q * m; badBest = b; } }
        const bulk = bulkOver(best, bad > allow ? badBest : 0);
        if (bulk) return { q: null, unknown: true, minDiff, bulkQ: bulk };
        return { q: best, unknown: false, minDiff, mixed: bad > allow };
      }
      return { q: null, unknown: true, minDiff, bulkQ: bulkOver(0, 0) };
    }

    // ---- 切り抜き: 矩形(上向きYの pt)で線を切る ----
    const CLIP_EPS = 0.01;   // 切り抜きの縁ちょうどの線を落とさないための余裕(pt)
    function interRect(a, b) {
      if (!a) return b;
      if (!b) return a;
      return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
    }
    // 線分を矩形の内側だけに切る(Liang-Barsky)。全部外なら null
    function clipSeg(x1, y1, x2, y2, c) {
      let t0 = 0, t1 = 1;
      const dx = x2 - x1, dy = y2 - y1;
      const P = [-dx, dx, -dy, dy];
      const Q = [x1 - (c.x0 - CLIP_EPS), (c.x1 + CLIP_EPS) - x1, y1 - (c.y0 - CLIP_EPS), (c.y1 + CLIP_EPS) - y1];
      for (let i = 0; i < 4; i++) {
        if (Math.abs(P[i]) < 1e-12) { if (Q[i] < 0) return null; continue; }
        const r = Q[i] / P[i];
        if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
      return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
    }
    const insideRect = (c, x0, y0, x1, y1) => x0 >= c.x0 - CLIP_EPS && y0 >= c.y0 - CLIP_EPS && x1 <= c.x1 + CLIP_EPS && y1 <= c.y1 + CLIP_EPS;
    const outsideRect = (c, x0, y0, x1, y1) => x1 < c.x0 - CLIP_EPS || y1 < c.y0 - CLIP_EPS || x0 > c.x1 + CLIP_EPS || y0 > c.y1 + CLIP_EPS;
    // 円弧を折れ線の点列に(反時計回り a1→a2、度。用紙上0.05mm以内)。切り抜きで一部が切れる円・円弧に使う
    function arcPoints(cx, cy, r, a1deg, a2deg) {
      const a1 = a1deg * Math.PI / 180;
      let a2 = a2deg * Math.PI / 180;
      while (a2 <= a1) a2 += 2 * Math.PI;
      const step = r > FLAT_TOL ? 2 * Math.acos(1 - FLAT_TOL / r) : Math.PI / 8;
      const n = Math.min(4096, Math.max(2, Math.ceil((a2 - a1) / Math.max(step, 0.001))));
      const pts = [];
      for (let i = 0; i <= n; i++) { const a = a1 + (a2 - a1) * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
      return pts;
    }
    // 切り抜きのパスが「軸に平行な長方形1つ」ならその範囲を返す(それ以外は null = 切れない)
    function rectOfPath(subpaths) {
      if (subpaths.length !== 1) return null;
      const segs = subpaths[0].segs.filter((s) => dist(s.a, s.b) > 1e-9);
      if (!segs.length || segs.some((s) => s.t !== 'L')) return null;
      const v = [segs[0].a].concat(segs.map((s) => s.b));
      if (dist(v[v.length - 1], v[0]) < 1e-6) v.pop();   // 閉じている(最後の点 = 始点)
      if (v.length !== 4) return null;
      let hv = '';
      for (let i = 0; i < 4; i++) {
        const a = v[i], b = v[(i + 1) % 4];
        const h = Math.abs(a.y - b.y) < 1e-4, vt = Math.abs(a.x - b.x) < 1e-4;
        if (h === vt) return null;   // 斜めの辺、または長さ0の辺
        hv += h ? 'H' : 'V';
      }
      if (hv !== 'HVHV' && hv !== 'VHVH') return null;
      const xs = v.map((p) => p.x), ys = v.map((p) => p.y);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }

    async function extractPage(page, occ) {
      const OPS = L.OPS;
      const vp = page.getViewport({ scale: 1 });   // 回転(/Rotate)と CropBox をここで吸収する
      const vpH = vp.height;
      const unit = page.userUnit > 0 ? page.userUnit : 1;   // /UserUnit(座標1 = unit × 1/72 インチ)
      const out = { lines: [], circles: [], arcs: [], texts: [], images: 0, vpW: vp.width, vpH, unit, quantum: null,
        hiddenLayer: false, hiddenTextUnsure: false, nonRectClip: 0, imageAreaPct: 0 };
      const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
      const CLOSE_FIRST = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
      const DISCARD = new Set([OPS.fill, OPS.eoFill, OPS.endPath]);   // 塗りつぶし・切り抜きは線にしない
      const IMAGE = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject,
        OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup,
        OPS.paintInlineImageXObjectGroup, OPS.paintSolidColorImageMask].filter((v) => v !== undefined));
      const UNIT_IMAGE = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => v !== undefined));
      let imgArea = 0;
      const ID = [1, 0, 0, 1, 0, 0];

      // 描画状態(save/restore で退避)。clip は上向きYの pt の矩形(null = 切り抜きなし)
      let gs = { ctm: ID, rgb: [0, 0, 0], dash: [], clip: null };
      const stack = [];
      let full = mul(vp.transform, gs.ctm);
      const toPt = (x, y) => ({ x: full[0] * x + full[2] * y + full[4], y: vpH - (full[1] * x + full[3] * y + full[5]) });   // 上向きY(DXFと同じ向き)
      const setGs = (patch) => { gs = Object.assign({}, gs, patch); if (patch.ctm) full = mul(vp.transform, gs.ctm); };
      const push = () => stack.push(gs);
      const pop = () => { if (stack.length) { gs = stack.pop(); full = mul(vp.transform, gs.ctm); } };
      // 今の座標系での枠 [x0,y0,x1,y1](フォームの BBox・注釈の枠)を切り抜きに重ねる
      const clipToBox = (b) => {
        if (!b || b.length !== 4) return;
        const ps = [toPt(b[0], b[1]), toPt(b[2], b[1]), toPt(b[2], b[3]), toPt(b[0], b[3])];
        const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
        setGs({ clip: interRect(gs.clip, { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }) });
      };
      const pageRect = { x0: 0, y0: 0, x1: vp.width, y1: vpH };
      const clipNow = () => interRect(pageRect, gs.clip);
      // 非表示レイヤ(OCG がオフ)の中は描かない。pdf.js の画面表示と同じ判定
      const mc = [];
      const visibleNow = () => mc.every(Boolean);

      // 取り出した図形の受け口: 用紙と切り抜きの範囲(r)で切ってから記録する。
      // r には「その図形を描いた瞬間」の範囲を渡す。曲線は抽出の最後にまとめて出すので(下の curveJobs)、出す時点の切り抜きを見てはいけない
      const sinkFor = (r) => {
        const sink = {
          line(l) {
            const s = clipSeg(l.x1, l.y1, l.x2, l.y2, r);
            if (s && Math.hypot(s[2] - s[0], s[3] - s[1]) > 1e-6) out.lines.push({ x1: s[0], y1: s[1], x2: s[2], y2: s[3], lt: l.lt, col: l.col });
          },
          polyline(pts, lt, col) {
            for (let i = 1; i < pts.length; i++) sink.line({ x1: pts[i - 1].x, y1: pts[i - 1].y, x2: pts[i].x, y2: pts[i].y, lt, col });
          },
          circle(c) {
            if (insideRect(r, c.cx - c.r, c.cy - c.r, c.cx + c.r, c.cy + c.r)) out.circles.push(c);
            else if (!outsideRect(r, c.cx - c.r, c.cy - c.r, c.cx + c.r, c.cy + c.r)) sink.polyline(arcPoints(c.cx, c.cy, c.r, 0, 360), c.lt, c.col);   // 一部だけ見えている円は、見えている部分を折れ線で
          },
          arc(a) {
            if (insideRect(r, a.cx - a.r, a.cy - a.r, a.cx + a.r, a.cy + a.r)) { out.arcs.push(a); return; }
            if (outsideRect(r, a.cx - a.r, a.cy - a.r, a.cx + a.r, a.cy + a.r)) return;
            const pts = arcPoints(a.cx, a.cy, a.r, a.a1, a.a2);
            if (pts.every((p) => insideRect(r, p.x, p.y, p.x, p.y))) out.arcs.push(a);
            else sink.polyline(pts, a.lt, a.col);
          },
        };
        return sink;
      };

      // 座標の刻みの推定用(直線と曲線を分けて集める)。集めるのは「見えている線として描いたパス」だけ(emitStroke)。
      // 塗りつぶしの面・切り抜きの枠・非表示レイヤは測る相手ではない(塗りの細い長方形が混ざって、刻みを実際より細かく見誤ったことがある)
      const lineDiffs = [], curveDiffs = [];
      const addDiff = (diffs, a, b) => {
        if (diffs.length >= 40000) return;
        const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
        if (dx > 1e-7) diffs.push(dx);
        if (dy > 1e-7) diffs.push(dy);
      };
      // 組み立て中のパス。canvas と同じく restore では捨てず、描画命令(stroke/fill/endPath)で確定・破棄する
      // (pdf-lib の円などは「組み立て→restore→stroke」の順で来る。実測済み)
      let subpaths = [], cur = null, pendingClip = null;
      const startSub = (p) => { subpaths.push({ segs: [], start: p }); cur = p; };
      const lineTo = (p) => { if (!cur) { startSub(p); return; } subpaths[subpaths.length - 1].segs.push({ t: 'L', a: cur, b: p }); cur = p; };
      const curveTo = (c1, c2, p) => { if (!cur) startSub(c1); subpaths[subpaths.length - 1].segs.push({ t: 'C', a: cur, c1, c2, b: p }); cur = p; };
      const closeSub = () => {
        const sp = subpaths[subpaths.length - 1];
        if (!sp || !cur) return;
        if (dist(cur, sp.start) > 1e-9) sp.segs.push({ t: 'L', a: cur, b: sp.start });
        cur = sp.start;
      };
      const appendPath = (ops, a) => {
        let i = 0;
        for (const op of ops) {
          if (op === OPS.moveTo) { startSub(toPt(a[i], a[i + 1])); i += 2; }
          else if (op === OPS.lineTo) { lineTo(toPt(a[i], a[i + 1])); i += 2; }
          else if (op === OPS.curveTo) { curveTo(toPt(a[i], a[i + 1]), toPt(a[i + 2], a[i + 3]), toPt(a[i + 4], a[i + 5])); i += 6; }
          else if (op === OPS.curveTo2) { const c2 = toPt(a[i], a[i + 1]), p = toPt(a[i + 2], a[i + 3]); curveTo(cur || c2, c2, p); i += 4; }   // v: 1つ目の制御点=現在点
          else if (op === OPS.curveTo3) { const c1 = toPt(a[i], a[i + 1]), p = toPt(a[i + 2], a[i + 3]); curveTo(c1, p, p); i += 4; }            // y: 2つ目の制御点=終点
          else if (op === OPS.closePath) { closeSub(); }
          else if (op === OPS.rectangle) {
            const x = a[i], y = a[i + 1], w = a[i + 2], h = a[i + 3]; i += 4;
            startSub(toPt(x, y)); lineTo(toPt(x + w, y)); lineTo(toPt(x + w, y + h)); lineTo(toPt(x, y + h)); closeSub();
          } else { break; }   // 未知の命令は引数の数が分からないので、このパスの残りは読まない(安全側)
        }
      };
      // 曲線は、その場では円・円弧にしない。同じ円かどうかの判定に座標の刻みが要るが、刻みはページを最後まで読まないと分からないため、
      // 描いた瞬間の色・線種・切り抜きの範囲と一緒に覚えておき、抽出の最後にまとめて出す。
      // (emitStroke は見えている時しか呼ばれないので、非表示レイヤの曲線はここに入らない)
      const curveJobs = [];
      const emitStroke = () => {
        const lt = linetypeOf(gs.dash), col = aciOf(gs.rgb), clip = clipNow();   // 色・線種・切り抜きは「描いた瞬間」の状態で決まる
        const sink = sinkFor(clip);
        for (const sp of subpaths) {
          let run = [];
          for (const s of sp.segs) {
            addDiff(s.t === 'C' ? curveDiffs : lineDiffs, s.a, s.b);
            if (s.t === 'C') { run.push(s); continue; }
            if (run.length) { curveJobs.push({ run, lt, col, clip }); run = []; }
            if (dist(s.a, s.b) > 1e-6) sink.line({ x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, lt, col });
          }
          if (run.length) curveJobs.push({ run, lt, col, clip });
        }
      };
      // パスを使い終えた時: 保留中の切り抜き(W)を反映してからパスを捨てる(PDFの仕様: W は描画の後から効く)
      const consumePath = () => {
        if (pendingClip === 'nonrect') out.nonRectClip++;   // 長方形以外の切り抜きでは切れない(画面で知らせる)
        else if (pendingClip) setGs({ clip: interRect(gs.clip, pendingClip) });
        pendingClip = null;
        subpaths = []; cur = null;
      };

      const opList = await page.getOperatorList();
      const fns = opList.fnArray, args = opList.argsArray;
      // ページ本体の範囲(この後ろは注釈)。文字の非表示判定の照合は本体だけで行う
      let pageEnd = fns.length;
      for (let k = 0; k < fns.length; k++) {
        if (fns[k] === OPS.beginAnnotation) { pageEnd = (k > 0 && fns[k - 1] === OPS.beginMarkedContentProps) ? k - 1 : k; break; }
      }
      const ocVis = [];   // ページ本体に現れたレイヤ印の表示/非表示(出てきた順)
      for (let k = 0; k < fns.length; k++) {
        const fn = fns[k], ar = args[k];
        if (fn === OPS.constructPath) appendPath(ar[0], ar[1]);
        else if (STROKE.has(fn)) { if (CLOSE_FIRST.has(fn)) closeSub(); if (visibleNow()) emitStroke(); consumePath(); }
        else if (DISCARD.has(fn)) consumePath();
        else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = rectOfPath(subpaths) || 'nonrect';
        else if (fn === OPS.save) push();
        else if (fn === OPS.restore) pop();
        else if (fn === OPS.transform) setGs({ ctm: mul(gs.ctm, ar) });
        else if (fn === OPS.paintFormXObjectBegin) {   // フォーム: 行列を掛けて BBox で切り抜く(canvas と同じ)
          push();
          if (ar && ar[0]) setGs({ ctm: mul(gs.ctm, ar[0]) });
          if (ar && ar[1]) clipToBox(ar[1]);
        }
        else if (fn === OPS.paintFormXObjectEnd) pop();
        else if (fn === OPS.beginAnnotation) {   // 注釈の外観: 基準の座標系で枠に切り抜き、transform × matrix で置く(canvas と同じ)
          push();
          setGs({ ctm: ID, rgb: [0, 0, 0], dash: [] });
          if (ar && ar[1]) clipToBox(ar[1]);
          setGs({ ctm: mul(ar && ar[2] ? ar[2] : ID, ar && ar[3] ? ar[3] : ID) });
        }
        else if (fn === OPS.endAnnotation) pop();
        else if (fn === OPS.beginMarkedContentProps) {
          let vis = true;
          if (ar && ar[0] === 'OC') {
            if (occ && ar[1]) { try { vis = occ.isVisible(ar[1]) !== false; } catch (_) { vis = true; } }
            if (k < pageEnd) ocVis.push(vis);
          }
          if (!vis) out.hiddenLayer = true;
          mc.push(vis);
        }
        else if (fn === OPS.beginMarkedContent) mc.push(true);
        else if (fn === OPS.endMarkedContent) mc.pop();
        else if (fn === OPS.setStrokeRGBColor) setGs({ rgb: [ar[0], ar[1], ar[2]] });
        else if (fn === OPS.setDash) setGs({ dash: ar && ar[0] ? Array.from(ar[0]) : [] });
        else if (fn === OPS.setGState && ar && ar[0]) {
          for (const kv of ar[0]) if (kv && kv[0] === 'D') setGs({ dash: kv[1] && kv[1][0] ? Array.from(kv[1][0]) : [] });
        } else if (IMAGE.has(fn)) {
          out.images++;
          // 画像が用紙のどれくらいを占めるか。画像(貼り付けた絵・写真・スキャン)の中の図は線として取り出せないので、画面で知らせる
          // (実データで発覚: Excel に図面の絵を貼ったPDFは、罫線と文字だけが変換され、肝心の図が無言で抜けていた)
          if (UNIT_IMAGE.has(fn) && visibleNow()) {
            const ps = [toPt(0, 0), toPt(1, 0), toPt(1, 1), toPt(0, 1)];   // 画像は「1×1 の正方形」を今の座標系で置いたもの
            const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
            const r = interRect(clipNow(), { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
            if (r.x1 > r.x0 && r.y1 > r.y0) imgArea += (r.x1 - r.x0) * (r.y1 - r.y0);
          }
        }
      }
      out.quantum = estimateQuantum(lineDiffs, curveDiffs);
      // 座標の刻みが分かったので、覚えておいた曲線を円・円弧・折れ線にする(切り抜きは、描いた瞬間の範囲で)
      // (刻みを決められなくても、かなりの部分が乗っている粗い候補があれば、それを使う。同じ円とみなす許容が広がるだけで、円・円弧として出してよいかは、まとめた後の検証で決まる)
      const quantumPt = (out.quantum && (out.quantum.q || out.quantum.bulkQ)) || 0;
      for (const j of curveJobs) emitCurves(j.run, j.lt, j.col, sinkFor(j.clip), quantumPt);
      out.imageAreaPct = Math.min(100, Math.round(imgArea / (vp.width * vpH) * 100));

      // 文字(アウトライン化された文字は塗りつぶしなので、線にも文字にもならない)
      // pdf.js の文字取り出しは非表示レイヤを区別しないので、レイヤ印の並びを描画命令と照合して非表示の文字を除く。
      // フォーム単位で非表示の時などは印の数が合わず照合できない → 文字は残し、画面で知らせる
      let tc = { items: [] };
      try { tc = await page.getTextContent({ includeMarkedContent: true }); } catch (_) { /* 文字が読めないページは線だけ変換 */ }
      const isOcItem = (it) => it && it.type === 'beginMarkedContentProps' && it.tag === 'OC';
      const anyHidden = ocVis.some((v) => !v);
      const canFilter = anyHidden && tc.items.filter(isOcItem).length === ocVis.length;
      if (anyHidden && !canFilter) out.hiddenTextUnsure = true;
      const tmc = [];
      let oi = 0;
      for (const it of tc.items) {
        if (!it) continue;
        if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') { tmc.push(isOcItem(it) && canFilter ? ocVis[oi++] : true); continue; }
        if (it.type === 'endMarkedContent') { tmc.pop(); continue; }
        if (!it.str || !it.transform || !tmc.every(Boolean)) continue;
        const s = Array.from(it.str).filter((ch) => { const c = ch.codePointAt(0); return c >= 0x20 && c !== 0x7F; }).join('');
        if (!s.trim()) continue;
        const m = L.Util.transform(vp.transform, it.transform);
        const h = Math.hypot(m[2], m[3]);
        if (!(h > 0.01)) continue;
        const x = m[4], y = vpH - m[5];
        if (!insideRect(pageRect, x, y, x, y)) continue;   // 用紙の外(見えていない所)の文字は出さない
        let rot = deg(-Math.atan2(m[1], m[0]));
        if (rot > 359.99) rot = 0;
        out.texts.push({ x, y, h, rot, s });
      }
      return out;
    }

    // ===================== 2. Shift-JIS(CP932)符号化 =====================
    // 外部ライブラリを使わず、ブラウザ内蔵の TextDecoder で全符号を1回デコードして逆引き表を作る(オフラインで動く)
    let cp932 = null;
    function cp932Table() {
      if (cp932) return cp932;
      const dec = new TextDecoder('shift_jis');
      const map = new Map();
      for (let b = 0xA1; b <= 0xDF; b++) {   // 半角カナ
        const ch = dec.decode(new Uint8Array([b]));
        if (ch.length === 1 && ch.codePointAt(0) !== 0xFFFD && !map.has(ch)) map.set(ch, [b]);
      }
      const leads = [];
      for (let l = 0x81; l <= 0x9F; l++) leads.push(l);
      for (let l = 0xE0; l <= 0xFC; l++) if (l !== 0xED && l !== 0xEE) leads.push(l);
      leads.push(0xED, 0xEE);   // NEC選定IBM拡張は後回し(同じ文字は IBM拡張 0xFA〜 の符号を優先する)
      const buf = new Uint8Array(2);
      for (const l of leads) {
        for (let t = 0x40; t <= 0xFC; t++) {
          if (t === 0x7F) continue;
          buf[0] = l; buf[1] = t;
          const ch = dec.decode(buf);
          if (ch.length === 1 && ch.codePointAt(0) !== 0xFFFD && !map.has(ch)) map.set(ch, [l, t]);
        }
      }
      // Windows(CP932)と JIS の対応差で、PDFに入りがちな文字の別名(波ダッシュ・双柱・マイナス・セント・ポンド・否定・ダッシュ)
      const ALIAS = [[0xFF5E, 0x301C], [0x2225, 0x2016], [0xFF0D, 0x2212], [0xFFE0, 0x00A2],
        [0xFFE1, 0x00A3], [0xFFE2, 0x00AC], [0x2014, 0x2015]].map((p) => p.map((c) => String.fromCodePoint(c)));
      for (const [a, b] of ALIAS) {
        if (map.has(a) && !map.has(b)) map.set(b, map.get(a));
        if (map.has(b) && !map.has(a)) map.set(a, map.get(b));
      }
      const YEN = String.fromCodePoint(0x00A5), OVERLINE = String.fromCodePoint(0x203E);
      if (!map.has(YEN)) map.set(YEN, [0x5C]);   // 円記号(日本語環境では 0x5C が円記号として表示される)
      if (!map.has(OVERLINE)) map.set(OVERLINE, [0x7E]);
      cp932 = map;
      return map;
    }
    // PDFの生成器(Chromium+游ゴシック・メイリオ等)は、漢字を「部首用の別の文字コード」で記録することがある(「文」→ U+2F42 など約230字。
    // JIS の全文字を実際にPDFにして読み戻す全数調査で確認。Jw_cad 実機で「縦の文字」が「縦の?字」になって発覚)。
    // 見た目は同じ字なので、Jw_cad で扱える元の字に戻す。ほとんどは NFKC で戻る。
    // NFKC で戻らないもの・旧字体になってしまうもの(戸→戶、黒→黑)だけ表で持つ
    const CHAR_FIX = new Map([
      [0x2F3E, 0x6238], [0x2FCA, 0x9ED2],                                                       // 戸・黒
      [0x2E8E, 0x5140], [0x2E90, 0x5C22], [0x2E92, 0x5DF3], [0x2E93, 0x5E7A], [0x2E94, 0x5F51],   // 兀 尢 巳 幺 彑
      [0x2E99, 0x6535], [0x2E9B, 0x65E1], [0x2EA0, 0x6C11], [0x2EC1, 0x864E], [0x2EC4, 0x897F],   // 攵 旡 民 虎 西
      [0x2EC6, 0x89D2], [0x2ED1, 0x9577], [0x2ED7, 0x96E8], [0x2ED8, 0x9752], [0x2EDD, 0x98DF],   // 角 長 雨 青 食
      [0x2EE3, 0x9AA8], [0x2EE4, 0x9B3C], [0x2EE8, 0x9EA6], [0x2EE9, 0x9EC4], [0x2EEB, 0x6589],   // 骨 鬼 麦 黄 斉
      [0x2EED, 0x6B6F], [0x2EEF, 0x7ADC], [0x2EF1, 0x9F9C], [0x2EF2, 0x4E80],                     // 歯 竜 龜 亀
      [0xFE13, 0xFF1A], [0xFE14, 0xFF1B], [0xFE15, 0xFF01], [0xFE16, 0xFF1F],                     // 縦書き用の ： ； ！ ？(全角のまま戻す)
      [0x02BB, 0x2018], [0x02BC, 0x2019], [0x2044, 0x2F],                                         // 引用符 ‘ ’ と、分数の斜線
    ]);
    const fbCache = new Map();
    // 表に無い文字の救済: 上の表 → NFKC(互換の字を標準の字に直す)の順で試し、全部 Jw_cad で扱える字になった時だけ採用する
    function fallbackBytes(ch, tbl, depth) {
      if (depth === 0 && fbCache.has(ch)) return fbCache.get(ch);
      let res = null;
      const fix = CHAR_FIX.get(ch.codePointAt(0));
      const cand = fix ? String.fromCodePoint(fix) : ch.normalize('NFKC');
      if (cand !== ch && depth < 2) {
        const out = [];
        for (const c of cand) {
          const n = c.codePointAt(0);
          if (n < 0x80) { if (n < 0x20 || n === 0x7F) { out.length = 0; break; } out.push(n); continue; }
          const b = tbl.get(c) || fallbackBytes(c, tbl, depth + 1);
          if (!b) { out.length = 0; break; }
          for (const x of b) out.push(x);
        }
        if (out.length && out.length <= 32) res = out;
      }
      if (depth === 0) fbCache.set(ch, res);
      return res;
    }
    function encodeCP932(str) {
      const tbl = cp932Table();
      let out = new Uint8Array(str.length * 2 + 64);
      let n = 0, bad = 0;
      for (const ch of str) {
        if (n + 40 > out.length) { const g = new Uint8Array(out.length * 2 + 64); g.set(out); out = g; }   // 救済で1文字が複数文字に広がる分(最大32バイト)
        const c = ch.codePointAt(0);
        if (c < 0x80) { out[n++] = c; continue; }
        const b = tbl.get(ch) || fallbackBytes(ch, tbl, 0);
        if (b) { for (const x of b) out[n++] = x; } else { out[n++] = 0x3F; bad++; }   // 表せない文字は「?」(件数を画面に出す)
      }
      return { bytes: out.slice(0, n), bad };
    }

    // ===================== 3. DXF 書き出し(R12) =====================
    const LTYPES = [
      { name: 'CONTINUOUS', desc: 'Solid line', pat: [] },
      { name: 'DASHED', desc: 'Dashed', pat: [12.7, -6.35] },
      { name: 'CENTER', desc: 'Center', pat: [31.75, -6.35, 6.35, -6.35] },
    ];
    const LAYERS = ['0', 'SEN', 'EN', 'MOJI'];
    function fnum(v) {
      if (!isFinite(v)) v = 0;
      let s = v.toFixed(4);
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
      return s === '-0' ? '0' : s;
    }
    function buildDxf(g, k) {
      const o = [];
      const P = (c, v) => { o.push(String(c)); o.push(String(v)); };
      P(0, 'SECTION'); P(2, 'HEADER'); P(9, '$ACADVER'); P(1, 'AC1009'); P(0, 'ENDSEC');
      P(0, 'SECTION'); P(2, 'TABLES');
      P(0, 'TABLE'); P(2, 'LTYPE'); P(70, LTYPES.length);
      for (const t of LTYPES) {
        P(0, 'LTYPE'); P(2, t.name); P(70, 0); P(3, t.desc); P(72, 65); P(73, t.pat.length);
        P(40, fnum(t.pat.reduce((s, v) => s + Math.abs(v), 0)));
        for (const v of t.pat) P(49, fnum(v));
      }
      P(0, 'ENDTAB');
      P(0, 'TABLE'); P(2, 'LAYER'); P(70, LAYERS.length);
      for (const n of LAYERS) { P(0, 'LAYER'); P(2, n); P(70, 0); P(62, 7); P(6, 'CONTINUOUS'); }
      P(0, 'ENDTAB'); P(0, 'ENDSEC');
      P(0, 'SECTION'); P(2, 'ENTITIES');
      for (const l of g.lines) {
        P(0, 'LINE'); P(8, 'SEN'); P(6, l.lt); P(62, l.col);
        P(10, fnum(l.x1 * k)); P(20, fnum(l.y1 * k)); P(11, fnum(l.x2 * k)); P(21, fnum(l.y2 * k));
      }
      for (const c of g.circles) {
        P(0, 'CIRCLE'); P(8, 'EN'); P(6, c.lt); P(62, c.col); P(10, fnum(c.cx * k)); P(20, fnum(c.cy * k)); P(40, fnum(c.r * k));
      }
      for (const a of g.arcs) {
        P(0, 'ARC'); P(8, 'EN'); P(6, a.lt); P(62, a.col); P(10, fnum(a.cx * k)); P(20, fnum(a.cy * k)); P(40, fnum(a.r * k));
        P(50, fnum(a.a1)); P(51, fnum(a.a2));
      }
      for (const t of g.texts) {
        P(0, 'TEXT'); P(8, 'MOJI'); P(62, 7); P(10, fnum(t.x * k)); P(20, fnum(t.y * k)); P(40, fnum(t.h * k)); P(1, t.s);
        if (t.rot > 0.01) P(50, fnum(t.rot));
      }
      P(0, 'ENDSEC'); P(0, 'EOF');
      const enc = encodeCP932(o.join('\r\n') + '\r\n');
      return { bytes: enc.bytes, bad: enc.bad };
    }

    // ===================== 3.5 精度の判定(画面に依らない計算。テストから直接呼べる) =====================
    // 誤差は2種類: (a) 縮尺の誤差 = 長さに比例する。(b) 測る線の両端の丸め = 長さに関係なく残る「床」。
    // (a) は標準の縮尺ちょうどを採用できればゼロになる。(b) は消せないので、正直に画面へ出す(docs/plans/pdf2dxf-stage1-spec.md A)

    // 座標の細かさの分類。k = 実寸mm / pt、1目盛りの実寸 g = q × k
    //   'few'     線が少なくて刻みを調べられない
    //   'grid'    刻みが分かり、1目盛りが実寸 0.05mm 以上(プリンタ経由のPDFなど)
    //   'fine'    十分に細かい(1目盛りが実寸 0.05mm 未満)
    //   'unknown' 刻みが分からず、細かいとも言えない(標準の縮尺の自動採用はしない)
    function precisionClass(quantum, k) {
      if (!quantum) return 'few';
      if (quantum.q) return quantum.q * k >= 0.05 ? 'grid' : 'fine';
      // 刻みは決められなくても、線のかなりの部分(20% 以上)が粗い格子に乗っているPDFは、いちばん小さい差が細かくても「十分に細かい」とは言わない
      if (quantum.bulkQ > 0 && quantum.bulkQ * k >= 0.05) return 'unknown';
      return (quantum.minDiff > 0 && quantum.minDiff * k < 0.05) ? 'fine' : 'unknown';
    }

    // ルールR: 寸法2点で測った縮尺が、標準の縮尺と「測り方の誤差の範囲で」一致するかを決める。
    //   den = 測った縮尺の分母、u = 測り方の相対誤差(1目盛り ÷ 合わせた2点間の距離。吸着なしなら画面1ピクセルぶんも見る)
    //   nominals = 標準の縮尺の分母(縮尺プルダウンと同じ集合)、classUnknown = 座標の細かさを確かめられないPDF
    // 返り値 kind: 'short'(u が大きすぎて判定しない)・'adopt'(標準値ちょうどを採用)・'unknown'(確かめられないPDFなので、一致するともしないとも言わない)・'measured'(一致しない)
    // 許容は max(1.5u, 0.03%)。2u や 4u に緩めると、縮小されたPDFを標準の縮尺と取り違える(モンテカルロで確認済み。緩めないこと)
    function nominalDecision(o) {
      const den = o.den, u = o.u;
      let nominal = null, rel = Infinity;
      for (const n of (o.nominals || [])) {
        if (!(n > 0)) continue;
        const r = Math.abs(den / n - 1);
        if (r < rel) { rel = r; nominal = n; }
      }
      const U_MAX = 0.0015, tol = Math.max(1.5 * u, 0.0003);
      let kind;
      if (!(u <= U_MAX)) kind = 'short';
      else if (nominal !== null && rel <= tol) kind = o.classUnknown ? 'unknown' : 'adopt';
      // 刻みが分からないPDFは u を小さく見積もっているおそれがある。いちばん緩い許容(1.5 × 0.15%)に入るうちは「一致しない」とも言い切らない
      else if (o.classUnknown && nominal !== null && rel <= 1.5 * U_MAX) kind = 'unknown';
      else kind = 'measured';
      return { kind, nominal, rel, tol };
    }

    // 測った長さの誤差の目安(mm)= 端点の床 + 長さ × 縮尺の相対誤差。
    //   床 = q × k ×(|cosθ| + |sinθ|)(θ = 測った線の向き。軸に平行なら q × k)。吸着していない点は、1点ごとに画面1ピクセルぶん(k ÷ ds)を足す
    //   relScale = 縮尺の相対誤差(標準の縮尺を採用中・プルダウンで選んだ時は 0)、len = 測った長さ(実寸mm)
    function measureError(o) {
      const q = o.q > 0 ? o.q : 0, k = o.k > 0 ? o.k : 0, th = o.theta || 0;
      const loose = o.unsnappedCount > 0 && o.ds > 0 ? o.unsnappedCount * k / o.ds : 0;
      const floor = q * k * (Math.abs(Math.cos(th)) + Math.abs(Math.sin(th))) + loose;
      const scale = (o.len > 0 ? o.len : 0) * (o.relScale > 0 ? o.relScale : 0);
      return { floor, scale, total: floor + scale };
    }
    // 確かめる(検算): 図面に書いてある寸法 want と、測った実寸 real の突き合わせ。e = 誤差の目安(mm)、known = 座標の細かさが分かるPDFか。
    //   'ok' 一致 / 'ng' 合わない / 'na' 判定できない(差だけを知らせる)
    // 座標の細かさが分からないPDF(unknown・few)は床を計算できないので、差が小さいうちは一致とも不一致とも言い切らない
    // (600dpi の図を後から縮めたPDFで、正しい寸法の約半分が「合いません」になっていた)。
    // 「明らかに大きい」= 長さの 0.3% と、300dpi 相当の1目盛り(斜めの線のぶん √2 を含む)の、大きいほうを超える差。通り芯の交点と壁の角の取り違え(約60mm)や、縮小されたPDF(数%)は、これで拾える
    const UNKNOWN_FLOOR_PT = 72 / 300 * Math.SQRT2, UNKNOWN_REL = 0.003;
    function verdictOf(o) {
      const gap = Math.abs(o.real - o.want);
      const limit = o.known ? o.e + 0.5 : o.e + Math.max(UNKNOWN_REL * o.want, UNKNOWN_FLOOR_PT * o.k);
      return { gap, state: gap <= limit ? (o.known ? 'ok' : 'na') : 'ng' };
    }
    window.__p2dTest = { encodeCP932, buildDxf, aciOf, linetypeOf, estimateQuantum, precisionClass, nominalDecision, measureError, verdictOf, scaleLabel: (k, u) => scaleLabel(k, u),
      // JWW 書き出し(第2段)。テストからは、保存せずに中身だけを取り出せるようにする
      buildJww: () => buildJww(curPg()), primsOf: (g, u) => primsOf(g, u), paperFor: (g, p, u) => paperFor(g, p, u), denOf: (pg, sc) => denOf(pg, sc),
      dxfIn: () => dxfIn, geomFromPrims: (d, n) => geomFromPrims(d, n), autoDen: (d) => autoDen(d),
      readDimScale: (g, u) => readDimScale(g || curPg().geom, u === undefined ? unitOf(curPg()) : u), dimScaleOf: () => dimScaleOf(curPg()),
      snapCandidates: (p, rad) => snapCandidates(curPg(), p, rad),
      // 連続するベジェ曲線の列を、円・円弧・折れ線にした結果(切り抜きなし)。q = 座標の刻み(pt)。乱数の総当たりの確認用
      fitCurves: (run, q) => {
        const o = { lines: [], circles: [], arcs: [] };
        emitCurves(run, 'CONTINUOUS', 7, { line: (l) => o.lines.push(l), circle: (c) => o.circles.push(c), arc: (a) => o.arcs.push(a) }, q);
        return o;
      },
      // カーソルを画面の座標 (x, y) に置いた時の1コマぶんの処理(候補点の計算+点の表示+ルーペ)を、その場で実行する(速さの確認用)
      hoverAt: (x, y) => { st.cursor = { x, y, touch: false }; updateHover(); } };

    // ===================== 4. 画面 =====================
    const fmtInt = (n) => n.toLocaleString('ja-JP');
    const fmtMm = (v) => (v >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
    const pad2 = (n) => String(n).padStart(2, '0');
    const curPg = () => st.pages[st.pageIndex];
    // cal = 縮尺の合わせ方の記録。寸法2点: { d, real, snapped, u, denMeasured, nominal, adopted, kind } / プルダウン: { preset:true, nominal }
    // prev = 検算から「この寸法で合わせ直す」を押す直前の縮尺 { k, kLabel, cal, kFrom }(1つだけ覚えておき、戻せるようにする)
    const newPg = () => ({ geom: null, k: null, kLabel: '', kFrom: null, cal: null, prev: null, index: null });
    const unitOf = (pg) => (pg && pg.geom && pg.geom.unit) || 1;   // /UserUnit(ふつうは 1)
    const paperMm = (d) => d * PT2MM * unitOf(curPg());          // 座標の長さ → 用紙上のmm
    const isScanned = (g) => g.lines.length + g.circles.length + g.arcs.length === 0 && g.images > 0;
    const isEmpty = (g) => g.lines.length + g.circles.length + g.arcs.length + g.texts.length === 0;
    const ready = () => !!(st.pdf && !st.rendering && curPg() && curPg().geom);

    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // 画面の外にある時だけ、見える所まで静かにスクロールする(見えている時は動かさない)。止まる位置の余白は styles.css の scroll-margin(16px)。
    // 画面の低い窓(ノートパソコンなど)では、図面をクリックしている間、縮尺の欄が画面の上へ出ている。次に使う欄・いまの状態の行を、操作のたびに見える所へ戻すために使う
    function bringIntoView(el) {
      if (!el) return;
      const rc = el.getBoundingClientRect();
      if (!(rc.height > 0)) return;   // 表示されていない
      // (注意の文のフェードインは 2px 上から始まるので、その分の余裕を見て判定する)
      if (rc.top >= 4 && rc.bottom <= window.innerHeight - 4) return;
      try { el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (_) { /* 無視 */ }
    }
    function setLoadMsg(text, type) {
      if (!loadMsg) return;
      loadMsg.textContent = text || '';
      loadMsg.className = 'p2d-loadmsg' + (type ? ' ' + type : '');
    }
    // 保存の結果は、保存ボタンの横(出力欄)に出す。caution = 結果の下に、注意色の別の行として添える文
    function setNote(text, type, caution) { st.note = text ? { text, type, caution: caution || '' } : null; refreshUI(); }
    // 縮尺の欄と図面の上の操作から出る結果・エラーは、縮尺の欄の中(操作した場所のそば)に出す。
    // 保存ボタンの横に出していた時は画面の外になり、「押しても何も起きない」ように見えていた
    function setScaleNote(text, type) {
      st.scaleNote = text ? { text, type } : null;
      refreshUI();
      if (!text) return;
      // 同じ場所の文が入れ替わっただけの時も気付けるよう、フェードインをやり直す。画面の外にある時は、見える所までスクロールする
      scaleNoteEl.style.animation = 'none'; void scaleNoteEl.offsetWidth; scaleNoteEl.style.animation = '';
      bringIntoView(scaleNoteEl);
    }
    const clearNotes = () => { st.note = null; st.scaleNote = null; };

    // 縮尺の表示名: 分母が整数から 0.05 以内なら「1/100」、それ以外は「約 1/100.4」(1/100 と言い切らない)
    function scaleLabel(k, unit) {
      const den = k / (PT2MM * (unit || 1));
      const r = Math.round(den);
      return (r >= 1 && Math.abs(den - r) < 0.05) ? '1/' + r : '約 1/' + den.toFixed(1);
    }
    // 寸法2点で測った縮尺の表示名(必ず「約」を付ける)。小数1桁だと標準値ちょうどに見えてしまう時だけ2桁にする(99.98 を「100.0」と書かない)
    function measuredDen(den) {
      const s = den.toFixed(1);
      return s.endsWith('.0') && Math.abs(den - Math.round(den)) >= 0.005 ? den.toFixed(2) : s;
    }
    function measuredLabel(den) { return '約 1/' + measuredDen(den); }
    // 計算に使う座標の刻み(pt)。刻みが分からないPDFは 0(床0。判定の許容は下限値 0.03% が効く)
    const calcQ = (pg) => (pg && pg.geom && pg.geom.quantum && pg.geom.quantum.q) || 0;
    // いまの縮尺に残っている相対誤差。標準の縮尺ちょうどを採用中・プルダウンで選んだ時は 0、測った値を使っている時は合わせた時の u
    const relScaleOf = (pg) => (pg && pg.cal && !pg.cal.preset && !pg.cal.adopted && pg.cal.u > 0 ? pg.cal.u : 0);
    const nominalList = () => Array.from(presetSel.options).map((o) => parseFloat(o.value)).filter((v) => v > 0);
    // 打ち込まれた縮尺の分母。受け付けるのは 0.01〜100000 の有限の数だけ(0・負・桁外れの値で図面が消えるのを防ぐ)
    const DEN_MIN = 0.01, DEN_MAX = 100000;
    function readDen() {
      const v = parseFloat(denInput.value);
      if (!isFinite(v) || v <= 0) return { ok: false, why: '縮尺の分母を入れてください(1/100 なら「100」)。' };
      if (v < DEN_MIN || v > DEN_MAX) return { ok: false, why: '縮尺の分母は ' + DEN_MIN + ' から ' + fmtInt(DEN_MAX) + ' までの数にしてください。' };
      return { ok: true, den: v };
    }
    // 分母を画面の文にする(100 → 「1/100」、103.14 → 「1/103.14」)
    const denText = (d) => '1/' + (Math.abs(d - Math.round(d)) < 1e-9 ? String(Math.round(d)) : String(d));
    // 誤差の表示: 0.5mm 未満は「±1mm未満」
    const errText = (mm) => (mm < 0.5 ? '±1mm未満' : '±' + (mm < 10 ? mm.toFixed(1) : String(Math.round(mm))) + 'mm');
    const fmtGap = (mm) => (mm < 10 ? Math.round(mm * 10) / 10 : Math.round(mm)).toLocaleString('ja-JP');

    // cal の内容から k と表示名を決める(採用・測った値の切り替えでも使う)
    function applyCal(pg) {
      const c = pg.cal;
      if (c.adopted) {
        pg.k = PT2MM * unitOf(pg) * c.nominal;
        pg.kLabel = '1/' + c.nominal + '(寸法 ' + fmtMm(c.real) + 'mm で確認。標準の縮尺ちょうどを採用)';
      } else {
        pg.k = c.real / c.d;
        // 縮尺の行は事実だけにする。標準の縮尺と一致しなかった理由と次の一手は、下の注意の行に出す(calNoteText)
        pg.kLabel = measuredLabel(c.denMeasured) + '(寸法 ' + fmtMm(c.real) + 'mm で測った値)';
      }
    }
    // 寸法2点で縮尺を合わせる(「この長さで合わせる」と、検算からの「この寸法で合わせ直す」の共通処理)。だめな時は理由の文を返す
    function calibrate(pg, picks, real) {
      if (!(real > 0)) return '実際の長さを mm で入力してください。';
      const d = dist(picks[0], picks[1]);
      if (!(d > 0.5)) return TOO_CLOSE;
      const kM = real / d, loose = picks.filter((p) => !p.snapped).length;
      const uGrid = calcQ(pg) / d;
      const u = loose ? Math.max(uGrid, (1 / st.ds) / d) : uGrid;   // 吸着していない点があれば、画面1ピクセルぶんの誤差を見込む
      const den = kM / (PT2MM * unitOf(pg));
      const cls = precisionClass(pg.geom.quantum, kM);
      const dec = nominalDecision({ den, u, classUnknown: cls === 'unknown' || cls === 'few', nominals: nominalList() });
      // 吸着していない点が1つでもあれば、標準の縮尺かどうかは判定しない(採用もしないし、「一致しません」とも言わない)。
      // 吸着なしの誤差を「画面1ピクセルぶん」と見込むだけでは、人の手のずれ(数ピクセル)を覆えない。用紙幅の 3/4 を超える長い寸法を
      // 線の途中のクリックで合わせると、0.5% 縮んだPDFを 1〜2割の確率で「1/100 ちょうど」と取り違えた(実画面で再現)。縮尺が分かっている人は「縮尺を選ぶ」で指定できる。
      // 寸法が短い・PDFの細かさが分からない、という別の理由がある時は、そちらを知らせる(吸着なしの注意は、どの場合も添える)
      const kind = loose && (dec.kind === 'adopt' || dec.kind === 'measured' || (dec.kind === 'short' && uGrid <= 0.0015)) ? 'loose' : dec.kind;
      pg.cal = { d, real, snapped: loose === 0, u, denMeasured: den, nominal: dec.nominal, adopted: kind === 'adopt', kind };
      pg.kFrom = null;
      applyCal(pg);
      return null;
    }
    // 縮尺の表示の下に出し続ける説明(判定できなかった理由・吸着なしで合わせた注意)
    const LOOSE_NOTE = '線の端や交点に吸い付いていない点で合わせています。';
    const LOOSE_SAVED = '線の端や交点に吸い付いていない点で合わせたため、誤差が大きい可能性があります。';   // 保存した後の案内に添える文(結果どうなるかまで書く)
    const TOO_CLOSE = '2点が近すぎます。もっと離れた2点を選んでください。';
    const SHORT_DIM = '短い寸法です。図面にもっと長い寸法があれば、そちらで合わせると誤差が小さくなります(このままでも合わせられます)。';
    const shortScale = (label) => String(label || '').split('(')[0];   // 「1/100(選んだ縮尺)」→「1/100」
    function calNoteText(pg) {
      const c = pg && pg.k ? pg.cal : null;
      if (!c || c.preset) return '';
      const out = [];
      // 標準の縮尺と一致しない理由は、縮小されたPDFとは限らない(点の取り違え・寸法の打ち間違い・一覧に無い縮尺 1/150 など)。PDFのせいと言い切らず、まず確かめることを案内する
      // 例に出す標準の縮尺は、測った値にいちばん近いもの(1/50 の図面に「1/100 など」と出さない)。
      // ほかのページから写した縮尺では、このページでは何もクリックしていないので、「クリックした2点を確かめて」とは言わない
      const near = '1/' + (c.nominal || 100);
      if (c.kind === 'measured') out.push(pg.kFrom
        ? pg.kFrom + 'ページ目で合わせた時に、標準の縮尺(' + near + ' など)とは一致しなかった縮尺です。測った値のまま、実寸に合わせて変換します。このページの図面にも合っているか、下の「確かめる」でお確かめください。'
        : '標準の縮尺(' + near + ' など)とは一致しませんでした。まず、クリックした2点と入力した寸法をお確かめください。どちらも正しければ、用紙に合わせて縮小されたPDFか、標準以外の縮尺(1/150 など)の図面と考えられます。測った値のまま、実寸に合わせて変換します。');
      if (c.kind === 'short') out.push('寸法が短いため、標準の縮尺かどうか判定できません。もっと長い寸法で合わせると、誤差が小さくなります。');
      if (c.kind === 'unknown') out.push('このPDFは線の位置の細かさを調べられないため、標準の縮尺(' + near + ')ちょうどかどうかは判定していません。下の「確かめる」で、図面の寸法と合うかをお確かめください。');
      if (!c.snapped) out.push(LOOSE_NOTE + (c.kind === 'loose' ? 'このため、標準の縮尺かどうか判定できません。線の端や交点をクリックして合わせ直すと、誤差が小さくなります。' : ''));
      return out.join(' ');
    }
    const looseCal = (pg) => !!(pg && pg.k && pg.cal && !pg.cal.preset && pg.cal.snapped === false);

    // 常設の「精度の目安」。1行目 = 座標の細かさ、2行目 = いまの縮尺で 10m を測った時の誤差、3行目 = 粗いPDFの円・円弧の注意
    function precisionInfo(pg) {
      const r = { text: '', caution: false, text2: '', caution2: false, text3: '' };
      if (!pg || !pg.k || !pg.geom) return r;
      // DXF は実寸の図形データなので、PDF のような「線の位置の丸め」が無い。残るのは曲線を円弧・折れ線に置き換えた分だけ
      if (isDxf()) {
        const d = dxfIn.report.worstDeviation || 0;
        r.text = '精度の目安: DXFは実寸の図形データなので、線の位置の読み取り誤差はありません。';
        r.text2 = d > 0
          ? '変換で生じるずれは、曲線を円弧や折れ線に置き換えた分だけです(最大 ' + (d < 0.01 ? '0.01' : String(Math.round(d * 100) / 100)) + 'mm)。'
          : '変換で形が変わる曲線はありませんでした。';
        return r;
      }
      const cls = precisionClass(pg.geom.quantum, pg.k);
      if (cls === 'few') { r.text = '精度の目安: 線が少ないため計算できません。図面の寸法文字と突き合わせて確かめてください。'; r.caution = true; return r; }
      if (cls === 'unknown') { r.text = '精度の目安: 線の位置の細かさを調べられませんでした。図面の寸法文字と突き合わせて確かめてください。'; r.caution = true; return r; }
      if (cls === 'grid') {
        const g = calcQ(pg) * pg.k, v = g < 1 ? String(Math.round(g * 100) / 100) : (g < 10 ? g.toFixed(1) : String(Math.round(g)));
        // 床は 1目盛り ×(|cosθ| + |sinθ|)なので、斜めの線では最大で √2 倍(検算の「誤差の目安」と食い違って見えないよう、ここで断っておく)。
        // 画面の文では「1目盛り」と言わない(現場の人に通じない言葉)。「実寸で約 ○mm きざみに記録されています」と書く
        r.text = '精度の目安: このPDFは、線の位置が実寸で約 ' + v + 'mm きざみに記録されています(測った長さは最大 ±' + v + 'mm ずれます。斜めの線では約1.4倍)。';
        // 1目盛りが実寸 1mm 以上の粗いPDFでは、円・円弧の中心と半径も目盛りぶんの幅でしか決まらない。
        // ここ(縮尺の欄の下のほう)に出すのは、縮尺を決めた拍子に欄の上に注意が現れて、図面が下へずれないようにするため
        if (g >= 1 && pg.geom.circles.length + pg.geom.arcs.length > 0) r.text3 = 'このPDFは線の位置が粗く記録されている(実寸で約 ' + v + 'mm きざみ)ため、円の中心と半径は目安です。';
      } else r.text = '精度の目安: 線の位置は十分に細かく記録されたPDFです(実寸で 0.05mm 未満のきざみ)。';
      const rel = relScaleOf(pg);
      const e = measureError({ q: calcQ(pg), k: pg.k, theta: 0, relScale: rel, unsnappedCount: 0, ds: st.ds, len: 10000 }).total;
      // 確かめていない縮尺(選んだ縮尺・ほかのページから写した縮尺)は、その縮尺が正しい場合の値だと断る
      const basis = pg.kFrom ? '(写した縮尺が、このページにも合っている場合)' : (pg.cal && pg.cal.preset ? '(選んだ縮尺が正しい場合)' : '');
      r.text2 = '測った長さの誤差の目安: ' + (rel > 0 ? '10m の長さで ' : '長さによらず ') + (e < 0.5 ? '' : '約 ') + errText(e) + (rel > 0 ? '(長いほど大きくなります)' : '') + basis + '。';
      r.caution2 = rel > 0.0005;   // 縮尺の相対誤差が 0.05% を超える時は注意色
      return r;
    }
    // 確かめ中の2点の実寸と誤差の目安(検算の行と、図面の上のラベルで同じ値を使う)
    function checkMeasure(pg) {
      const a = st.picks[0], b = st.picks[1], real = dist(a, b) * pg.k;
      const loose = st.picks.filter((p) => !p.snapped).length;
      const e = measureError({ q: calcQ(pg), k: pg.k, theta: Math.atan2(b.y - a.y, b.x - a.x), relScale: relScaleOf(pg), unsnappedCount: loose, ds: st.ds, len: real }).total;
      const cls = precisionClass(pg.geom.quantum, pg.k);
      // 座標の細かさが分からないPDFでは、床を 0 と言い切らない
      return { real, loose, e, known: cls === 'grid' || cls === 'fine' };
    }
    // 確かめる(検算): 2点の実寸と誤差の目安、図面に書いてある寸法との突き合わせ。m = 2点の実寸と誤差の目安(checkMeasure)
    function checkInfo(pg) {
      const r = { text: '', verdict: '', state: '', recal: false, m: null };
      if (st.picks.length !== 2) return r;
      const m = r.m = checkMeasure(pg), real = m.real, loose = m.loose, e = m.e, known = m.known;
      r.text = 'この2点の実寸: ' + fmtMm(real) + 'mm(' + (known ? '誤差の目安 ' + errText(e) : '誤差の目安は計算できません') +
        (loose ? '・線の端や交点に吸い付いていない点を含みます' : '') + ')';
      const want = parseFloat(checkLen.value);
      // 入力の途中(1文字打つごと)には判定しない。「3640」と打つ間の「3」「36」「364」で「合いません」と合わせ直しのボタンが出ては消え、縮尺の欄の高さが跳ねていた。
      // 判定するのは、入力が止まってから・Enter・欄を離れた時(下の judgeNow)
      if (want > 0 && !st.checkTyping) {
        const v = verdictOf({ real, want, e, known, k: pg.k });
        r.state = v.state;
        r.recal = v.state === 'ng';   // 合わせ直しへ誘うのは、差が明らかな時だけ
        // 合わない原因でいちばん多いのは、点の取り違えと寸法の打ち間違い。縮尺やPDFを疑う前に、まずそこを確かめてもらう
        r.verdict = v.state === 'ok' ? '図面の寸法と一致しました(差 ' + fmtGap(v.gap) + 'mm)'
          : v.state === 'na' ? '図面の寸法との差は ' + fmtGap(v.gap) + 'mm です。このPDFは線の位置の細かさが分からないため、一致したかどうかは判定できません。'
            : '図面の寸法と ' + fmtGap(v.gap) + 'mm 合いません。まず、クリックした2点と入力した寸法をお確かめください。それでも合わない時は、縮尺が違うか、用紙に合わせて縮小されたPDFの可能性があります。';
      }
      return r;
    }

    function refreshUI() {
      const pg = curPg();
      if (!pg || !pg.geom) return;
      const g = pg.geom;
      const nL = g.lines.length, nC = g.circles.length + g.arcs.length, nT = g.texts.length;
      summary.textContent = '線 ' + fmtInt(nL) + ' 本 ・ 円/円弧 ' + fmtInt(nC) + ' 個 ・ 文字 ' + fmtInt(nT) + ' 個';
      const scanned = isScanned(g), empty = isEmpty(g);
      banner.textContent = scanned
        ? 'このページはスキャンした画像のため、線を取り出せません。CADから出力したPDFをお使いください。'
        : (empty ? 'このページには変換できる線や文字がありません。' : '');
      banner.classList.toggle('show', scanned || empty);
      const info = [];
      if (!scanned && g.imageAreaPct >= 5) info.push('このページには画像が ' + fmtInt(g.images) + ' 枚あり、用紙の約 ' + g.imageAreaPct + '% を占めています。画像(貼り付けた絵・写真・スキャンした図)の中の線は変換されません。青い線で表示されている部分だけが変換されます。');
      if (g.hiddenLayer) {
        info.push(g.hiddenTextUnsure
          ? '非表示に設定されたレイヤ(画面に表示されていない層)の線は変換していません。ただし、このPDFでは非表示レイヤの文字を見分けられないため、文字は含まれている可能性があります。'
          : '非表示に設定されたレイヤ(画面に表示されていない層)の線と文字は変換していません。');
      }
      if (g.nonRectClip) info.push('このページには長方形以外の切り抜き範囲があるため、画面に見えていない部分の線が含まれている可能性があります。');
      if (infoEl) infoEl.textContent = info.join(' ');

      modeDimBtn.classList.toggle('active', st.mode === 'dim');
      modePresetBtn.classList.toggle('active', st.mode === 'preset');
      dimBody.hidden = st.mode !== 'dim';
      presetBody.hidden = st.mode !== 'preset';
      // DXF は実寸のデータなので、縮尺を合わせる手順は出さない(用紙に収める縮尺を選ぶだけ)
      if (dxfHint) {
        dxfHint.hidden = !isDxf();
        if (isDxf()) dxfHint.textContent = 'この DXF は実寸のデータなので、縮尺を合わせる必要はありません。A3 の用紙に収まる縮尺(1/' + dxfIn.den + ')を選びました。変えたい時は、下の欄に分母を打つか「よく使う縮尺」から選んでください。';
      }
      const dimToggle = modeDimBtn.parentElement;
      if (dimToggle) dimToggle.hidden = isDxf();
      if (presetHint) presetHint.hidden = isDxf();   // 縮んだPDFの話は DXF には当てはまらない

      if (pg.k) { scaleStatus.textContent = '縮尺: ' + pg.kLabel; scaleStatus.classList.add('set'); }
      else { scaleStatus.textContent = '縮尺: 未設定(保存するには縮尺を合わせてください)'; scaleStatus.classList.remove('set'); }
      // 判定できなかった理由・吸着なしで合わせた注意は、確定後もここに出し続ける
      if (calNote) calNote.textContent = calNoteText(pg);
      const canToggle = !!(pg.k && pg.cal && pg.cal.kind === 'adopt' && !pg.kFrom);
      // 測った値の表示が標準の縮尺と同じになる時(「約 1/100.0」と「1/100」)は、切り替えても何も変わらないように見えるので、リンクを出さない
      const sameLabel = canToggle && pg.cal.adopted && parseFloat(measuredDen(pg.cal.denMeasured)) === pg.cal.nominal;
      calToggle.hidden = !canToggle || sameLabel;
      if (canToggle) {
        calToggle.textContent = pg.cal.adopted ? '測った値(' + measuredLabel(pg.cal.denMeasured) + ')を使う' : '標準の縮尺(1/' + pg.cal.nominal + ')を使う';
        // ふつうは押す必要のないリンクなので、押すと何が起きるかを添える
        calToggle.title = pg.cal.adopted ? '標準の縮尺ではなく、クリックした2点と寸法から計算した縮尺で変換します(ふつうは押す必要はありません)' : '';
      }
      // 検算から合わせ直した後は、直前の縮尺へ戻せる(寸法の打ち間違い・点の取り違えで、確かめ済みの縮尺を上書きしても取り返せるように)
      recalUndoBtn.hidden = !(pg.k && pg.prev);
      if (pg.prev) recalUndoBtn.textContent = '前の縮尺(' + shortScale(pg.prev.kLabel) + ')に戻す';

      let shortDim = false, tooClose = false;
      if (st.calibrating) {
        const n = st.picks.length;
        if (n === 0) pickInfo.textContent = '1点目をクリックしてください';
        else if (n === 1) pickInfo.textContent = '2点目をクリックしてください';
        else {
          const d = dist(st.picks[0], st.picks[1]);
          pickInfo.textContent = '2点間: 図面上 ' + fmtMm(paperMm(d)) + 'mm' + (st.picks.some((p) => !p.snapped) ? '(線の端や交点に吸い付いていない点があります)' : '');
          tooClose = !(d > 0.5);   // 同じ点を2回取った等。合わせられないので、ボタンを押せなくして理由をその場に出す
          // 「短い寸法です」の注意は、縮尺の精度が実際に落ちる時だけ出す(確定は止めない)。線の位置のきざみ q が分かるPDFでは u = q ÷ d が 0.05% を超える時、
          // 分からないPDFでは用紙の長辺の 15% 未満の時。以前は一律に「長辺の 25% 未満」で、細かく記録されたPDFや、これ以上長い寸法の無い図面(A2・1/100 の 10,920mm)でも出ていた
          const q = calcQ(pg);
          shortDim = !tooClose && (q > 0 ? q / d > 0.0005 : d < 0.15 * Math.max(g.vpW, g.vpH));
        }
      } else if (st.mode === 'dim') {
        pickInfo.textContent = pg.k ? '縮尺を合わせ直す時は、上の「図面の寸法で合わせる」をもう一度押してください。' : '';
      }
      const lenLabel = realLen.closest('label');
      if (lenLabel) lenLabel.hidden = !st.calibrating;
      applyDimBtn.hidden = !st.calibrating;
      if (dimHint) dimHint.hidden = !st.calibrating;
      if (shortWarn) {
        // 粗く記録されたPDFでは、図面でいちばん長い寸法でもこの注意が出ることがある。これ以上長い寸法が無い人が迷わないよう、このままでよいことも伝える
        shortWarn.textContent = tooClose ? TOO_CLOSE : SHORT_DIM;
        shortWarn.hidden = !(shortDim || tooClose);
      }
      pickInfo.classList.toggle('muted', !st.calibrating);
      const lenOk = parseFloat(realLen.value) > 0;
      applyDimBtn.disabled = !(st.calibrating && st.picks.length === 2 && lenOk && !tooClose);
      // 1点目を取った時に保った高さ(commitPick)は、2点目を取ったら解く。確かめる欄に入力している間に保った高さ(checkLen の input)は、判定したら解く
      if (st.picks.length !== 1 && !st.checkTyping) scaleBox.style.minHeight = '';

      checkBox.hidden = !pg.k || st.calibrating;
      const ck = checkBox.hidden ? null : checkInfo(pg);
      checkResult.textContent = ck ? ck.text : '';
      if (checkVerdict) {
        checkVerdict.textContent = ck ? ck.verdict : '';
        checkVerdict.className = 'p2d-verdict' + (ck && ck.state ? ' ' + ck.state : '');
      }
      recalBtn.hidden = !(ck && ck.recal);
      const pi = precisionInfo(pg);
      precisionEl.textContent = pi.text;
      precisionEl.classList.toggle('caution', pi.caution);
      if (precision2El) {
        precision2El.textContent = pi.text2;
        precision2El.classList.toggle('caution', pi.caution2);
      }
      if (precision3El) precision3El.textContent = pi.text3;
      // 図面に書いてある寸法から読んだ縮尺(提案・食い違いの注意・答え合わせ)
      const dn = dimNoteInfo(pg);
      dimNote.hidden = !dn;
      if (dn) {
        dimText.textContent = dn.text;
        dimNote.classList.toggle('caution', dn.caution);
        dimBtn.hidden = !dn.btn;
        dimBtn.textContent = dn.btn;
        dimBtn.dataset.den = dn.den ? String(dn.den) : '';
      }
      applyAllBtn.hidden = !(pg.k && st.numPages > 1);
      scaleNoteEl.textContent = st.scaleNote ? st.scaleNote.text : '';
      scaleNoteEl.className = 'p2d-scale-note' + (st.scaleNote && st.scaleNote.type ? ' ' + st.scaleNote.type : '');

      const canExport = !!pg.k && !scanned && !empty;
      exportBtn.disabled = !canExport || st.busy;
      exportAllBtn.hidden = st.numPages <= 1;
      exportAllBtn.disabled = st.busy || !Object.keys(st.pages).some((i) => st.pages[i].k);
      if (st.note) {
        exportNote.textContent = st.note.text; exportNote.className = 'redact-export-note p2d-note ' + (st.note.type || '');
        if (st.note.caution) {   // 注意は、成功の文の末尾に続けず、注意色の別の行にする
          const c = document.createElement('span');
          c.className = 'p2d-note-caution'; c.textContent = st.note.caution;
          exportNote.appendChild(c);
        }
      } else {
        exportNote.className = 'redact-export-note';
        exportNote.textContent = (scanned || empty) ? 'このページは保存できません。'
          : (pg.k ? (outFmt === 'jww' ? 'Jw_cad の「ファイル」→「開く」でそのまま開けます。' : 'Jw_cad の「ファイル」→「DXFファイルを開く」で開けます。') : '縮尺を合わせると保存できます。');
      }
      scheduleHover();   // 合わせ中/確かめ中が切り替わった時に、カーソルを動かさなくてもルーペの色が変わるように
    }

    // ---- 描画: 取り出した線(青)と、クリックした点 ----
    function drawVectors() {
      const ctx = vecLayer.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, vecLayer.width, vecLayer.height);
      const pg = curPg();
      if (!pg || !pg.geom || !showLines.checked) return;
      const g = pg.geom, s = st.ds * st.dpr;
      ctx.setTransform(s, 0, 0, -s, 0, g.vpH * s);   // pt(上向きY) → 画面
      ctx.lineWidth = 1.2 / s;
      ctx.strokeStyle = 'rgba(0, 92, 255, 0.7)';
      ctx.beginPath();
      for (const l of g.lines) { ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); }
      for (const c of g.circles) { ctx.moveTo(c.cx + c.r, c.cy); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2); }
      for (const a of g.arcs) {
        const a1 = a.a1 * Math.PI / 180, a2 = a.a2 * Math.PI / 180;
        ctx.moveTo(a.cx + a.r * Math.cos(a1), a.cy + a.r * Math.sin(a1));
        ctx.arc(a.cx, a.cy, a.r, a1, a2, false);
      }
      ctx.stroke();
    }
    const modeColor = () => (st.calibrating ? '#e8590c' : '#1a8f3c');   // 合わせ中 = 橙、確かめ中 = 緑
    const CAUTION_COLOR = '#8a3a16';                                    // 注意の色(styles.css の .p2d-caution と同じ)
    function drawPicks() {
      const ctx = pickLayer.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pickLayer.width, pickLayer.height);
      const pg = curPg();
      if (!pg || !pg.geom) return;
      const s = st.ds * st.dpr, H = pg.geom.vpH, r = st.dpr;
      const dev = (p) => [p.x * s, (H - p.y) * s];
      const col = modeColor();
      if (st.hover) {
        const [x, y] = dev(st.hover);
        ctx.lineWidth = 1.5 * r;
        ctx.strokeStyle = st.hover.snapped ? col : 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.arc(x, y, (st.hover.snapped ? 7 : 4) * r, 0, Math.PI * 2); ctx.stroke();
      }
      if (st.picks.length === 2) {
        const [x1, y1] = dev(st.picks[0]), [x2, y2] = dev(st.picks[1]);
        ctx.lineWidth = 2 * r; ctx.strokeStyle = col; ctx.setLineDash([6 * r, 4 * r]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
        const d = dist(st.picks[0], st.picks[1]);
        // 合わせ中は、次にすること(実際の長さを入力して Enter)まで図面の上に出す。画面の低い窓では、入力欄のある縮尺の欄が画面の外に出ていることがある
        // 確かめ中は、実寸に誤差の目安(±)を添える。縮尺の欄が長く、検算の行が画面の外に出ていても、図面の上で ± まで読めるように
        let label = '図面上 ' + fmtMm(paperMm(d)) + 'mm', labelCol = col;
        if (st.calibrating) { if (d > 0.5) label += ' ・ 実際の長さを入力して Enter'; }
        else if (pg.k) {
          const ck = checkInfo(pg), m = ck.m;
          label = fmtMm(m.real) + 'mm' + (m.known ? ' ' + errText(m.e) : '');
          if (ck.state === 'ng') labelCol = CAUTION_COLOR;   // 図面の寸法と合わなかった時は、成功に見える緑で見せない
        }
        ctx.font = '600 ' + (13 * r) + 'px sans-serif';
        // ラベルは2点のまん中の上。用紙の端に近い線では、用紙の外へはみ出して切れないよう内側へ寄せる
        const tw = ctx.measureText(label).width, edge = tw / 2 + 7 * r;
        const mx = clampTo((x1 + x2) / 2, edge, Math.max(edge, pickLayer.width - edge)), my = Math.max((y1 + y2) / 2 - 14 * r, 13 * r);
        ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(mx - tw / 2 - 5 * r, my - 11 * r, tw + 10 * r, 18 * r);
        ctx.fillStyle = labelCol; ctx.textAlign = 'center'; ctx.fillText(label, mx, my + 3 * r);
      }
      for (const p of st.picks) {
        const [x, y] = dev(p);
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 4.5 * r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 1.5 * r; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
    }

    // ---- 格子の索引(一様グリッド) ----
    // カーソルの近くにある線・円・円弧だけを素早く取り出すための索引。ページごとに一度だけ作る(線が10万本あっても、1回の問い合わせは近くのマスを見るだけで済む)。
    // 吸着の候補点・ルーペ・選び直しの小窓が同じ索引を使う。図形の番号: 0〜 線、nL〜 円、nL+nC〜 円弧
    function indexOf(pg) {
      if (pg.index) return pg.index;
      const g = pg.geom, nL = g.lines.length, nC = g.circles.length, n = nL + nC + g.arcs.length;
      const W = Math.max(g.vpW, 1), H = Math.max(g.vpH, 1);
      // マスの大きさ(pt): 図形1個あたり4マスほど。マスの総数は100万までに抑える
      const cell = Math.max(4, Math.sqrt(W * H / 1e6), Math.min(48, 2 * Math.sqrt(W * H / Math.max(n, 1))));
      const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
      const col = (x) => Math.max(0, Math.min(nx - 1, Math.floor(x / cell)));
      const row = (y) => Math.max(0, Math.min(ny - 1, Math.floor(y / cell)));
      const boxCells = (x0, y0, x1, y1, cb) => {
        const ix0 = col(x0), ix1 = col(x1), iy1 = row(y1);
        for (let iy = row(y0); iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) cb(iy * nx + ix);
      };
      // 線が通るマス: 列ごとに、その列の中での y の範囲を求める(斜めの長い線でも、通るマスだけに登録される)
      const lineCells = (l, cb) => {
        const fwd = l.x1 <= l.x2, xa = fwd ? l.x1 : l.x2, ya = fwd ? l.y1 : l.y2, xb = fwd ? l.x2 : l.x1, yb = fwd ? l.y2 : l.y1;
        const ix0 = col(xa), ix1 = col(xb), dx = xb - xa;
        for (let ix = ix0; ix <= ix1; ix++) {
          const u0 = ix === ix0 ? xa : ix * cell, u1 = ix === ix1 ? xb : (ix + 1) * cell;
          const v0 = dx > 0 ? ya + (yb - ya) * (u0 - xa) / dx : ya, v1 = dx > 0 ? ya + (yb - ya) * (u1 - xa) / dx : yb;
          const iy1 = row(Math.max(v0, v1));
          for (let iy = row(Math.min(v0, v1)); iy <= iy1; iy++) cb(iy * nx + ix);
        }
      };
      // 円・円弧が通るマス: 短い弧に分け、弧ごとの外接の四角で登録する。中心のマスにも登録する(中心に吸い付けるように)
      const arcCells = (c, a1, a2, cb) => {
        const sweep = a2 - a1;
        const n = Math.min(4096, Math.max(1, Math.ceil(sweep / (Math.PI / 2)), Math.ceil(sweep * c.r / (2 * cell))));
        const step = sweep / n, sag = c.r * (1 - Math.cos(step / 2));
        for (let i = 0; i < n; i++) {
          const b1 = a1 + step * i, b2 = b1 + step;
          const px = c.cx + c.r * Math.cos(b1), py = c.cy + c.r * Math.sin(b1), qx = c.cx + c.r * Math.cos(b2), qy = c.cy + c.r * Math.sin(b2);
          boxCells(Math.min(px, qx) - sag, Math.min(py, qy) - sag, Math.max(px, qx) + sag, Math.max(py, qy) + sag, cb);
        }
        if (c.cx >= 0 && c.cx <= W && c.cy >= 0 && c.cy <= H) boxCells(c.cx, c.cy, c.cx, c.cy, cb);
      };
      const visit = (i, cb) => {
        if (i < nL) { lineCells(g.lines[i], cb); return; }
        if (i < nL + nC) { arcCells(g.circles[i - nL], 0, 2 * Math.PI, cb); return; }
        const a = g.arcs[i - nL - nC], a1 = a.a1 * Math.PI / 180;
        let a2 = a.a2 * Math.PI / 180;
        while (a2 <= a1) a2 += 2 * Math.PI;   // DXF と同じく反時計回り a1→a2
        arcCells(a, a1, a2, cb);
      };
      // マスごとの図形の一覧を、1本の配列に詰めて持つ(start[マス] 〜 start[マス+1] がそのマスの図形)。1回目で数え、2回目で詰める
      const start = new Uint32Array(nx * ny + 1);
      const countCell = (c) => { start[c + 1]++; };
      for (let i = 0; i < n; i++) visit(i, countCell);
      for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
      const items = new Uint32Array(start[nx * ny]), fill = start.slice(0, nx * ny);
      let cur = 0;
      const putCell = (c) => { items[fill[c]++] = cur; };
      for (cur = 0; cur < n; cur++) visit(cur, putCell);
      // 問い合わせ: 四角の範囲に掛かるマスの図形を、重複なく1回ずつ cb に渡す
      const stamp = new Uint32Array(n);
      let gen = 0;
      const query = (x0, y0, x1, y1, cb) => {
        if (++gen >= 0xFFFFFFFF) { stamp.fill(0); gen = 1; }
        const ix0 = col(x0), ix1 = col(x1), iy1 = row(y1);
        for (let iy = row(y0); iy <= iy1; iy++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const c = iy * nx + ix;
            for (let k = start[c]; k < start[c + 1]; k++) { const i = items[k]; if (stamp[i] !== gen) { stamp[i] = gen; cb(i); } }
          }
        }
      };
      pg.index = { nL, nC, query };
      return pg.index;
    }

    // ---- 吸着の候補点(線の端・円弧の端・円と円弧の中心・円の四分点・線どうしの交点) ----
    // カーソルを動かした時・クリックした時・ルーペ・選び直しの小窓は、すべてこの関数の結果を使う(ルーペに見えている点 = クリックで取れる点)。
    // p から rad(pt)以内の候補点を近い順に返す。同じ点(0.01pt 以内)はまとめ、線の端などの「描かれた点」を、計算で出した交点より優先して残す
    function snapCandidates(pg, p, rad) {
      const g = pg.geom, idx = indexOf(pg), rad2 = rad * rad, raw = [], near = [];
      const add = (x, y, drawn) => {
        const dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
        if (d2 <= rad2) raw.push({ x, y, d: Math.sqrt(d2), drawn });
      };
      idx.query(p.x - rad, p.y - rad, p.x + rad, p.y + rad, (i) => {
        if (i < idx.nL) {
          const l = g.lines[i];
          add(l.x1, l.y1, true); add(l.x2, l.y2, true);
          // 交点(通り芯の交点など)の計算に使うのは、カーソルの近くを通る線だけ
          const dx = l.x2 - l.x1, dy = l.y2 - l.y1, L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / L2)) : 0;
          const ex = l.x1 + t * dx - p.x, ey = l.y1 + t * dy - p.y, d2 = ex * ex + ey * ey;
          if (d2 <= rad2) near.push({ l, d2 });
        } else if (i < idx.nL + idx.nC) {
          const c = g.circles[i - idx.nL];
          add(c.cx, c.cy, true); add(c.cx + c.r, c.cy, true); add(c.cx - c.r, c.cy, true); add(c.cx, c.cy + c.r, true); add(c.cx, c.cy - c.r, true);
        } else {
          const r = g.arcs[i - idx.nL - idx.nC], a1 = r.a1 * Math.PI / 180, a2 = r.a2 * Math.PI / 180;
          add(r.cx, r.cy, true); add(r.cx + r.r * Math.cos(a1), r.cy + r.r * Math.sin(a1), true); add(r.cx + r.r * Math.cos(a2), r.cy + r.r * Math.sin(a2), true);
        }
      });
      near.sort((a, b) => a.d2 - b.d2);
      const n = Math.min(near.length, 40);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = near[i].l, b = near[j].l;
          const rx = a.x2 - a.x1, ry = a.y2 - a.y1, sx = b.x2 - b.x1, sy = b.y2 - b.y1;
          const den = rx * sy - ry * sx;
          if (Math.abs(den) <= 1e-9 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) continue;   // 平行
          const qx = b.x1 - a.x1, qy = b.y1 - a.y1;
          const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
          if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;   // 線の延長上で交わる(実際には交わっていない)
          add(a.x1 + t * rx, a.y1 + t * ry, false);
        }
      }
      raw.sort((a, b) => a.d - b.d);
      const out = [];
      for (const c of raw) {
        let dup = null;   // 近い順に並んでいるので、同じ点はすぐ手前にしか居ない
        for (let k = out.length - 1; k >= 0 && c.d - out[k].d <= 2 * MERGE_PT; k--) {
          if (Math.hypot(out[k].x - c.x, out[k].y - c.y) <= MERGE_PT) { dup = out[k]; break; }
        }
        if (dup) { if (c.drawn && !dup.drawn) { dup.x = c.x; dup.y = c.y; dup.drawn = true; } continue; }
        out.push(c);
        if (out.length >= 256) break;
      }
      return out;
    }
    // カーソル位置 p の吸着の様子。cands = ルーペに見える範囲の候補点(近い順)、best = いま吸い付く点(吸着範囲の中でいちばん近い候補。無ければ null)
    function snapAt(pg, p) {
      const lim = SNAP_PX / st.ds, view = LOUPE_PX / LOUPE_MAG / 2 * Math.SQRT2 / st.ds;
      const cands = snapCandidates(pg, p, Math.max(lim, view));
      return { cands, lim, best: cands.length && cands[0].d <= lim ? cands[0] : null };
    }
    function clientToPt(x, y) {
      const rc = pickLayer.getBoundingClientRect();
      return { x: (x - rc.left) / st.ds, y: curPg().geom.vpH - (y - rc.top) / st.ds };
    }

    // ---- 拡大表示(ルーペと選び直しの小窓で共通): 取り出した線データを描く(ラスタ画像の拡大ではない) ----
    // center = 中心に置く図面上の点(pt)、scale = 画面px / pt、size = 表示の大きさ(画面px)。索引から、見える範囲の図形だけを描く
    function drawView(ctx, pg, center, scale, size) {
      const g = pg.geom, idx = indexOf(pg), dpr = st.dpr, s = scale * dpr, half = size / 2 / scale;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#e9ebf0';   // 用紙の外は薄い灰色(用紙の端が分かるように)
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.setTransform(s, 0, 0, -s, (size / 2 - center.x * scale) * dpr, (size / 2 + center.y * scale) * dpr);   // pt(上向きY) → 表示
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, g.vpW, g.vpH);
      ctx.lineWidth = 1.25 / scale;
      ctx.strokeStyle = '#3c4148';
      ctx.beginPath();
      let count = 0;
      idx.query(center.x - half, center.y - half, center.x + half, center.y + half, (i) => {
        if (++count % 200 === 0) { ctx.stroke(); ctx.beginPath(); }   // 線が密な所では、1本の長大なパスにすると描画が極端に遅くなるので、小分けにして描く
        if (i < idx.nL) { const l = g.lines[i]; ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); return; }
        if (i < idx.nL + idx.nC) { const c = g.circles[i - idx.nL]; ctx.moveTo(c.cx + c.r, c.cy); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2); return; }
        const a = g.arcs[i - idx.nL - idx.nC], a1 = a.a1 * Math.PI / 180, a2 = a.a2 * Math.PI / 180;
        ctx.moveTo(a.cx + a.r * Math.cos(a1), a.cy + a.r * Math.sin(a1));
        ctx.arc(a.cx, a.cy, a.r, a1, a2, false);
      });
      ctx.stroke();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // この後の目印(丸・十字)は画面px で描く
    }
    // 十字の目印。中心の近くは空けて、下の線が見えるようにする
    function drawCross(ctx, x, y, color, width) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath();
      for (const v of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + v[0] * 4, y + v[1] * 4); ctx.lineTo(x + v[0] * 14, y + v[1] * 14); }
      ctx.stroke();
    }
    // 用紙のうち、いま画面に見えている範囲(用紙の左上からの画面px)。ルーペと小窓はこの中に置く
    function visibleBox(rc) {
      return { x0: Math.max(0, -rc.left), y0: Math.max(0, -rc.top), x1: Math.min(rc.width, window.innerWidth - rc.left), y1: Math.min(rc.height, window.innerHeight - rc.top) };
    }
    const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // ---- ルーペ: カーソルの近くに、取り出した線と吸着の候補点を 8 倍で見せる ----
    // 図面全体を画面の幅に収めているので、通り芯の交点と壁の角が画面では 2px ほどしか離れておらず、どれに吸い付いたか見分けられないため
    function hideLoupe() { loupe.classList.remove('show'); }
    function drawLoupe(pg, p, sn, rc) {
      const px = Math.round(LOUPE_PX * st.dpr), scale = st.ds * LOUPE_MAG, S = LOUPE_PX;
      if (loupe.width !== px) { loupe.width = px; loupe.height = px; }
      const ctx = loupe.getContext('2d');
      drawView(ctx, pg, p, scale, S);
      const toV = (c) => [(c.x - p.x) * scale + S / 2, (p.y - c.y) * scale + S / 2];
      // 吸着の候補点(小さな丸)
      ctx.lineWidth = 1.25; ctx.strokeStyle = '#5b6470'; ctx.fillStyle = '#fff';
      for (const c of sn.cands) {
        const v = toV(c);
        if (v[0] < -4 || v[0] > S + 4 || v[1] < -4 || v[1] > S + 4) continue;
        ctx.beginPath(); ctx.arc(v[0], v[1], 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      if (sn.best) {   // いま吸い付く点: モードの色の輪と十字
        const v = toV(sn.best), color = modeColor();
        ctx.lineWidth = 2; ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(v[0], v[1], 8, 0, Math.PI * 2); ctx.stroke();
        drawCross(ctx, v[0], v[1], color, 2);
      } else drawCross(ctx, S / 2, S / 2, 'rgba(0,0,0,.5)', 1.5);   // 吸い付いていない時は、カーソルの位置に十字だけ
      // 置き場所: カーソルの右上。端では反対側へ逃がす。タッチは指で隠れないよう指の上側(上に余地が無ければ横)
      const cx = st.cursor.x - rc.left, cy = st.cursor.y - rc.top, vb = visibleBox(rc);
      let left, top;
      if (st.cursor.touch) {
        left = cx - S / 2; top = cy - LOUPE_TOUCH_GAP - S;
        if (top < vb.y0) { top = cy - S / 2; left = cx + LOUPE_TOUCH_GAP; if (left + S > vb.x1) left = cx - LOUPE_TOUCH_GAP - S; }
      } else {
        left = cx + LOUPE_GAP; top = cy - LOUPE_GAP - S;
        if (left + S > vb.x1) left = cx - LOUPE_GAP - S;
        if (top < vb.y0) top = cy + LOUPE_GAP;
      }
      left = clampTo(left, vb.x0, vb.x1 - S); top = clampTo(top, vb.y0, vb.y1 - S);
      loupe.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
      loupe.classList.add('show');
    }
    // カーソルが動いた時の1コマぶんの処理(候補点の計算・吸い付く点の表示・ルーペ)。requestAnimationFrame で間引き、1コマに1回だけ走らせる
    let hoverRaf = 0;
    const scheduleHover = () => { if (!hoverRaf) hoverRaf = requestAnimationFrame(updateHover); };
    function updateHover() {
      hoverRaf = 0;
      const pg = curPg();
      if (!st.cursor || !ready() || st.chooser) { st.hover = null; hideLoupe(); drawPicks(); return; }
      const rc = pickLayer.getBoundingClientRect();
      const p = clientToPt(st.cursor.x, st.cursor.y), sn = snapAt(pg, p);
      st.hover = sn.best ? { x: sn.best.x, y: sn.best.y, snapped: true } : { x: p.x, y: p.y, snapped: false };
      drawPicks();
      // ルーペを出すのは、クリックで点が取れる時だけ(縮尺を合わせている最中か、縮尺が決まった後)。「縮尺を選ぶ」で縮尺が未設定のうちは、クリックしても点は取れない
      if (st.calibrating || pg.k) drawLoupe(pg, p, sn, rc); else hideLoupe();
    }

    // ---- 点を取る ----
    function commitPick(pt) {
      const h = scaleBox.offsetHeight;
      if (st.picks.length >= 2) dropPicks();
      st.picks.push(pt);
      clearNotes();
      // 1点目を取った拍子に、前の判定や案内の行が消えて図面が上へずれると、2点目をねらいにくい。2点目を取るまでは、縮尺の欄の高さを保つ
      scaleBox.style.minHeight = st.picks.length === 1 ? h + 'px' : '';
      refreshUI(); drawPicks();
      if (st.calibrating && st.picks.length === 2) {
        try { realLen.focus({ preventScroll: true }); realLen.select(); } catch (_) { /* 無視 */ }
        // 次に入力する欄が画面の外にある時は、見える所まで動かす(フォーカスだけ移しても、どこに入力するのか見えなかった)
        bringIntoView(realLen.closest('.p2d-row'));
      }
    }
    function pickAt(x, y) {
      const pg = curPg();
      if (!st.calibrating && !pg.k) { setScaleNote('先に縮尺を決めてください。上の「この縮尺にする」を押すか、「図面の寸法で合わせる」に切り替えて、長さの分かっている線の両端をクリックしてください。', 'error'); return; }
      try {
        const p = clientToPt(x, y), sn = snapAt(pg, p);
        if (!sn.best) { commitPick({ x: p.x, y: p.y, snapped: false }); return; }
        // 吸い付く点のすぐ近く(画面で 6px 以内)に別の候補点がある時は、取り違えを防ぐため、確定せずに拡大して選んでもらう
        // (通り芯の交点と 60mm 隣の壁の角を取り違えると、縮尺が 1.6% ずれる)
        const inRange = sn.cands.filter((c) => c.d <= sn.lim);
        const rivals = inRange.filter((c) => dist(c, sn.best) * st.ds <= AMBIG_PX);
        if (rivals.length > 1) openChooser(p, inRange, rivals);
        else commitPick({ x: sn.best.x, y: sn.best.y, snapped: true });
      } catch (e) {
        console.error('[p2d] pick failed', e);
        setScaleNote('点を取れませんでした: ' + (e && e.message ? e.message : e), 'error');
      }
    }

    // ---- 選び直しの小窓(近くに候補点が複数ある時だけ開く) ----
    let chooserTimer = 0;
    // cands = 吸着範囲の中の候補点、focus = 取り違えやすい候補のかたまり(これが見分けられる倍率で、これを中心に描く)
    function openChooser(p, cands, focus) {
      const pg = curPg();
      let gap = Infinity, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      focus.forEach((a, i) => {
        x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x); y1 = Math.max(y1, a.y);
        for (let j = i + 1; j < focus.length; j++) gap = Math.min(gap, dist(a, focus[j]));
      });
      // 倍率(画面表示に対して): 候補点どうしの最小間隔が 44px 以上になるように。下限 8 倍・上限 96 倍。かたまりの全部が小窓に収まる倍率は超えない
      const ext = Math.max(x1 - x0, y1 - y0) * st.ds, room = CHOOSER_PX - 2 * (CHOOSER_HIT + 10);
      const mag = Math.max(CHOOSER_MAG_MIN, Math.min(CHOOSER_MAG_MAX, CHOOSER_GAP / (gap * st.ds), ext > 0 ? room / ext : CHOOSER_MAG_MAX));
      const center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, scale = st.ds * mag;
      // 小窓に見えている候補点だけを選べる(左から順に並べる。矢印キーで順に選べる)
      const view = [];
      for (const c of cands) {
        const vx = (c.x - center.x) * scale + CHOOSER_PX / 2, vy = (center.y - c.y) * scale + CHOOSER_PX / 2;
        if (vx >= CHOOSER_DOT && vx <= CHOOSER_PX - CHOOSER_DOT && vy >= CHOOSER_DOT && vy <= CHOOSER_PX - CHOOSER_DOT) view.push({ x: c.x, y: c.y, vx, vy, d: c.d });
      }
      view.sort((a, b) => (a.vx - b.vx) || (a.vy - b.vy));
      let sel = 0;   // はじめは、クリックした位置にいちばん近い点を選んだ状態にしておく
      view.forEach((v, i) => { if (v.d < view[sel].d) sel = i; });
      const reopen = !!st.chooser;
      st.chooser = { p, cands, center, mag, view, sel, down: -1, prevFocus: reopen ? st.chooser.prevFocus : document.activeElement };
      st.hover = null; hideLoupe(); drawPicks();
      clearTimeout(chooserTimer);
      chooser.hidden = false;
      if (!reopen) {
        // 置き場所: 拡大図の中心がクリックした位置に来るように。用紙と画面からはみ出さない。
        // ただし、横向きの図面を狭い窓で開いた時など、用紙の見えている高さが小窓より低い時は、用紙の下へはみ出してよい(画面の下端までに収める。
        // 図面欄は小窓を切らない: styles.css)。以前は用紙の下端で抑えていたため、小窓の下が図面欄に切られ、下のほうの候補を押すと「外側のクリック」になって取り消されていた
        const rc = wrap.getBoundingClientRect(), vb = visibleBox(rc), pw = chooser.offsetWidth, ph = chooser.offsetHeight;
        const cx = p.x * st.ds, cy = (pg.geom.vpH - p.y) * st.ds;
        const yEnd = vb.y1 - vb.y0 >= ph ? vb.y1 : Math.max(vb.y1, window.innerHeight - rc.top);
        const mx = clampTo((vb.x1 - vb.x0 - pw) / 2, 0, 8), my = clampTo((yEnd - vb.y0 - ph) / 2, 0, 8);   // 端からの余白(狭い画面では詰める)
        chooser.style.left = Math.round(clampTo(cx - pw / 2, vb.x0 + mx, vb.x1 - pw - mx)) + 'px';
        // 縦は、最後に必ず画面(ビューポート)で抑える。用紙の上のほうだけが画面の下端に見えている時(縮尺を決めた後は縮尺の欄が伸び、狭い窓ではこの位置がふつうに起きる)は、
        // 用紙の中には小窓を置く余地が無い。用紙の見えている範囲だけで決めていた時は、小窓が画面の下へはみ出し、選ぶ点が1つも見えなかった。
        // この時は用紙の上(縮尺の欄の上)へはみ出して開く。画面が小窓より低い時は、見出しと × が見える上端を優先する
        const sTop = -rc.top, sBot = window.innerHeight - rc.top;   // 画面の上端・下端(用紙の左上からの px)
        const ms = clampTo((sBot - sTop - ph) / 2, 0, 8);
        const top = clampTo(cy - (ph - CHOOSER_PX) - CHOOSER_PX / 2, vb.y0 + my, yEnd - ph - my);
        chooser.style.top = Math.round(Math.max(sTop + ms, Math.min(top, sBot - ph - ms))) + 'px';
        document.addEventListener('keydown', onChooserKey, true);
        document.addEventListener('pointerdown', onChooserOutside, true);
        void chooser.offsetWidth;   // ここで一度レイアウトを確定させ、フェードインを効かせる
        chooser.classList.add('show');
        const grab = () => { if (st.chooser && !chooser.contains(document.activeElement)) { try { chooser.focus({ preventScroll: true }); } catch (_) { /* 無視 */ } } };
        grab(); requestAnimationFrame(grab);   // 描画のタイミングで取りこぼすことがあるので、次のコマでもう一度
      }
      drawChooser();
    }
    // 閉じる。restore = 開く前にフォーカスのあった所へ戻す(取り消した時・点を選んだ時)。2点目を選んだ時は、この後の commitPick が実寸の入力欄へ移す
    function closeChooser(restore) {
      const c = st.chooser;
      if (!c) return;
      st.chooser = null;
      document.removeEventListener('keydown', onChooserKey, true);
      document.removeEventListener('pointerdown', onChooserOutside, true);
      chooser.classList.remove('show');
      chooserCanvas.classList.remove('hit');
      clearTimeout(chooserTimer);
      chooserTimer = setTimeout(() => { if (!st.chooser) chooser.hidden = true; }, reducedMotion() ? 0 : 130);   // フェードアウト(120ms)が終わってから片付ける
      if (chooser.contains(document.activeElement)) {
        const back = restore && c.prevFocus && c.prevFocus !== document.body && document.contains(c.prevFocus) ? c.prevFocus : null;
        try { if (back) back.focus({ preventScroll: true }); else document.activeElement.blur(); } catch (_) { /* 無視 */ }
      }
    }
    function drawChooser() {
      const c = st.chooser, pg = curPg();
      if (!c || !pg || !pg.geom) return;
      const px = Math.round(CHOOSER_PX * st.dpr), scale = st.ds * c.mag, color = modeColor();
      if (chooserCanvas.width !== px) { chooserCanvas.width = px; chooserCanvas.height = px; }
      const ctx = chooserCanvas.getContext('2d');
      drawView(ctx, pg, c.center, scale, CHOOSER_PX);
      // クリックした位置(灰色の十字)
      drawCross(ctx, (c.p.x - c.center.x) * scale + CHOOSER_PX / 2, (c.center.y - c.p.y) * scale + CHOOSER_PX / 2, 'rgba(0,0,0,.4)', 1.5);
      c.view.forEach((v, i) => {
        const on = i === c.sel;
        ctx.beginPath(); ctx.arc(v.vx, v.vy, CHOOSER_DOT, 0, Math.PI * 2);
        ctx.fillStyle = on ? color : 'rgba(255,255,255,.9)'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
        if (on) { ctx.beginPath(); ctx.arc(v.vx, v.vy, CHOOSER_DOT + 5, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.stroke(); }   // いま選ばれている点は、塗りと外側の輪で示す
      });
    }
    // 小窓の中の位置から、当たり判定(半径 22px)に入るいちばん近い候補点の番号。無ければ -1
    function chooserHit(ev) {
      const c = st.chooser, rc = chooserCanvas.getBoundingClientRect();
      const x = (ev.clientX - rc.left) * CHOOSER_PX / rc.width, y = (ev.clientY - rc.top) * CHOOSER_PX / rc.height;
      let best = -1, bd = CHOOSER_HIT;
      c.view.forEach((v, i) => { const d = Math.hypot(v.vx - x, v.vy - y); if (d <= bd) { bd = d; best = i; } });
      return best;
    }
    function chooseCandidate(i) {
      const c = st.chooser, v = c && c.view[i];
      if (!v) return;
      // 丸が重なって見分けられない候補がまだある時は、その周りをさらに拡大して選び直してもらう(上限の倍率まで来ていれば、選んだ点を採る)
      const crowd = c.view.filter((o) => Math.hypot(o.vx - v.vx, o.vy - v.vy) < 2 * CHOOSER_DOT);
      if (crowd.length > 1 && c.mag < CHOOSER_MAG_MAX) { openChooser(c.p, c.cands, crowd); return; }
      closeChooser(true);
      commitPick({ x: v.x, y: v.y, snapped: true });   // 通常のクリックと同じ扱いで確定する
    }
    function onChooserKey(ev) {
      const c = st.chooser;
      if (!c) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeChooser(true); return; }
      // Tab は小窓の中(拡大図 ⇔ ×)で回す。外へ抜けると、小窓が開いたまま別のボタンへフォーカスが移り、続けて Enter を押した時に意図しない操作になる
      if (ev.key === 'Tab') {
        ev.preventDefault();
        try { (document.activeElement === chooserClose ? chooser : chooserClose).focus({ preventScroll: true }); } catch (_) { /* 無視 */ }
        return;
      }
      if (!chooser.contains(document.activeElement) || document.activeElement === chooserClose || !c.view.length) return;
      const n = c.view.length;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') c.sel = (c.sel + 1) % n;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') c.sel = (c.sel - 1 + n) % n;
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); chooseCandidate(c.sel); return; }
      else return;
      ev.preventDefault();
      drawChooser();
    }
    // 小窓の外を押したら取り消す。図面の上を押した時は、取り消すだけで点は取らない
    function onChooserOutside(ev) {
      if (!st.chooser || chooser.contains(ev.target)) return;
      closeChooser(true);
      if (wrap.contains(ev.target)) { ev.preventDefault(); ev.stopPropagation(); }
    }
    chooserClose.addEventListener('click', () => closeChooser(true));
    chooser.addEventListener('pointerdown', (ev) => ev.stopPropagation());   // 小窓の中の操作を、外側の「外を押したら閉じる」仕組みへ伝えない
    chooserCanvas.addEventListener('pointermove', (ev) => {
      const c = st.chooser;
      if (!c) return;
      const i = chooserHit(ev);
      chooserCanvas.classList.toggle('hit', i >= 0);
      if (i >= 0 && i !== c.sel) { c.sel = i; drawChooser(); }
    });
    // 押した点と離した点が同じ候補の時だけ選ぶ(小窓を開いたクリックの「離す」が、開いた直後の小窓に届いても選ばれない)
    chooserCanvas.addEventListener('pointerdown', (ev) => {
      const c = st.chooser;
      if (!c || ev.button !== 0) return;
      ev.preventDefault();
      c.down = chooserHit(ev);
      if (c.down >= 0 && c.down !== c.sel) { c.sel = c.down; drawChooser(); }
    });
    chooserCanvas.addEventListener('pointerup', (ev) => {
      const c = st.chooser;
      if (!c) return;
      const i = c.down;
      c.down = -1;
      if (i >= 0 && chooserHit(ev) === i) chooseCandidate(i);
    });

    // ---- 図面の上のポインタ操作 ----
    pickLayer.addEventListener('pointermove', (ev) => {
      if (st.aim !== null && ev.pointerId !== st.aim) return;
      st.cursor = { x: ev.clientX, y: ev.clientY, touch: ev.pointerType === 'touch' };
      scheduleHover();
    });
    pickLayer.addEventListener('pointerleave', () => { if (st.aim !== null) return; st.cursor = null; scheduleHover(); });
    pickLayer.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || !ready()) return;
      ev.preventDefault();
      if (ev.pointerType === 'touch') {
        // タッチはカーソルが無く、指で図面が隠れる。押している間は指の上側のルーペを見ながら位置を直せるようにし、点を取るのは指を離した時
        st.aim = ev.pointerId;
        st.cursor = { x: ev.clientX, y: ev.clientY, touch: true };
        try { pickLayer.setPointerCapture(ev.pointerId); } catch (_) { /* 無視 */ }
        scheduleHover();
        return;
      }
      pickAt(ev.clientX, ev.clientY);
    });
    const endAim = (ev, take) => {
      if (st.aim === null || ev.pointerId !== st.aim) return;
      st.aim = null; st.cursor = null;
      scheduleHover();
      if (!take || !ready()) return;
      const rc = pickLayer.getBoundingClientRect();
      if (ev.clientX < rc.left || ev.clientX > rc.right || ev.clientY < rc.top || ev.clientY > rc.bottom) return;   // 図面の外で指を離した時は取り消し
      pickAt(ev.clientX, ev.clientY);
    };
    pickLayer.addEventListener('pointerup', (ev) => endAim(ev, true));
    pickLayer.addEventListener('pointercancel', (ev) => endAim(ev, false));

    // ---- 縮尺 ----
    // 取った2点を捨てる。確かめる欄に入れた「図面に書いてある寸法」はその2点のものなので、一緒に消す(入力途中の判定の予約も取り消す)
    function dropPicks() { st.picks = []; checkLen.value = ''; cancelJudge(); closeChooser(false); }
    function setMode(m) {
      st.mode = m;
      st.calibrating = m === 'dim';   // 「寸法で合わせる」を押したら(合わせ直しも含め)2点を取り直す
      dropPicks(); clearNotes();
      realLen.value = '';   // 前に合わせた時の値を残さない(残っていると、次の2点を取った時点で、別の線の寸法のまま確定できてしまう)
      refreshUI(); drawPicks();
    }
    modeDimBtn.addEventListener('click', () => setMode('dim'));
    modePresetBtn.addEventListener('click', () => {
      // いまの縮尺を入力欄に出しておく(打ち直しの手間を減らす)。まだ決まっていない時は 1/100 を置く
      //   (プルダウンだけだった頃の既定が 1/100 で、切り替えてすぐ押せば 1/100 になっていた。その手数を保つ)
      const pg = curPg();
      if (pg && pg.k) denInput.value = String(Math.round(denOf(pg, PT2MM * unitOf(pg)) * 1000) / 1000);
      else if (!denInput.value) denInput.value = '100';
      denWarn.hidden = true;
      setMode('preset');
    });
    realLen.addEventListener('input', refreshUI);
    realLen.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !applyDimBtn.disabled) applyDimBtn.click(); });
    applyDimBtn.addEventListener('click', () => {
      const pg = curPg();
      if (!pg || st.picks.length < 2) return;
      const err = calibrate(pg, st.picks, parseFloat(realLen.value));
      if (err) { setScaleNote(err, 'error'); return; }
      const hadFocus = document.activeElement === realLen || document.activeElement === applyDimBtn;
      pg.prev = null;
      st.calibrating = false; dropPicks(); clearNotes(); realLen.value = '';
      refreshUI(); drawPicks();
      // 確定すると入力欄とボタンが隠れる。キーボードで操作している人が位置を見失わないよう、次の手順(確かめる)へフォーカスを移す
      if (hadFocus) { try { checkBox.focus({ preventScroll: true }); } catch (_) { /* 無視 */ } }
      // 縮尺の行(いまの状態)が画面の外へ出た時は、見える所へ戻す。画面の低い窓では、確定で欄が縮んだ拍子に縮尺の行が画面の上へ出て、
      // 先頭に見える行が「測った値を使う」のリンクになり、それがいまの状態のように読めた。縮尺を変える操作(合わせ直す・戻す・切り替える・選ぶ)は、どれも同じ
      bringIntoView(scaleStatus);
    });
    // 標準の縮尺ちょうどを採用した後でも、測った値に戻せる(もう一度押すと標準の縮尺に戻る)
    calToggle.addEventListener('click', () => {
      const pg = curPg();
      if (!pg || !pg.cal || pg.cal.kind !== 'adopt' || pg.kFrom) return;
      pg.cal.adopted = !pg.cal.adopted;
      applyCal(pg);
      clearNotes();
      refreshUI(); drawPicks();
      bringIntoView(scaleStatus);
    });
    // 確かめる: 図面に書いてある寸法(任意)。合わなかった時は、その2点と寸法で縮尺を合わせ直せる。
    // 判定は、入力が止まってから(約 0.6 秒)・Enter・欄を離れた時に出す。入力している間は、判定の行と合わせ直しのボタンを隠し、縮尺の欄の高さを保つ
    // (1文字ごとに判定していた時は、打つたびに「合いません」とボタンが出ては消え、欄の高さが 96px 跳ねていた)
    const JUDGE_WAIT_MS = 600;
    let judgeTimer = 0;
    function cancelJudge() { clearTimeout(judgeTimer); judgeTimer = 0; st.checkTyping = false; }
    // reveal = 判定の行が画面の外に出る時は、見える所まで動かす(欄を離れた時は動かさない: 別の所を押している最中かもしれない)
    function judgeNow(reveal) {
      if (!st.checkTyping) return;
      cancelJudge();
      refreshUI(); drawPicks();
      if (reveal) bringIntoView(checkLen.closest('.p2d-row'));
    }
    checkLen.addEventListener('input', () => {
      if (!st.checkTyping) scaleBox.style.minHeight = scaleBox.offsetHeight + 'px';   // 出ていた判定を隠しても、欄が縮まないように
      st.checkTyping = true;
      clearTimeout(judgeTimer);
      judgeTimer = setTimeout(() => judgeNow(true), JUDGE_WAIT_MS);
      refreshUI(); drawPicks();
    });
    checkLen.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); judgeNow(true); } });
    // 欄を離れた時。ただし、マウスや指でほかの所を押したせいで離れた時は、その場では判定しない(押している最中に判定の行が現れると、下のボタンがずれて押し損なう)。
    // この時は、入力が止まってからの判定(上のタイマー)に任せる
    let pointerHeld = false;
    document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
    for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { pointerHeld = false; }, true);
    checkLen.addEventListener('blur', () => { if (!pointerHeld) judgeNow(false); });
    checkLen.addEventListener('focus', () => { try { checkLen.select(); } catch (_) { /* 無視 */ } });
    recalBtn.addEventListener('click', () => {
      const pg = curPg();
      if (!pg || st.calibrating || st.picks.length < 2) return;
      // 合わせ直す前の縮尺を1つだけ覚えておく(calibrate は cal を作り直すので、前の cal はそのまま残る)
      const prev = { k: pg.k, kLabel: pg.kLabel, cal: pg.cal, kFrom: pg.kFrom };
      const err = calibrate(pg, st.picks, parseFloat(checkLen.value));
      if (err) { setScaleNote(err, 'error'); return; }
      pg.prev = prev;
      dropPicks(); clearNotes();
      refreshUI(); drawPicks();
      try { recalUndoBtn.focus({ preventScroll: true }); } catch (_) { /* 無視 */ }   // 押したボタンは隠れる。すぐ取り消せるよう、戻すリンクへ
      bringIntoView(scaleStatus);
    });
    recalUndoBtn.addEventListener('click', () => {
      const pg = curPg();
      if (!pg || !pg.prev) return;
      const p = pg.prev;
      pg.k = p.k; pg.kLabel = p.kLabel; pg.cal = p.cal; pg.kFrom = p.kFrom; pg.prev = null;
      dropPicks(); st.note = null;
      setScaleNote('前の縮尺(' + shortScale(p.kLabel) + ')に戻しました。', 'done');
      drawPicks();
      try { checkBox.focus({ preventScroll: true }); } catch (_) { /* 無視 */ }
      bringIntoView(scaleStatus);   // 「戻しました」の文より、縮尺の行(いまの状態)が見えることを優先する
    });
    // fromDims = 図面に書いてある寸法から読んだ値を使う時(画面の表示を「指定した」と言い分ける)
    function applyDen(fromDims) {
      const r = readDen();
      denWarn.hidden = r.ok;
      if (!r.ok) { denWarn.textContent = r.why; return; }
      const den = r.den;
      // DXF は、縮尺で用紙の中の大きさが変わるので、図面データごと作り直す(画面の表示と保存の中身をずらさないため)
      if (isDxf()) {
        clearNotes();
        applyDxfScale(den);
        dropPicks();
        renderPage(0);
        bringIntoView(scaleStatus);
        return;
      }
      const pg = curPg();
      if (!pg) return;
      pg.k = PT2MM * unitOf(pg) * den; pg.kFrom = null;
      pg.cal = { preset: true, nominal: den, fromDims: !!fromDims };
      pg.kLabel = denText(den) + (fromDims ? '(図面の寸法から)' : '(指定した縮尺)');
      pg.prev = null;
      st.calibrating = false; dropPicks(); clearNotes();
      refreshUI(); drawPicks();
      bringIntoView(scaleStatus);
    }
    applyPresetBtn.addEventListener('click', () => applyDen(false));   // click の引数をそのまま渡さない(真になってしまう)
    // 「1/50 で合わせる」: 読み取った縮尺をそのまま使う(勝手には変えない。押された時だけ)
    dimBtn.addEventListener('click', () => {
      const den = parseFloat(dimBtn.dataset.den);
      if (!(den > 0)) return;
      denInput.value = String(den);
      denWarn.hidden = true;
      applyDen(true);
    });
    // プルダウンは入力欄への近道。選んだらそのまま確定する(2手かかるのを避ける)
    presetSel.addEventListener('change', () => {
      const v = parseFloat(presetSel.value);
      if (!(v > 0)) return;
      denInput.value = String(v);
      presetSel.value = '';
      applyDen();
    });
    denInput.addEventListener('input', () => { if (!denWarn.hidden && readDen().ok) denWarn.hidden = true; });
    denInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); applyDen(); } });
    const pageList = (a) => (a.length > 10 ? a.slice(0, 10).join('・') + ' ほか' : a.join('・')) + ' ページ目';
    applyAllBtn.addEventListener('click', async () => {
      const cur = curPg();
      if (!cur || !cur.k || !cur.geom || st.busy) return;
      st.busy = true;
      try {
        // 縮尺は用紙の上での比率なので、用紙の大きさ(向きは問わない)が同じページにだけ写す
        const u0 = unitOf(cur);
        const base = [Math.min(cur.geom.vpW, cur.geom.vpH) * u0, Math.max(cur.geom.vpW, cur.geom.vpH) * u0];
        const done = [], other = [];
        for (let i = 0; i < st.numPages; i++) {
          if (i === st.pageIndex) continue;
          if (!st.pages[i]) st.pages[i] = newPg();
          const pg = st.pages[i];
          if (pg.k) continue;
          const page = await st.pdf.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 }), u = page.userUnit > 0 ? page.userUnit : 1;
          const sz = [Math.min(vp.width, vp.height) * u, Math.max(vp.width, vp.height) * u];
          if (Math.abs(sz[0] - base[0]) > 2 || Math.abs(sz[1] - base[1]) > 2) { other.push(i + 1); continue; }
          pg.k = cur.k * u / u0; pg.kFrom = st.pageIndex + 1; pg.prev = null;
          pg.cal = cur.cal ? Object.assign({}, cur.cal) : null;   // 合わせ方の記録も写す(誤差の目安と、吸着なしの注意を引き継ぐ)
          // 測った値を使っている時は、元のページと同じ「約 1/○」の表示にする(写した先だけ 1/100 と言い切らない)
          const measured = pg.cal && !pg.cal.preset && !pg.cal.adopted;
          // 「同じ縮尺」とは書かない: 写した後に元のページの縮尺を変えても、写した先は変わらない
          pg.kLabel = (measured ? measuredLabel(pg.cal.denMeasured) : scaleLabel(pg.k, u)) + '(' + (st.pageIndex + 1) + 'ページ目から写した縮尺)';
          done.push(i + 1);
        }
        st.busy = false;
        setScaleNote((done.length ? '縮尺が未設定だった ' + done.length + ' ページ(' + pageList(done) + ')に、このページの縮尺を設定しました。縮尺の違う図面が混ざっていないか、各ページで確かめてください。'
          : 'このページと同じ用紙サイズで、縮尺が未設定のページはありません。') +
          (other.length ? ' 用紙サイズが違う ' + pageList(other) + 'には設定していません(それぞれのページで合わせてください)。' : ''), 'done');
      } catch (e) {
        console.error('[p2d] apply all failed', e);
        st.busy = false;
        setScaleNote('縮尺の設定に失敗しました: ' + (e && e.message ? e.message : e), 'error');
      }
    });
    showLines.addEventListener('change', drawVectors);

    // ===================== 3.6 JWW の書き出し(第2段) =====================
    // Jw_cad は DXF の色を必ず「SXF対応拡張線色」で読むので、DXF では利用者の線色設定(白背景用の色・線色ごとの印刷線幅)に乗らない。
    // JWW を直接書けば、線1本ずつに線色1〜8・線種1〜8を指定できる(Jw_cad 8.25a の実機で確認済み)。
    // ここは入口だけ。座標は用紙上のmm(図寸)をそのまま渡し、縮尺はヘッダにだけ書く(scale:1 + headerScale:分母)。
    // 組み立て・掃除・読み直し検査は 73-prims-to-jww.js、ファイル形式は 72-jww-writer.js が受け持つ
    const jwwNS = () => {
      const NS = window.P2D;
      if (!NS || !NS.jwwWriter || !NS.primsToJww || !NS.jwwTemplate) throw new Error('JWW を書き出す部品が読み込まれていません');
      return NS;
    };
    // 図面 → 部品(prims)。座標は用紙上のmm。レイヤは 線・円・文字 の3つ(出てきた順にレイヤ0・1・2へ入る)
    function primsOf(g, unit) {
      const s = PT2MM * unit, out = [];
      for (const l of g.lines) out.push({ t: 'L', a: { x: l.x1 * s, y: l.y1 * s }, b: { x: l.x2 * s, y: l.y2 * s }, aci: l.col, lt: l.lt, layer: '線' });
      for (const c of g.circles) out.push({ t: 'C', cx: c.cx * s, cy: c.cy * s, r: c.r * s, aci: c.col, lt: c.lt, layer: '円' });
      for (const a of g.arcs) out.push({ t: 'A', cx: a.cx * s, cy: a.cy * s, r: a.r * s, a1: a.a1, a2: a.a2, aci: a.col, lt: a.lt, layer: '円' });
      for (const t of g.texts) out.push({ t: 'T', x: t.x * s, y: t.y * s, h: t.h * s, s: t.s, rot: t.rot, aci: 7, layer: '文字' });
      return out;
    }
    // 用紙: ページがそのまま入り、図形も用紙からはみ出さない、いちばん小さい Jw_cad の用紙。
    //   Jw_cad の用紙は横置きしか無いので、縦向きのページは一回り大きい用紙になる(A4縦 → A3)
    //   図形の側には 1mm の余裕を持たせる。用紙選びは 0.5mm まで大目に見る(1191pt = 420.16mm のような、A3 を少しはみ出す大きさのページを A3 に収めるため)ので、
    //   その大目に見た分だけ図形が用紙からはみ出すと、書き出し直前の検査で止まってしまう
    const PAPER_PAD_MM = 1.0;
    function paperFor(g, prims, unit) {
      const P = jwwNS().primsToJww, s = PT2MM * unit;
      const pw = g.vpW * s, ph = g.vpH * s, ox = pw / 2, oy = ph / 2;
      const b = P.drawingBbox(prims);
      const reqW = Math.max(pw, 2 * Math.max(Math.abs(b[0] - ox), Math.abs(b[2] - ox)) + PAPER_PAD_MM);
      const reqH = Math.max(ph, 2 * Math.max(Math.abs(b[1] - oy), Math.abs(b[3] - oy)) + PAPER_PAD_MM);
      return { code: P.choosePaperCode(reqW, reqH), origin: [ox, oy] };
    }
    const PAPER_LABEL = { 0: 'A0', 1: 'A1', 2: 'A2', 3: 'A3', 4: 'A4' };
    const paperLabel = (code) => PAPER_LABEL[code] || 'A0より大きい用紙';
    // 縮尺の分母を画面の文にする(1/100・1/103.1 など)
    const denLabel = (d) => '1/' + (Math.abs(d - Math.round(d)) < 0.005 ? String(Math.round(d)) : String(Math.round(d * 10) / 10));
    // ヘッダに書く縮尺の分母。標準の縮尺を採用した時・プルダウンで選んだ時は、その値ちょうどを書く
    //   (pg.k から割り戻すと 99.99999999999999 のような値になり、Jw_cad の縮尺の欄に出てしまう)
    function denOf(pg, s) {
      const c = pg.cal;
      if (c && c.nominal > 0 && (c.preset || c.adopted)) return c.nominal;
      const d = pg.k / s, r = Math.round(d);
      return Math.abs(d - r) < 1e-9 * Math.max(1, Math.abs(d)) ? r : d;
    }
    // 1ページぶんの JWW を作る(読み直し検査に通ったものだけが返る。落ちたら例外)
    function buildJww(pg) {
      const NS = jwwNS(), g = pg.geom, unit = unitOf(pg), s = PT2MM * unit;
      const prims = primsOf(g, unit);
      if (!prims.length) throw new Error('変換できる線や文字がありません');
      const paper = paperFor(g, prims, unit);
      const opt = { colorMode, scale: 1, headerScale: denOf(pg, s), origin: paper.origin, paperCode: paper.code };
      // 内蔵ひな形の時だけ、画面の線色が想定どおりかを確かめる(登録したひな形の色は利用者のものなので見ない)
      if (!userTmpl) opt.expectPalette = NS.jwwTemplate.BUILTIN_PALETTE;
      return NS.primsToJww.convert({ prims }, userTmpl ? userTmpl.bytes : NS.jwwTemplate.builtinTemplate(), opt);
    }
    // 保存した後の文(JWW)。入れなかったもの・置き換えた文字は黙らずに数で知らせる
    function doneTextJww(pg, r) {
      const i = r.info, c = i.stats, prims = i.prims;
      const n = (t) => prims.filter((p) => p.t === t).length;
      const bits = [];
      if (c.unencodable_chars) bits.push('Jw_cad で扱えない文字が ' + fmtInt(c.unencodable_chars) + ' 個あったため「?」に置き換えました。');
      const dropped = c.dropped_zero_length_lines + c.dropped_zero_radius_arcs + c.dropped_empty_texts + c.dropped_bad_size_texts;
      if (dropped) bits.push('長さ0の線や中身の無い文字など ' + fmtInt(dropped) + ' 個は入れていません。');
      if (c.flat_arcs_to_lines) bits.push('ほぼ真っすぐな円弧 ' + fmtInt(c.flat_arcs_to_lines) + ' 個は線にしました。');
      if (pg.geom.imageAreaPct >= 5) bits.push('画像の部分は含まれていません。');
      if (!userTmpl) bits.push('標準のひな形で書き出しました。線の色や印刷の設定をご自分の Jw_cad に合わせたい時は、下の「Jw_cad の設定を登録」からひな形を登録してください。');
      return '保存しました(線 ' + fmtInt(n('L')) + ' 本・円/円弧 ' + fmtInt(n('C') + n('A')) + ' 個・文字 ' + fmtInt(n('T')) + ' 個)。' +
        '用紙 ' + paperLabel(i.paperCode) + ' ・ 縮尺 ' + denLabel(i.headerScale) + ' ・ レイヤは「線」「円」「文字」。' +
        'Jw_cad の「ファイル」→「開く」でそのまま開けます。' + (bits.length ? ' ' + bits.join(' ') : '');
    }

    // ---- ひな形(利用者の Jw_cad の設定)。図形は取り込まず、ヘッダだけをこのブラウザの中に保存する ----
    function tmplDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(TMPL_DB, 1);
        req.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(TMPL_STORE)) db.createObjectStore(TMPL_STORE); };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
      });
    }
    function tmplTx(mode, run) {
      return tmplDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction([TMPL_STORE], mode), store = tx.objectStore(TMPL_STORE);
        let got;
        try { got = run(store); } catch (e) { db.close(); reject(e); return; }
        tx.oncomplete = () => { db.close(); resolve(got && got.result !== undefined ? got.result : got); };
        tx.onerror = (e) => { db.close(); reject(e.target.error); };
      }));
    }
    const tmplLoad = () => tmplTx('readonly', (st2) => st2.get(TMPL_KEY)).catch(() => null);
    const tmplPut = (rec) => tmplTx('readwrite', (st2) => { st2.put(rec, TMPL_KEY); });
    const tmplDrop = () => tmplTx('readwrite', (st2) => { st2.delete(TMPL_KEY); });
    // 選んでもらった .jww から、図面メモ・レイヤ名を空にしたヘッダだけを取り出す
    async function registerTemplate(file) {
      const NS = jwwNS();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const header = NS.jwwWriter.extractTemplateHeader(bytes);   // Ver700 以外・読めないファイルはここで断られる
      const rec = { bytes: header, name: file.name, at: Date.now() };
      await tmplPut(rec);
      userTmpl = rec;
    }

    // ---- 保存の設定(形式・線の色・ひな形)----
    function refreshOutputUI() {
      fmtJwwBtn.classList.toggle('active', outFmt === 'jww');
      fmtDxfBtn.classList.toggle('active', outFmt === 'dxf');
      jwwOpts.hidden = outFmt !== 'jww';
      fmtHint.textContent = outFmt === 'jww'
        ? 'Jw_cad の図面ファイル(.jww)をそのまま作ります。線の色と線種が Jw_cad の線色1〜8・線種1〜8に入るので、画面の色も印刷の太さも、お使いの設定どおりになります。'
        : 'DXFファイル(.dxf)を作ります。ほかのCADでも読めますが、Jw_cad で開くと線の色は「SXF対応拡張線色」になり、線色ごとの設定(画面の色・印刷の太さ)には乗りません。';
      colorSel.value = colorMode;
      tmplClearBtn.hidden = !userTmpl;
      tmplState.textContent = userTmpl
        ? 'いまのひな形: ' + userTmpl.name + '(登録した設定で書き出します)'
        : 'いまのひな形: 標準。ご自分の Jw_cad の線の色や印刷の設定に合わせたい時は、Jw_cad で図形の無い図面を保存して、「Jw_cad の設定を登録」から選んでください。図面は取り込まず、設定の部分だけをこのパソコンのブラウザの中に保存します。';
      exportBtn.textContent = outFmt === 'jww' ? 'JWWに変換して保存' : 'DXFに変換して保存';
    }
    function setFmt(v) {
      outFmt = v === 'dxf' ? 'dxf' : 'jww';
      lsSet(FMT_KEY, outFmt);
      clearNotes();
      refreshOutputUI(); refreshUI();
    }
    fmtJwwBtn.addEventListener('click', () => setFmt('jww'));
    fmtDxfBtn.addEventListener('click', () => setFmt('dxf'));
    colorSel.addEventListener('change', () => {
      colorMode = colorSel.value === 'original' ? 'original' : 'white';
      lsSet(COLOR_KEY, colorMode);
    });
    tmplPickBtn.addEventListener('click', () => { tmplInput.value = ''; tmplInput.click(); });
    tmplInput.addEventListener('change', async () => {
      const f = tmplInput.files && tmplInput.files[0];
      if (!f) return;
      try {
        await registerTemplate(f);
        refreshOutputUI();
        setNote('ひな形を登録しました。次からは、この設定(線の色・線種・印刷の設定)で書き出します。', 'done');
      } catch (e) {
        console.error('[p2d] template register failed', e);
        setNote('このファイルはひな形にできません: ' + (e && e.message ? e.message : e), 'error');
      }
      refreshUI();
    });
    tmplClearBtn.addEventListener('click', async () => {
      try { await tmplDrop(); } catch (e) { console.error('[p2d] template clear failed', e); }
      userTmpl = null;
      refreshOutputUI();
      setNote('標準のひな形に戻しました。', 'done');
      refreshUI();
    });
    refreshOutputUI();
    tmplLoad().then((rec) => {
      if (!rec || !rec.bytes) return;
      userTmpl = rec;
      refreshOutputUI();
    });

    // ===================== 3.7 図面に書いてある寸法から縮尺を読む =====================
    // 図面の寸法文字(「3,640」など)と、その寸法線の長さを突き合わせると、この図面が本来何分の1かが分かる。
    // 使い道は3つ: ①読み込んだ直後に縮尺を提案する ②合わせた縮尺が図面と食い違う時に知らせる ③変換の答え合わせを数で出す。
    // いちばん怖いのは「違います」と誤って言うことなので、確かなことが言えない時は黙る(下の DIM_MIN_PAIRS と ばらつきの関門)
    const DIM_NEAR_PT = 30;        // 寸法文字から寸法線までの距離(用紙上pt)。これより遠い線はその文字の寸法線ではない
    const DIM_MIN_MM = 100, DIM_MAX_MM = 30000;   // 寸法らしい値の範囲(部屋名や面積・縮尺の表記を拾わないため)
    const DIM_TOL_REL = 0.03, DIM_TOL_MM = 30;    // 2回目の対応付けで「その寸法線」と認める許容
    const DIM_MIN_PAIRS = 5;       // 対にできた寸法がこれ未満なら、何も言わない
    const DIM_MAX_LINES = 300000;  // 線が多すぎる図面では諦める(画面が固まらないように)
    const DIM_BUCKET_PT = 64;      // 線を置き場所で仕分ける升目の大きさ

    // 数字だけの文字を拾う。文字の中心をだいたいの位置として持つ(x,y は書き始めの位置なので、そのままだと左に寄る)
    function dimTexts(g) {
      const out = [];
      for (const t of g.texts) {
        const raw = String(t.s === undefined || t.s === null ? '' : t.s).trim();
        if (!/^[0-9][0-9,]*$/.test(raw)) continue;
        const v = parseFloat(raw.split(',').join(''));
        if (!(v >= DIM_MIN_MM && v <= DIM_MAX_MM)) continue;
        const w = raw.length * (t.h || 0) * 0.5;        // 数字の幅のおおよそ(高さの半分 × 文字数)
        const rot = ((t.rot || 0) % 360 + 360) % 360;
        const horiz = rot < 45 || rot > 315;
        const rad = rot * Math.PI / 180;
        out.push({ v, horiz, x: t.x + Math.cos(rad) * w / 2, y: t.y + Math.sin(rad) * w / 2 });
      }
      return out;
    }
    // 縦横の線を、置き場所の升目に仕分ける(文字の近くの線だけを見るため)
    function dimLineIndex(g) {
      const idx = { H: new Map(), V: new Map() };
      const put = (m, l, len, mx, my) => {
        const key = Math.round(mx / DIM_BUCKET_PT) + ':' + Math.round(my / DIM_BUCKET_PT);
        let a = m.get(key);
        if (!a) { a = []; m.set(key, a); }
        a.push({ len, mx, my });
      };
      for (const l of g.lines) {
        const dx = Math.abs(l.x2 - l.x1), dy = Math.abs(l.y2 - l.y1);
        if (dy < 0.01 && dx >= 3) put(idx.H, l, dx, (l.x1 + l.x2) / 2, l.y1);
        else if (dx < 0.01 && dy >= 3) put(idx.V, l, dy, l.x1, (l.y1 + l.y2) / 2);
      }
      return idx;
    }
    // ある文字の近くにある線を集める(升目の周り1つぶんだけ見る)
    function dimNear(idx, t) {
      const m = t.horiz ? idx.H : idx.V, out = [];
      const cx = Math.round(t.x / DIM_BUCKET_PT), cy = Math.round(t.y / DIM_BUCKET_PT);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const a = m.get((cx + i) + ':' + (cy + j));
          if (!a) continue;
          for (const l of a) { const d = Math.hypot(l.mx - t.x, l.my - t.y); if (d <= DIM_NEAR_PT) out.push({ len: l.len, d }); }
        }
      }
      return out;
    }
    // 図面の寸法から縮尺を読む。読めなければ null(何も言わない)
    //   返り値: { den, k, pairs, median, p95, worst, texts } — den は分母、median などは「図面の寸法と何mm違うか」
    function readDimScale(g, unit) {
      if (!g || !g.lines || g.lines.length > DIM_MAX_LINES) return null;
      const ts = dimTexts(g);
      if (ts.length < DIM_MIN_PAIRS) return null;
      const idx = dimLineIndex(g);
      // 1回目: 文字1つにつき、いちばん近い線1本だけで比をとり、その中央値をだいたいの縮尺にする
      //   (近くの線を全部入れると、短い補助線の比が混ざって中央値が壊れる)
      const rough = [];
      for (const t of ts) {
        let best = null;
        for (const l of dimNear(idx, t)) if (!best || l.d < best.d) best = l;
        if (best && best.len > 0) rough.push(t.v / best.len);
      }
      if (rough.length < DIM_MIN_PAIRS) return null;
      rough.sort((a, b) => a - b);
      const k0 = rough[Math.floor(rough.length / 2)];
      if (!(k0 > 0 && isFinite(k0))) return null;
      // 2回目: だいたいの縮尺で長さが合う線だけを「その文字の寸法線」と認める
      const pairs = [];
      for (const t of ts) {
        let best = null;
        for (const l of dimNear(idx, t)) {
          if (Math.abs(l.len * k0 - t.v) > Math.max(DIM_TOL_MM, t.v * DIM_TOL_REL)) continue;
          if (!best || l.d < best.d) best = l;
        }
        if (best) pairs.push({ v: t.v, len: best.len });
      }
      if (pairs.length < DIM_MIN_PAIRS) return null;
      // 比例の当てはめ(最小二乗)。長い寸法ほど効くので、縮尺は長い寸法で決まる
      let sxy = 0, sxx = 0;
      for (const p of pairs) { sxy += p.len * p.v; sxx += p.len * p.len; }
      if (!(sxx > 0)) return null;
      const k = sxy / sxx, den = k / (PT2MM * (unit || 1));
      if (!(den > 0 && isFinite(den))) return null;
      const abs = pairs.map((p) => Math.abs(p.len * k - p.v)).sort((a, b) => a - b);
      const at = (f) => abs[Math.min(abs.length - 1, Math.floor(abs.length * f))];
      return { den, k, pairs: pairs.length, texts: ts.length, median: at(0.5), p95: at(0.95), worst: at(1) };
    }
    // 読み取った縮尺を信用してよいか。ばらつきが大きい時は使わない(誤警告を出さないための関門)
    //   目安は「座標の刻み2つぶん」と「寸法の 1%」の大きいほう。刻みが分からない図面では 1% だけで見る
    function dimScaleTrusted(r, g, unit) {
      if (!r || r.pairs < DIM_MIN_PAIRS) return false;
      const gridMm = (g.quantum && g.quantum.q ? g.quantum.q : 0) * r.k;
      const typical = r.k * 100;   // 用紙上100pt ぶんの実寸。寸法の大きさのおおよそ
      return r.median <= Math.max(gridMm * 2, typical * 0.01);
    }
    // ページごとに1回だけ計算して覚えておく
    function dimScaleOf(pg) {
      if (!pg || !pg.geom) return null;
      if (pg.dimScale === undefined) {
        let r = null;
        try { r = readDimScale(pg.geom, unitOf(pg)); } catch (e) { console.error('[p2d] dim scale failed', e); r = null; }
        pg.dimScale = r && dimScaleTrusted(r, pg.geom, unitOf(pg)) ? r : null;
      }
      return pg.dimScale;
    }
    // 読み取った分母を、画面に出す値にする。標準の縮尺に 1% 以内で寄っていれば、その切りのよい値にする
    //   (1/50.01 を「1/50.01」と出しても現場では使いにくい。丸めるのは表示と提案だけで、判定は生の値で行う)
    function dimNominal(den) {
      let best = null, rel = Infinity;
      for (const n of nominalList()) { const r = Math.abs(den / n - 1); if (r < rel) { rel = r; best = n; } }
      if (best !== null && rel <= 0.01) return best;
      return Math.round(den * 100) / 100;
    }
    // 図面の寸法から読んだ縮尺の行。3つの顔を持つ:
    //   縮尺が未設定 → 提案(ボタンで一発で合わせられる) / 合っている → 答え合わせの数 / 食い違う → 注意とボタン
    //   確かなことが言えない図面(寸法文字が無い・ばらつきが大きい)では、この行ごと出さない
    function dimNoteInfo(pg) {
      const r = dimScaleOf(pg);
      if (!r) return null;
      const want = dimNominal(r.den);
      const shown = '1/' + want;
      const where = '(図面の寸法 ' + fmtInt(r.pairs) + ' か所で確認)';
      if (!pg.k) {
        return { text: '図面に書いてある寸法から、この図面の縮尺は ' + shown + ' と読み取れました' + where + '。', btn: shown + ' で合わせる', den: want, caution: false };
      }
      const now = denOf(pg, PT2MM * unitOf(pg));
      const off = Math.abs(now / r.den - 1);
      if (off > 0.02) {
        return { text: 'いまの縮尺(' + denText(now) + ')は、図面に書いてある寸法と合いません。この図面の寸法からは ' + shown + ' と読み取れます' + where + '。',
          btn: shown + ' にする', den: want, caution: true };
      }
      return { text: '図面に書いてある寸法 ' + fmtInt(r.pairs) + ' か所と突き合わせました。95% が ' + errText(r.p95) + ' 以内で合っています。', btn: '', den: 0, caution: false };
    }

    // ===================== 4. DXF を入力にする(第3段) =====================
    // メーカー提供の DXF は SPLINE(自由曲線)・ELLIPSE(楕円)などを含み、Jw_cad はそれを黙って飛ばすので外形が途切れて見える。
    // ここで分解して、円弧にできるものは円弧に・できないものは細かい折れ線にしてから渡す(分解そのものは 71-dxf-flatten.js)。
    // 画面では、分解した部品を「PDF と同じ形の図面データ」に作り直して使う。こうすると、青い線の表示・吸着・ルーペ・確かめる・保存が、
    // PDF の時と同じ部品のまま動く(DXF 専用の描画や操作を作らずに済む)
    const A3_MM = [420, 297];                                      // Jw_cad の A3(用紙は横置きだけ)
    const A3_PT = [A3_MM[0] / PT2MM, A3_MM[1] / PT2MM];
    const dxfNS = () => {
      const NS = window.P2D;
      if (!NS || !NS.dxfFlatten) throw new Error('DXF を読む部品が読み込まれていません');
      return NS.dxfFlatten;
    };
    // 部品(実寸mm)→ 画面で使う図面データ(用紙上pt・A3 の中央に置く)
    function geomFromPrims(primsDoc, den) {
      const s = 1 / (PT2MM * den), b = primsDoc.bbox;
      const ox = (b[0] + b[2]) / 2, oy = (b[1] + b[3]) / 2;
      const X = (x) => (x - ox) * s + A3_PT[0] / 2, Y = (y) => (y - oy) * s + A3_PT[1] / 2;
      const g = { lines: [], circles: [], arcs: [], texts: [], images: 0, imageAreaPct: 0,
        vpW: A3_PT[0], vpH: A3_PT[1], unit: 1, quantum: null, hiddenLayer: false, hiddenTextUnsure: false, nonRectClip: false };
      for (const p of primsDoc.prims) {
        const lt = p.lt || 'CONTINUOUS', col = p.aci;
        if (p.t === 'L') g.lines.push({ x1: X(p.a.x), y1: Y(p.a.y), x2: X(p.b.x), y2: Y(p.b.y), col, lt });
        else if (p.t === 'C') g.circles.push({ cx: X(p.cx), cy: Y(p.cy), r: p.r * s, col, lt });
        else if (p.t === 'A') g.arcs.push({ cx: X(p.cx), cy: Y(p.cy), r: p.r * s, a1: p.a1, a2: p.a2, col, lt });
        else if (p.t === 'T') g.texts.push({ x: X(p.x), y: Y(p.y), h: p.h * s, s: p.s, rot: p.rot || 0 });
        else if (p.t === 'S') {
          // 塗り(ソリッド)は、画面では外周の線として見せる(保存の時は部品のまま塗りとして入る)
          const q = p.q, o = [q[0], q[1], q[3], q[2]];
          for (let i = 0; i < 4; i++) { const a = o[i], c = o[(i + 1) % 4]; g.lines.push({ x1: X(a.x), y1: Y(a.y), x2: X(c.x), y2: Y(c.y), col, lt: 'CONTINUOUS' }); }
        }
      }
      return g;
    }
    // 用紙(A3)に余白つきで収まる、いちばん小さい縮尺分母
    function autoDen(primsDoc) {
      const P = jwwNS().primsToJww, b = primsDoc.bbox;
      const framed = P.hasSheetFrame(primsDoc.prims, b);
      return P.chooseScale(b[2] - b[0], b[3] - b[1], framed, 3);
    }
    // 縮尺を決めて、画面の図面データを作り直す(縮尺を変えた時にも呼ぶ)
    function applyDxfScale(den) {
      dxfIn.den = den;
      const pg = { geom: geomFromPrims(dxfIn.primsDoc, den), k: PT2MM * den, kLabel: '1/' + den, kFrom: null,
        cal: { preset: true, nominal: den }, prev: null, index: null };
      st.pages = { 0: pg };
      denInput.value = String(den);   // プルダウンには足さない(足すと、次に PDF を開いた時の「標準の縮尺」の一覧が汚れる)
    }
    // 保存した後の文(DXF 由来)。分解で何が起きたかを数で知らせる
    function dxfNotes() {
      const r = dxfIn.report, out = [];
      const cur = (r.arcsFromCurves || 0) + (r.linesFromCurves || 0);
      if (r.curves) out.push('Jw_cad が読めない曲線(自由曲線・楕円など)' + fmtInt(r.curves) + ' 本を、円弧 ' + fmtInt(r.arcsFromCurves || 0) + ' 個と線 ' + fmtInt(r.linesFromCurves || 0) + ' 本に置き換えました(元の形からのずれは最大 ' + (r.worstDeviation < 0.01 ? '0.01' : String(r.worstDeviation)) + 'mm)。');
      const skipped = Object.keys(r.skipped || {}).map((k) => k + ' ' + fmtInt(r.skipped[k]) + '個');
      if (skipped.length) out.push('扱えない要素は入れていません(' + skipped.join('、') + ')。');
      const far = Object.keys(r.farOutliersDropped || {}).reduce((n, k) => n + r.farOutliersDropped[k], 0);
      if (far) out.push('図面から遠く離れた位置にあるごみ ' + fmtInt(far) + ' 個を除きました。');
      if (r.flatArcsToLines) out.push('ほぼ真っすぐな円弧 ' + fmtInt(r.flatArcsToLines) + ' 個は線にしました。');
      return out;
    }

    // ---- 保存 ----
    // DXF 由来の保存。JWW は部品から直接組み立て、DXF は分解し直したものをそのまま出す
    function exportFromDxf(stamp) {
      const base = (dxfIn.name || 'dxf').replace(/[.][^.]*$/, '');
      if (outFmt === 'jww') {
        const NS = jwwNS(), b = dxfIn.primsDoc.bbox;
        const opt = { colorMode, scale: dxfIn.den, paperCode: 3, origin: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] };
        if (!userTmpl) opt.expectPalette = NS.jwwTemplate.BUILTIN_PALETTE;
        const r = NS.primsToJww.convert(dxfIn.primsDoc, userTmpl ? userTmpl.bytes : NS.jwwTemplate.builtinTemplate(), opt);
        triggerDownload(new Blob([r.bytes], { type: 'application/octet-stream' }), base + '_' + stamp + '.jww');
        const i = r.info, c = i.stats, prims = i.prims, n = (t) => prims.filter((p) => p.t === t).length;
        const bits = dxfNotes();
        if (c.unencodable_chars) bits.push('Jw_cad で扱えない文字が ' + fmtInt(c.unencodable_chars) + ' 個あったため「?」に置き換えました。');
        if (!userTmpl) bits.push('標準のひな形で書き出しました。線の色や印刷の設定をご自分の Jw_cad に合わせたい時は、下の「Jw_cad の設定を登録」からひな形を登録してください。');
        setNote('保存しました(線 ' + fmtInt(n('L')) + ' 本・円/円弧 ' + fmtInt(n('C') + n('A')) + ' 個・文字 ' + fmtInt(n('T')) + ' 個)。' +
          '用紙 ' + paperLabel(i.paperCode) + ' ・ 縮尺 ' + denLabel(i.headerScale) + ' ・ レイヤは元の図面のレイヤ名のまま。' +
          'Jw_cad の「ファイル」→「開く」でそのまま開けます。' + (bits.length ? ' ' + bits.join(' ') : ''), 'done');
        return;
      }
      // DXF で保存: 色の割り当てに合わせて分解し直す(元の色に近い = 色を変えない)
      const F = dxfNS();
      const out = F.flattenDxf(dxfIn.bytes, { keepColors: colorMode === 'original', sourceName: dxfIn.name });
      triggerDownload(new Blob([out.flatDxfBytes], { type: 'application/dxf' }), base + '_' + stamp + '.dxf');
      const bits = dxfNotes();
      if (out.report.unencodableChars) bits.push('Jw_cad で扱えない文字が ' + fmtInt(out.report.unencodableChars) + ' 個あったため「?」に置き換えました。');
      const wrote = Object.keys(out.report.written || {}).reduce((n, k) => n + out.report.written[k], 0);
      setNote('保存しました(図形 ' + fmtInt(wrote) + ' 個)。実寸のまま、Jw_cad の「ファイル」→「DXFファイルを開く」で開けます。' +
        (bits.length ? ' ' + bits.join(' ') : ''), 'done');
    }
    function doneText(pg, r) {
      const g = pg.geom;
      return '保存しました(線 ' + fmtInt(g.lines.length) + ' 本・円/円弧 ' + fmtInt(g.circles.length + g.arcs.length) +
        ' 個・文字 ' + fmtInt(g.texts.length) + ' 個)。Jw_cad の「ファイル」→「DXFファイルを開く」で開けます。' +
        (g.imageAreaPct >= 5 ? ' 画像の部分は含まれていません。' : '') +
        (r.bad ? ' Jw_cad で扱えない文字が ' + r.bad + ' 個あったため「?」に置き換えました。' : '');
    }
    exportBtn.addEventListener('click', () => {
      const pg = curPg();
      if (st.busy || !pg || !pg.k || !pg.geom) return;
      try {
        const stamp = makeTimestamp() + '_' + pad2(st.pageIndex + 1);
        if (isDxf()) { exportFromDxf(makeTimestamp()); return; }
        if (outFmt === 'jww') {
          const r = buildJww(pg);
          triggerDownload(new Blob([r.bytes], { type: 'application/octet-stream' }), 'JWW変換_' + stamp + '.jww');
          setNote(doneTextJww(pg, r), 'done', looseCal(pg) ? '縮尺は、' + LOOSE_SAVED : '');
        } else {
          const r = buildDxf(pg.geom, pg.k);
          triggerDownload(new Blob([r.bytes], { type: 'application/dxf' }), 'DXF変換_' + stamp + '.dxf');
          setNote(doneText(pg, r), 'done', looseCal(pg) ? '縮尺は、' + LOOSE_SAVED : '');
        }
      } catch (e) {
        console.error('[p2d] export failed', e);
        setNote('変換に失敗しました: ' + (e && e.message ? e.message : e), 'error');
      }
    });
    exportAllBtn.addEventListener('click', async () => {
      if (st.busy || !window.JSZip) return;
      st.busy = true; setNote('変換しています…', '');
      try {
        const ymd = makeTimestamp(), zip = new window.JSZip(), jww = outFmt === 'jww';
        const skip = { unset: [], scanned: [], empty: [] };   // 保存しないページ(理由ごと)
        let count = 0, bad = 0;
        const borrowed = [], loosePages = [];
        for (let i = 0; i < st.numPages; i++) {
          const pg = st.pages[i];
          if (!pg || !pg.k) { skip.unset.push(i + 1); continue; }
          if (!pg.geom) pg.geom = await extractPage(await st.pdf.getPage(i + 1), st.occ);
          if (isScanned(pg.geom)) { skip.scanned.push(i + 1); continue; }
          if (isEmpty(pg.geom)) { skip.empty.push(i + 1); continue; }
          if (jww) {
            const r = buildJww(pg);
            zip.file('JWW変換_' + ymd + '_' + pad2(i + 1) + '.jww', r.bytes);
            bad += r.info.stats.unencodable_chars;
          } else {
            const r = buildDxf(pg.geom, pg.k);
            zip.file('DXF変換_' + ymd + '_' + pad2(i + 1) + '.dxf', r.bytes);
            bad += r.bad;
          }
          count++;
          if (pg.kFrom) borrowed.push(i + 1);
          if (looseCal(pg)) loosePages.push(i + 1);
        }
        // 保存しなかったページは、理由ごとに文にして知らせる(「3 ページ目は、縮尺が未設定のため保存していません。」)
        const skippedText = [[skip.unset, '縮尺が未設定のため'], [skip.scanned, 'スキャンした画像のため'], [skip.empty, '変換できる線や文字が無いため']]
          .filter((s) => s[0].length).map((s) => pageList(s[0]) + 'は、' + s[1] + '保存していません。').join(' ');
        if (!count) { st.busy = false; setNote('保存できるページがありません。' + skippedText, 'error'); return; }
        triggerDownload(await zip.generateAsync({ type: 'blob' }), (jww ? 'JWW変換_' : 'DXF変換_') + ymd + '.zip');
        st.busy = false;
        setNote(count + ' ページ分をまとめて保存しました。' + (skippedText ? ' ' + skippedText : '') +
          (borrowed.length ? ' ' + pageList(borrowed) + 'は、ほかのページで合わせた縮尺を使っています。' : '') +
          (bad ? ' Jw_cad で扱えない文字が ' + bad + ' 個あったため「?」に置き換えました。' : ''), 'done',
          loosePages.length ? pageList(loosePages) + 'の縮尺は、' + LOOSE_SAVED : '');
      } catch (e) {
        console.error('[p2d] export all failed', e);
        st.busy = false;
        setNote('変換に失敗しました: ' + (e && e.message ? e.message : e), 'error');
      }
    });

    // ---- ページ表示(ステージ幅にフィット・高DPIで描く。塗りつぶしタブと同じ作法) ----
    let fitW = 0;   // いまの表示を作った時の、図面欄の幅(画面px)
    async function renderPage(idx) {
      if (!st.pdf) return;
      idx = Math.max(0, Math.min(st.numPages - 1, idx));
      const gen = ++st.renderGen;
      st.rendering = true;
      if (idx !== st.pageIndex) realLen.value = '';   // ほかのページで入れた寸法を持ち越さない
      st.pageIndex = idx; dropPicks(); st.hover = null; st.cursor = null; st.aim = null; hideLoupe(); clearNotes();
      const page = isDxf() ? null : await st.pdf.getPage(idx + 1);   // DXF の時は下敷きにする絵が無い(白紙に青い線だけを描く)
      if (gen !== st.renderGen) return;
      const vp1 = page ? page.getViewport({ scale: 1 }) : { width: A3_PT[0], height: A3_PT[1] };
      const stageEl = wrap.closest('.redact-stage');
      let availW = stageEl ? stageEl.clientWidth : 0;
      fitW = availW;
      if (availW < 50) availW = 900;
      availW -= 16;
      const ds = Math.min(2, availW / vp1.width);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      let rs = Math.max(ds * dpr * 1.5, 1.5);
      const maxR = Math.max(vp1.width, vp1.height) * rs;
      if (maxR > 4000) rs = rs * 4000 / maxR;
      const rvp = page ? page.getViewport({ scale: rs }) : { width: vp1.width * rs, height: vp1.height * rs };
      const DW = Math.floor(vp1.width * ds), DH = Math.floor(vp1.height * ds);
      canvas.width = Math.ceil(rvp.width); canvas.height = Math.ceil(rvp.height);
      canvas.style.width = DW + 'px'; canvas.style.height = DH + 'px';
      wrap.style.width = DW + 'px'; wrap.style.height = DH + 'px';
      for (const lay of [vecLayer, pickLayer]) {
        lay.width = Math.round(DW * dpr); lay.height = Math.round(DH * dpr);
        lay.style.width = DW + 'px'; lay.style.height = DH + 'px';
      }
      st.ds = ds; st.dpr = dpr;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (page) { try { await page.render({ canvasContext: ctx, viewport: rvp }).promise; } catch (_) { /* 表示だけの失敗は変換に影響しない */ } }
      if (gen !== st.renderGen) return;
      if (!st.pages[idx]) st.pages[idx] = newPg();
      if (!st.pages[idx].geom && page) {
        try { st.pages[idx].geom = await extractPage(page, st.occ); }
        catch (e) {
          console.error('[p2d] extract failed', e);
          st.pages[idx].geom = { lines: [], circles: [], arcs: [], texts: [], images: 0, vpW: vp1.width, vpH: vp1.height, unit: 1, quantum: null };
          st.note = { text: 'このページの線を読み取れませんでした: ' + (e && e.message ? e.message : e), type: 'error' };
        }
      }
      if (gen !== st.renderGen) return;
      pageInfo.textContent = (idx + 1) + ' / ' + st.numPages;
      prevBtn.disabled = idx === 0;
      nextBtn.disabled = idx === st.numPages - 1;
      st.calibrating = st.mode === 'dim' && !st.pages[idx].k;
      st.rendering = false;
      drawVectors(); drawPicks(); refreshUI();
    }
    prevBtn.addEventListener('click', () => { if (!st.rendering) renderPage(st.pageIndex - 1); });
    nextBtn.addEventListener('click', () => { if (!st.rendering) renderPage(st.pageIndex + 1); });
    // 図面欄の幅が変わったら、幅に収まるように描き直す。窓の大きさだけでなく、取説を右に開閉した時も幅が変わる(この時は window の resize が来ない)。
    // 図面はいつも図面欄の幅に収まっている前提で、このタブの図面欄は横にスクロールしない(styles.css)。
    // 20px 未満の変化では描き直さない(縦スクロールバーの出入りで幅が揺れ、描き直しを繰り返すのを防ぐ。図面の左右には 16px の余白がある)
    let resizeTimer = 0;
    function refit() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!st.pdf || !panel.classList.contains('active')) return;
        if (st.rendering) { refit(); return; }
        const stageEl = wrap.closest('.redact-stage');
        if (stageEl && Math.abs(stageEl.clientWidth - fitW) < 20) return;
        renderPage(st.pageIndex);
      }, 200);
    }
    window.addEventListener('resize', refit);
    if (window.ResizeObserver && wrap.closest('.redact-stage')) new ResizeObserver(refit).observe(wrap.closest('.redact-stage'));

    // ---- 読み込み ----
    async function loadPdf(file) {
      setLoadMsg('');
      if (!file || (file.type !== 'application/pdf' && !/[.]pdf$/i.test(file.name || ''))) { setLoadMsg('PDF または DXF のファイルを選んでください。', 'error'); return; }
      try {
        setLoadMsg('読み込んでいます…');
        st.renderGen++; st.rendering = true;   // 読み込み中は前のPDFのページで操作・保存させない
        const pdf = await L.getDocument({ data: await file.arrayBuffer() }).promise;
        st.pdf = pdf; st.numPages = pdf.numPages; st.pages = {}; st.pageIndex = 0; dxfIn = null; dropPicks(); clearNotes();
        st.occ = null;
        try { st.occ = await pdf.getOptionalContentConfig(); } catch (_) { /* レイヤ情報が読めなければ全部表示扱い */ }
        st.mode = 'dim'; realLen.value = '';
        setLoadMsg('');
        upload.style.display = 'none';
        editor.classList.add('active');
        await renderPage(0);
        // 読み込んだら、このタブの操作欄(ページ送りと縮尺の欄)が画面の上端に来る位置へ動かす(ほかのタブと同じ作法)。読み込み中にほかのタブへ移っていたら動かさない
        requestAnimationFrame(() => {
          const bar = editor.querySelector('.redact-toolbar');
          if (!bar || !st.pdf || !panel.classList.contains('active')) return;
          try { bar.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (_) { /* 無視 */ }
        });
      } catch (e) {
        console.error('[p2d] load failed', e);
        st.rendering = false;
        const pw = e && (e.name === 'PasswordException' || /password/i.test(String(e.message)));
        setLoadMsg(pw ? 'パスワード付きのPDFは開けません。パスワードを解除してから読み込んでください。'
          : 'PDFの読み込みに失敗しました: ' + (e && e.message ? e.message : e), 'error');
      }
    }
    // DXF を読み込む。分解 → 部品 → 画面用の図面データ の順。縮尺は用紙(A3)に収まるものを自動で選ぶ
    async function loadDxf(file) {
      setLoadMsg('');
      try {
        setLoadMsg('読み込んでいます…(大きな DXF は少し時間がかかります)');
        st.renderGen++; st.rendering = true;
        await new Promise((r) => setTimeout(r, 0));   // 「読み込んでいます」を先に出す
        const bytes = new Uint8Array(await file.arrayBuffer());
        const out = dxfNS().flattenDxf(bytes, { keepColors: true, sourceName: file.name });
        st.pdf = { dxf: true };   // 「読み込み済み」の印(ページ送り・描き直しの判定で使う)
        st.occ = null; st.numPages = 1; st.pageIndex = 0; st.pages = {};
        dxfIn = { name: file.name, bytes, primsDoc: out.primsDoc, report: out.report, den: 1 };
        dropPicks(); clearNotes();
        st.mode = 'preset'; realLen.value = '';
        applyDxfScale(autoDen(out.primsDoc));
        setLoadMsg('');
        upload.style.display = 'none';
        editor.classList.add('active');
        await renderPage(0);
        requestAnimationFrame(() => {
          const bar = editor.querySelector('.redact-toolbar');
          if (!bar || !st.pdf || !panel.classList.contains('active')) return;
          try { bar.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (_) { /* 無視 */ }
        });
      } catch (e) {
        console.error('[p2d] dxf load failed', e);
        st.rendering = false; st.pdf = null; dxfIn = null;
        setLoadMsg('DXFの読み込みに失敗しました: ' + (e && e.message ? e.message : e), 'error');
      }
    }
    // 落とされたファイルの種類で振り分ける
    function loadFile(f) {
      if (!f) return;
      if (/[.]dxf$/i.test(f.name || '')) loadDxf(f); else loadPdf(f);
    }
    upload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; fileInput.value = ''; loadFile(f); });
    upload.addEventListener('dragover', (e) => { e.preventDefault(); upload.classList.add('dragover'); });
    upload.addEventListener('dragleave', () => upload.classList.remove('dragover'));
    upload.addEventListener('drop', (e) => {
      e.preventDefault(); upload.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      loadFile(f);
    });
    resetBtn.addEventListener('click', () => {
      st.renderGen++;
      st.pdf = null; st.occ = null; st.numPages = 0; st.pages = {}; dxfIn = null; dropPicks(); clearNotes(); st.rendering = false;
      st.hover = null; st.cursor = null; st.aim = null; hideLoupe();
      editor.classList.remove('active');
      upload.style.display = '';
      setLoadMsg('');
    });
  })();
