// 現場写真風ダミー画像生成 (pure JS、外部 native 依存なし)
// 「PDFに画像配置」モードのデモ用バリエーション
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const W = 1200;
const H = 900;

function makeRand(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

function fill(data, x0, y0, x1, y1, [r, g, b]) {
  x0 = Math.max(0, x0|0); y0 = Math.max(0, y0|0);
  x1 = Math.min(W, x1|0); y1 = Math.min(H, y1|0);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  }
}

function circle(data, cx, cy, r, [cr, cg, cb]) {
  const r2 = r * r;
  for (let y = Math.max(0, cy-r|0); y < Math.min(H, cy+r+1|0); y++) {
    for (let x = Math.max(0, cx-r|0); x < Math.min(W, cx+r+1|0); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy <= r2) {
        const i = (y * W + x) * 4;
        data[i] = cr; data[i+1] = cg; data[i+2] = cb; data[i+3] = 255;
      }
    }
  }
}

function line(data, x0, y0, x1, y1, w, [lr, lg, lb]) {
  const steps = Math.ceil(Math.hypot(x1-x0, y1-y0));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + (x1-x0) * t;
    const py = y0 + (y1-y0) * t;
    for (let dy = -w; dy <= w; dy++) {
      for (let dx = -w; dx <= w; dx++) {
        if (dx*dx + dy*dy > w*w) continue;
        const x = Math.round(px+dx), y = Math.round(py+dy);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const i = (y * W + x) * 4;
        data[i] = lr; data[i+1] = lg; data[i+2] = lb; data[i+3] = 255;
      }
    }
  }
}

function gradient(data, top, bot) {
  const [r1, g1, b1] = top, [r2, g2, b2] = bot;
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
    }
  }
}

function addNoise(data, intensity, seed) {
  const rnd = makeRand(seed);
  for (let n = 0; n < 6000; n++) {
    const x = (rnd() * W) | 0;
    const y = (rnd() * H) | 0;
    const v = ((rnd() - 0.5) * intensity) | 0;
    const i = (y * W + x) * 4;
    data[i]   = Math.max(0, Math.min(255, data[i] + v));
    data[i+1] = Math.max(0, Math.min(255, data[i+1] + v));
    data[i+2] = Math.max(0, Math.min(255, data[i+2] + v));
  }
}

// シーン1: 天井に取り付けたダウンライト風
function scene_downlight() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [240, 235, 220], [200, 195, 180]);
  addNoise(data, 30, 11);
  // 天井パネル風 ラインの繰り返し
  for (let y = 0; y < H; y += 110) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.max(0, data[i] - 25);
      data[i+1] = Math.max(0, data[i+1] - 25);
      data[i+2] = Math.max(0, data[i+2] - 25);
    }
  }
  // 中央にダウンライト = 黒丸 + 光輪
  for (let r = 200; r > 120; r -= 10) {
    const t = (200 - r) / 80;
    const col = [255 * t + 240*(1-t), 245 * t + 230*(1-t), 200 * t + 210*(1-t)];
    circle(data, W/2, H/2, r, col.map(v => v|0));
  }
  circle(data, W/2, H/2, 130, [40, 35, 30]);
  circle(data, W/2, H/2, 110, [255, 245, 200]);
  circle(data, W/2, H/2, 80, [255, 255, 240]);
  return data;
}

// シーン2: 壁面コンセント風
function scene_outlet() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [230, 225, 215], [195, 190, 180]);
  addNoise(data, 25, 22);
  // 中央に大きな白いコンセントパネル
  const px = W/2 - 200, py = H/2 - 140, pw = 400, ph = 280;
  fill(data, px - 4, py - 4, px + pw + 4, py + ph + 4, [180, 175, 165]);
  fill(data, px, py, px + pw, py + ph, [248, 245, 235]);
  // 上下2口のソケット
  for (const cy of [py + ph/3, py + (ph/3)*2]) {
    fill(data, px + 80, cy - 40, px + 320, cy + 40, [220, 215, 205]);
    // 縦穴2つ
    fill(data, px + 150, cy - 30, px + 165, cy + 30, [20, 18, 15]);
    fill(data, px + 235, cy - 30, px + 250, cy + 30, [20, 18, 15]);
    // アース穴
    fill(data, px + 192, cy + 15, px + 208, cy + 30, [20, 18, 15]);
  }
  return data;
}

// シーン3: スイッチプレート (家庭用照明スイッチ)
function scene_switch() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [225, 220, 210], [180, 175, 165]);
  addNoise(data, 25, 33);
  const px = W/2 - 180, py = H/2 - 240, pw = 360, ph = 480;
  fill(data, px - 4, py - 4, px + pw + 4, py + ph + 4, [160, 155, 145]);
  fill(data, px, py, px + pw, py + ph, [250, 248, 240]);
  // 3つのスイッチ
  for (let i = 0; i < 3; i++) {
    const sy = py + 50 + i * 140;
    fill(data, px + 80, sy, px + 280, sy + 90, [230, 225, 215]);
    fill(data, px + 100, sy + 20, px + 260, sy + 70, [200, 195, 180]);
    // ON/OFF 表示
    fill(data, px + 100, sy + 20, px + 180, sy + 70, [60, 180, 90]);
  }
  return data;
}

// シーン4: 蛍光灯ベース
function scene_fluorescent() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [220, 230, 235], [180, 190, 200]);
  addNoise(data, 20, 44);
  // 細長い蛍光灯
  fill(data, 200, 400, 1000, 500, [40, 38, 35]);
  fill(data, 210, 410, 990, 490, [255, 250, 230]);
  // 光のグロー
  for (let r = 300; r > 200; r -= 15) {
    const op = (300 - r) / 100;
    const col = [255 - 50 * op, 250 - 50 * op, 200 - 50 * op].map(v => v|0);
    fill(data, 200 + (1000-200)/2 - r, 450 - 60, 200 + (1000-200)/2 + r, 450 + 60, col);
  }
  fill(data, 200, 400, 1000, 500, [40, 38, 35]);
  fill(data, 210, 410, 990, 490, [255, 252, 235]);
  // ねじ穴2つ
  circle(data, 220, 450, 12, [180, 175, 165]);
  circle(data, 980, 450, 12, [180, 175, 165]);
  return data;
}

// シーン5: 配電盤の扉
function scene_breaker() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [200, 210, 220], [160, 170, 185]);
  addNoise(data, 25, 55);
  const px = W/2 - 250, py = H/2 - 280, pw = 500, ph = 560;
  fill(data, px - 6, py - 6, px + pw + 6, py + ph + 6, [120, 130, 145]);
  fill(data, px, py, px + pw, py + ph, [220, 225, 230]);
  // ヒンジ
  fill(data, px - 4, py + 60, px + 8, py + 110, [80, 90, 100]);
  fill(data, px - 4, py + ph - 110, px + 8, py + ph - 60, [80, 90, 100]);
  // ブレーカースイッチ列
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const sx = px + 30 + col * 75;
      const sy = py + 100 + row * 100;
      fill(data, sx, sy, sx + 55, sy + 70, [50, 55, 65]);
      fill(data, sx + 8, sy + 10, sx + 47, sy + 35, (row + col) % 2 ? [80, 200, 100] : [200, 80, 60]);
    }
  }
  // ハンドル
  fill(data, px + pw - 60, py + ph/2 - 40, px + pw - 30, py + ph/2 + 40, [60, 70, 85]);
  return data;
}

// シーン6: 電気メーター
function scene_meter() {
  const data = Buffer.alloc(W * H * 4);
  gradient(data, [210, 215, 220], [170, 175, 185]);
  addNoise(data, 20, 66);
  // メーター本体 (上に出っ張った半円)
  const cx = W/2, cy = H/2 + 50;
  fill(data, cx - 220, cy - 100, cx + 220, cy + 200, [70, 75, 85]);
  fill(data, cx - 200, cy - 80, cx + 200, cy + 180, [240, 240, 235]);
  // 半円表示部
  for (let a = -Math.PI; a <= 0; a += 0.01) {
    const x = cx + Math.cos(a) * 180;
    const y = cy + Math.sin(a) * 180;
    circle(data, x|0, y|0, 3, [40, 45, 55]);
  }
  // 中心に針
  line(data, cx, cy, cx - 100, cy - 130, 4, [200, 50, 50]);
  circle(data, cx, cy, 10, [50, 55, 65]);
  // 下にデジタル表示桁
  for (let d = 0; d < 5; d++) {
    const dx = cx - 100 + d * 50;
    fill(data, dx, cy + 50, dx + 40, cy + 110, [30, 35, 45]);
    // 7セグ風
    fill(data, dx + 8, cy + 60, dx + 32, cy + 70, [80, 220, 100]);
    fill(data, dx + 8, cy + 90, dx + 32, cy + 100, [80, 220, 100]);
  }
  return data;
}

const scenes = [
  { name: 'サンプル写真_01_ダウンライト', fn: scene_downlight, fmt: 'png' },
  { name: 'サンプル写真_02_コンセント', fn: scene_outlet, fmt: 'jpg' },
  { name: 'サンプル写真_03_スイッチ', fn: scene_switch, fmt: 'png' },
  { name: 'サンプル写真_04_蛍光灯', fn: scene_fluorescent, fmt: 'jpg' },
  { name: 'サンプル写真_05_配電盤', fn: scene_breaker, fmt: 'png' },
  { name: 'サンプル写真_06_電気メーター', fn: scene_meter, fmt: 'jpg' },
];

for (const s of scenes) {
  const data = s.fn();
  const fname = `${s.name}.${s.fmt}`;
  const fpath = path.join(__dirname, fname);
  if (s.fmt === 'png') {
    const png = new PNG({ width: W, height: H });
    data.copy(png.data);
    fs.writeFileSync(fpath, PNG.sync.write(png));
  } else {
    const jpgOut = jpeg.encode({ data, width: W, height: H }, 80);
    fs.writeFileSync(fpath, jpgOut.data);
  }
  console.log(`Generated: ${fname}`);
}

console.log('Done.');
