# PDF Compact 開発の学び (lessons)

このファイルは「次に同じミス繰り返さんため」に書く。新しいハマりを発見したら追記する。

---

## v3.3.x 取説ドック化シリーズの教訓 (2026-05-28)

### 1. `<script type="text/html">` の中に `</script>` を含めるな

**症状**: ガイドソースを格納してた `<script type="text/html" id="guideSource">` の中に `<script>...</script>` を追加したら、外側の script タグが早期終了して取説 HTML 全体が壊れた。

**原因**: HTML パーサーは `<script>` 内のテキストでも `</script>` (大文字小文字無視) を見つけると即終了する。type 属性は関係ない。

**対策**:
- ガイドソース内には絶対に `</script>` を書かない
- どうしても script 必要なら、親側 JS から `iframe.contentDocument` に DOM 注入する
- やむを得ず書くなら `<\/script>` でエスケープ

**実装例**:
```js
// 親 JS から iframe にスタイル注入 (ガイドソースを汚さない)
function installAnchorHandler() {
  const doc = iframe.contentDocument;
  const hideStyle = doc.createElement('style');
  hideStyle.textContent = '.topnav-cta { display: none !important; }';
  doc.head.appendChild(hideStyle);
}
```

### 2. `body` の `padding-right` は CSS で効かないケースがある

**症状**: `body.guide-docked { padding-right: 480px }` を書いても、`!important` 付けても、インライン `!important` 付けても、computed padding-right が 20px (元の値) のまま動かなかった。Chrome の何かが特定条件で body の padding-right longhand を弾く。

**詳細**: 
- `padding-top`, `padding-left`, `padding-bottom`, `margin-right` 等は普通に効く
- `padding-right` だけが効かない
- inline style も無効化される
- ただし `html` 要素 (documentElement) なら同じ書き方で効く

**対策**: body の幅を縮めたい時は `document.documentElement.style.setProperty('padding-right', ..., 'important')` で html 要素に inline で設定する。

**注**: 厳密な原因は未特定。Chrome のビューポート伝搬関連の挙動の可能性。再現したら CSS じゃなく JS + html 要素で逃げる。

### 3. localStorage の auto-save 汚染に注意

**症状**: v3.3.0 の openGuide が初回起動時に `setGuideDocked(false)` を呼んでて、それが localStorage に '0' を auto-save。次バージョンで「'0' でなければデフォルトドック」判定したら、その auto-saved '0' が「明示的ユーザー選択」と誤判定される。

**対策**:
- 設定保存関数には `persist=true|false` 引数を持たせる
- 起動時の状態適用は `persist=false` で呼んで localStorage を汚染しない
- ユーザー操作(トグルボタン押下等)の時だけ `persist=true` で保存
- 既存キーが汚染済みの場合はキー名刷新 (`.v2`) + 旧キー削除でマイグレーション

**実装例**:
```js
function setGuideDocked(docked, persist) {
  if (persist === undefined) persist = true;
  // ... apply state ...
  if (persist) { localStorage.setItem(KEY, docked ? '1' : '0'); }
}
// openGuide からの自動適用
setGuideDocked(true, false); // 状態は変えるが保存しない
// ユーザー操作のトグル
setGuideDocked(!current, true); // 保存する
```

### 4. ユーザーの「変わらん」「でてこん」は実機ブラウザキャッシュを疑う

**症状**: 自分のテスト (preview) では動いてるのにユーザーが「変わらん」と言う。

**原因**: ブラウザが古い HTML を持ったまま、F5 (通常リロード) だとキャッシュから読む。

**対策**:
- 即「Ctrl+Shift+R or Ctrl+F5」を提案
- バージョンバッジの値で実際にどのバージョンが読まれてるか確認
- それでも直らんかったらシークレットタブで開いてキャッシュ完全回避

### 5. iframe 内の要素も親から制御できる (same-origin の時)

**症状**: 取説 (iframe) 内の `topnav-cta` ボタンを非表示にしたい。

**できること**:
- `iframe.contentDocument.head` に `<style>` 要素を appendChild で注入
- `iframe.contentDocument.getElementById()` で要素取得して操作
- `iframe.contentDocument.documentElement.classList.add(...)` でクラス付与

**注**: cross-origin だと SecurityError。同一オリジン or srcdoc/docwrite なら制御可能。

### 6. fixed 要素のシフトには CSS var が便利

**症状**: ドック分シフトしたい fixed 要素が複数 (imgPlace 右ペイン、更新バナー、トラッシュボタン等)。

**対策**: `:root { --guide-dock-w: 480px }` を CSS var にしておいて、各 fixed 要素で `right: calc(16px + var(--guide-dock-w))` のように参照。値の一元管理 + JS から `setProperty('--guide-dock-w', '500px')` で動的変更も可能。

### 7. モード切替と取説連動 = 学習補助になる

**ユーザー要件**: タブ切り替えたら取説も該当セクションへスクロール。

**実装**: `data-mode` → guide section id のマッピングテーブル + `iframe.contentDocument.getElementById(sectionId).scrollIntoView({behavior:'smooth'})`。

**応用**: ユーザーが触ってる UI と関連ドキュメントを同期させる発想は、教育目的のツールで強い体験。
