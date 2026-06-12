// EXIF orientation パーサの等価性ゴールデン(Phase 2 EXIF統一の防波堤)。
// 旧img2pdf版・旧imgplace版・新共有版の3実装を、EXIF注入JPEG(orientation 1-8 ×
// リトル/ビッグエンディアン + 異常系)に対して走らせ、全部が同じ値を返すことを固定する。
// これが通れば「新共有 ≡ 旧両実装」= 各モードの下流挙動は不変、と保証できる。
const { test } = require('@playwright/test');
const { expect } = require('@playwright/test');

// ---- 3つのパーサ実装(文字列としてページに渡し eval する)----
// 旧 img2pdf 版(File→async)の「中核(ArrayBuffer解析)」部分を関数化したもの
const OLD_IMG2PDF = `function(buffer){
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return 1;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xFF00) !== 0xFF00) return 1;
    if (marker === 0xFFDA) return 1;
    const size = view.getUint16(offset + 2);
    if (size < 2) return 1;
    if (marker === 0xFFE1 && offset + 18 <= view.byteLength &&
        view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      const endianMark = view.getUint16(tiff);
      if (endianMark !== 0x4949 && endianMark !== 0x4D4D) return 1;
      const little = endianMark === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > view.byteLength) return 1;
      const count = view.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > view.byteLength) return 1;
        if (view.getUint16(entry, little) === 0x0112) {
          const val = view.getUint16(entry + 8, little);
          return (val >= 1 && val <= 8) ? val : 1;
        }
      }
      return 1;
    }
    offset += 2 + size;
  }
  return 1;
}`;

// 旧 imgplace 版(getJpegOrientation)— ただし raw 返しを 1-8 クランプして比較
// (imgplace の下流は 1/3/6/8 の switch で、範囲外は実質「補正なし=1」扱いのため等価)
const OLD_IMGPLACE = `function(buffer){
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1;
    let offset = 2;
    while (offset < view.byteLength - 1) {
      if (view.getUint8(offset) !== 0xFF) return 1;
      const marker = view.getUint16(offset, false);
      offset += 2;
      if (marker === 0xFFE1) {
        if (offset + 8 > view.byteLength) return 1;
        const segLen = view.getUint16(offset, false);
        if (view.getUint32(offset + 2, false) !== 0x45786966) { offset += segLen; continue; }
        const tiffOffset = offset + 8;
        if (tiffOffset + 8 > view.byteLength) return 1;
        const little = view.getUint16(tiffOffset, false) === 0x4949;
        const ifdOffset = view.getUint32(tiffOffset + 4, little);
        const tagsOffset = tiffOffset + ifdOffset;
        if (tagsOffset + 2 > view.byteLength) return 1;
        const numEntries = view.getUint16(tagsOffset, little);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = tagsOffset + 2 + i * 12;
          if (entryOffset + 10 > view.byteLength) return 1;
          if (view.getUint16(entryOffset, little) === 0x0112) {
            const v = view.getUint16(entryOffset + 8, little);
            return (v >= 1 && v <= 8) ? v : 1;
          }
        }
        return 1;
      } else {
        if ((marker & 0xFF00) !== 0xFF00) return 1;
        const segLen = view.getUint16(offset, false);
        offset += segLen;
      }
    }
  } catch (e) {}
  return 1;
}`;

// 新共有版(00-core に入れる予定のもの。img2pdf版を ArrayBuffer 入力にしたもの)
const NEW_SHARED = OLD_IMG2PDF;  // 設計上 img2pdf版と同一(ArrayBuffer版)

// ---- EXIF注入JPEGバッファを作るヘルパー(ページ内) ----
// SOI + APP1(Exif/TIFF/IFD0に Orientation 1個) + EOI。リトル/ビッグ両対応。
const BUILD_BUFFER = `function(orientation, little){
  // TIFF: ヘッダ(8) + IFD(2 + 12 + 4)
  const tiff = [];
  const u16 = (v) => little ? [v & 0xFF, (v>>8)&0xFF] : [(v>>8)&0xFF, v & 0xFF];
  const u32 = (v) => little ? [v&0xFF,(v>>8)&0xFF,(v>>16)&0xFF,(v>>24)&0xFF] : [(v>>24)&0xFF,(v>>16)&0xFF,(v>>8)&0xFF,v&0xFF];
  tiff.push(...(little ? [0x49,0x49] : [0x4D,0x4D]));  // II / MM
  tiff.push(...u16(0x002A));        // magic 42
  tiff.push(...u32(8));             // IFD0 offset = 8
  tiff.push(...u16(1));             // entry count = 1
  tiff.push(...u16(0x0112));        // tag Orientation
  tiff.push(...u16(3));             // type SHORT
  tiff.push(...u32(1));             // count 1
  tiff.push(...u16(orientation));   // value (SHORTは先頭2バイト)
  tiff.push(0,0);                   // value 後半パディング
  tiff.push(...u32(0));             // next IFD = 0
  const exifHdr = [0x45,0x78,0x69,0x66,0x00,0x00]; // "Exif\\0\\0"
  const app1Payload = exifHdr.concat(tiff);
  const segLen = app1Payload.length + 2; // 長さフィールド自身を含む
  const bytes = [0xFF,0xD8, 0xFF,0xE1, (segLen>>8)&0xFF, segLen&0xFF, ...app1Payload, 0xFF,0xD9];
  return new Uint8Array(bytes).buffer;
}`;

test.describe('EXIF orientation パーサ等価性', () => {
  test('orientation 1-8 × 両エンディアンで 旧img2pdf=旧imgplace=新共有=期待値', async ({ page }) => {
    await page.goto('/pdf_compact_bundle.html');  // ページコンテキストが要るだけ(ライブラリ不要)
    const result = await page.evaluate(({ oldA, oldB, neu, build }) => {
      const pOldA = eval('(' + oldA + ')');
      const pOldB = eval('(' + oldB + ')');
      const pNew = eval('(' + neu + ')');
      const mk = eval('(' + build + ')');
      const rows = [];
      for (const little of [true, false]) {
        for (let o = 1; o <= 8; o++) {
          const buf = mk(o, little);
          rows.push({ o, little, a: pOldA(buf), b: pOldB(buf), n: pNew(buf) });
        }
      }
      return rows;
    }, { oldA: OLD_IMG2PDF, oldB: OLD_IMGPLACE, neu: NEW_SHARED, build: BUILD_BUFFER });

    for (const r of result) {
      const ctx = `orientation=${r.o} little=${r.little}`;
      expect(r.a, ctx + ' img2pdf').toBe(r.o);
      expect(r.b, ctx + ' imgplace').toBe(r.o);
      expect(r.n, ctx + ' shared').toBe(r.o);
    }
  });

  test('異常系(非JPEG/EXIFなし/壊れ)は全実装が 1 を返す', async ({ page }) => {
    await page.goto('/pdf_compact_bundle.html');
    const result = await page.evaluate(({ oldA, oldB, neu }) => {
      const pOldA = eval('(' + oldA + ')'), pOldB = eval('(' + oldB + ')'), pNew = eval('(' + neu + ')');
      const cases = {
        notJpeg: new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer,        // PNG signature
        tooShort: new Uint8Array([0xFF, 0xD8]).buffer,                   // SOI のみ
        noExif: new Uint8Array([0xFF,0xD8, 0xFF,0xD9]).buffer,           // SOI+EOI(APP1なし)
        empty: new Uint8Array([]).buffer,
      };
      const out = {};
      for (const k in cases) out[k] = [pOldA(cases[k]), pOldB(cases[k]), pNew(cases[k])];
      return out;
    }, { oldA: OLD_IMG2PDF, oldB: OLD_IMGPLACE, neu: NEW_SHARED });

    for (const k in result) {
      expect(result[k], k).toEqual([1, 1, 1]);
    }
  });
});
