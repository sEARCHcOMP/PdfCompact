// PDF Compact ビルドスクリプト(連結のみ)
// src/ の分割ファイルを骨格テンプレートに差し込んで、単一HTML index.html を生成する。
// 方針(docs/plans/refactoring-handoff.md 法則2): bundler/transpile/minify は一切しない。
//   - ランタイム依存ゼロ(node標準APIのみ)
//   - 出力は人間が読める形のまま(デバッグ性を維持)
//   - 改行は CRLF を維持(法則3)
// 使い方: node build.js          … ビルド(bundleを上書き)
//         node build.js --check  … ビルド結果が現行bundleとbyte一致するか検証(書き換えない)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const TEMPLATE = path.join(ROOT, 'src', 'index.template.html');
const OUT = path.join(ROOT, 'index.html');

// アプリJS は src/app/*.js をファイル名のソート順に連結して1つの payload にする。
//   00-core / 10-img2pdf / 20-convert / 30-pdfedit / 40-imgplace / 50-redact / 90-settings
//   連番プレフィックスで順序を固定(連結のみ・区切り文字なし=byte一致)。
function buildAppPayload() {
  const dir = path.join(ROOT, 'src', 'app');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
  if (files.length === 0) throw new Error('src/app/ に .js が無い');
  return files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
}

// sentinel → 差し込むペイロード。各 sentinel はテンプレート内にちょうど1回出現する。
function getIncludes() {
  return [
    { sentinel: '/*@@INCLUDE:styles.css@@*/', payload: fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8') },
    { sentinel: '@@INCLUDE:guide.html@@',     payload: fs.readFileSync(path.join(ROOT, 'src/guide.html'), 'utf8') },
    { sentinel: '/*@@INCLUDE:app.js@@*/',     payload: buildAppPayload() },
  ];
}

function build() {
  let html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const inc of getIncludes()) {
    const parts = html.split(inc.sentinel);
    if (parts.length !== 2) {
      throw new Error(`sentinel ${inc.sentinel} がテンプレに ${parts.length - 1} 回(1回であるべき)`);
    }
    html = parts[0] + inc.payload + parts[1];
  }
  // ガード: guideSource(text/html)以外に </script> が紛れていないか。
  //   <script> 内に </script> リテラルがあると外側が早期終了する(過去 v3.3.5 の事故)。
  const app = buildAppPayload();
  if (/<\/script>/i.test(app)) {
    throw new Error('src/app/*.js に </script> が含まれている(<script>が早期終了する)。エスケープが必要');
  }
  return html;
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

if (process.argv.includes('--check')) {
  const built = build();
  const current = fs.readFileSync(OUT, 'utf8');
  if (sha(built) === sha(current)) {
    console.log('✓ byte一致: ビルド結果は現行 bundle と完全一致');
    process.exit(0);
  } else {
    console.error('✗ 不一致: ビルド結果が現行 bundle と異なる');
    console.error('  built   len=' + built.length + ' sha=' + sha(built).slice(0, 12));
    console.error('  current len=' + current.length + ' sha=' + sha(current).slice(0, 12));
    // 最初の相違位置を出す
    const n = Math.min(built.length, current.length);
    let i = 0; while (i < n && built[i] === current[i]) i++;
    console.error('  最初の相違: offset ' + i + ' 付近 built=' + JSON.stringify(built.slice(i, i + 40)));
    console.error('              current=' + JSON.stringify(current.slice(i, i + 40)));
    process.exit(1);
  }
} else {
  const built = build();
  fs.writeFileSync(OUT, built);
  console.log('✓ ビルド完了: ' + OUT + ' (' + built.length + ' bytes)');
}
