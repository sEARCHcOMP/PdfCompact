// 現場写真風ダミー画像生成 (pure JS、外部 native 依存なし)
// 照明器具表枠サンプル.pdf に貼り込むテスト用 PNG/JPG を作る
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const W = 1200;
const H = 900;

// 写真らしいグラデーション + ノイズ + 中央ボックス + 撮影日風テクスチャを描画
function paint({ bgTop, bgBot, boxColor, boxBorder, accentDot }) {
  const data = Buffer.alloc(W * H * 4);
  const [r1, g1, b1] = bgTop;
  const [r2, g2, b2] = bgBot;
  // グラデーション
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  // ランダムノイズ (写真ぽさ)
  let seed = 42;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let n = 0; n < 6000; n++) {
    const x = Math.floor(rnd() * W);
    const y = Math.floor(rnd() * H);
    const v = Math.floor((rnd() - 0.5) * 40);
    const i = (y * W + x) * 4;
    data[i] = Math.max(0, Math.min(255, data[i] + v));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + v));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + v));
  }
  // 中央ボックス (被写体の領域)
  const boxW = Math.floor(W * 0.5);
  const boxH = Math.floor(H * 0.5);
  const bx = Math.floor((W - boxW) / 2);
  const by = Math.floor((H - boxH) / 2);
  const [br, bg, bb] = boxColor;
  for (let y = by; y < by + boxH; y++) {
    for (let x = bx; x < bx + boxW; x++) {
      const i = (y * W + x) * 4;
      data[i] = br;
      data[i + 1] = bg;
      data[i + 2] = bb;
      data[i + 3] = 255;
    }
  }
  // ボックスの外枠 (太さ 6px)
  const [obr, obg, obb] = boxBorder;
  const bw = 6;
  for (let t = 0; t < bw; t++) {
    for (let x = bx - t; x < bx + boxW + t; x++) {
      if (x < 0 || x >= W) continue;
      // 上
      let i1 = ((by - t) * W + x) * 4;
      if ((by - t) >= 0) { data[i1] = obr; data[i1 + 1] = obg; data[i1 + 2] = obb; }
      // 下
      let i2 = ((by + boxH + t - 1) * W + x) * 4;
      if ((by + boxH + t - 1) < H) { data[i2] = obr; data[i2 + 1] = obg; data[i2 + 2] = obb; }
    }
    for (let y = by - t; y < by + boxH + t; y++) {
      if (y < 0 || y >= H) continue;
      // 左
      let i1 = (y * W + (bx - t)) * 4;
      if ((bx - t) >= 0) { data[i1] = obr; data[i1 + 1] = obg; data[i1 + 2] = obb; }
      // 右
      let i2 = (y * W + (bx + boxW + t - 1)) * 4;
      if ((bx + boxW + t - 1) < W) { data[i2] = obr; data[i2 + 1] = obg; data[i2 + 2] = obb; }
    }
  }
  // アクセントドット (4隅)
  const [adr, adg, adb] = accentDot;
  const corners = [
    [bx + 20, by + 20], [bx + boxW - 20, by + 20],
    [bx + 20, by + boxH - 20], [bx + boxW - 20, by + boxH - 20],
  ];
  for (const [cx, cy] of corners) {
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        if (dx * dx + dy * dy > 100) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const i = (y * W + x) * 4;
        data[i] = adr; data[i + 1] = adg; data[i + 2] = adb;
      }
    }
  }
  // 中央に大きい × アイコン風 (被写体識別)
  const cx = bx + boxW / 2, cy = by + boxH / 2, size = 80;
  for (let t = -3; t <= 3; t++) {
    for (let k = -size; k <= size; k++) {
      const x1 = Math.round(cx + k), y1 = Math.round(cy + k + t);
      const x2 = Math.round(cx + k), y2 = Math.round(cy - k + t);
      for (const [px, py] of [[x1, y1], [x2, y2]]) {
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const i = (py * W + px) * 4;
        data[i] = adr; data[i + 1] = adg; data[i + 2] = adb;
      }
    }
  }
  return data;
}

// PNG 書き出し (青系トーン: 照明器具A)
const pngData = paint({
  bgTop: [225, 235, 250], bgBot: [170, 195, 230],
  boxColor: [248, 250, 254], boxBorder: [0, 64, 255], accentDot: [0, 64, 255],
});
const png = new PNG({ width: W, height: H });
pngData.copy(png.data);
const pngOut = PNG.sync.write(png);
fs.writeFileSync(path.join(__dirname, 'サンプル写真_001.png'), pngOut);
console.log('PNG generated: サンプル写真_001.png');

// JPG 書き出し (暖色トーン: 照明器具B)
const jpgData = paint({
  bgTop: [245, 235, 220], bgBot: [225, 200, 170],
  boxColor: [255, 250, 245], boxBorder: [204, 85, 32], accentDot: [204, 85, 32],
});
const jpgOut = jpeg.encode({ data: jpgData, width: W, height: H }, 80);
fs.writeFileSync(path.join(__dirname, 'サンプル写真_002.jpg'), jpgOut.data);
console.log('JPG generated: サンプル写真_002.jpg');

console.log('Done.');
