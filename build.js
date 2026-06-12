// PDF Compact ビルドスクリプト(連結のみ)
// src/ の分割ファイルを骨格テンプレートに差し込んで、単一HTML pdf_compact_bundle.html を生成する。
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
const OUT = path.join(ROOT, 'pdf_compact_bundle.html');

// sentinel → 差し込むファイル。各 sentinel はテンプレート内にちょうど1回出現する。
const INCLUDES = [
  { sentinel: '/*@@INCLUDE:styles.css@@*/', file: 'src/styles.css' },
  { sentinel: '@@INCLUDE:guide.html@@',     file: 'src/guide.html' },
  { sentinel: '/*@@INCLUDE:app.js@@*/',     file: 'src/app.js' },
];

function build() {
  let html = fs.readFileSync(TEMPLATE, 'utf8');
  for (const inc of INCLUDES) {
    const parts = html.split(inc.sentinel);
    if (parts.length !== 2) {
      throw new Error(`sentinel ${inc.sentinel} がテンプレに ${parts.length - 1} 回(1回であるべき)`);
    }
    const payload = fs.readFileSync(path.join(ROOT, inc.file), 'utf8');
    html = parts[0] + payload + parts[1];
  }
  // ガード: 取説(text/html)以外に </script> が紛れていないか等の健全性チェック
  //   guideSource の中に </script> があると外側が早期終了する(過去 v3.3.5 の事故)。
  //   ここでは「app.js 内に </script> リテラルが無い」ことだけ機械チェックする。
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  if (/<\/script>/i.test(app)) {
    throw new Error('app.js に </script> が含まれている(<script>が早期終了する)。エスケープが必要');
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
