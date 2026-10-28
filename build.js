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
// ガード: src の改行コードの混在。1行だけ LF の行が混ざると、Git の改行変換(core.autocrlf)で
//   チェックアウトのたびに bundle が1バイトずれ、--check が永久に通らなくなる(2026-10-28 に実際に発生)。
//   このリポジトリの原本はすべて CRLF。裸の LF・裸の CR を見つけたら、どのファイルの何行目かを出して止める。
function assertCrlf(file, text) {
  const marked = text.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(1));
  for (const ch of [String.fromCharCode(10), String.fromCharCode(13)]) {
    const at = marked.indexOf(ch);
    if (at < 0) continue;
    const line = marked.slice(0, at).split(String.fromCharCode(1)).length;
    const what = ch === String.fromCharCode(10) ? 'LF' : 'CR';
    throw new Error(file + ' の ' + line + ' 行目が裸の ' + what + ' で終わっている。このリポジトリの原本は CRLF で揃える');
  }
}
function buildAppPayload() {
  const dir = path.join(ROOT, 'src', 'app');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
  if (files.length === 0) throw new Error('src/app/ に .js が無い');
  return files.map(f => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assertCrlf('src/app/' + f, text);
    return text;
  }).join('');
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
  // ガード: 制御文字(タブ・改行以外)の混入。HTML はスクリプト中の NUL を別の文字に置き換えるため、
  //   正規表現などに NUL が入ると連結した1本のスクリプトごと読めなくなり、全機能が止まる(v4.5.0 開発中に実際に発生)。
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0x7F) {
      const line = html.slice(0, i).split(String.fromCharCode(10)).length;
      throw new Error('制御文字 U+' + c.toString(16).padStart(4, '0') + ' が生成物の ' + line + ' 行目にある。文字コードの数値で書き直すこと');
    }
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
