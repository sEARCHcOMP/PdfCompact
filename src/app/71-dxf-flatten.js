// dxf-flatten.js: メーカー提供の DXF を分解して、図面の部品(prims = 線・円弧・円・文字・塗り・点)にする純粋な部品。入力は Uint8Array、出力は部品と報告(ファイルの読み書きはしない)
//   Jw_cad は SPLINE(自由曲線)・ELLIPSE(楕円)などを読めず、その部分が抜けて線が途切れて見える(実例: エアコンの外形)。
//   対処: 曲線は「円弧と確認できたものは ARC/CIRCLE」「それ以外は細かい LINE」に置き換える。ブロック・寸法・連続線は分解して線と文字にする。
//   元の形からのズレは最後に機械で測って報告に入れる。遠く離れた所にあるゴミ(図面が点にしか見えなくなる原因)は除いて、その数を報告に入れる。
// 種本: 手元の DXF 分解ツール(Node)。図形の計算は1文字も変えずに移してあり、同じ DXF からは同じ部品が出る(手元の答え合わせスクリプトが確かめる)
//   種本から変えたのは「読めない入力・壊れた入力の断り方」だけ: バイナリ形式や DXF でないファイルは理由を付けて断る / 改行は CRLF・LF・CR のどれでも(混ざっていても)読む /
//   自分自身を含むブロックは読み飛ばす / 並べ複写の数・分解の回数・図形の数に上限を置く(画面が固まったりメモリを使い切ったりしないように) / 図形が1つも取れない時は空のファイルを作らずに断る /
//   値の壊れた要素(節点が小さい順でない SPLINE など)は、その要素だけを読み飛ばして数える(全体を落とさない) /
//   大きな曲線で固まらないように、手間が「点の数の2乗」になっていた所を直した: ズレの測定・節点の挿入・節点の区間さがし は、結果を変えずに速い手順へ替えた。点の間引きには手間の歯止めを入れた(片寄った形の大きな曲線でだけ働く) /
//   半径や角度が桁外れで終わらない繰り返しになる円弧は、その要素だけを読み飛ばす / DXF の中の名前(要素の種類・レイヤ名・線種名)が「constructor」などでも、件数を正しく数える
// 注意: このファイルには逆スラッシュの表記を書かない(必要な時は文字コードで作る)。Node 専用の機能(fs・Buffer・require)も使わない
(function (root) {
'use strict';
const NS = root.P2D || (root.P2D = {});
const CR = String.fromCharCode(13), LF = String.fromCharCode(10), CRLF = CR + LF, BS = String.fromCharCode(92);
const EOL = new RegExp(CRLF + '|' + CR + '|' + LF);   // 行の区切り(CRLF・CR だけ・LF だけ。1つのファイルに混ざっていてもよい)
const TOL = 0.005;        // 曲線を置き換える時の許容ズレ(図面の単位。ふつうは mm)
const STRAIGHT = 0.002;   // これ以内なら直線とみなす
const ID = [1, 0, 0, 1, 0, 0];
// 暴走を止める上限(flattenDxf の options.limits で変えられる)。手元のメーカー DXF 8本は、最大でも 図形 約1万8千個・分解 約1万8千回
const LIMITS = {
  maxPrims: 1000000,    // 出来上がる図形(線・円弧・文字…)の数
  maxVisits: 3000000,   // 要素を1つ分解するごと・並べ複写の1マスごとに1回と数えた回数(図形を1つも出さずに回り続ける入れ子を止める)
  maxArray: 10000,      // 1つの INSERT の並べ複写(列 × 行)の数
  maxDeviationScans: 20000000   // 曲線のズレを測る時に「探す範囲を広げてやり直す」比較の回数(1回の分解の合計。約 0.3 秒ぶん)。使い切ったら、その先は狭い範囲だけで測り、報告に deviationCheckLimited を出す
};
const MAX_SPLINE_WORK = 5000000;   // 重みつき・3次以外の SPLINE の「次数の2乗 × 制御点の数」の上限。曲線上の1点を求める手間が次数の2乗で、点は制御点の 40 倍取るので、これで 1〜2 秒。主な CAD の次数は 10〜24 まで
const MAX_ARC_STEPS = 1000000;  // 楕円になる円弧を線に分ける時の本数の上限(半径や倍率が桁外れの時に、終わらない繰り返しになるのを止める)
function resolveLimits(given) {
  const g = given || {}, lim = {};
  for (const k of Object.keys(LIMITS)) lim[k] = typeof g[k] === 'number' && g[k] > 0 ? g[k] : LIMITS[k];
  return lim;
}
// 要素の値が壊れていて図形にできない時に投げる(walk が受け止めて、その要素だけを「値が不正」として数える)
function rejectEntity(why) { throw new RangeError(why); }

// 利用者にそのまま見せてよい、理由のはっきりした失敗(読めないファイル・上限超え)。これ以外の例外はプログラムの不具合
class DxfError extends Error {
  constructor(message) { super(message); this.name = 'DxfError'; }
}

// ===================== 読み込み =====================
function parseDxf(buf) {
  let head = '';
  for (let i = 0, lim = Math.min(buf.length, 4000); i < lim; i++) head += String.fromCharCode(buf[i]);
  if (head.indexOf('AutoCAD Binary DXF') === 0) throw new DxfError('バイナリ形式の DXF は読み込めません。CAD で「テキスト形式(ASCII)の DXF」を選んで保存し直してください');
  if (/^AC10[0-9]{2}/.test(head)) throw new DxfError('DWG 形式のファイルは読み込めません。CAD で DXF 形式を選んで保存し直してください');
  const m = /AC10[0-9]{2}/.exec(head);
  const ver = m ? m[0] : 'AC1009';
  const text = new TextDecoder(ver >= 'AC1021' ? 'utf-8' : 'shift_jis').decode(buf);   // 2007 形式以降は UTF-8、それより前は Shift-JIS
  const rows = text.split(EOL);
  const raw = [];
  let sec = null, cur = null, sawEntities = false;
  for (let k = 0; k + 1 < rows.length; k += 2) {
    const c = rows[k].trim(), v = rows[k + 1];
    if (c === '0' && v.trim() === 'SECTION') { sec = (rows[k + 3] || '').trim(); cur = null; if (sec === 'ENTITIES') sawEntities = true; continue; }
    if (c === '0') { cur = { type: v.trim(), sec, g: [] }; raw.push(cur); } else if (cur) cur.g.push([c, c === '1' || c === '3' ? v : v.trim()]);
  }
  // 図形の入る部分(ENTITIES)が無い = DXF として読めていない(DXF でないファイル・文字コードの違うファイル・途中で切れたファイル)。黙って空の図面を返さない
  if (!sawEntities) throw new DxfError('DXF として読み込めませんでした(図形の入っている部分が見つかりません)。テキスト形式(ASCII)の DXF かどうかをご確認ください');
  const get = (e, c) => { const p = e.g.find((x) => x[0] === c); return p ? p[1] : null; };
  const layers = Object.create(null);   // レイヤ名がそのままキーになる。親を持たない入れ物にしておく(「constructor」「__proto__」という名前のレイヤが来ても、ふつうの名前として扱える)
  for (const e of raw) if (e.sec === 'TABLES' && e.type === 'LAYER') layers[get(e, '2')] = { col: Math.abs(parseInt(get(e, '62'), 10)) || 7, lt: get(e, '6') || 'CONTINUOUS' };
  // 連続線(POLYLINE)は後ろに続く VERTEX を、属性つきの INSERT は ATTRIB を、SEQEND までまとめる
  function group(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type === 'POLYLINE' || (e.type === 'INSERT' && get(e, '66') === '1')) {
        e.children = [];
        while (i + 1 < list.length && list[i + 1].type !== 'SEQEND' && (list[i + 1].type === 'VERTEX' || list[i + 1].type === 'ATTRIB')) e.children.push(list[++i]);
        if (i + 1 < list.length && list[i + 1].type === 'SEQEND') i++;
      }
      if (e.type !== 'SEQEND' && e.type !== 'ENDSEC' && e.type !== 'EOF') out.push(e);
    }
    return out;
  }
  const blocks = new Map();
  let bl = null;
  for (const e of raw.filter((x) => x.sec === 'BLOCKS')) {
    if (e.type === 'BLOCK') { bl = { name: get(e, '2'), bx: parseFloat(get(e, '10')) || 0, by: parseFloat(get(e, '20')) || 0, list: [] }; continue; }
    if (e.type === 'ENDBLK') { if (bl) { bl.list = group(bl.list); blocks.set(bl.name, bl); } bl = null; continue; }
    if (bl) bl.list.push(e);
  }
  return { ver, layers, blocks, entities: group(raw.filter((x) => x.sec === 'ENTITIES')), get };
}

// ===================== 図形の計算 =====================
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const deg = (rad) => ((rad * 180 / Math.PI) % 360 + 360) % 360;
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
function similarity(m) {   // 縦横同じ倍率(+回転・裏返し)だけの変換か
  const s1 = Math.hypot(m[0], m[1]), s2 = Math.hypot(m[2], m[3]);
  const ok = Math.abs(s1 - s2) <= 1e-9 * Math.max(1, s1) && Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * Math.max(1, s1 * s2);
  return { ok, s: s1, mirrored: m[0] * m[3] - m[1] * m[2] < 0 };
}
function bez(p, t) { const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t; return { x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x, y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y }; }
// B スプライン → ベジェ曲線の列(節点の挿入。Boehm の方法)。種本の手順そのまま。節点を1つ足すたびに配列を丸ごと作り直すので、手間は制御点の数の2乗(2万点の曲線で 40 秒以上)
function toBeziersSlow(p, knots, ctrl) {
  let U = knots.slice(), P = ctrl.map((q) => ({ x: q.x, y: q.y }));
  const lo = U[p], hi = U[U.length - p - 1];
  for (const u of Array.from(new Set(U.filter((v) => v > lo + 1e-12 && v < hi - 1e-12)))) {
    let s = U.filter((v) => Math.abs(v - u) < 1e-12).length;
    while (s < p) {
      let k = -1;
      for (let i = 0; i < U.length - 1; i++) if (U[i] <= u + 1e-12 && u < U[i + 1] - 1e-12) k = i;
      if (k < 0) break;
      const Q = [];
      for (let i = 0; i <= P.length; i++) {
        if (i <= k - p) Q.push(P[i]); else if (i >= k + 1) Q.push(P[i - 1]);
        else { const den = U[i + p] - U[i], a = den > 1e-15 ? (u - U[i]) / den : 0; Q.push({ x: (1 - a) * P[i - 1].x + a * P[i].x, y: (1 - a) * P[i - 1].y + a * P[i].y }); }
      }
      P = Q; U = U.slice(0, k + 1).concat([u], U.slice(k + 1)); s++;
    }
  }
  const out = [];
  for (let i = 0; i + p < P.length; i += p) out.push(P.slice(i, i + p + 1));
  return out;
}
const SLOW_KNOTS_MAX = 3000;   // 種本の手順のまま行う曲線の、節点の数の上限(これで 0.3 秒ほど)
// 同じ結果を、制御点の数に比例する手間で出す版。節点(knots)は有限で小さい順に並んでいること(呼ぶ側の SPLINE の所で確かめてある)
//   節点を足す場所は左から右へ進むだけなので、「もう変わらない左側(UL・PL)」と「まだ読んでいない右側(元の配列の ur・pr 番目から先)」に分けて持ち、足す所の近くだけを書き換える。
//   1回ごとの式・計算の順番・比べ方(1e-12 の幅)は種本と同じなので、結果は1ビットも変わらない(check/run-checks.js が、乱数で作った曲線で種本の手順と突き合わせる)
//   ただし、値の違う節点どうしが 4e-12 より近い曲線(計算の誤差で、同じ節点が2通りの値で書かれたもの)では 1e-12 の幅の比べ方が結果を左右するので、種本の手順のまま行う
function toBeziers(p, knots, ctrl) {
  for (let i = 1; i < knots.length; i++) {
    const gap = knots[i] - knots[i - 1];
    if (gap !== 0 && !(gap > 4e-12)) { if (knots.length > SLOW_KNOTS_MAX) rejectEntity('値の近すぎる節点を持つ、大きすぎる曲線'); return toBeziersSlow(p, knots, ctrl); }
  }
  const src = ctrl.map((q) => ({ x: q.x, y: q.y }));
  const lo = knots[p], hi = knots[knots.length - p - 1];
  const UL = [], PL = [];
  let ur = 0, pr = 0;
  const lenU = () => UL.length + knots.length - ur;
  const getU = (i) => (i < UL.length ? UL[i] : knots[ur + i - UL.length]);
  // 小さい順に並んだ U の中で、cond(U[i]) が成り立つ最後の番号(0〜last の範囲。無ければ -1)。cond は「左側だけで成り立つ」形のものに限る
  const lastWhere = (last, cond) => { let a = 0, b = last, r = -1; while (a <= b) { const m = (a + b) >> 1; if (cond(getU(m))) { r = m; a = m + 1; } else b = m - 1; } return r; };
  for (const u of Array.from(new Set(knots.filter((v) => v > lo + 1e-12 && v < hi - 1e-12)))) {
    // いまの U の中で u と同じとみなす節点の数(u そのものは必ず U の中にあり、同じとみなす節点はその前後に固まっている)
    const at = lastWhere(lenU() - 1, (v) => v < u) + 1;
    let s = 0;
    for (let j = at; j < lenU() && Math.abs(getU(j) - u) < 1e-12; j++) s++;
    for (let j = at - 1; j >= 0 && Math.abs(getU(j) - u) < 1e-12; j--) s++;
    while (s < p) {
      // 種本の「U[i] <= u + 1e-12 かつ u < U[i + 1] - 1e-12 を満たす最後の i」。前の条件は左側だけ・後の条件は右側だけで成り立つので、前の条件の最後の i で後の条件を見れば足りる
      const k = lastWhere(lenU() - 2, (v) => v <= u + 1e-12);
      if (k < 0 || !(u < getU(k + 1) - 1e-12)) break;
      // 左側を U[0..k]・P[0..k-p] にそろえる。前の回に左へ入れた点のうち、今回書き換える分(多くて p-1 個)は mid へ戻す
      while (UL.length < k + 1) UL.push(knots[ur++]);
      const mid = [];
      while (PL.length > k - p + 1) mid.unshift(PL.pop());
      while (PL.length < k - p + 1) PL.push(src[pr++]);
      const win = [PL[PL.length - 1]].concat(mid);   // win[j] = P[k - p + j]
      for (let t = 0; win.length < p + 1; t++) win.push(src[pr + t]);
      pr += p - 1 - mid.length;                      // P[k-p+1..k-1] は新しい点に置き換わる。P[k] は右側に残す
      for (let i = k - p + 1; i <= k; i++) {
        const den = getU(i + p) - getU(i), a = den > 1e-15 ? (u - getU(i)) / den : 0, q0 = win[i - 1 - (k - p)], q1 = win[i - (k - p)];
        PL.push({ x: (1 - a) * q0.x + a * q1.x, y: (1 - a) * q0.y + a * q1.y });
      }
      UL.push(u); s++;
    }
  }
  const P = PL.concat(src.slice(pr)), out = [];
  for (let i = 0; i + p < P.length; i += p) out.push(P.slice(i, i + p + 1));
  return out;
}
// 重みつき・3次以外のスプライン用: 曲線上の点を直接求める(de Boor の方法)。節点(U)は有限で小さい順に並んでいること
function evalSpline(p, U, P, W, u) {
  // u の入る区間 = 「u >= U[i] を満たす最後の i(p 〜 U.length-p-2 の範囲)」。種本は毎回端から順に探していた(制御点の数の2乗の手間)。小さい順なので半分ずつ絞っても同じ番号になる
  let k = p;
  for (let a = p, b = U.length - p - 2; a <= b;) { const m = (a + b) >> 1; if (u >= U[m]) { k = m; a = m + 1; } else b = m - 1; }
  const d = [];
  for (let j = 0; j <= p; j++) { const w = W ? W[j + k - p] : 1; d.push({ x: P[j + k - p].x * w, y: P[j + k - p].y * w, w }); }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const den = U[j + 1 + k - r] - U[j + k - p], a = den > 1e-15 ? (u - U[j + k - p]) / den : 0;
    d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
  }
  return { x: d[p].x / d[p].w, y: d[p].y / d[p].w };
}
// 折れ線の点を、形が tol 以上変わらない範囲で間引く(いちばん離れた点で2つに分けていく方法)。
//   ふつうの形なら手間は 点の数 × その対数 ほどだが、分け方が片寄る形(だんだん大きくなるのこぎり波など)では点の数の2乗になる(その形をした制御点 5000 個の2次の SPLINE で、間引きだけに 12 秒)。
//   そこで比べた回数を数え、SIMPLIFY_BUDGET を超えたら、残りの区間を SIMPLIFY_CHUNK 点ずつに切って続ける(切れ目の点は必ず残す)。
//   歯止めが掛かるまでは種本と同じ結果。掛かった後も「間引いた点は、残した線から tol 以内」は変わらない(残る点が少し増えるだけ)
const SIMPLIFY_BUDGET = 50000000, SIMPLIFY_CHUNK = 1000;   // 5 千万回で 0.5 秒ほど。ふつうの形なら、制御点 2万個(点 80 万個)の曲線でも 2 千万回に届かない
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  let work = 0;
  while (st.length) {
    const [a, b] = st.pop(); let mx = 0, mi = -1;
    if (work > SIMPLIFY_BUDGET && b - a > SIMPLIFY_CHUNK) { for (let c = a; c < b; c += SIMPLIFY_CHUNK) { const e = Math.min(b, c + SIMPLIFY_CHUNK); keep[e] = 1; st.push([c, e]); } continue; }
    work += b - a;
    const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((pts[i].x - pts[a].x) * dx + (pts[i].y - pts[a].y) * dy) / L2)) : 0;
      const d = Math.hypot(pts[i].x - (pts[a].x + t * dx), pts[i].y - (pts[a].y + t * dy));
      if (d > mx) { mx = d; mi = i; }
    }
    if (mx > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function isStraight(b) {
  const a = b[0], z = b[3], L = dist(a, z);
  if (L < 1e-9) return dist(a, b[1]) < STRAIGHT && dist(a, b[2]) < STRAIGHT;
  for (const q of [b[1], b[2]]) {
    const off = Math.abs((q.x - a.x) * (z.y - a.y) - (q.y - a.y) * (z.x - a.x)) / L;
    const along = ((q.x - a.x) * (z.x - a.x) + (q.y - a.y) * (z.y - a.y)) / (L * L);
    if (off > STRAIGHT || along < -1e-6 || along > 1 + 1e-6) return false;
  }
  return true;
}
function flattenBez(b, out) {
  (function rec(p0, p1, p2, p3, depth) {
    const dx = p3.x - p0.x, dy = p3.y - p0.y, L2 = dx * dx + dy * dy;
    const off = (q) => (L2 < 1e-18 ? dist(q, p0) : Math.abs((q.x - p0.x) * dy - (q.y - p0.y) * dx) / Math.sqrt(L2));
    // 制御点が弦の延長上にはみ出す曲線(行って戻る形)は、弦1本にすると端が欠けるので、はみ出しが無くなるまで分ける
    const al = (q) => (L2 < 1e-18 ? 0.5 : ((q.x - p0.x) * dx + (q.y - p0.y) * dy) / L2);
    const inside = Math.sqrt(L2) <= TOL || (al(p1) >= -0.01 && al(p1) <= 1.01 && al(p2) >= -0.01 && al(p2) <= 1.01);
    if (depth >= 18 || (off(p1) <= TOL && off(p2) <= TOL && inside)) { out.push(p3); return; }
    const m01 = mid(p0, p1), m12 = mid(p1, p2), m23 = mid(p2, p3), a = mid(m01, m12), c = mid(m12, m23), m = mid(a, c);
    rec(p0, m01, a, m, depth + 1); rec(m, c, m23, p3, depth + 1);
  })(b[0], b[1], b[2], b[3], 0);
}
function fitCircleLS(pts) {
  const n = pts.length; let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; } mx /= n; my /= n;
  let Suu = 0, Suv = 0, Svv = 0, Suz = 0, Svz = 0, Sz = 0;
  for (const p of pts) { const u = p.x - mx, v = p.y - my, z = u * u + v * v; Suu += u * u; Suv += u * v; Svv += v * v; Suz += u * z; Svz += v * z; Sz += z; }
  const det = Suu * Svv - Suv * Suv;
  if (!(Math.abs(det) > 1e-12 * (Suu + Svv) * (Suu + Svv))) return null;
  const D = (-Suz * Svv + Svz * Suv) / det, E = (-Svz * Suu + Suz * Suv) / det, F = -Sz / n, r2 = (D * D + E * E) / 4 - F;
  return r2 > 0 ? { x: mx - D / 2, y: my - E / 2, r: Math.sqrt(r2) } : null;
}
const sampleBez = (b, n) => { const a = []; for (let i = 0; i <= n; i++) a.push(bez(b, i / n)); return a; };
// 点の列が1つの円に乗るか(ズレ TOL 以内・同じ向きに回る)。乗るなら中心・半径・回転量を返す
function arcOfPoints(pts) {
  const c = fitCircleLS(pts);
  if (!c || c.r > 5000 || c.r < 0.02) return null;
  let sweep = 0, sign = 0, prev = Math.atan2(pts[0].y - c.y, pts[0].x - c.x);
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(Math.hypot(pts[i].x - c.x, pts[i].y - c.y) - c.r) > TOL) return null;
    if (!i) continue;
    const a = Math.atan2(pts[i].y - c.y, pts[i].x - c.x); let d = a - prev;
    while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
    if (Math.abs(d) > 1e-12) { const s = Math.sign(d); if (sign && s !== sign) return null; sign = s; }
    sweep += d; prev = a;
  }
  if (Math.abs(sweep) < 0.03) return null;   // 回転が小さすぎる(ほぼ直線)ものは円弧にしない
  return { cx: c.x, cy: c.y, r: c.r, sweep, p0: pts[0], p1: pts[pts.length - 1] };
}
function arcPrim(a) {
  if (Math.abs(a.sweep) >= 2 * Math.PI - 0.01) return { t: 'C', cx: a.cx, cy: a.cy, r: a.r };
  const s = Math.atan2(a.p0.y - a.cy, a.p0.x - a.cx), e = Math.atan2(a.p1.y - a.cy, a.p1.x - a.cx);
  return { t: 'A', cx: a.cx, cy: a.cy, r: a.r, a1: deg(a.sweep > 0 ? s : e), a2: deg(a.sweep > 0 ? e : s) };
}
// ベジェ曲線の列 → 線・円弧・円
function convertBeziers(bs, push) {
  let i = 0;
  while (i < bs.length) {
    if (isStraight(bs[i])) { push({ t: 'L', a: bs[i][0], b: bs[i][3] }); i++; continue; }
    let best = null, j = i;
    while (j < bs.length && !isStraight(bs[j])) {
      const pts = [];
      bs.slice(i, j + 1).forEach((b, n) => { const s = sampleBez(b, 16); if (n) s.shift(); for (const q of s) pts.push(q); });
      const a = arcOfPoints(pts);
      if (!a || Math.abs(a.sweep) > 2 * Math.PI + 0.01) break;
      best = { a, end: j }; j++;
    }
    if (best) { push(arcPrim(best.a)); i = best.end + 1; continue; }
    const pts = [bs[i][0]]; flattenBez(bs[i], pts);
    for (let k = 1; k < pts.length; k++) push({ t: 'L', a: pts[k - 1], b: pts[k] });
    i++;
  }
}

// ===================== 文字コード(Shift-JIS)と、MTEXT の書式の除去 =====================
let cp932 = null;
function cp932Table() {
  if (cp932) return cp932;
  const dec = new TextDecoder('shift_jis'), map = new Map();
  for (let b = 0xA1; b <= 0xDF; b++) { const ch = dec.decode(new Uint8Array([b])); if (ch.length === 1 && ch.codePointAt(0) !== 0xFFFD) map.set(ch, [b]); }
  const leads = [];
  for (let l = 0x81; l <= 0x9F; l++) leads.push(l);
  for (let l = 0xE0; l <= 0xFC; l++) if (l !== 0xED && l !== 0xEE) leads.push(l);
  leads.push(0xED, 0xEE);
  for (const l of leads) for (let t = 0x40; t <= 0xFC; t++) { if (t === 0x7F) continue; const ch = dec.decode(new Uint8Array([l, t])); if (ch.length === 1 && ch.codePointAt(0) !== 0xFFFD && !map.has(ch)) map.set(ch, [l, t]); }
  for (const [a, b] of [[0xFF5E, 0x301C], [0x2225, 0x2016], [0xFF0D, 0x2212], [0xFFE0, 0x00A2], [0xFFE1, 0x00A3], [0xFFE2, 0x00AC], [0x2014, 0x2015]].map((p) => p.map((c) => String.fromCodePoint(c)))) {
    if (map.has(a) && !map.has(b)) map.set(b, map.get(a));
    if (map.has(b) && !map.has(a)) map.set(a, map.get(b));
  }
  cp932 = map; return map;
}
// バイト列をためる入れ物(足りなくなったら倍に広げる)。ふつうの配列に1バイトずつ積むと、大きな図面で出力の何十倍ものメモリを使うため
function byteSink() {
  let buf = new Uint8Array(1 << 16), n = 0;
  return {
    put(b) { if (n === buf.length) { const next = new Uint8Array(buf.length * 2); next.set(buf); buf = next; } buf[n++] = b; },
    bytes() { return buf.slice(0, n); }
  };
}
// str を Shift-JIS にして sink へ足す。戻り値は書けなかった文字(「?」にした文字)の数
function encodeInto(str, sink) {
  const tbl = cp932Table(); let bad = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { sink.put(c); continue; }
    let b = tbl.get(ch);
    if (!b) { const n = ch.normalize('NFKC'); const bs = []; let ok = n !== ch; for (const q of n) { const qc = q.codePointAt(0); if (qc < 0x80) bs.push(qc); else if (tbl.get(q)) for (const x of tbl.get(q)) bs.push(x); else ok = false; } if (ok && bs.length) b = bs; }
    if (b) for (const x of b) sink.put(x); else { sink.put(0x3F); bad++; }
  }
  return bad;
}
function encodeCP932(str) {
  const sink = byteSink(), bad = encodeInto(str, sink);
  return { bytes: sink.bytes(), bad };
}
// DXF の特殊な表記(%%d = °、%%p = ±、%%c = φ、%%u %%o = 下線・上線)
// AutoCAD は、文字コードに無い字を「逆スラッシュ U+2205」のように書く(2205 = 直径の記号)。Jw_cad はこれを読めず、そのまま表示してしまうので、本物の字に戻す
function decodeUnicodeEscapes(s) {
  let out = '', i = 0; const HEX = '0123456789abcdefABCDEF';
  while (i < s.length) {
    if (s[i] === BS && s[i + 1] === 'U' && s[i + 2] === '+' && i + 6 < s.length + 0 && [3, 4, 5, 6].every((k) => HEX.indexOf(s[i + k]) >= 0 && s[i + k] !== undefined)) {
      const cp = parseInt(s.slice(i + 3, i + 7), 16);
      out += (cp === 0x2205 || cp === 0x2300 || cp === 0xD8 || cp === 0xF8) ? 'φ' : String.fromCodePoint(cp);   // 直径の記号は、日本の図面で使う「φ」にする
      i += 7; continue;
    }
    out += s[i]; i++;
  }
  return out;
}
function plainText(s) {
  let t = decodeUnicodeEscapes(String(s || ''));
  for (const [a, b] of [['%%d', '°'], ['%%D', '°'], ['%%p', '±'], ['%%P', '±'], ['%%c', 'φ'], ['%%C', 'φ'], ['%%u', ''], ['%%U', ''], ['%%o', ''], ['%%O', ''], ['%%%', '%']]) t = t.split(a).join(b);
  return t;
}
function mtextLines(s) {
  const out = ['']; let i = 0; const src = String(s || '');
  while (i < src.length) {
    const ch = src[i];
    if (ch === BS && i + 1 < src.length) {
      const n = src[i + 1];
      if (n === 'P') { out.push(''); i += 2; continue; }
      if (n === '~') { out[out.length - 1] += ' '; i += 2; continue; }
      if (n === BS || n === '{' || n === '}') { out[out.length - 1] += n; i += 2; continue; }
      if ('LlOoKk'.indexOf(n) >= 0) { i += 2; continue; }
      if (n === 'S') { const e = src.indexOf(';', i); const body = src.slice(i + 2, e < 0 ? src.length : e); out[out.length - 1] += body.split('^').join('/').split('#').join('/'); i = e < 0 ? src.length : e + 1; continue; }
      if (n === 'U' && src[i + 2] === '+') { out[out.length - 1] += src.slice(i, i + 7); i += 7; continue; }   // 文字コードの表記は後で本物の字に戻す
      if ('AaCcHhWwQqTtFfPp'.indexOf(n) >= 0) { const e = src.indexOf(';', i); i = e < 0 ? src.length : e + 1; continue; }
      i += 2; continue;
    }
    if (ch === '{' || ch === '}') { i++; continue; }
    out[out.length - 1] += ch; i++;
  }
  return out.map(plainText);
}
const textWidth = (s, h) => { let w = 0; for (const ch of s) w += (ch.codePointAt(0) < 0x80 ? 0.62 : 1.0) * h; return w; };

// ===================== 色・線種(Jw_cad 実機で確認が取れている範囲に寄せる) =====================
// 実機確認(2026-09-20、標本DXFを Jw_cad で開いた結果):
//   色: 1赤 2黄 3緑 4水 5青 6紫 7黒 はそのまま通る。8 = 灰色、9 = 薄い灰色、30 = 橙 も通る。18・51・154・162・193・250・252・254 は全部「黒」になる(補助線にはならない)
//   線種: DASHED と HIDDEN = 破線、CENTER と DASHDOT = 一点鎖線、PHANTOM = 二点鎖線、DOT = 点線 として読まれる(LTYPE の表に定義がある時)
function mapColor(c) {   // 通ると確認できた番号はそのまま。ほかは色相の近い色へ(黒に潰れて部品の区別が消えるのを避ける)。灰色は明るさの近い灰色へ
  if ((c >= 1 && c <= 9) || c === 30) return c;
  if (c === 250 || c === 251 || !(c >= 1)) return 7;
  if (c === 252) return 8;
  if (c === 253 || c === 254 || c === 255) return 9;
  const hue = Math.floor((c - 10) / 10) * 15;
  if (hue === 30) return 30;   // 橙の系統は橙へ
  return [1, 2, 3, 4, 5, 6][Math.floor(hue / 60) % 6];
}
// 白い背景で使う人向けの色替え(さっちゃんの Jw_cad は白背景。2026-09-20 の要望)。
// 白地で見えにくい色 = 黄(2)・緑(3)・水色(4)の系統と薄い灰色(9)。実線は黒(7)、破線・鎖線・点線は灰色(8)にする。赤・青・紫・橙・黒・灰はそのまま。
// recolor に false を渡すと、この色替えをしない(黒背景で使う人向け。CLI の「--keep-colors」)
function whiteBg(col, lt, recolor) {
  if (!recolor) return col;
  if (col !== 2 && col !== 3 && col !== 4 && col !== 9) return col;
  return (!lt || lt === 'CONTINUOUS') ? 7 : 8;
}
function mapLt(name) {
  const n = String(name || '').toUpperCase();
  if (n.indexOf('PHANTOM') >= 0 || n.indexOf('DIVIDE') >= 0) return 'PHANTOM';
  if (n.indexOf('CENTER') >= 0 || n.indexOf('DASHDOT') >= 0 || n.indexOf('AI9') >= 0) return 'CENTER';
  if (n.indexOf('HIDDEN') >= 0 || n.indexOf('DASH') >= 0) return 'DASHED';
  if (n.indexOf('DOT') >= 0) return 'DOT';
  return 'CONTINUOUS';
}

// ===================== 分解して、線・円弧・円・文字・塗り・点にする =====================
function convert(dxf, recolor, limits) {
  const get = dxf.get, prims = [], curves = [];
  const stat = { from: Object.create(null), skipped: Object.create(null), arcsFromCurves: 0, linesFromCurves: 0, brokenByJww: 0, errors: [] };   // errors = 要素ごとに受け止めた失敗の控え(先頭の5件。原因を調べる時のため)
  const F = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  // 暴走を止める仕掛け。深さの上限(12)だけでは、1つのブロックが自分を何個も含む形(4個なら 4 の 13 乗回)や、図形を出さない入れ子の掛け算を止められない
  const lim = resolveLimits(limits);
  const active = new Set();   // いま分解している途中のブロック
  let visits = 0;
  const tick = () => { if (++visits > lim.maxVisits) throw new DxfError('ブロックの入れ子が多すぎて、分解を続けられません(' + lim.maxVisits + ' 回を超えました)。DXF が壊れている可能性があります'); };
  function style(e, ctx) {
    let layer = get(e, '8') || '0'; if (layer === '0' && ctx.layer) layer = ctx.layer;
    const lay = dxf.layers[layer] || dxf.layers[get(e, '8')] || { col: 7, lt: 'CONTINUOUS' };
    let lt = get(e, '6'); const LT = String(lt || '').toUpperCase();
    if (!lt || LT === 'BYLAYER') lt = lay.lt; else if (LT === 'BYBLOCK') lt = ctx.lt || lay.lt;
    let col = parseInt(get(e, '62'), 10);
    if (!isFinite(col) || col === 256) col = lay.col; else if (col === 0) col = ctx.col || lay.col;
    return { layer, ltRaw: lt, colRaw: Math.abs(col), lt: mapLt(lt), col: whiteBg(mapColor(Math.abs(col)), mapLt(lt), recolor) };
  }
  function walk(list, M, ctx, depth, unreadable) {
    for (const e of list) {
      tick();
      // 要素1つの中で思わぬ失敗(値の壊れた要素・プログラムの見落とし)が起きても、図面全体を落とさない。その要素が出しかけた図形を取り消し、「値が不正」として数えて次へ進む。
      // 上限超えの DxfError だけは、利用者にそのまま見せる理由なので外へ出す
      const mark = prims.length, markCurves = curves.length, markFlat = stat.flatArcs;
      try { entity(e, M, ctx, depth, unreadable); }
      catch (ex) {
        if (ex instanceof DxfError) throw ex;
        prims.length = mark; curves.length = markCurves; stat.flatArcs = markFlat;
        const key = String(e && e.type) + '(値が不正)';
        stat.skipped[key] = (stat.skipped[key] || 0) + 1;
        if (stat.errors.length < 5) stat.errors.push(String(e && e.type) + ': ' + String(ex && ex.name) + ': ' + String(ex && ex.message));
      }
    }
  }
  function entity(e, M, ctx, depth, unreadable) {
    const st = style(e, ctx), sim = similarity(M);
    const flip = F(get(e, '230'), 1) < 0;   // 裏返しの座標系(押し出し方向が -Z)
    const push = (p) => { if (prims.length >= lim.maxPrims) throw new DxfError('図形の数が多すぎます(' + lim.maxPrims + ' 個を超えました)。図面を分けて保存し直すか、ブロックの入れ子に異常がないかをご確認ください'); prims.push(Object.assign(p, { layer: st.layer, lt: st.lt, aci: mapColor(st.colRaw), aciRaw: st.colRaw, col: (p.t === 'T' || p.t === 'S' || p.t === 'P') ? whiteBg(mapColor(st.colRaw), 'CONTINUOUS', recolor) : st.col })); };   // 文字・塗り・点は線種に関係なく黒側へ
    const count = (k) => { stat.from[k] = (stat.from[k] || 0) + 1; };
    const line = (a, b) => { const p = ap(M, a), q = ap(M, b); if (dist(p, q) > 1e-9) push({ t: 'L', a: p, b: q }); };
    const arc = (cx, cy, r, a1, a2, full) => {   // 角度は度、反時計回り
      if (flip) { cx = -cx; const t = a1; a1 = 180 - a2; a2 = 180 - t; }
      if (sim.ok) {
        const c = ap(M, { x: cx, y: cy }), rr = r * sim.s;
        if (full) { push({ t: 'C', cx: c.x, cy: c.y, r: rr }); return; }
        const dir = (a) => { const v = { x: Math.cos(a * Math.PI / 180), y: Math.sin(a * Math.PI / 180) }; return deg(Math.atan2(M[1] * v.x + M[3] * v.y, M[0] * v.x + M[2] * v.y)); };
        const s = dir(a1), t = dir(a2);
        const A1 = sim.mirrored ? t : s, A2 = sim.mirrored ? s : t, span = (((A2 - A1) % 360) + 360) % 360 * Math.PI / 180;
        // 半径がとても大きく、ふくらみが許容ズレより小さい円弧(3次元CADの自動作図に多い)は、直線として出す。中心が何百万mmも遠くにあり、Jw_cad で扱いにくいため
        if (span < Math.PI && rr * (1 - Math.cos(span / 2)) <= TOL) { stat.flatArcs = (stat.flatArcs || 0) + 1; push({ t: 'L', a: { x: c.x + rr * Math.cos(A1 * Math.PI / 180), y: c.y + rr * Math.sin(A1 * Math.PI / 180) }, b: { x: c.x + rr * Math.cos(A2 * Math.PI / 180), y: c.y + rr * Math.sin(A2 * Math.PI / 180) } }); return; }
        push({ t: 'A', cx: c.x, cy: c.y, r: rr, a1: A1, a2: A2 });
      } else {   // 縦横の倍率が違う配置の中の円・円弧は楕円になるので、細かい線にする
        if (!(Math.abs(a1) <= 1e6 && Math.abs(a2) <= 1e6)) rejectEntity('円弧の角度が桁外れ');   // 下の while が終わらなくなる(360 を足しても値が変わらない大きさ)
        let b2 = full ? a1 + 360 : a2; while (b2 <= a1) b2 += 360;
        const n = Math.max(12, Math.ceil((b2 - a1) * Math.PI / 180 / Math.sqrt(8 * TOL / Math.max(r * Math.max(Math.hypot(M[0], M[1]), Math.hypot(M[2], M[3])), 1e-6))));
        if (!(n <= MAX_ARC_STEPS)) rejectEntity('円弧を分ける本数が桁外れ');   // 半径 × 倍率が無限大になると n も無限大になり、下の繰り返しが終わらない
        let prev = null;
        for (let i = 0; i <= n; i++) { const a = (a1 + (b2 - a1) * i / n) * Math.PI / 180, q = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; if (prev) line(prev, q); prev = q; }
      }
    };
    const bulgeSeg = (p, q, b) => {
      if (!(Math.abs(b) > 1e-9)) { line(p, q); return; }
      const c = dist(p, q); if (c < 1e-12) return;
      const th = 4 * Math.atan(b), d = (c / 2) / Math.tan(th / 2), m = mid(p, q);
      const cx = m.x - (q.y - p.y) / c * d, cy = m.y + (q.x - p.x) / c * d, r = Math.hypot(p.x - cx, p.y - cy);
      const ap1 = deg(Math.atan2(p.y - cy, p.x - cx)), aq = deg(Math.atan2(q.y - cy, q.x - cx));
      if (b > 0) arc(cx, cy, r, ap1, aq, false); else arc(cx, cy, r, aq, ap1, false);
    };
    const text = (x, y, h, rotDeg, s, wf) => {
      const str = plainText(s); if (!str.trim()) return;
      const p = ap(M, { x, y }), r = rotDeg * Math.PI / 180;
      const vx = M[0] * Math.cos(r) + M[2] * Math.sin(r), vy = M[1] * Math.cos(r) + M[3] * Math.sin(r);
      push({ t: 'T', x: p.x, y: p.y, h: h * Math.hypot(M[2], M[3]), rot: deg(Math.atan2(vy, vx)), s: str, wf: wf });
    };
    const T = e.type;
    if (T === 'LINE') { count(T); line({ x: F(get(e, '10'), 0), y: F(get(e, '20'), 0) }, { x: F(get(e, '11'), 0), y: F(get(e, '21'), 0) }); }
    else if (T === 'ARC') { count(T); arc(F(get(e, '10'), 0), F(get(e, '20'), 0), F(get(e, '40'), 0), F(get(e, '50'), 0), F(get(e, '51'), 0), false); }
    else if (T === 'CIRCLE') { count(T); arc(F(get(e, '10'), 0), F(get(e, '20'), 0), F(get(e, '40'), 0), 0, 360, true); }
    else if (T === 'POINT') { count(T); const p = ap(M, { x: F(get(e, '10'), 0), y: F(get(e, '20'), 0) }); push({ t: 'P', x: p.x, y: p.y }); }
    else if (T === 'SOLID' || T === 'TRACE') { count(T); const q = [['10', '20'], ['11', '21'], ['12', '22'], ['13', '23']].map((k) => ap(M, { x: F(get(e, k[0]), F(get(e, '12'), 0)), y: F(get(e, k[1]), F(get(e, '22'), 0)) })); push({ t: 'S', q }); }
    else if (T === 'LWPOLYLINE') {
      count(T);
      const v = []; let curV = null;
      for (const [c, val] of e.g) { if (c === '10') { curV = { x: parseFloat(val), y: 0, b: 0 }; v.push(curV); } else if (c === '20' && curV) curV.y = parseFloat(val); else if (c === '42' && curV) curV.b = parseFloat(val); }
      const closed = (parseInt(get(e, '70'), 10) || 0) & 1;
      for (let i = 1; i < v.length; i++) bulgeSeg(v[i - 1], v[i], v[i - 1].b);
      if (closed && v.length > 1) bulgeSeg(v[v.length - 1], v[0], v[v.length - 1].b);
    }
    else if (T === 'POLYLINE') {
      count(T);
      const flags = parseInt(get(e, '70'), 10) || 0;
      if (flags & (16 | 64)) { stat.skipped['POLYLINE(網目・多面体)'] = (stat.skipped['POLYLINE(網目・多面体)'] || 0) + 1; return; }
      const v = (e.children || []).filter((c) => c.type === 'VERTEX' && !((parseInt(get(c, '70'), 10) || 0) & 16)).map((c) => ({ x: F(get(c, '10'), 0), y: F(get(c, '20'), 0), b: F(get(c, '42'), 0) }));
      for (let i = 1; i < v.length; i++) bulgeSeg(v[i - 1], v[i], v[i - 1].b);
      if ((flags & 1) && v.length > 1) bulgeSeg(v[v.length - 1], v[0], v[v.length - 1].b);
    }
    else if (T === 'SPLINE') {
      count(T); if (unreadable) stat.brokenByJww++;
      const p = parseInt(get(e, '71'), 10) || 3, U = e.g.filter((x) => x[0] === '40').map((x) => parseFloat(x[1]));
      const xs = e.g.filter((x) => x[0] === '10').map((x) => parseFloat(x[1])), ys = e.g.filter((x) => x[0] === '20').map((x) => parseFloat(x[1]));
      const W = e.g.filter((x) => x[0] === '41').map((x) => parseFloat(x[1]));
      const P = xs.map((x, i) => ap(M, { x: flip ? -x : x, y: ys[i] }));
      if (P.length < p + 1 || U.length !== P.length + p + 1) { stat.skipped['SPLINE(通過点だけの形式)'] = (stat.skipped['SPLINE(通過点だけの形式)'] || 0) + 1; return; }
      // 値の検査。節点が小さい順でない曲線は、下の計算が配列の外を読んで落ちる(数字が1つ壊れた DXF で実際に起きた)。重みが壊れた曲線は、何も出さずに黙って消えていた
      if (!(p >= 1)) rejectEntity('次数が 1 より小さい');
      if (!U.every(isFinite) || U.some((v, i) => i > 0 && v < U[i - 1])) rejectEntity('節点が有限でない、または小さい順でない');
      if (!P.every((q) => isFinite(q.x) && isFinite(q.y))) rejectEntity('制御点が有限でない');
      if (W.length === P.length && !W.every((w) => isFinite(w) && w > 0)) rejectEntity('重みが有限でない、または正でない');
      const from = prims.length; let pts;
      if (p === 3 && !W.length) {
        const bs = toBeziers(p, U, P);
        convertBeziers(bs, push);
        pts = []; for (const b of bs) for (const q of sampleBez(b, 40)) pts.push(q);
      } else {   // 重みつき・3次以外: 細かく点を取り、円弧なら円弧、違えば間引いた線にする
        if (P.length * p * p > MAX_SPLINE_WORK) rejectEntity('次数と制御点の数が大きすぎる');
        const lo = U[p], hi = U[U.length - p - 1], n = Math.max(200, P.length * 40); pts = [];
        for (let i = 0; i <= n; i++) pts.push(evalSpline(p, U, P, W.length === P.length ? W : null, Math.min(hi - 1e-12 * Math.max(1, Math.abs(hi)), lo + (hi - lo) * i / n)));
        const a = arcOfPoints(pts);
        if (a) push(arcPrim(a)); else { const sp = simplify(pts, TOL / 2); for (let i = 1; i < sp.length; i++) if (dist(sp[i - 1], sp[i]) > 1e-9) push({ t: 'L', a: sp[i - 1], b: sp[i] }); }
      }
      curves.push({ kind: T, pts, from, to: prims.length });
    }
    else if (T === 'ELLIPSE') {
      count(T); if (unreadable) stat.brokenByJww++;
      const sgn = flip ? -1 : 1;
      const C = ap(M, { x: sgn * F(get(e, '10'), 0), y: F(get(e, '20'), 0) }), ax = sgn * F(get(e, '11'), 0), ay = F(get(e, '21'), 0), ratio = F(get(e, '40'), 1);
      const A = { x: M[0] * ax + M[2] * ay, y: M[1] * ax + M[3] * ay }, bx0 = -ay * ratio * sgn, by0 = ax * ratio * sgn, B = { x: M[0] * bx0 + M[2] * by0, y: M[1] * bx0 + M[3] * by0 };
      let t0 = F(get(e, '41'), 0), t1 = F(get(e, '42'), 2 * Math.PI); if (!(t1 > t0)) t1 += 2 * Math.PI;
      const Pt = (t) => ({ x: C.x + Math.cos(t) * A.x + Math.sin(t) * B.x, y: C.y + Math.cos(t) * A.y + Math.sin(t) * B.y });
      const pts = []; for (let i = 0; i <= 400; i++) pts.push(Pt(t0 + (t1 - t0) * i / 400));
      const from = prims.length, a = arcOfPoints(pts);
      if (a) push(arcPrim(a));   // ほぼ真円の楕円は、本物の円・円弧として出す(Jw_cad で中心が取れる)
      else { const sp = simplify(pts, TOL / 2); for (let i = 1; i < sp.length; i++) if (dist(sp[i - 1], sp[i]) > 1e-9) push({ t: 'L', a: sp[i - 1], b: sp[i] }); }
      curves.push({ kind: T, pts, from, to: prims.length });
    }
    else if (T === 'TEXT' || T === 'ATTRIB') { count(T); text(F(get(e, '10'), 0), F(get(e, '20'), 0), F(get(e, '40'), 1), F(get(e, '50'), 0), get(e, '1'), F(get(e, '41'), 1)); }
    else if (T === 'MTEXT') {
      count(T); if (unreadable) stat.brokenByJww++;
      const h = F(get(e, '40'), 1), att = parseInt(get(e, '71'), 10) || 1;
      let rot = F(get(e, '50'), NaN); if (!isFinite(rot)) rot = deg(Math.atan2(F(get(e, '21'), 0), F(get(e, '11'), 1)));
      const body = e.g.filter((x) => x[0] === '3').map((x) => x[1]).join('') + (get(e, '1') || '');
      const lines = mtextLines(body), ls = h * 5 / 3, r = rot * Math.PI / 180;
      const x0 = F(get(e, '10'), 0), y0 = F(get(e, '20'), 0), row = Math.floor((att - 1) / 3), colm = (att - 1) % 3;
      lines.forEach((s, i) => {
        const w = textWidth(s, h), dx = colm === 0 ? 0 : colm === 1 ? -w / 2 : -w;
        const dy = row === 0 ? -h - i * ls : row === 1 ? (lines.length - 1) * ls / 2 - h / 2 - i * ls : (lines.length - 1 - i) * ls;
        text(x0 + dx * Math.cos(r) - dy * Math.sin(r), y0 + dx * Math.sin(r) + dy * Math.cos(r), h, rot, s, 1);
      });
    }
    else if (T === 'INSERT' || T === 'DIMENSION') {
      count(T); if (T === 'DIMENSION' && unreadable) stat.brokenByJww++;
      const b = dxf.blocks.get(get(e, '2'));
      if (!b || depth > 12) { stat.skipped[T + '(ブロックなし)'] = (stat.skipped[T + '(ブロックなし)'] || 0) + 1; return; }
      // 自分自身を(直接でも、ほかのブロック経由でも)含むブロックは、2周目に入る所で読み飛ばす。CAD では作れない形で、壊れた DXF にだけ出る
      if (active.has(b)) { stat.skipped[T + '(自分自身を含むブロック)'] = (stat.skipped[T + '(自分自身を含むブロック)'] || 0) + 1; return; }
      active.add(b);
      try {
        let Mi = ID;
        if (T === 'INSERT') {
          const sx = F(get(e, '41'), 1), sy = F(get(e, '42'), 1), r = F(get(e, '50'), 0) * Math.PI / 180, ix = (flip ? -1 : 1) * F(get(e, '10'), 0), iy = F(get(e, '20'), 0);
          const nc = Math.max(1, parseInt(get(e, '70'), 10) || 1), nr = Math.max(1, parseInt(get(e, '71'), 10) || 1), dc = F(get(e, '44'), 0), dr = F(get(e, '45'), 0);
          if (nc * nr > lim.maxArray) throw new DxfError('ブロックの並べ複写の数が異常です(' + nc + ' × ' + nr + ')。DXF が壊れている可能性があります');
          for (let cI = 0; cI < nc; cI++) for (let rI = 0; rI < nr; rI++) {
            if (cI + rI > 0) tick();
            const ox = cI * dc, oy = rI * dr;
            Mi = mul([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), ix, iy], mul([1, 0, 0, 1, ox, oy], mul([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, -b.bx, -b.by])));
            walk(b.list, mul(M, Mi), { layer: st.layer, col: st.colRaw, lt: st.ltRaw }, depth + 1, false);
          }
          for (const a of (e.children || [])) walk([a], M, ctx, depth + 1, false);
        } else walk(b.list, M, { layer: st.layer, col: st.colRaw, lt: st.ltRaw }, depth + 1, false);
      } finally { active.delete(b); }   // 途中で外へ抜けても「分解中」の印を必ず外す(残ると、同じブロックの次の配置が循環と間違われる)
    }
    else { stat.skipped[T] = (stat.skipped[T] || 0) + 1; }
  }
  walk(dxf.entities, ID, {}, 0, true);
  stat.arcsFromCurves = curves.reduce((n, c) => n + prims.slice(c.from, c.to).filter((p) => p.t !== 'L').length, 0);
  stat.linesFromCurves = curves.reduce((n, c) => n + prims.slice(c.from, c.to).filter((p) => p.t === 'L').length, 0);
  return { prims, curves, stat };
}

// ===================== 検証: 元の曲線の各点から、置き換えた部品までの距離 =====================
function distToPrim(q, p) {
  if (p.t === 'L') { const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((q.x - p.a.x) * dx + (q.y - p.a.y) * dy) / L2)) : 0; return Math.hypot(q.x - (p.a.x + t * dx), q.y - (p.a.y + t * dy)); }
  if (p.t === 'C') return Math.abs(Math.hypot(q.x - p.cx, q.y - p.cy) - p.r);
  if (p.t === 'A') {
    const a = deg(Math.atan2(q.y - p.cy, q.x - p.cx)), span = ((p.a2 - p.a1) % 360 + 360) % 360, rel = ((a - p.a1) % 360 + 360) % 360;
    if (rel <= span + 1e-9) return Math.abs(Math.hypot(q.x - p.cx, q.y - p.cy) - p.r);
    const e1 = { x: p.cx + p.r * Math.cos(p.a1 * Math.PI / 180), y: p.cy + p.r * Math.sin(p.a1 * Math.PI / 180) }, e2 = { x: p.cx + p.r * Math.cos(p.a2 * Math.PI / 180), y: p.cy + p.r * Math.sin(p.a2 * Math.PI / 180) };
    return Math.min(dist(q, e1), dist(q, e2));
  }
  return Infinity;
}
// 種本は、曲線の点1つごとに、その曲線から出来た部品の全部と比べていた(手間が 点の数 × 部品の数。制御点 1000 個の曲線1本で 16 秒、2000 個では終わらない)。
//   部品が VERIFY_SMALL 個以下の曲線は、今までどおり全部と比べる(手元のメーカー DXF 8本はすべてこちら。いちばん大きい曲線で部品 52 個)。
//   それより多い曲線は、点も部品も曲線に沿って順に並んでいることを使う: 前の点でいちばん近かった部品の前後 VERIFY_WINDOW 個だけを見て、
//   許容ズレの2倍を超えた時だけ、見る範囲を4倍ずつ広げてやり直す(最後は全部)。だから「許容ズレの2倍を超えた曲線の数(over)」は、全部と比べた時と同じになる。
//   ズレの最大(worst)は、離れた場所を通る同じ曲線の別の部分のほうが近い点があると、種本より大きめに出ることがあり得る(小さく出ることは無く、許容ズレの2倍をまたぐことも無い)。検査に使った曲線では、自分と何度も交わる形を含めて全部が種本と同じ値だった。
//   広げてやり直す比較の回数には上限(maxDeviationScans)があり、使い切った後は狭い範囲だけで測る = ズレを大きめに見積もることはあっても、小さく見積もることは無い。
//   そうなった曲線の数を limited で返す(報告の deviationCheckLimited)
const VERIFY_SMALL = 256, VERIFY_WINDOW = 32;
function verify(prims, curves, limits) {
  let worst = 0, over = 0, limited = 0, spare = resolveLimits(limits).maxDeviationScans;
  for (const c of curves) {
    let m = 0, best = c.from, cut = false;
    const small = c.to - c.from <= VERIFY_SMALL;
    for (const q of c.pts) {
      let d = Infinity;
      if (small) { for (let i = c.from; i < c.to; i++) d = Math.min(d, distToPrim(q, prims[i])); }
      else {
        let lo = best, hi = best, w = VERIFY_WINDOW, bi = best;   // [lo, hi) = もう比べた範囲
        for (;;) {
          const lo2 = Math.max(c.from, best - w), hi2 = Math.min(c.to, best + w + 1);
          if (w > VERIFY_WINDOW) { const cost = (lo - lo2) + (hi2 - hi); if (cost > spare) { cut = true; break; } spare -= cost; }
          for (let i = lo2; i < lo; i++) { const v = distToPrim(q, prims[i]); if (v < d) { d = v; bi = i; } }
          for (let i = hi; i < hi2; i++) { const v = distToPrim(q, prims[i]); if (v < d) { d = v; bi = i; } }
          lo = lo2; hi = hi2;
          if (d <= TOL * 2 || (lo === c.from && hi === c.to)) break;
          w *= 4;
        }
        best = bi;
      }
      m = Math.max(m, d);
    }
    worst = Math.max(worst, m); if (m > TOL * 2) over++; if (cut) limited++;
  }
  return { worst, over, limited };
}

// ===================== 遠く離れた所のゴミを見つける =====================
function boxOf(p) {
  if (p.t === 'L') return [Math.min(p.a.x, p.b.x), Math.min(p.a.y, p.b.y), Math.max(p.a.x, p.b.x), Math.max(p.a.y, p.b.y)];
  if (p.t === 'C') return [p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r];
  if (p.t === 'A') {   // 円弧は「実際に描かれる部分」の範囲(中心が遠くにある、ほぼ真っすぐな円弧があるため)
    const span = ((p.a2 - p.a1) % 360 + 360) % 360, as = [p.a1, p.a2];
    for (const q of [0, 90, 180, 270]) if ((((q - p.a1) % 360) + 360) % 360 <= span) as.push(q);
    const xs = as.map((a) => p.cx + p.r * Math.cos(a * Math.PI / 180)), ys = as.map((a) => p.cy + p.r * Math.sin(a * Math.PI / 180));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (p.t === 'S') return [Math.min(...p.q.map((v) => v.x)), Math.min(...p.q.map((v) => v.y)), Math.max(...p.q.map((v) => v.x)), Math.max(...p.q.map((v) => v.y))];
  return [p.x, p.y, p.x, p.y];
}
function findOutliers(prims) {
  if (prims.length < 20) return { keep: prims, dropped: [], core: null };
  const cx = [], cy = [];
  for (const p of prims) { const b = boxOf(p); cx.push((b[0] + b[2]) / 2); cy.push((b[1] + b[3]) / 2); }
  const pct = (a, q) => { const s = a.slice().sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };
  const x0 = pct(cx, 0.02), x1 = pct(cx, 0.98), y0 = pct(cy, 0.02), y1 = pct(cy, 0.98);
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1), mg = 5 * Math.max(w, h);   // 図面の主要部の5倍より外にあるものだけを「遠く離れたゴミ」とみなす
  const core = [x0 - mg, y0 - mg, x1 + mg, y1 + mg], keep = [], dropped = [];
  for (const p of prims) { const b = boxOf(p); if (b[2] < core[0] || b[0] > core[2] || b[3] < core[1] || b[1] > core[3] || !b.every(isFinite)) dropped.push(p); else keep.push(p); }
  return { keep, dropped, core: [x0, y0, x1, y1] };
}

// ===================== 書き出し(Jw_cad 実機で確認済みの R12 の書式) =====================
function writeR12(prims, layerColors, recolor) {
  const fnum = (v) => { let s = (isFinite(v) ? v : 0).toFixed(5); while (s.indexOf('.') >= 0 && (s.endsWith('0') || s.endsWith('.'))) s = s.slice(0, -1); return s === '-0' || s === '' ? '0' : s; };
  const o = [], W = (c, v) => { o.push(String(c)); o.push(String(v)); };
  // 行がたまったら、その分だけ先にバイト列にして捨てる(全部の行を持ったまま最後に1本につなぐのと同じバイト列になる。メモリだけが違う)
  const sink = byteSink(); let bad = 0;
  const flush = () => { if (o.length) { bad += encodeInto(o.join(CRLF) + CRLF, sink); o.length = 0; } };
  const LTYPES = [{ name: 'CONTINUOUS', desc: 'Solid line', pat: [] }, { name: 'DASHED', desc: 'Dashed', pat: [12.7, -6.35] }, { name: 'CENTER', desc: 'Center', pat: [31.75, -6.35, 6.35, -6.35] },
    { name: 'PHANTOM', desc: 'Phantom', pat: [31.75, -6.35, 6.35, -6.35, 6.35, -6.35] }, { name: 'DOT', desc: 'Dot', pat: [0, -6.35] }];   // 標本と同じ定義(実機で 二点鎖線・点線 と確認済み)
  const layers = Array.from(new Set(['0'].concat(prims.map((p) => p.layer))));
  W(0, 'SECTION'); W(2, 'HEADER'); W(9, '$ACADVER'); W(1, 'AC1009'); W(0, 'ENDSEC');
  W(0, 'SECTION'); W(2, 'TABLES'); W(0, 'TABLE'); W(2, 'LTYPE'); W(70, LTYPES.length);
  for (const t of LTYPES) { W(0, 'LTYPE'); W(2, t.name); W(70, 0); W(3, t.desc); W(72, 65); W(73, t.pat.length); W(40, fnum(t.pat.reduce((s, v) => s + Math.abs(v), 0))); for (const v of t.pat) W(49, fnum(v)); }
  W(0, 'ENDTAB'); W(0, 'TABLE'); W(2, 'LAYER'); W(70, layers.length);
  for (const n of layers) { W(0, 'LAYER'); W(2, n); W(70, 0); W(62, whiteBg(mapColor((layerColors[n] || { col: 7 }).col), 'CONTINUOUS', recolor)); W(6, 'CONTINUOUS'); }
  W(0, 'ENDTAB'); W(0, 'ENDSEC'); W(0, 'SECTION'); W(2, 'ENTITIES');
  const n = { LINE: 0, ARC: 0, CIRCLE: 0, TEXT: 0, SOLID: 0, POINT: 0 };
  for (const p of prims) {
    if (p.t === 'L') { W(0, 'LINE'); W(8, p.layer); W(6, p.lt); W(62, p.col); W(10, fnum(p.a.x)); W(20, fnum(p.a.y)); W(11, fnum(p.b.x)); W(21, fnum(p.b.y)); n.LINE++; }
    else if (p.t === 'A') { W(0, 'ARC'); W(8, p.layer); W(6, p.lt); W(62, p.col); W(10, fnum(p.cx)); W(20, fnum(p.cy)); W(40, fnum(p.r)); W(50, fnum(p.a1)); W(51, fnum(p.a2)); n.ARC++; }
    else if (p.t === 'C') { W(0, 'CIRCLE'); W(8, p.layer); W(6, p.lt); W(62, p.col); W(10, fnum(p.cx)); W(20, fnum(p.cy)); W(40, fnum(p.r)); n.CIRCLE++; }
    else if (p.t === 'T') { W(0, 'TEXT'); W(8, p.layer); W(62, p.col); W(10, fnum(p.x)); W(20, fnum(p.y)); W(40, fnum(p.h)); W(1, p.s); if (Math.abs(p.rot) > 0.01 && Math.abs(p.rot - 360) > 0.01) W(50, fnum(p.rot)); if (p.wf && Math.abs(p.wf - 1) > 1e-6) W(41, fnum(p.wf)); n.TEXT++; }
    else if (p.t === 'S') { W(0, 'SOLID'); W(8, p.layer); W(62, p.col); ['10', '11', '12', '13'].forEach((c, i) => { W(c, fnum(p.q[i].x)); W(String(parseInt(c, 10) + 10), fnum(p.q[i].y)); }); n.SOLID++; }
    else if (p.t === 'P') { W(0, 'POINT'); W(8, p.layer); W(62, p.col); W(10, fnum(p.x)); W(20, fnum(p.y)); n.POINT++; }
    if (o.length >= 32768) flush();
  }
  W(0, 'ENDSEC'); W(0, 'EOF');
  flush();
  return { bytes: sink.bytes(), bad, n };
}

// ===================== 実行(ファイルの読み書きをしない形) =====================
const PRIMS_NOTE = 't: L=線 A=円弧(a1→a2 反時計回り・度) C=円 T=文字(x,y=左下 h=高さ rot=度 wf=幅係数) S=塗り(4点・DXFのSOLIDの並び) P=点。lt=CONTINUOUS|DASHED|CENTER|PHANTOM|DOT。aci=色相で寄せた後のDXF色番号(1赤2黄3緑4水5青6紫7黒8灰9薄灰30橙)。col=白背景用に黒灰へ替えた後の色';
// 確認用の絵のデータ(変換の前後を重ねて見るためのもの)
function buildDump(prims, curves, o) {
  const seg = (p) => {
    if (p.t === 'L') return [[p.a.x, p.a.y, p.b.x, p.b.y]];
    if (p.t === 'S') return [[p.q[0].x, p.q[0].y, p.q[1].x, p.q[1].y], [p.q[1].x, p.q[1].y, p.q[3].x, p.q[3].y], [p.q[3].x, p.q[3].y, p.q[2].x, p.q[2].y], [p.q[2].x, p.q[2].y, p.q[0].x, p.q[0].y]];
    if (p.t !== 'A' && p.t !== 'C') return [];
    const a1 = p.t === 'C' ? 0 : p.a1 * Math.PI / 180; let a2 = p.t === 'C' ? 2 * Math.PI : p.a2 * Math.PI / 180; while (a2 <= a1) a2 += 2 * Math.PI;
    const n = Math.max(8, Math.ceil((a2 - a1) / 0.05)), r = [];
    for (let i = 0; i < n; i++) { const u = a1 + (a2 - a1) * i / n, t = a1 + (a2 - a1) * (i + 1) / n; r.push([p.cx + p.r * Math.cos(u), p.cy + p.r * Math.sin(u), p.cx + p.r * Math.cos(t), p.cy + p.r * Math.sin(t)]); }
    return r;
  };
  const idx = new Set(); for (const c of curves) for (let i = c.from; i < c.to; i++) idx.add(prims[i]);
  const before = [], after = [], texts = [];
  for (const p of o.keep) { if (p.t === 'T') { texts.push([p.x, p.y, p.h, p.rot, p.s]); continue; } for (const q of seg(p)) { after.push(q.concat([p.col, p.lt === 'CONTINUOUS' ? 0 : 1])); if (!idx.has(p)) before.push(q); } }
  return { before, after, texts, dropped: o.dropped.length };
}
// 数値を「JSON に書いて読み直した時」と同じ形にそろえる(-0 → 0、有限でない値 → null)。
// こうしておくと、部品をメモリのまま JWW 書き出しへ渡しても、いったん JSON ファイルにしてから渡しても、同じ結果になる
function jsonClean(v) {
  const keys = Array.isArray(v) ? null : Object.keys(v), n = keys ? keys.length : v.length;
  for (let i = 0; i < n; i++) {
    const k = keys ? keys[i] : i, x = v[k];
    if (typeof x === 'number') { if (!isFinite(x)) v[k] = null; else if (x === 0) v[k] = 0; }
    else if (x && typeof x === 'object') jsonClean(x);
  }
  return v;
}
// DXF のバイト列 → { primsDoc(JWW 書き出し用の部品), report(報告), flatDxfBytes(Jw_cad が読める R12 の DXF), dump(確認用の絵。wantDump の時だけ) }
//   options: sourceName(報告と部品に入れる元ファイル名) / outName(報告に入れる出力名) / keepColors(true で白背景用の色替えをしない) / wantDump / limits(上限を変える時。LIMITS と同じ名前)
//   読めないファイル・上限超え・図形が1つも無い時は DxfError(message は利用者にそのまま見せてよい日本語)を投げる。空の結果を黙って返すことはない
function flattenDxf(bytes, options) {
  const opt = options || {}, recolor = !opt.keepColors;
  const srcName = opt.sourceName === undefined ? '' : String(opt.sourceName), outName = opt.outName === undefined ? '' : String(opt.outName);
  if (Object.prototype.toString.call(bytes) !== '[object Uint8Array]') throw new DxfError('DXF のデータが Uint8Array ではありません');
  const dxf = parseDxf(bytes);
  const { prims, curves, stat } = convert(dxf, recolor, opt.limits);
  const v = verify(prims, curves, opt.limits);
  const o = findOutliers(prims);
  if (!o.keep.length) {
    const seen = Object.keys(stat.from).map((k) => k + ' ' + stat.from[k] + '個'), lost = Object.keys(stat.skipped).map((k) => k + ' ' + stat.skipped[k] + '個');
    throw new DxfError('この DXF からは、変換できる図形が1つも取り出せませんでした' + (seen.length || lost.length ? '(読めた要素: ' + (seen.join('、') || 'なし') + ' / 読み飛ばした要素: ' + (lost.join('、') || 'なし') + ')' : ''));
  }
  const w = writeR12(o.keep, dxf.layers, recolor);
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of o.keep) { if (p.t === 'T' || p.t === 'P') continue; const b = boxOf(p); bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]; }
  const colors = {}, lts = Object.create(null);
  const lists = [dxf.entities];   // 図面本体 → 各ブロックの順(引数に展開して1本につなぐと、ブロックが十数万個ある時に呼び出しの深さの上限を超える)
  for (const b of dxf.blocks.values()) lists.push(b.list);
  for (const list of lists) for (const e of list) { const c = dxf.get(e, '62'); if (c && c !== '256' && parseInt(c, 10) > 0 && mapColor(parseInt(c, 10)) !== parseInt(c, 10)) colors[c + '→' + mapColor(parseInt(c, 10))] = (colors[c + '→' + mapColor(parseInt(c, 10))] || 0) + 1; const l = dxf.get(e, '6'); if (l && ['CONTINUOUS', 'DASHED', 'CENTER', 'PHANTOM', 'DOT', 'BYLAYER', 'BYBLOCK'].indexOf(l.toUpperCase()) < 0) lts[l] = (lts[l] || 0) + 1; }
  const report = { src: srcName, out: outName, version: dxf.ver, sizeKB: Math.round(w.bytes.length / 1024), sourceEntities: stat.from, unreadableByJww: stat.brokenByJww, skipped: stat.skipped,
    written: w.n, flatArcsToLines: stat.flatArcs || 0, curves: curves.length, arcsFromCurves: stat.arcsFromCurves, linesFromCurves: stat.linesFromCurves, worstDeviation: Math.round(v.worst * 100000) / 100000, curvesOverTolerance: v.over,
    farOutliersDropped: o.dropped.reduce((m, p) => { m[p.t] = (m[p.t] || 0) + 1; return m; }, {}), sizeAfter: [Math.round(bb[2] - bb[0]), Math.round(bb[3] - bb[1])], unencodableChars: w.bad, remappedColors: colors, remappedLinetypes: lts, whiteBackgroundRecolor: recolor,
    colorsWritten: o.keep.reduce((m, p) => { m[p.col] = (m[p.col] || 0) + 1; return m; }, {}) };
  // 下の2つは、あった時だけ報告に足す(無い時の報告は種本と同じ形のまま)
  if (v.limited) report.deviationCheckLimited = v.limited;   // ズレを測り切れなかった曲線の数(その曲線のズレは大きめに出ていることがある)
  if (stat.errors.length) report.entityErrors = stat.errors;   // 「値が不正」として読み飛ばした要素で起きた失敗の控え(先頭の5件)
  const dump = opt.wantDump ? buildDump(prims, curves, o) : null;
  // 座標は元の図面の単位(ふつうは実寸mm)。最後に JSON と同じ形へそろえる(報告・絵のデータを作った後で行う)
  const primsDoc = jsonClean({ source: srcName, bbox: bb, note: PRIMS_NOTE, prims: o.keep });
  return { primsDoc, report, flatDxfBytes: w.bytes, dump };
}

const api = { DxfError, LIMITS, flattenDxf, parseDxf, convert, verify, findOutliers, writeR12, mtextLines, mapColor, mapLt, cp932Table, encodeCP932, toBeziers, toBeziersSlow, evalSpline, simplify };
NS.dxfFlatten = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
