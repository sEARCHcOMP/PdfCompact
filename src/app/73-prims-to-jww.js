// prims-to-jww.js: 図面の部品(prims = 線・円弧・円・文字・塗り・点)を、線色1〜8・線種1〜8を直接持つ JWW のバイト列にする。対応表・掃除・縮尺の自動決定・レイヤ割り当て・読み直し検査を受け持つ
// 種本: 手元の DXF→JWW 変換ツール(Python)。白背景用の対応表では、同じ入力・同じ sin/cos の手順なら Python 版と1バイトも違わない出力になるように移した
//   (手を入れない Python は実行環境の math.sin / math.cos を使うので、斜めの文字の終点と「線に直した平たい円弧」の端点だけ、最後の1ビットが違うことがある。下の「三角関数」の説明を参照)
// 注意: このファイルには逆スラッシュの表記を書かない。Node 専用の機能(fs・Buffer・require)も使わない。先に jww-writer.js を読み込んでおくこと
(function (root) {
  'use strict';
  const NS = root.P2D || (root.P2D = {});
  const writer = () => {
    if (!NS.jwwWriter) throw new Error('jww-writer.js が先に読み込まれていません');
    return NS.jwwWriter;
  };

  class ConvertError extends Error {
    constructor(message) { super(message); this.name = 'ConvertError'; }
  }

  // =====================================================================
  // 【対応表】変換の決まりごとは全部ここ。変えたい時はここだけ直す
  // =====================================================================
  // --- 線色: DXFの色番号(aci。色相で寄せた後の番号 1赤 2黄 3緑 4水 5青 6紫 7黒 8灰 9薄灰 30橙)→ Jw_cad の線色番号 ---
  const COLOR_MODES = {
    // 白背景用(既定・Python 版と同じ): 赤→8 青→6 紫→7 橙→4 黒→2 灰→5。見えにくい色(黄・緑・水色)は 実線→2、破線・鎖線・点線→5、塗り・点→2
    white: { table: new Map([[1, 8], [5, 6], [6, 7], [30, 4], [7, 2], [8, 5], [9, 5]]), weak: [2, 3, 4], weakSolidLine: 2, weakOtherLine: 5, weakFillPoint: 2 },
    // 元の色に近い線色: 赤→8 黄→4 緑→3 水色→1 青→6 紫→7 橙→4 黒(白)→2 灰→5
    original: { table: new Map([[1, 8], [2, 4], [3, 3], [4, 1], [5, 6], [6, 7], [30, 4], [7, 2], [8, 5], [9, 5]]), weak: [], weakSolidLine: 2, weakOtherLine: 5, weakFillPoint: 2 }
  };
  const TEXT_PEN = 2;            // 文字は元の色に関係なく線色2(null にすると文字も上の表に従う)
  const UNKNOWN_ACI_PEN = 2;     // 表に無い色番号 → 線色2。件数は報告に出す
  // --- 線種: 1実線 / 2点線 / 3破線 / 5一点鎖線 / 7二点鎖線 ---
  const LT_TO_PEN_STYLE = new Map([['CONTINUOUS', 1], ['DOT', 2], ['DASHED', 3], ['CENTER', 5], ['PHANTOM', 7]]);
  const UNKNOWN_LT_STYLE = 1;
  // --- 用紙と縮尺 ---
  const PAPER_SIZES = new Map([[0, [1189, 841]], [1, [841, 594]], [2, [594, 420]], [3, [420, 297]], [4, [297, 210]],
    [8, [1682, 1189]], [9, [2378, 1682]], [10, [3364, 2378]], [11, [4756, 3364]], [12, [10000, 10000]], [13, [50000, 50000]], [14, [100000, 100000]]]);
  const DEFAULT_PAPER_CODE = 3;   // A3(Jw_cad の用紙は横置きだけ)
  const SCALE_DENOMS = [1, 2, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];
  const SCALE_MIN = 0.001, SCALE_MAX = 1000000;   // 自分で指定する縮尺分母(scale・headerScale)として受け付ける範囲。0・負・無限大・桁外れの値をヘッダに書かないための歯止め(Python 版には無い)
  const MARGIN_MM = 10.0;              // 図面範囲と用紙の端との余白(図寸mm)
  const SHEET_MARGIN_MM = 3.0;         // 図枠つきの図面は、余白をここまで詰めてよい
  const SHEET_FRAME_RATIO = 0.8;       // 図枠とみなす線の長さ(図面範囲の幅・高さに対する割合)
  const SHEET_FRAME_EDGE_RATIO = 0.15; // 図枠とみなす線の位置(図面範囲の端からこの割合以内)
  // --- 掃除 ---
  const FLAT_ARC_SAGITTA_MM = 0.001;   // ふくらみが図寸でこれ未満の円弧は線にする
  const MAX_LAYERS = 256;
  // --- 文字 ---
  const TEXT_FONT = 'ＭＳ ゴシック';
  const TEXT_WIDTH_RATIO = 1.0;
  const TEXT_WIDTH_RATIO_HANKAKU_ONLY = 1.0;
  const TEXT_KANKAKU = 0.0;
  const TEXT_MOJI_SHU = 0;
  const TEXT_KITEN = 1;
  const UNENCODABLE_CHAR = '〓';
  // --- 要素の共通属性 ---
  const ENTITY_FLAGS = 0x0002;
  const ENTITY_GROUP = 0;
  const ENTITY_PEN_WIDTH = 0;          // 0 = 線色ごとの線幅設定に従う
  const CLASS_SCHEMA = 700;
  // 自作標本の画面色。内蔵ひな形が想定どおりかの確認に使える(options.expectPalette に渡す)
  const REFERENCE_PALETTE = [[255, 255, 255], [0, 192, 192], [0, 0, 0], [0, 192, 0], [128, 64, 0], [160, 160, 160], [0, 0, 255], [192, 0, 192], [255, 0, 0], [220, 220, 220]];

  const KIND_OF_PRIM = { L: 'line', A: 'arc', C: 'arc', T: 'text', S: 'solid', P: 'point' };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;   // Python の math.radians / math.degrees と同じ掛け算

  // =====================================================================
  // 数の扱いを Python に合わせる小道具
  // =====================================================================
  function num(v, what) {
    if (typeof v !== 'number') throw new ConvertError('数値でない値があります(' + what + ')');
    return v;
  }
  // Python の % (割る数と同じ符号になる余り。0 は必ず +0)
  function pyMod(a, b) {
    let m = a % b;
    if (m !== 0) { if ((b < 0) !== (m < 0)) m += b; } else m = 0;
    return m;
  }
  // Python の round(偶数丸め)。結果の -0 は +0 にする(Python は整数にしてから実数へ戻すので -0 にならない)
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    const r = d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1);
    return r + 0;
  }
  // Python の min / max(先に出た方を残す。-0 と +0・NaN の扱いを合わせるため)
  const min2 = (a, b) => (b < a ? b : a);
  const max2 = (a, b) => (b > a ? b : a);
  const minOf = (list) => list.reduce(min2);
  const maxOf = (list) => list.reduce(max2);
  // Python の str.isspace() が真になる文字
  function isPySpace(c) {
    return (c >= 0x09 && c <= 0x0D) || (c >= 0x1C && c <= 0x20) || c === 0x85 || c === 0xA0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000;
  }
  function isBlank(s) {
    for (const ch of s) if (!isPySpace(ch.codePointAt(0))) return false;
    return true;
  }

  // =====================================================================
  // 三角関数。Math.sin / Math.cos は使わない。
  //   理由: sin・cos の最後の1ビットは、ブラウザや Python の実行環境(数学ライブラリ)ごとに違うことがある。
  //   同じ入力からはどこで動かしても同じバイト列を出すために、四則演算だけで書いた同じ手順を使う(fdlibm の考え方。誤差は1ulp未満)。
  //   check/ref_bytes.py に同じ手順の Python 版があり、1ビットも違わないことを確かめている
  // =====================================================================
  const TWO_PI = 2 * Math.PI, PIO4 = Math.PI / 4, TINY = 1 / 134217728;
  const INVPIO2 = 6.36619772367581382433e-01;
  const PIO2_1 = 1.57079632673412561417e+00, PIO2_2 = 6.07710050630396597660e-11;
  const PIO2_3 = 2.02226624871116645580e-21, PIO2_3T = 8.47842766036889956997e-32;
  const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04;
  const S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05;
  const C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  function kernelSin(x, y, exact) {
    if (Math.abs(x) < TINY) return x;
    const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if (exact) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }
  function kernelCos(x, y) {
    const ax = Math.abs(x);
    if (ax < TINY) return 1;
    const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if (ax < 0.3) return 1 - (0.5 * z - (z * r - x * y));
    const qx = ax > 0.78125 ? 0.28125 : Math.floor(ax * 262144) / 1048576;
    const hz = 0.5 * z - qx, a = 1 - qx;
    return a - (hz - (z * r - x * y));
  }
  // |x| を π/2 の整数倍 + 余り(y0 + y1)に分ける。戻り値は [何個目の象限(0〜3), y0, y1]
  function reduceAngle(ax) {
    if (ax <= PIO4) return [0, ax, 0, true];
    if (ax > 1e6) ax = ax % TWO_PI;   // とても大きい角度(実用では出ない)は先に1周ぶんの余りにする
    const fn = Math.floor(ax * INVPIO2 + 0.5);
    // π/2 を3つに分けた値を順に引く。引き算で出た丸めの誤差(e2・e3)も捨てずに持ち回る
    const r1 = ax - fn * PIO2_1;
    const w2 = fn * PIO2_2, r2 = r1 - w2, e2 = (r1 - r2) - w2;
    const w3 = fn * PIO2_3, r3 = r2 - w3, e3 = (r2 - r3) - w3;
    const w = (fn * PIO2_3T - e3) - e2;
    const y0 = r3 - w;
    return [fn % 4, y0, (r3 - y0) - w, false];
  }
  function sinCosAbs(ax, wantSin) {
    const q = reduceAngle(ax), n = wantSin ? q[0] : (q[0] + 1) % 4;
    // sin(x) の象限 n: 0→sin 1→cos 2→-sin 3→-cos。cos(x) = sin(x + π/2) なので象限を1つ進める
    if (n === 0) return kernelSin(q[1], q[2], q[3]);
    if (n === 1) return kernelCos(q[1], q[2]);
    if (n === 2) return -kernelSin(q[1], q[2], q[3]);
    return -kernelCos(q[1], q[2]);
  }
  function detSin(x) {
    if (!isFinite(x)) return NaN;
    const s = sinCosAbs(Math.abs(x), true);
    return (x < 0 || (x === 0 && 1 / x < 0)) ? -s : s;
  }
  function detCos(x) {
    if (!isFinite(x)) return NaN;
    return sinCosAbs(Math.abs(x), false);
  }
  // 差し替え口(検査で Math.sin / Math.cos と比べる時だけ使う。製品では触らない)
  const trig = { sin: detSin, cos: detCos };

  // =====================================================================
  // 対応表の引き方
  // =====================================================================
  function penOf(p, mode) {
    if (p.t === 'T' && TEXT_PEN !== null) return TEXT_PEN;
    const aci = p.aci;
    if (mode.weak.indexOf(aci) >= 0) {
      if (p.t === 'T' || p.t === 'S' || p.t === 'P') return mode.weakFillPoint;
      if ((has(p, 'lt') ? p.lt : 'CONTINUOUS') === 'CONTINUOUS') return mode.weakSolidLine;
      return mode.weakOtherLine;
    }
    const pen = mode.table.get(aci);
    return pen === undefined ? UNKNOWN_ACI_PEN : pen;
  }
  function penStyleOf(p) {
    // 点は Jw_cad が保存時に必ず1にする。文字のこの欄は線種でなく基点。塗りは 101 以上が円ソリッドの指定になるので必ず1
    if (p.t === 'P') return 1;
    if (p.t === 'T') return TEXT_KITEN;
    if (p.t === 'S') return 1;
    const style = LT_TO_PEN_STYLE.get(has(p, 'lt') ? p.lt : 'CONTINUOUS');
    return style === undefined ? UNKNOWN_LT_STYLE : style;
  }

  // =====================================================================
  // 図面範囲(円弧は実際に描かれる部分だけ)
  // =====================================================================
  function arcSpanDeg(p) {
    // 円弧の開き(度)。a1 から a2 へ反時計回り。0 になるのは「始角=終角」で、DXF の決まりでは全円
    const span = pyMod(num(p.a2, 'a2') - num(p.a1, 'a1'), 360.0);
    return span > 0.0 ? span : 360.0;
  }
  function arcBox(cx, cy, r, a1Deg, spanDeg) {
    const angles = [a1Deg, a1Deg + spanDeg];
    for (const q of [0.0, 90.0, 180.0, 270.0]) if (pyMod(q - a1Deg, 360.0) <= spanDeg) angles.push(q);
    const xs = angles.map((a) => cx + r * trig.cos(a * RAD)), ys = angles.map((a) => cy + r * trig.sin(a * RAD));
    return [minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)];
  }
  function primBox(p) {
    const t = p.t;
    if (t === 'L') {
      const ax = num(p.a.x, 'L.a.x'), ay = num(p.a.y, 'L.a.y'), bx = num(p.b.x, 'L.b.x'), by = num(p.b.y, 'L.b.y');
      return [min2(ax, bx), min2(ay, by), max2(ax, bx), max2(ay, by)];
    }
    if (t === 'C') { const cx = num(p.cx, 'cx'), cy = num(p.cy, 'cy'), r = num(p.r, 'r'); return [cx - r, cy - r, cx + r, cy + r]; }
    if (t === 'A') return arcBox(num(p.cx, 'cx'), num(p.cy, 'cy'), num(p.r, 'r'), num(p.a1, 'a1'), arcSpanDeg(p));
    if (t === 'S') {
      const xs = p.q.map((v) => num(v.x, 'S.q.x')), ys = p.q.map((v) => num(v.y, 'S.q.y'));
      return [minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)];
    }
    return [num(p.x, 'x'), num(p.y, 'y'), p.x, p.y];
  }
  function unionBox(boxes) {
    let out = null;
    for (const b of boxes) out = out === null ? b.slice() : [min2(out[0], b[0]), min2(out[1], b[1]), max2(out[2], b[2]), max2(out[3], b[3])];
    return out;
  }
  function drawingBbox(prims) {
    // 図形(線・円弧・円・塗り)の範囲。図形が1つも無い時だけ文字・点の位置も使う
    const shapes = prims.filter((p) => p.t === 'L' || p.t === 'A' || p.t === 'C' || p.t === 'S');
    const box = unionBox((shapes.length ? shapes : prims).map(primBox));
    if (box === null) throw new ConvertError('変換できる要素が1つもありません');
    return box;
  }

  // =====================================================================
  // 縮尺の自動決定
  // =====================================================================
  function hasSheetFrame(prims, bbox) {
    // 図枠(図面範囲のほぼ全幅・全高にわたる4辺の線)があるか
    const x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3], w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return false;
    const tol = 1e-6 * max2(w, h);
    let left = false, right = false, bottom = false, top = false;
    for (const p of prims) {
      if (p.t !== 'L') continue;
      const ax = p.a.x, ay = p.a.y, bx = p.b.x, by = p.b.y;
      if (Math.abs(ax - bx) <= tol && Math.abs(ay - by) >= SHEET_FRAME_RATIO * h) {
        if (ax - x0 <= SHEET_FRAME_EDGE_RATIO * w) left = true;
        if (x1 - ax <= SHEET_FRAME_EDGE_RATIO * w) right = true;
      }
      if (Math.abs(ay - by) <= tol && Math.abs(ax - bx) >= SHEET_FRAME_RATIO * w) {
        if (ay - y0 <= SHEET_FRAME_EDGE_RATIO * h) bottom = true;
        if (y1 - ay <= SHEET_FRAME_EDGE_RATIO * h) top = true;
      }
    }
    return left && right && bottom && top;
  }
  function paperSize(code) {
    const s = PAPER_SIZES.get(code);
    if (!s) throw new ConvertError('用紙の番号が不正です: ' + code);
    return s;
  }
  function chooseScale(width, height, framed, paperCode) {
    // 用紙に余白つきで収まる最小の縮尺分母を返す
    const paper = paperSize(paperCode === undefined ? DEFAULT_PAPER_CODE : paperCode);
    const margin = framed ? SHEET_MARGIN_MM : MARGIN_MM;
    for (const n of SCALE_DENOMS) if (width / n <= paper[0] - 2 * margin && height / n <= paper[1] - 2 * margin) return n;
    throw new ConvertError('図面が大きすぎて縮尺を決められません(幅' + Math.round(width) + ' 高さ' + Math.round(height) + ')');
  }
  // PDF 由来の時に使う: ページの大きさ(mm)がそのまま入る Jw_cad の用紙(A4〜A0 のうち最小。入らなければ一回り大きい用紙)。Python 版には無い
  //   Jw_cad の用紙は横置きしか無く、図面はページの向きのまま置くので、幅と高さを入れ替えずに見る。
  //   縦向きのページ(A4縦 210×297)は A4(297×210)に入らないので A3(420×297)を選ぶ。
  //   入れ替えて見ていた時は、A4縦に A4 を選んでしまい、図形が用紙の上下からはみ出して読み直し検査で必ず止まっていた
  function choosePaperCode(widthMm, heightMm) {
    if (!(isFinite(widthMm) && isFinite(heightMm) && widthMm > 0 && heightMm > 0)) throw new ConvertError('ページの大きさが不正です');
    const EPS = 0.5;
    for (const code of [4, 3, 2, 1, 0, 8, 9, 10, 11, 12, 13, 14]) { const s = PAPER_SIZES.get(code); if (widthMm <= s[0] + EPS && heightMm <= s[1] + EPS) return code; }
    throw new ConvertError('ページが大きすぎて用紙を決められません');
  }

  // =====================================================================
  // レイヤ割り当て・文字の掃除
  // =====================================================================
  // Python の str() と同じ文字列にする(文字列以外が来た時のため。null は None、真偽値は True / False)
  function pyStr(v) {
    if (typeof v === 'string') return v;
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    return String(v);
  }
  function layerNameOf(p) { return has(p, 'layer') ? pyStr(p.layer) : '0'; }
  function assignLayers(prims) {
    // レイヤ名 → [レイヤグループ, レイヤ]。出てきた順に グループ0 の 0〜F、あふれたらグループ1へ…と詰める
    const table = new Map();
    for (const p of prims) {
      const name = layerNameOf(p);
      if (table.has(name)) continue;
      const i = table.size;
      if (i >= MAX_LAYERS) throw new ConvertError('レイヤが' + MAX_LAYERS + '個を超えています');
      table.set(name, [Math.floor(i / 16), i % 16]);
    }
    return table;
  }
  function cleanText(s) {
    // Shift_JIS で書けない文字を置き換える。[置き換え後の文字列, 置き換えた数] を返す
    const W = writer();
    let out = '', bad = 0;
    for (const ch of pyStr(s)) { if (W.canEncodeCp932(ch)) out += ch; else { out += UNENCODABLE_CHAR; bad++; } }
    return [out, bad];
  }
  function cleanAngleDeg(rot) {
    // 角度を (-180, 180] に収め、89.9999999 のような計算誤差は整数度に丸める
    let a = pyMod(num(rot, 'rot'), 360.0);
    if (a !== a) throw new ConvertError('文字の角度が数値として不正です');
    if (a > 180.0) a -= 360.0;
    if (Math.abs(a - pyRound(a)) < 1e-6) a = pyRound(a);
    return a;
  }
  // 全角=2 / 半角=1。cp932 で書ける文字の範囲でだけ正しい(cleanText を通した後の文字列に使う)。
  //   Python の unicodedata.east_asian_width が W・F・A 以外を返す cp932 の文字は、ここに挙げた分で全部(run-checks.js が全数で確かめる)
  function charUnits(code) {
    if (code <= 0x80 || (code >= 0xFF61 && code <= 0xFF9F)) return 1;
    if (code === 0xA2 || code === 0xA3 || code === 0xAC || code === 0x2212) return 1;
    return 2;
  }
  function textSpan(text, sizeX, kankaku) {
    // 1文字の送りは 全角 (幅+間隔)・半角はその半分。末尾の1文字ぶんの間隔は付かない(jww_patch.text_span と同じ式・同じ計算順)
    if (!text) return 0.0;
    let total = 0.0, units = 1;
    for (const ch of text) { units = charUnits(ch.codePointAt(0)); total += (sizeX + kankaku) * units / 2.0; }
    return total - kankaku * units / 2.0;
  }

  // =====================================================================
  // 掃除(捨てた・置き換えた件数は必ず数える)
  // =====================================================================
  function tidyPrims(prims, scale) {
    const n = scale;
    const counts = { flat_arcs_to_lines: 0, dropped_zero_length_lines: 0, dropped_zero_radius_arcs: 0, dropped_empty_texts: 0, dropped_bad_size_texts: 0 };
    const out = [];
    for (const p of prims) {
      const t = p.t;
      if (t === 'L') {
        if (Math.hypot(num(p.b.x, 'L.b.x') - num(p.a.x, 'L.a.x'), num(p.b.y, 'L.b.y') - num(p.a.y, 'L.a.y')) <= 1e-9) { counts.dropped_zero_length_lines++; continue; }
      } else if (t === 'A' || t === 'C') {
        if (!(num(p.r, 'r') > 0)) { counts.dropped_zero_radius_arcs++; continue; }
        if (t === 'A' && FLAT_ARC_SAGITTA_MM > 0) {
          const span = arcSpanDeg(p) * RAD;
          if (span < Math.PI && (p.r / n) * (1.0 - trig.cos(span / 2.0)) < FLAT_ARC_SAGITTA_MM) {
            const a1 = p.a1 * RAD, a2 = a1 + span;
            const q = {};
            for (const k of Object.keys(p)) if (k !== 'cx' && k !== 'cy' && k !== 'r' && k !== 'a1' && k !== 'a2') q[k] = p[k];
            q.t = 'L';
            q.a = { x: num(p.cx, 'cx') + p.r * trig.cos(a1), y: num(p.cy, 'cy') + p.r * trig.sin(a1) };
            q.b = { x: p.cx + p.r * trig.cos(a2), y: p.cy + p.r * trig.sin(a2) };
            q.fromFlatArc = true;
            counts.flat_arcs_to_lines++;
            out.push(q);
            continue;
          }
        }
      } else if (t === 'T') {
        if (isBlank(cleanText(has(p, 's') ? p.s : '')[0])) { counts.dropped_empty_texts++; continue; }
        const h = p.h;
        if (typeof h !== 'number' || !isFinite(h) || !(h > 0)) { counts.dropped_bad_size_texts++; continue; }
      }
      out.push(p);
    }
    return [out, counts];
  }

  // =====================================================================
  // prims → JWW の図形(jww_dump.py の read_* が返す dict と同じ形)
  // =====================================================================
  // 部品1つ → 図形1つ。stats には件数を足し込む(読み直し検査でも、書くつもりだった値を作り直すのに使う)
  function buildEntity(p, layers, scale, origin, mode, stats) {
    const ox = origin[0], oy = origin[1], n = scale;
    const tx = (x) => (x - ox) / n, ty = (y) => (y - oy) / n;
    const fullCircle = (p, e) => { e.cx = tx(num(p.cx, 'cx')); e.cy = ty(num(p.cy, 'cy')); e.radius = num(p.r, 'r') / n; e.start_rad = 0.0; e.arc_rad = 2.0 * Math.PI; e.tilt_rad = 0.0; e.flatness = 1.0; e.full_circle = 1; };
    const t = p.t;
    if (!has(KIND_OF_PRIM, t)) throw new ConvertError('未対応の部品種別: ' + t);
    const aci = p.aci;
    if (mode.weak.indexOf(aci) < 0 && !mode.table.has(aci)) stats.unknown_aci++;
    if ((t === 'L' || t === 'A' || t === 'C') && !LT_TO_PEN_STYLE.has(has(p, 'lt') ? p.lt : 'CONTINUOUS')) stats.unknown_lt++;
    const gl = layers.get(layerNameOf(p));
    const e = { group: ENTITY_GROUP, pen_style: penStyleOf(p), pen_color: penOf(p, mode), pen_width: ENTITY_PEN_WIDTH, layer: gl[1], glayer: gl[0], flags: ENTITY_FLAGS, kind: KIND_OF_PRIM[t] };
    if (t === 'L') {
      e.x1 = tx(num(p.a.x, 'L.a.x')); e.y1 = ty(num(p.a.y, 'L.a.y')); e.x2 = tx(num(p.b.x, 'L.b.x')); e.y2 = ty(num(p.b.y, 'L.b.y'));
    } else if (t === 'C') {
      fullCircle(p, e);   // 全円: 開始角0・円弧角2π・傾き0・偏平率1・全円フラグ1
    } else if (t === 'A') {
      // 円弧: 開始角から反時計回りに円弧角ぶん(どちらもラジアン・円弧角は必ず正)
      const span = arcSpanDeg(p);
      if (span >= 360.0) { stats.full_circle_from_arc++; fullCircle(p, e); }
      else {
        e.cx = tx(num(p.cx, 'cx')); e.cy = ty(num(p.cy, 'cy')); e.radius = num(p.r, 'r') / n;
        e.start_rad = pyMod(p.a1, 360.0) * RAD; e.arc_rad = span * RAD; e.tilt_rad = 0.0; e.flatness = 1.0; e.full_circle = 0;
      }
    } else if (t === 'P') {
      e.x = tx(num(p.x, 'P.x')); e.y = ty(num(p.y, 'P.y')); e.kariten = 0;
    } else if (t === 'S') {
      // DXF の SOLID は頂点が 1,2,4,3 の順。Jw_cad のソリッドは外周の順 ①②③④ で、ファイルには ①④②③ の順に入る
      const q = p.q, outline = [q[0], q[1], q[3], q[2]];
      e.x1 = tx(num(outline[0].x, 'S.x')); e.y1 = ty(num(outline[0].y, 'S.y'));
      e.x2 = tx(num(outline[3].x, 'S.x')); e.y2 = ty(num(outline[3].y, 'S.y'));
      e.x3 = tx(num(outline[1].x, 'S.x')); e.y3 = ty(num(outline[1].y, 'S.y'));
      e.x4 = tx(num(outline[2].x, 'S.x')); e.y4 = ty(num(outline[2].y, 'S.y'));
    } else {
      const cleaned = cleanText(has(p, 's') ? p.s : '');
      const text = cleaned[0];
      stats.unencodable_chars += cleaned[1];
      let wf = p.wf;
      if (typeof wf !== 'number' || !(wf > 0)) wf = 1.0;
      const sizeY = num(p.h, 'T.h') / n;
      let sizeX = p.h * wf * TEXT_WIDTH_RATIO / n;
      let ascii = text.length > 0;
      for (let i = 0; i < text.length && ascii; i++) if (text.charCodeAt(i) >= 0x80) ascii = false;
      if (ascii) sizeX *= TEXT_WIDTH_RATIO_HANKAKU_ONLY;
      const deg = cleanAngleDeg(has(p, 'rot') ? p.rot : 0.0);
      const span = textSpan(text, sizeX, TEXT_KANKAKU);
      const x1 = tx(num(p.x, 'T.x')), y1 = ty(num(p.y, 'T.y'));
      e.x1 = x1; e.y1 = y1;
      e.x2 = x1 + span * trig.cos(deg * RAD); e.y2 = y1 + span * trig.sin(deg * RAD);
      e.moji_shu = TEXT_MOJI_SHU; e.size_x = sizeX; e.size_y = sizeY; e.kankaku = TEXT_KANKAKU; e.kakudo_deg = deg;
      e.font = TEXT_FONT; e.text = text;
    }
    for (const k of Object.keys(e)) if (typeof e[k] === 'number' && !isFinite(e[k])) throw new ConvertError('数値が有限でない(' + t + ' の ' + k + ')');
    return e;
  }
  function buildEntities(prims, layers, scale, origin, mode) {
    const stats = { unknown_aci: 0, unknown_lt: 0, unencodable_chars: 0, full_circle_from_arc: 0 };
    const entities = [];
    for (const p of prims) entities.push(buildEntity(p, layers, scale, origin, mode, stats));
    return [entities, stats];
  }

  // =====================================================================
  // 組み立て(prims2jww.py の build_doc + jww_write.py の build_jww)
  //   templateBytes: 内蔵ひな形、または jwwWriter.extractTemplateHeader の戻り値(登録したひな形 = メモ・レイヤ名を空にしたヘッダ)を渡すこと。
  //     利用者の JWW ファイル全体をそのまま渡すと、Python 版と同じく、その図面のメモ・レイヤ名・レイヤグループ名が書き出しに入る
  //   options:
  //     colorMode       'white'(既定・白背景用) | 'original'(元の色に近い線色)
  //     scale           縮尺分母を自分で決める時(座標をこの数で割って図寸にする)。省略すると自動。0.001〜1000000 の有限の数だけ(0・負・無限大・NaN は ConvertError)
  //     origin          用紙中央に置く実寸の点 [x, y]。省略すると図面範囲の中心
  //     headerScale     ヘッダに書く縮尺分母だけを変える時(PDF 由来 = 座標は図寸のまま scale:1、ヘッダには合わせた分母)。Python 版には無い。受け付ける範囲は scale と同じ
  //     paperCode       用紙(0=A0 1=A1 2=A2 3=A3 4=A4 …)。既定 3
  //     stringUnicode   文字列を Unicode 形式で書く(既定 false = Python の build_doc と同じ ANSI 形式)
  //     expectPalette   ひな形の画面色がこの表([赤,緑,青]×10)と違えば止める(Python 版は標本の色で必ず確かめている)
  // =====================================================================
  // 縮尺分母は「有限で、正で、桁外れでない」数だけを受け付ける。0・負・無限大をそのままヘッダに書くと、開けない(または縮尺が無限大の)JWW になる
  function checkScale(v, what) {
    if (!(isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX)) throw new ConvertError(what + 'の値が不正です(' + v + ')。' + SCALE_MIN + ' から ' + SCALE_MAX + ' までの数にしてください');
  }
  // 部品の形(入れ物の形)だけを先に確かめる。数値かどうかは、使う所で num() が確かめる
  function checkPrimShape(p, i) {
    const isObj = (v) => v !== null && typeof v === 'object';
    let ok = isObj(p);
    if (ok && p.t === 'L') ok = isObj(p.a) && isObj(p.b);
    if (ok && p.t === 'S') ok = Array.isArray(p.q) && p.q.length >= 4 && p.q.every(isObj);
    if (!ok) throw new ConvertError('部品のデータの形が不正です(' + (i + 1) + ' 個目)');
  }
  function buildBytes(primsDoc, templateBytes, options) {
    const W = writer(), opt = options || {};
    if (!W.cp932SelfCheck()) throw new ConvertError('このブラウザの Shift_JIS の表が想定と違うため、JWW を正しく書けません');
    const colorMode = opt.colorMode === undefined ? 'white' : opt.colorMode;
    if (typeof colorMode !== 'string' || !has(COLOR_MODES, colorMode)) throw new ConvertError('色の割り当ての指定が不正です: ' + colorMode);
    const mode = COLOR_MODES[colorMode];
    const paperCode = opt.paperCode === undefined ? DEFAULT_PAPER_CODE : opt.paperCode;
    paperSize(paperCode);
    if (!primsDoc || !Array.isArray(primsDoc.prims)) throw new ConvertError('部品のデータ(prims)がありません');
    let prims = primsDoc.prims;
    for (let i = 0; i < prims.length; i++) checkPrimShape(prims[i], i);
    let bbox = drawingBbox(prims);
    const framed = hasSheetFrame(prims, bbox);
    const scale = opt.scale === undefined || opt.scale === null ? chooseScale(bbox[2] - bbox[0], bbox[3] - bbox[1], framed, paperCode) : num(opt.scale, 'scale');
    const headerScale = opt.headerScale === undefined || opt.headerScale === null ? scale : num(opt.headerScale, 'headerScale');
    checkScale(scale, '縮尺');
    checkScale(headerScale, 'ヘッダに書く縮尺');
    // 掃除は縮尺が決まってから(ふくらみは図寸で判定するため)。範囲は掃除後の図形で取り直す
    const tidied = tidyPrims(prims, scale);
    prims = tidied[0];
    if (!prims.length) throw new ConvertError('書き出せる図形がありません');
    bbox = drawingBbox(prims);
    const origin = opt.origin === undefined || opt.origin === null ? [(bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0] : [num(opt.origin[0], 'origin'), num(opt.origin[1], 'origin')];
    const layers = assignLayers(prims);
    const built = buildEntities(prims, layers, scale, origin, mode);
    const entities = built[0], stats = built[1];

    const template = W.loadTemplate(templateBytes);
    if (opt.expectPalette && JSON.stringify(W.paletteOf(template)) !== JSON.stringify(opt.expectPalette)) throw new ConvertError('ひな形の画面色が想定と違います');
    const patch = new Map();
    patch.set('paper_size', [paperCode]);
    for (let g = 0; g < 16; g++) patch.set('scale_' + g, [headerScale]);
    for (const item of layers) {
      const key = 'lay_names_' + item[1][0];
      if (!patch.has(key)) patch.set(key, template.index.get(key).vals.slice());
      patch.get(key)[item[1][1]] = cleanText(item[0])[0];
    }
    patch.set('bairitsu', [1.0]);        // 開いた時に用紙全体が見える
    patch.set('genten', [0.0, 0.0]);
    const bytes = W.buildJww(template, patch, entities, { stringUnicode: !!opt.stringUnicode, classSchema: CLASS_SCHEMA });
    Object.assign(stats, tidied[1]);
    // 画面に出す用のレイヤ表(名前 → グループ-レイヤ。label は JWW に書いたレイヤ名)
    const layerTable = Array.from(layers).map((item) => ({ name: item[0], group: item[1][0], layer: item[1][1], label: cleanText(item[0])[0] }));
    const info = { scale, headerScale, origin, bbox, framed, paperCode, colorMode, layers, layerTable, stats, prims, entityCount: entities.length, stringUnicode: !!opt.stringUnicode };
    return { bytes, info };
  }

  // =====================================================================
  // 読み直し検査(prims2jww.py の verify)。1つでも外れたら ConvertError
  //   Python 版に足した検査(Python 版は NaN を見逃す。min / max が NaN を素通しし、文字と点は範囲の検査に入らないため):
  //     読み直した数値が全部有限か / 円弧の傾きが 0 か / 文字の大きさが正か / 画面の倍率・原点がヘッダに入っているか /
  //     図形を1つずつ「書くつもりだった値(部品から作り直したもの)」と全部の欄で突き合わせる(レイヤの取り違え・用紙の外へ飛んだ文字や点もここで見つかる)
  // =====================================================================
  function entityBox(e) {
    if (e.kind === 'line') return [min2(e.x1, e.x2), min2(e.y1, e.y2), max2(e.x1, e.x2), max2(e.y1, e.y2)];
    if (e.kind === 'arc') {
      if (e.full_circle) return [e.cx - e.radius, e.cy - e.radius, e.cx + e.radius, e.cy + e.radius];
      return arcBox(e.cx, e.cy, e.radius, (e.start_rad + e.tilt_rad) * DEG, e.arc_rad * DEG);
    }
    if (e.kind === 'solid') {
      const xs = [e.x1, e.x2, e.x3, e.x4], ys = [e.y1, e.y2, e.y3, e.y4];
      return [minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)];
    }
    return null;
  }
  function verifyBytes(bytes, primsDoc, info) {
    const W = writer();
    let doc;
    try { doc = W.parseJww(bytes); } catch (ex) { throw new ConvertError('作ったデータを読み直せません: ' + ex.message); }
    const prims = info.prims, ents = doc.entities, problems = [];
    const hist = (list, keyOf) => { const m = {}; for (const x of list) { const k = keyOf(x); m[k] = (m[k] || 0) + 1; } return m; };

    if (doc.trailingBytes !== 0) problems.push('読み残し ' + doc.trailingBytes + ' バイト');
    if (doc.blockDefs.length !== 0 || doc.images.length !== 0) problems.push('ブロック定義・画像が空でない');
    const want = hist(prims, (p) => KIND_OF_PRIM[p.t]), got = hist(ents, (e) => e.kind);
    const sameHist = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);
    if (!sameHist(want, got)) problems.push('種類ごとの件数が違う 期待' + JSON.stringify(want) + ' 実際' + JSON.stringify(got));
    const circlesWant = prims.filter((p) => p.t === 'C' || (p.t === 'A' && arcSpanDeg(p) >= 360.0)).length;
    const circlesGot = ents.filter((e) => e.kind === 'arc' && e.full_circle === 1).length;
    if (circlesWant !== circlesGot) problems.push('全円の数が違う 期待' + circlesWant + ' 実際' + circlesGot);
    if (ents.some((e) => e.pen_color < 1 || e.pen_color > 8)) problems.push('線色が1〜8の外');
    if (ents.some((e) => e.pen_style < 1 || e.pen_style > 8)) problems.push('線種が1〜8の外');
    if (ents.some((e) => e.glayer > 15 || e.layer > 15)) problems.push('レイヤ番号が範囲外');
    for (const e of ents) {
      let bad = null;
      for (const k of Object.keys(e)) if (typeof e[k] === 'number' && !isFinite(e[k])) { bad = k; break; }
      if (bad === null && e.kind === 'arc' && e.tilt_rad !== 0) bad = 'tilt_rad';
      if (bad === null && e.kind === 'text' && !(e.size_x > 0 && e.size_y > 0)) bad = 'size_x / size_y';
      if (bad !== null) { problems.push('図形の数値が不正 (' + e.id + ' の ' + bad + ')'); break; }
    }
    for (const e of ents) {
      if (e.kind === 'arc' && !(e.radius > 0 && 0 < e.arc_rad && e.arc_rad <= 2 * Math.PI + 1e-12 && 0 <= e.start_rad && e.start_rad < 2 * Math.PI && e.flatness === 1.0)) { problems.push('円弧の値が想定外 (' + e.id + ')'); break; }
    }
    // 文字列: 書いたバイト列を読み直した結果と比べる。ANSI 形式の cp932 には片道の読み替え(「−」→「－」など)があるので、期待値も一度バイト列にして戻した形で比べる
    const asWritten = (s) => (info.stringUnicode ? s : W.decodeCp932(W.encodeCp932(s)));
    const wantTexts = prims.filter((p) => p.t === 'T').map((p) => asWritten(cleanText(has(p, 's') ? p.s : '')[0]));
    const gotTexts = ents.filter((e) => e.kind === 'text').map((e) => e.text);
    if (wantTexts.length !== gotTexts.length || wantTexts.some((s, i) => s !== gotTexts[i])) problems.push('文字列が一致しない');
    // 1つずつの突き合わせ: 部品から作り直した図形と、読み直した図形が、全部の欄で同じか(数値は1ビットも違わないこと。文字列は書いたバイト列を読み直した形で比べる)
    const mode = typeof info.colorMode === 'string' && has(COLOR_MODES, info.colorMode) ? COLOR_MODES[info.colorMode] : null;
    if (mode === null) problems.push('色の割り当ての指定が分からない');
    else if (ents.length === prims.length) {
      const scratch = { unknown_aci: 0, unknown_lt: 0, unencodable_chars: 0, full_circle_from_arc: 0 };
      for (let i = 0; i < prims.length; i++) {
        const wantEnt = buildEntity(prims[i], info.layers, info.scale, info.origin, mode, scratch), gotEnt = ents[i];
        let bad = null;
        for (const k of Object.keys(wantEnt)) {
          const same = typeof wantEnt[k] === 'string' ? asWritten(wantEnt[k]) === gotEnt[k] : Object.is(wantEnt[k], gotEnt[k]);
          if (!same) { bad = k; break; }
        }
        if (bad !== null) { problems.push('書いた図形が元の部品と違う (' + gotEnt.id + ' の ' + bad + ')'); break; }
      }
    }

    // 図面範囲: 読み直した図寸 → 実寸に戻して、元の範囲と比べる
    const n = info.scale, ox = info.origin[0], oy = info.origin[1];
    const box = unionBox(ents.map(entityBox).filter((b) => b !== null));
    let bboxBack = null, bboxErr = null;
    if (box !== null) {
      bboxBack = [box[0] * n + ox, box[1] * n + oy, box[2] * n + ox, box[3] * n + oy];
      const ref = info.bbox;
      bboxErr = maxOf([0, 1, 2, 3].map((i) => Math.abs(bboxBack[i] - ref[i])));
      if (!(bboxErr <= 1e-6)) problems.push('図面範囲が元と ' + bboxErr + ' mm ずれている');
      const given = primsDoc.bbox;
      if (Array.isArray(given) && given.length === 4 && given.every((v) => typeof v === 'number' && isFinite(v))) {
        // ほぼ真っすぐな円弧を線にすると、範囲がふくらみの分だけ縮むことがある
        if (maxOf([0, 1, 2, 3].map((i) => Math.abs(given[i] - ref[i]))) > 1e-6 + FLAT_ARC_SAGITTA_MM * n) problems.push('中間データに書かれた範囲と、部品から計算した範囲が違う');
      }
    }
    const paper = paperSize(info.paperCode);
    if (box !== null && (box[0] < -paper[0] / 2 || box[2] > paper[0] / 2 || box[1] < -paper[1] / 2 || box[3] > paper[1] / 2)) problems.push('図形が用紙からはみ出している');

    const idx = doc.header.index;
    let scalesOk = idx.get('paper_size').vals[0] === info.paperCode;
    for (let g = 0; g < 16; g++) if (idx.get('scale_' + g).vals[0] !== info.headerScale) scalesOk = false;
    if (!scalesOk) problems.push('用紙または縮尺がヘッダに入っていない');
    const genten = idx.get('genten').vals;
    if (idx.get('bairitsu').vals[0] !== 1 || genten[0] !== 0 || genten[1] !== 0) problems.push('画面の倍率・原点がヘッダに入っていない');
    for (const item of info.layers) {
      const wantName = asWritten(cleanText(item[0])[0]);
      if (idx.get('lay_names_' + item[1][0]).vals[item[1][1]] !== wantName) { problems.push('レイヤ名が入っていない'); break; }
    }
    for (const v of doc.classSchemas.values()) if (v !== CLASS_SCHEMA) { problems.push('クラスのスキーマ番号が700でない'); break; }

    if (problems.length) throw new ConvertError('自己検査に失敗: ' + problems.join(' / '));
    return {
      counts: got, full_circles: circlesGot, pens: hist(ents, (e) => e.pen_color),
      line_styles: hist(ents.filter((e) => e.kind === 'line' || e.kind === 'arc'), (e) => e.pen_style),
      bbox_back: bboxBack, bbox_error_mm: bboxErr, texts: gotTexts.length,
      classes: Array.from(doc.classSchemas.keys()).sort(), trailing_bytes: doc.trailingBytes
    };
  }

  // 変換して、読み直し検査まで通ったものだけを返す(検査に落ちたら ConvertError。保存してはいけない)
  function convert(primsDoc, templateBytes, options) {
    const built = buildBytes(primsDoc, templateBytes, options);
    const checks = verifyBytes(built.bytes, primsDoc, built.info);
    return { bytes: built.bytes, info: built.info, checks };
  }

  const api = {
    ConvertError, convert, buildBytes, verifyBytes, choosePaperCode, chooseScale,
    COLOR_MODES, LT_TO_PEN_STYLE, PAPER_SIZES, SCALE_DENOMS, REFERENCE_PALETTE, TEXT_FONT, UNENCODABLE_CHAR,
    penOf, penStyleOf, buildEntity, cleanText, cleanAngleDeg, textSpan, charUnits, isPySpace, tidyPrims, assignLayers, hasSheetFrame, drawingBbox, arcSpanDeg,
    detSin, detCos, trig
  };
  NS.primsToJww = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
