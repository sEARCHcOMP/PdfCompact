// jww-writer.js: Jw_cad の図面ファイル(JWW = MFC CArchive 形式)を読み書きする部品。ひな形ヘッダの解読と書き換え・図形の書き込み・読み直し・cp932 の符号化を受け持つ
// 種本: 手元の JWW 読み書きツール(Python)。同じ入力なら Python 版と1バイトも違わない出力になるように移した
//   わざと変えてあるのは2点だけ(どちらも Python 版が読めないファイルを作ってしまう所): 文字列長がちょうど 0xFFFE の時の書き方、Unicode 形式での BMP 外の文字の数え方
//   Python 版に無い機能: ひな形の登録(extractTemplateHeader)。利用者の図面からヘッダだけを取り出し、図面メモ・レイヤ名・レイヤグループ名を空にして作り直す(その図面の現場名などを、以後の書き出しに持ち越さないため)
// 注意: このファイルには逆スラッシュの表記を書かない。単一HTMLへそのまま貼り込めるよう、Node 専用の機能(fs・Buffer・require)も使わない
(function (root) {
  'use strict';
  const NS = root.P2D || (root.P2D = {});

  const MAGIC = [0x4A, 0x77, 0x77, 0x44, 0x61, 0x74, 0x61, 0x2E];   // 先頭8バイト「JwwData.」
  const MAX_ENTITY_COUNT = 10000000;   // 壊れたファイルの巨大な件数で暴走しないための上限
  const SUPPORTED_VERSION = 700;       // 書き出しに使えるひな形の形式(Jw_cad Ver.7 以降の保存形式)
  const REPLACEMENT = String.fromCharCode(0xFFFD);
  // Jw_cad がメモの無い図面に書く「図面メモ」の値(改行1つ)。自作標本3枚とも同じで、内蔵ひな形もこの値。登録するひな形のメモはこれに置き換える
  const BLANK_MEMO = String.fromCharCode(13, 10);

  class JwwError extends Error {
    constructor(message) { super(message); this.name = 'JwwError'; }
  }

  // =====================================================================
  // cp932(Shift_JIS)の符号化。ブラウザには Shift_JIS の TextEncoder が無いので、TextDecoder から逆引き表を作る
  //   Python の cp932 と全文字で同じバイト列になるようにしてある(check/run-checks.js が全数で突き合わせる)
  //   - 同じ文字に複数のバイト列がある時(NEC特殊文字・NEC選定IBM拡張・IBM拡張の重複)は、バイト列の小さい方 = 先に出てきた方を使う
  //   - 下の11文字は Python だけが符号化できる(片道の読み替えと、1バイトの特殊領域)ので、明示して足す
  // =====================================================================
  const CP932_PYTHON_ONLY = [
    [0x0080, [0x80]], [0x00A2, [0x81, 0x91]], [0x00A3, [0x81, 0x92]], [0x00AC, [0x81, 0xCA]],
    [0x2016, [0x81, 0x61]], [0x2212, [0x81, 0x7C]], [0x301C, [0x81, 0x60]],
    [0xF8F0, [0xA0]], [0xF8F1, [0xFD]], [0xF8F2, [0xFE]], [0xF8F3, [0xFF]]
  ];
  // 表が Python と同じ内容になっているかの指紋(FNV-1a 32ビット)。ブラウザの種類によって表が違っていたら、書き出しを止めるために使う
  //   値は「Python の cp932 と全数で一致した表」から計算したもの(run-checks.js が、この値と全数一致の両方を確かめる)
  const CP932_FINGERPRINT = 0x059FBCCD;
  let cpTables = null;

  function cp932Tables() {
    if (cpTables) return cpTables;
    const dec = new TextDecoder('shift_jis');
    const enc = new Map();   // 文字 → バイト列
    const fwd = new Map();   // 2バイトの符号(上位×256+下位) → 文字
    const two = new Uint8Array(2);
    for (let b = 0xA1; b <= 0xDF; b++) enc.set(String.fromCharCode(0xFEC0 + b), [b]);   // 半角カナ
    for (let lead = 0x81; lead <= 0xFC; lead++) {
      if (lead >= 0xA0 && lead <= 0xDF) continue;
      for (let trail = 0x40; trail <= 0xFC; trail++) {
        if (trail === 0x7F) continue;
        two[0] = lead; two[1] = trail;
        const ch = dec.decode(two);
        if (ch.length !== 1) continue;
        const code = ch.charCodeAt(0);
        if (code === 0xFFFD || code <= 0x80) continue;
        fwd.set(lead * 256 + trail, ch);
        if (!enc.has(ch)) enc.set(ch, [lead, trail]);
      }
    }
    for (const pair of CP932_PYTHON_ONLY) enc.set(String.fromCharCode(pair[0]), pair[1]);
    cpTables = { enc, fwd };
    return cpTables;
  }

  function cp932Fingerprint() {
    const t = cp932Tables();
    let h = 0x811C9DC5;
    const mix = (b) => { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; };
    const keys = Array.from(t.enc.keys()).sort();
    for (const k of keys) {
      const c = k.charCodeAt(0), b = t.enc.get(k);
      mix(c >> 8); mix(c & 255); mix(b.length);
      for (const x of b) mix(x);
    }
    for (let code = 0x8140; code <= 0xFCFC; code++) {
      const ch = t.fwd.get(code);
      if (ch === undefined) continue;
      const c = ch.charCodeAt(0);
      mix(code >> 8); mix(code & 255); mix(c >> 8); mix(c & 255);
    }
    return h >>> 0;
  }

  let selfCheckResult = null;
  function cp932SelfCheck() {
    if (selfCheckResult === null) selfCheckResult = cp932Fingerprint() === CP932_FINGERPRINT;
    return selfCheckResult;
  }

  // 1文字(コードポイント単位)が cp932 で書けるか
  function canEncodeCp932(ch) {
    const c = ch.codePointAt(0);
    if (c < 0x80) return true;
    return ch.length === 1 && cp932Tables().enc.has(ch);
  }

  // 文字列 → cp932 のバイト列。書けない文字は「?」にする(Python の errors="replace" と同じ)
  function encodeCp932(str) {
    const enc = cp932Tables().enc, out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) { out.push(c); continue; }
      const b = ch.length === 1 ? enc.get(ch) : undefined;
      if (b === undefined) { out.push(0x3F); continue; }
      for (let i = 0; i < b.length; i++) out.push(b[i]);
    }
    return Uint8Array.from(out);
  }

  // cp932 のバイト列 → 文字列。読めないバイトは1バイトごとに U+FFFD にする(Python の errors="replace" と同じ進み方)
  function decodeCp932(bytes, start, end) {
    const fwd = cp932Tables().fwd;
    const parts = [];
    let cur = '';
    let i = start === undefined ? 0 : start;
    const stop = end === undefined ? bytes.length : end;
    while (i < stop) {
      const c = bytes[i];
      if (c <= 0x80) { cur += String.fromCharCode(c); i += 1; }
      else if (c >= 0xA0 && c <= 0xDF) { cur += String.fromCharCode(c === 0xA0 ? 0xF8F0 : 0xFEC0 + c); i += 1; }
      else if (c >= 0xFD) { cur += String.fromCharCode(0xF8F1 + (c - 0xFD)); i += 1; }
      else if (i + 1 >= stop) { cur += REPLACEMENT; i += 1; }
      else {
        const ch = fwd.get(c * 256 + bytes[i + 1]);
        if (ch === undefined) { cur += REPLACEMENT; i += 1; } else { cur += ch; i += 2; }
      }
      if (cur.length >= 8192) { parts.push(cur); cur = ''; }
    }
    parts.push(cur);
    return parts.join('');
  }

  // =====================================================================
  // MFC CArchive 相当の読み手(jww_dump.py の ArReader)
  // =====================================================================
  class ArReader {
    constructor(bytes) {
      this.data = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
      // MFC の対応表: クラスもオブジェクトも同じ連番に入る。0番は NULL
      this.loadMap = [null];
      this.classSchemas = new Map();
      this.stringUnicode = false;   // 文字列が Unicode 形式で入っていたか
      // 書式の隅を実際に通ったかを検査で確かめるための数(件数の 0xFFFF 越え・大きいクラス番号のタグ・文字列長の書き方)
      this.seen = { countEscapes: 0, bigTags: 0, newClasses: 0, len8: 0, len16: 0, len32: 0 };
    }
    take(n) {
      if (n < 0) throw new JwwError('負の読み取り長 (' + n + ', offset=' + this.pos + ')');
      if (this.pos + n > this.data.length) throw new JwwError('ファイル終端を超えて読もうとした (offset=' + this.pos + ', 要求=' + n + ')');
      const p = this.pos;
      this.pos += n;
      return p;
    }
    u8() { return this.data[this.take(1)]; }
    u16() { return this.view.getUint16(this.take(2), true); }
    u32() { return this.view.getUint32(this.take(4), true); }
    i32() { return this.view.getInt32(this.take(4), true); }
    f64() { return this.view.getFloat64(this.take(8), true); }
    raw(n) { const p = this.take(n); return this.data.subarray(p, p + n); }
    readCount() {
      // CArchive::ReadCount: WORD、0xFFFF なら DWORD、さらに 0xFFFFFFFF なら QWORD
      const w = this.u16();
      if (w !== 0xFFFF) return w;
      this.seen.countEscapes++;
      const d = this.u32();
      if (d !== 0xFFFFFFFF) return d;
      const lo = this.u32(), hi = this.u32();
      return hi * 4294967296 + lo;
    }
    readString() {
      // CString の形式: BYTE長 / 0xFF+WORD長 / 0xFF+0xFFFF+DWORD長。0xFF+0xFFFE は Unicode(UTF-16)の印
      let charSize = 1, length;
      const b = this.u8();
      if (b === 0xFF) {
        let w = this.u16();
        const markAt = this.pos;
        if (w === 0xFFFE) {
          charSize = 2;
          this.stringUnicode = true;
          const b2 = this.u8();
          if (b2 < 0xFF) length = b2;
          else { w = this.u16(); length = w === 0xFFFF ? this.u32() : w; }
        } else if (w === 0xFFFF) length = this.u32();
        else length = w;
        const used = this.pos - markAt;
        if (used >= 4) this.seen.len32++; else if (used === 0 || used === 3) this.seen.len16++; else this.seen.len8++;
      } else { length = b; this.seen.len8++; }
      const p = this.take(length * charSize);
      if (charSize === 2) return decodeUtf16le(this.data, p, p + length * 2);
      return decodeCp932(this.data, p, p + length);
    }
    readObjectHeader() {
      // CArchive::ReadObject のタグ処理。戻り値は null(NULL オブジェクト)かクラス名
      const w = this.u16();
      let isClass, index;
      if (w === 0x7FFF) {   // 大きい番号用の32ビットのタグが続く
        this.seen.bigTags++;
        const tag = this.u32();
        isClass = tag >= 0x80000000;
        index = isClass ? tag - 0x80000000 : tag;
      } else {
        isClass = (w & 0x8000) !== 0;
        index = w & 0x7FFF;
      }
      if (!isClass) {
        if (index === 0) return null;
        throw new JwwError('既読オブジェクトへの参照(共有)は未対応 (offset=' + this.pos + ')');
      }
      if (w === 0xFFFF) {   // 新しいクラスの定義が続く
        const schema = this.u16();
        const nameLen = this.u16();
        const p = this.take(nameLen);
        let name = '';
        for (let i = 0; i < nameLen; i++) name += String.fromCharCode(this.data[p + i]);
        // クラス名は必ず英数字の識別子。違えば解析位置のずれ。読んだ中身(図面の内容かもしれない)はメッセージに入れない
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new JwwError('クラス名が不正 = 解析位置ずれの疑い (名前長' + nameLen + ', offset=' + this.pos + ')');
        this.loadMap.push({ cls: name });   // クラスが先に番号を取り
        this.loadMap.push(null);            // 続けてオブジェクト本体
        this.classSchemas.set(name, schema);
        this.seen.newClasses++;
        return name;
      }
      if (index >= this.loadMap.length) throw new JwwError('クラス参照が範囲外 (index=' + index + ', offset=' + this.pos + ')');
      const entry = this.loadMap[index];
      if (!entry) throw new JwwError('クラス参照先がクラスでない (index=' + index + ', offset=' + this.pos + ')');
      this.loadMap.push(null);
      return entry.cls;
    }
  }

  let utf16Decoder = null;
  function decodeUtf16le(bytes, start, end) {
    // 対になっていないサロゲートは U+FFFD にする(Python の errors="replace" と同じ)。先頭の BOM は文字として残す
    if (!utf16Decoder) utf16Decoder = new TextDecoder('utf-16le', { ignoreBOM: true });
    return utf16Decoder.decode(bytes.subarray(start, end));
  }

  // =====================================================================
  // 図形の読み取り(jww_dump.py の read_*)。キー名は Python 版の dict と同じにしてある
  // =====================================================================
  function readBase(ar, version) {
    const d = {};
    d.group = ar.u32();
    d.pen_style = ar.u8();
    d.pen_color = ar.u16();
    d.pen_width = version >= 351 ? ar.u16() : 0;
    d.layer = ar.u16();
    d.glayer = ar.u16();
    d.flags = ar.u16();
    return d;
  }
  function readSen(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'line';
    d.x1 = ar.f64(); d.y1 = ar.f64(); d.x2 = ar.f64(); d.y2 = ar.f64();
    return d;
  }
  function readEnko(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'arc';
    d.cx = ar.f64(); d.cy = ar.f64(); d.radius = ar.f64();
    d.start_rad = ar.f64(); d.arc_rad = ar.f64(); d.tilt_rad = ar.f64(); d.flatness = ar.f64();
    d.full_circle = ar.u32();
    return d;
  }
  function readTen(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'point';
    d.x = ar.f64(); d.y = ar.f64();
    d.kariten = ar.u32();
    if (d.pen_style === 100) { d.marker_code = ar.u32(); d.marker_rad = ar.f64(); d.marker_scale = ar.f64(); }
    return d;
  }
  function readMoji(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'text';
    d.x1 = ar.f64(); d.y1 = ar.f64(); d.x2 = ar.f64(); d.y2 = ar.f64();
    d.moji_shu = ar.u32();
    d.size_x = ar.f64(); d.size_y = ar.f64(); d.kankaku = ar.f64(); d.kakudo_deg = ar.f64();
    d.font = ar.readString();
    d.text = ar.readString();
    return d;
  }
  function readSunpou(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'dim';
    d.sen = readSen(ar, version);
    d.moji = readMoji(ar, version);
    if (version >= 420) {
      d.sxf_mode = ar.u16();
      d.sen_ho1 = readSen(ar, version); d.sen_ho2 = readSen(ar, version);
      d.ten1 = readTen(ar, version); d.ten2 = readTen(ar, version);
      d.ten_ho1 = readTen(ar, version); d.ten_ho2 = readTen(ar, version);
    }
    return d;
  }
  function readSolid(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'solid';
    d.x1 = ar.f64(); d.y1 = ar.f64(); d.x2 = ar.f64(); d.y2 = ar.f64();
    d.x3 = ar.f64(); d.y3 = ar.f64(); d.x4 = ar.f64(); d.y4 = ar.f64();
    if (d.pen_color === 10) d.rgb = ar.u32();
    return d;
  }
  function readBlockRef(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'block_ref';
    d.x = ar.f64(); d.y = ar.f64(); d.scale_x = ar.f64(); d.scale_y = ar.f64(); d.rotate_rad = ar.f64();
    d.block_number = ar.u32();
    return d;
  }
  function readBlockDef(ar, version) {
    const d = readBase(ar, version);
    d.kind = 'block_def';
    d.number = ar.i32();
    d.referred = ar.u32();
    d.time_bytes = ar.raw(8);
    d.name = ar.readString();
    d.entities = readEntityList(ar, version, false);
    return d;
  }
  const ENTITY_READERS = {
    CDataSen: readSen, CDataEnko: readEnko, CDataTen: readTen, CDataMoji: readMoji,
    CDataSunpou: readSunpou, CDataSolid: readSolid, CDataBlock: readBlockRef
  };
  function readEntityList(ar, version, allowDataList) {
    const count = ar.readCount();
    if (count > MAX_ENTITY_COUNT) throw new JwwError('図形の件数が異常 (' + count + '個, offset=' + ar.pos + ')');
    const entities = [];
    for (let i = 0; i < count; i++) {
      const name = ar.readObjectHeader();
      if (name === null) continue;
      if (Object.prototype.hasOwnProperty.call(ENTITY_READERS, name)) entities.push(ENTITY_READERS[name](ar, version));
      else if (name === 'CDataList' && allowDataList) entities.push(readBlockDef(ar, version));
      else throw new JwwError('未対応のクラス ' + name + ' (' + (i + 1) + '個目, offset=' + ar.pos + ')');
    }
    return entities;
  }

  // =====================================================================
  // ヘッダの並び(jww_dump.py の header_layout をそのまま移した。読み書き共通のただ1つの定義)
  //   戻り値は [キー, 型('str'|'u32'|'f64'), 個数] の列。先頭のバージョン(u32)は含めない
  // =====================================================================
  function headerLayout(version) {
    const L = [];
    const add = (key, kind, n) => { L.push([key, kind, n === undefined ? 1 : n]); };
    add('memo', 'str');
    add('paper_size', 'u32');
    add('write_glayer', 'u32');
    for (let g = 0; g < 16; g++) {
      add('glay_state_' + g, 'u32');
      add('glay_write_layer_' + g, 'u32');
      add('scale_' + g, 'f64');
      add('glay_protect_' + g, 'u32');
      for (let l = 0; l < 16; l++) {
        add('lay_state_' + g + '_' + l, 'u32');
        add('lay_protect_' + g + '_' + l, 'u32');
      }
    }
    add('dummy_a', 'u32', 14);
    add('sunpou_settings', 'u32', 5);
    add('dummy_b', 'u32');
    add('line_width_max', 'u32');
    add('prt_genten', 'f64', 2);
    add('prt_bairitsu', 'f64');
    add('prt_set', 'u32');
    add('memori_mode', 'u32');
    add('memori_hyouji_min', 'f64');
    add('memori', 'f64', 4);
    for (let g = 0; g < 16; g++) add('lay_names_' + g, 'str', 16);
    add('glay_names', 'str', 16);
    add('kage_level', 'f64');
    add('kage_ido', 'f64');
    add('kage_flg', 'u32');
    add('kabe_kage_level', 'f64');
    if (version >= 300) add('tenkuu', 'f64', 2);
    add('mm_tani_3d', 'u32');
    add('bairitsu', 'f64');
    add('genten', 'f64', 2);
    add('hanni_bairitsu', 'f64');
    add('hanni_genten', 'f64', 2);
    if (version >= 300) {
      for (let i = 0; i < 8; i++) { add('zoom_jump_' + i, 'f64', 3); add('zoom_jump_glay_' + i, 'u32'); }
    } else {
      for (let i = 0; i < 4; i++) add('zoom_jump_' + i, 'f64', 3);
    }
    if (version >= 300) {
      add('dummy_c', 'f64', 3);
      add('dummy_d', 'u32');
      add('dummy_e', 'f64', 2);
      add('moji_bg', 'f64');
      add('moji_bg_mode', 'u32');
    }
    add('fukusen', 'f64', 10);
    add('ryogawa_fukusen_tome', 'f64');
    for (let i = 0; i < 10; i++) { add('pen_color_' + i, 'u32'); add('pen_width_' + i, 'u32'); }
    for (let i = 0; i < 10; i++) { add('prt_pen_color_' + i, 'u32'); add('prt_pen_width_' + i, 'u32'); add('prt_ten_hankei_' + i, 'f64'); }
    for (let i = 0; i < 8; i++) add('ltype_' + i, 'u32', 4);
    for (let i = 0; i < 5; i++) add('ltype_rnd_' + i, 'u32', 5);
    for (let i = 0; i < 4; i++) add('ltype_double_' + i, 'u32', 4);
    add('draw_flags', 'u32', 11);
    if (version >= 223) {
      add('draw_time', 'u32');
      add('eye_init', 'u32');
      add('eye_h', 'u32', 3);
      add('eye_f', 'f64', 5);
    }
    if (version >= 225) add('last_values', 'f64', 4);
    if (version >= 230) { add('solid_ninni_color', 'u32'); add('solid_color', 'u32'); }
    if (version >= 420) {
      for (let i = 0; i < 257; i++) add('sxf_pen_' + i, 'u32', 2);
      for (let i = 0; i < 257; i++) { add('sxf_color_name_' + i, 'str'); add('sxf_prt_' + i, 'u32', 2); add('sxf_prt_ten_' + i, 'f64'); }
      for (let i = 0; i < 33; i++) add('sxf_ltype_' + i, 'u32', 4);
      for (let i = 0; i < 33; i++) { add('sxf_ltype_name_' + i, 'str'); add('sxf_ltype_seg_' + i, 'u32'); add('sxf_ltype_pitch_' + i, 'f64', 10); }
    }
    for (let i = 0; i < 10; i++) { add('moji_x_' + i, 'f64'); add('moji_y_' + i, 'f64'); add('moji_d_' + i, 'f64'); add('moji_col_' + i, 'u32'); }
    add('write_moji_size', 'f64', 3);
    add('write_moji_color', 'u32');
    add('write_moji_shu', 'u32');
    add('moji_seiri', 'f64', 2);
    add('moji_kijun_zure_on', 'u32');
    add('moji_kijun_zure', 'f64', 6);
    return L;
  }

  // ヘッダを読む。各項目は { key, kind, n, vals(値の配列), start, end(ファイル内の位置) }。
  // 数値の項目は書き戻す時に元のバイトをそのまま写すので、位置も覚えておく
  function readHeader(ar) {
    const version = ar.u32();
    const fields = [], index = new Map();
    for (const item of headerLayout(version)) {
      const kind = item[1], n = item[2], start = ar.pos, vals = [];
      for (let i = 0; i < n; i++) vals.push(kind === 'str' ? ar.readString() : kind === 'f64' ? ar.f64() : ar.u32());
      const f = { key: item[0], kind, n, vals, start, end: ar.pos };
      fields.push(f);
      index.set(f.key, f);
    }
    return { version, fields, index };
  }

  function checkMagic(ar) {
    const m = ar.raw(8);
    for (let i = 0; i < 8; i++) if (m[i] !== MAGIC[i]) throw new JwwError('JWWファイルではありません(先頭の目印が違います)');
  }

  // ファイル全体を読む(jww_dump.py の parse_jww_bytes)。書いたデータの読み直し検査と、ひな形登録時の確認に使う
  function parseJww(bytes) {
    const ar = new ArReader(bytes);
    checkMagic(ar);
    const header = readHeader(ar);
    const headerEnd = ar.pos;
    const version = header.version;
    if (version < 420) throw new JwwError('フォーマット Ver' + version + ' は未対応(Ver4.20 以降のみ)');
    const entities = readEntityList(ar, version, false);
    for (let i = 0; i < entities.length; i++) entities[i].id = 'E-' + String(i + 1).padStart(4, '0');
    const blockDefs = readEntityList(ar, version, true);
    const images = [];
    if (version >= 700) {
      const nImage = ar.i32();
      if (nImage < 0 || nImage > 100000) throw new JwwError('画像の件数が異常 (' + nImage + '個, offset=' + ar.pos + ')');
      for (let i = 0; i < nImage; i++) {
        const name = ar.readString();
        const size = ar.i32();
        if (size < 0) throw new JwwError('画像のサイズが異常 (' + size + ', offset=' + ar.pos + ')');
        images.push({ name, size, data: ar.raw(size) });
      }
    }
    return {
      header, headerEnd, entities, blockDefs, images,
      classSchemas: ar.classSchemas, stringUnicode: ar.stringUnicode, seen: ar.seen,
      trailingBytes: bytes.length - ar.pos
    };
  }

  // =====================================================================
  // ひな形(ヘッダだけを使う)
  // =====================================================================
  // Uint8Array かどうか(別の窓や枠で作られた配列でも通るように、型の名前で見る)
  const isBytes = (v) => Object.prototype.toString.call(v) === '[object Uint8Array]';
  // ひな形を読む。渡すのは「ヘッダだけを取り出したバイト列」でも「JWWファイル全体」でもよい(使うのはヘッダまで)
  function loadTemplate(bytes) {
    if (!isBytes(bytes)) throw new JwwError('ひな形のデータが Uint8Array ではありません');
    const ar = new ArReader(bytes);
    checkMagic(ar);
    const header = readHeader(ar);
    if (header.version !== SUPPORTED_VERSION) throw new JwwError('このひな形は保存形式が Ver' + header.version + ' です。Jw_cad Ver.7 以降で保存し直したファイル(形式 700)だけが使えます');
    return { version: header.version, fields: header.fields, index: header.index, headerEnd: ar.pos, stringUnicode: ar.stringUnicode, bytes: bytes.subarray(0, ar.pos) };
  }

  // 登録用: JWWファイル全体を最後まで読んで確かめてから、ヘッダ部分だけのバイト列を返す(図形・ブロック・画像は含まない)。
  //   利用者は手近な実物件の図面を登録することが多い。そのヘッダには 図面メモ・レイヤ名・レイヤグループ名(現場名や施主名が入りやすい)があり、
  //   そのまま保存すると、以後に書き出す全部の JWW(社外へ渡すメーカー部品の図面も)にそれが入ってしまう。
  //   そこで登録の時点で、メモは BLANK_MEMO に、レイヤ名 16×16 個とレイヤグループ名 16 個は空にして、ヘッダを作り直す(内蔵ひな形と同じ状態)。
  //   残す文字列は SXF の色名・線種名だけ(線色・線幅・印刷・寸法などの設定は数値なので、元のバイトのまま残る)。文字列の形式(ANSI / Unicode)は元のファイルのまま。
  //   保存するのは必ずこの戻り値にすること(convert にファイル全体を渡すと、Python 版と同じく、メモとレイヤ名がそのまま持ち越される)
  function extractTemplateHeader(fileBytes) {
    if (!isBytes(fileBytes)) throw new JwwError('ひな形のデータが Uint8Array ではありません');
    const doc = parseJww(fileBytes);
    if (doc.header.version !== SUPPORTED_VERSION) throw new JwwError('このファイルは保存形式が Ver' + doc.header.version + ' です。Jw_cad Ver.7 以降で保存し直したファイル(形式 700)だけが登録できます');
    if (doc.trailingBytes !== 0) throw new JwwError('このファイルは最後まで読み切れませんでした(読み残し ' + doc.trailingBytes + ' バイト)。登録できません');
    const blank = new Map([['memo', [BLANK_MEMO]], ['glay_names', new Array(16).fill('')]]);
    for (let g = 0; g < 16; g++) blank.set('lay_names_' + g, new Array(16).fill(''));
    const aw = new ArWriter(doc.stringUnicode);
    writeHeader(aw, { version: doc.header.version, fields: doc.header.fields, bytes: fileBytes }, blank);
    return aw.result();
  }

  // 画面の線色表(0=背景 1〜8=線色 9=グレー)を [赤, 緑, 青] で返す
  function paletteOf(template) {
    const out = [];
    for (let i = 0; i < 10; i++) {
      const c = template.index.get('pen_color_' + i).vals[0];
      out.push([c & 255, (c >>> 8) & 255, (c >>> 16) & 255]);
    }
    return out;
  }

  // =====================================================================
  // MFC CArchive 相当の書き手(jww_write.py の ArWriter)
  // =====================================================================
  class ArWriter {
    constructor(stringUnicode) {
      this.buf = new Uint8Array(1 << 16);
      this.view = new DataView(this.buf.buffer);
      this.pos = 0;
      this.mapIndex = 1;   // 読み手の loadMap と同じ採番。0番は NULL、クラスとオブジェクトが同じ連番を使う
      this.classIndex = new Map();
      this.stringUnicode = !!stringUnicode;
    }
    room(n) {
      if (this.pos + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.pos + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    u8(v) { this.room(1); this.buf[this.pos] = v & 0xFF; this.pos += 1; }
    u16(v) { this.room(2); this.view.setUint16(this.pos, v & 0xFFFF, true); this.pos += 2; }
    u32(v) { this.room(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
    i32(v) { this.room(4); this.view.setInt32(this.pos, v, true); this.pos += 4; }
    f64(v) { this.room(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; }
    raw(bytes) { this.room(bytes.length); this.buf.set(bytes, this.pos); this.pos += bytes.length; }
    writeCount(n) {
      // CArchive::WriteCount。0xFFFF 以上は 0xFFFF の後に DWORD
      if (n < 0xFFFF) this.u16(n);
      else if (n < 0xFFFFFFFF) { this.u16(0xFFFF); this.u32(n); }
      else throw new JwwError('件数が大きすぎます');
    }
    writeString(s) {
      // Unicode 形式は 0xFF + 0xFFFE + 長さ(文字数) + UTF-16LE。ANSI 形式は 長さ(バイト数) + cp932
      let body, n;
      if (this.stringUnicode) {
        this.u8(0xFF); this.u16(0xFFFE);
        body = encodeUtf16le(s);
        n = body.length / 2;
      } else {
        body = encodeCp932(s);
        n = body.length;
      }
      if (n < 0xFF) this.u8(n);
      else if (n < 0xFFFE) { this.u8(0xFF); this.u16(n); }   // MFC(AfxWriteStringLength)と同じ境目。0xFFFE は Unicode の印なので長さには使えない
      else { this.u8(0xFF); this.u16(0xFFFF); this.u32(n); }
      this.raw(body);
    }
    writeObjectHeader(name, schema) {
      // CArchive::WriteObject のタグ処理
      const known = this.classIndex.get(name);
      if (known === undefined) {
        this.u16(0xFFFF); this.u16(schema); this.u16(name.length);
        for (let i = 0; i < name.length; i++) this.u8(name.charCodeAt(i));
        this.classIndex.set(name, this.mapIndex);   // クラスが先に番号を取り
        this.mapIndex += 2;                          // 続けてオブジェクト本体
        return;
      }
      if (known < 0x7FFF) this.u16(0x8000 | known);
      else { this.u16(0x7FFF); this.u32(0x80000000 + known); }   // 番号が大きい時は32ビットのタグ
      this.mapIndex += 1;
    }
    result() { return this.buf.slice(0, this.pos); }
  }

  // 文字列 → UTF-16LE。長さは MFC と同じく UTF-16 の単位数で数える(Python 版はコードポイント数で数えるので、BMP 外の文字があると食い違う。その時は MFC に合わせたこちらが正しい)
  function encodeUtf16le(s) {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      // 対になっていないサロゲートは「?」にする(Python の errors="replace" と同じ)
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (next >= 0xDC00 && next <= 0xDFFF) { out[i * 2] = c & 255; out[i * 2 + 1] = c >> 8; i++; c = next; }
        else c = 0x3F;
      } else if (c >= 0xDC00 && c <= 0xDFFF) c = 0x3F;
      out[i * 2] = c & 255; out[i * 2 + 1] = c >> 8;
    }
    return out;
  }

  // =====================================================================
  // 図形の書き込み(jww_write.py の write_*)。線・円弧・点・文字・塗りの5種類
  // =====================================================================
  function writeBase(aw, d, version) {
    aw.u32(d.group); aw.u8(d.pen_style); aw.u16(d.pen_color);
    if (version >= 351) aw.u16(d.pen_width);
    aw.u16(d.layer); aw.u16(d.glayer); aw.u16(d.flags);
  }
  function writeSen(aw, d, version) {
    writeBase(aw, d, version);
    aw.f64(d.x1); aw.f64(d.y1); aw.f64(d.x2); aw.f64(d.y2);
  }
  function writeEnko(aw, d, version) {
    writeBase(aw, d, version);
    aw.f64(d.cx); aw.f64(d.cy); aw.f64(d.radius); aw.f64(d.start_rad); aw.f64(d.arc_rad); aw.f64(d.tilt_rad); aw.f64(d.flatness);
    aw.u32(d.full_circle);
  }
  function writeTen(aw, d, version) {
    writeBase(aw, d, version);
    aw.f64(d.x); aw.f64(d.y); aw.u32(d.kariten);
    if (d.pen_style === 100) { aw.u32(d.marker_code); aw.f64(d.marker_rad); aw.f64(d.marker_scale); }
  }
  function writeMoji(aw, d, version) {
    writeBase(aw, d, version);
    aw.f64(d.x1); aw.f64(d.y1); aw.f64(d.x2); aw.f64(d.y2);
    aw.u32(d.moji_shu);
    aw.f64(d.size_x); aw.f64(d.size_y); aw.f64(d.kankaku); aw.f64(d.kakudo_deg);
    aw.writeString(d.font);
    aw.writeString(d.text);
  }
  function writeSolid(aw, d, version) {
    writeBase(aw, d, version);
    aw.f64(d.x1); aw.f64(d.y1); aw.f64(d.x2); aw.f64(d.y2); aw.f64(d.x3); aw.f64(d.y3); aw.f64(d.x4); aw.f64(d.y4);
    if (d.pen_color === 10) aw.u32(d.rgb);
  }
  const ENTITY_WRITERS = {
    line: ['CDataSen', writeSen], arc: ['CDataEnko', writeEnko], point: ['CDataTen', writeTen],
    text: ['CDataMoji', writeMoji], solid: ['CDataSolid', writeSolid]
  };
  function writeEntityList(aw, entities, version, schema) {
    aw.writeCount(entities.length);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!Object.prototype.hasOwnProperty.call(ENTITY_WRITERS, e.kind)) throw new JwwError('書き込み未対応の種別 ' + e.kind);
      const w = ENTITY_WRITERS[e.kind];
      aw.writeObjectHeader(w[0], schema);
      w[1](aw, e, version);
    }
  }

  // ひな形のヘッダ + 図形の列 → JWW のバイト列(jww_write.py の build_jww)。
  //   patch: ヘッダの書き換え。キー → 値の配列(その項目の全個数ぶん)。ここに無い項目は、数値なら元のバイトのまま、文字列なら読んだ文字列を書き直す
  //   options.stringUnicode: 文字列を Unicode 形式で書くか(既定は ANSI = Python の build_doc と同じ)
  //   options.classSchema: クラスのスキーマ番号(既定 700)
  function buildJww(template, patch, entities, options) {
    const opt = options || {};
    const version = template.version;
    const aw = new ArWriter(!!opt.stringUnicode);
    writeHeader(aw, template, patch);
    writeEntityList(aw, entities, version, opt.classSchema === undefined ? 700 : opt.classSchema);
    writeEntityList(aw, [], version, 700);   // ブロック定義は無し
    if (version >= 700) aw.i32(0);           // 画像は無し
    return aw.result();
  }

  // 先頭の目印・バージョン・ヘッダの全項目を書く(buildJww と、ひな形の登録 extractTemplateHeader が使う)。template は { version, fields, bytes }
  function writeHeader(aw, template, patch) {
    aw.raw(Uint8Array.from(MAGIC));
    aw.u32(template.version);
    for (const f of template.fields) {
      const vals = patch && patch.has(f.key) ? patch.get(f.key) : null;
      if (vals !== null && vals.length !== f.n) throw new JwwError('ヘッダ項目 ' + f.key + ' の個数が不正 (' + vals.length + '/' + f.n + ')');
      if (f.kind === 'str') { const src = vals === null ? f.vals : vals; for (let i = 0; i < f.n; i++) aw.writeString(src[i]); }
      else if (vals === null) aw.raw(template.bytes.subarray(f.start, f.end));
      else if (f.kind === 'f64') for (let i = 0; i < f.n; i++) aw.f64(vals[i]);
      else for (let i = 0; i < f.n; i++) aw.u32(vals[i]);
    }
  }

  const api = {
    JwwError, SUPPORTED_VERSION, BLANK_MEMO,
    cp932Tables, cp932Fingerprint, cp932SelfCheck, CP932_FINGERPRINT, canEncodeCp932, encodeCp932, decodeCp932,
    headerLayout, parseJww, loadTemplate, extractTemplateHeader, paletteOf, buildJww
  };
  NS.jwwWriter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
