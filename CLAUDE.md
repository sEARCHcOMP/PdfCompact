# PDF Compact — プロジェクトのクセ

現場監督向けの「1ファイルで全部入り」PDFツール。ブラウザだけで完結し、ファイルは外部に出ない。
このファイルは **触る前に必ず読む前提のクセ集**。ここを外すと配布事故になる。

---

## 絶対に守る掟

1. **顧客データを1バイトもコミットしない**
   不具合調査で実PDF・実写真を使う時は、作業フォルダ直下に置かず `_scratch/`(gitignore済)へ。
   調査が終わったら**その場で削除**し、`git status` で残骸ゼロを確認してからコミットする。
   実データは「解析はローカル完結・中身は読まない・外部送信しない」を徹底する。

2. **偽リダクションを作らない**(塗りつぶし機能)
   隠す処理は **canvas の fillRect で焼き込む**のみ。`pdf-lib` の `drawRectangle` で四角を被せる実装は
   下に文字が生き残るため**禁止**。出力前に `verifyRedaction()`(該当ページのテキスト量ゼロ)を必ず通し、
   1文字でも残ったら出力を中止する。テストは生バイト走査で秘密文字列ゼロを確認している。

3. **`src/app/*.js` に文字列 `</script>` を書かない**
   単一HTMLに連結する構造上、外側の `<script>` が早期終了して全機能が死ぬ(v3.3.5 で事故済み)。
   build.js にガードあり。動的 script 注入で回避する。

---

## 開発フロー(ここを間違えると変更が反映されない)

```bash
# 1. src/ を編集(index.html を直接編集しない！ 生成物なので上書きされる)
# 2. ビルド(src → index.html を生成)
node build.js
# 3. テスト(36本、pretest で build --check も走る)
npm test
# 4. リリース(テストゲート→版上げ→ZIP再構築→整合チェック)
pwsh build/release.ps1 -Version x.y.z -Notes "利用者向けの日本語説明"
# 5. commit → push origin main = 即・全社配布(Cloudflare Pages が約1分で反映)
```

- **`index.html` は build.js の生成物**。真実は `src/` にある(`src/index.template.html` + `src/styles.css` + `src/guide.html` + `src/app/*.js`)
- `src/app/` は**ファイル名のソート順で連結**される(`00-core-*` → `10-img2pdf` → … → `90-settings`)
- ワーキングコピーは **CRLF**。エディタ外のツールで書いたら `(Get-Content $f) | Set-Content $f` で正規化してからコミット
- **push = 配布**。未完成を main に置かない

---

## 配布とバージョンの仕組み

- 公開URL: `https://pdfcompact.pages.dev/`(GitHubリポに Git 連携、main への push で自動デプロイ)
- 自動更新: アプリ内 `_BASE_B64`(base64化した配布URL)+ `version.json` の `download_path` でリモートを解決
- **配布元URLは平文で書かない**(コメントにも)。bundle と exe に埋まるため。更新時は `btoa()` の結果だけ貼る
- ランチャー `PDF Compact.exe` の再生成:
  ```powershell
  . .\ps2exe.ps1; Invoke-ps2exe -inputFile .\launcher.ps1 -outputFile '.\PDF Compact.exe' -noConsole
  ```
  (dot-source が必須。関数定義型のため直接実行では動かない)
- ZIP内の本体名だけは旧名 `pdf_compact_bundle.html`(配布済みランチャーとの互換。release.ps1 が変換)

### 「直したのに直ってない」と言われたら
コードを疑う前に、**起動中アプリのフッターに出る `vX.Y.Z` が最新か**を確認させる。
ブラウザキャッシュ/未再起動の旧版でテストして誤報告、が定番(実例あり)。
アプリを閉じて `PDF Compact.exe` 再起動、または `Ctrl+Shift+R`。

---

## 地雷ゾーン(過去に踏んだやつ)

| 領域 | 罠 |
|---|---|
| **HEIC** | heic2any 0.0.4 は Apple の HDR HEIC(ゲインマップ/10bit)を `ERR_LIBHEIF format not supported` で弾く。失敗時のみ libheif-js にフォールバックする実装済み。**HeifDecoder は解放APIが無いので必ず単一インスタンスを使い回す**(毎回 new すると WASM メモリが漏れる) |
| **PDF編集** | `pdf-lib` は暗号化PDFを復号できない。編集ロック付きは `ignoreEncryption:true` で強行すると**壊れたPDFを無言で出力**する。v4.4.0 以降は確認のうえ画像化して非保護PDFに変換してから通常フローへ流す |
| **PDF分割** | `copyPages()` は未使用リソースを剪定しきれずサイズ爆発。戦略A(`removePage`)/B(`copyPages`)を自動切替済 |
| **jsPDF** | CDN落ち防御で `const jsPDF = (window.jspdf && window.jspdf.jsPDF) \|\| null;` を維持 |
| **取説** | `src/guide.html` が正。bundle 内に埋め込まれるので**取説を直したら必ず再ビルド**。章の id(`part-hikari` 等)はタブ連動スクロールのキーなので改名しない |
| **リリース履歴の日付** | セッションが日を跨ぐと手書き日付が古いままになる事故が2回。**書く直前に実日付を確認**し、release.ps1 が打つREADMEバッジと突き合わせる |

---

## スマホ転送(Hikari)について

- バックエンドは**別プロジェクト** `pc-toolkit`(Cloudflare Worker + Firebase RTDB + R2)と共有
- **スマホ側UI(`phone.js`)を直したら、そちらのリポで `npm run deploy:phone` が必要**。このリポの push だけでは反映されない
- Firebase の Web config はソースに直書き(公開前提の識別子。認可は DB ルール側で担保)
- 転送プロトコル: `rooms/{roomId}/transfers/{fileId}` に メタを書き、実体は R2。
  送信は ≤100MB が Worker 経由 PUT、>100MB が署名付きURLで R2 直PUT(**署名に content-type を含むため PUT 時のヘッダと完全一致必須**)

---

## やらないと決めていること

- PDF→Word/Excel 変換(ブラウザ完結では書式維持が不可能。Acrobat等を案内する)
- クラウド保存・アカウント機能(ローカル完結が売りのため)

---

## 利用者像(文言を書く時の基準)

- 建設現場の監督・施工管理者。**コードは読まない**。動作・出力・画面で判断する
- **アプリ内の文言・取説は美しい標準語**で書く(会話は関西弁でも、UIは丁寧語)
- 専門用語を避け、「何が起きるか」「次に何をすればいいか」が分かる文にする
- 失敗は**無言でスキップしない**。必ず画面に理由を残す(過去に無言失敗で事故った)

---

## モデル運用ルール(全プロジェクト共通・2026-08-21 制定)

- **検討・設計 = Fable / 実装以降 = Opus**。利用上限を圧迫するため、大量サブエージェントは既定で使わない
- Claudeは次の4点に当たったら **着手前に「🔴ここはFable案件や」と宣言**して判断を仰ぐ:
  1. 未知の仕様に踏み込む(資料が無い/散らばっていて突き合わせが要る)
  2. 設計の分岐点(方式を決めたら手戻りが高い)
  3. 不可逆・流出リスク(バイナリ書き込み・削除・社外流出の境界)
  4. 2回直して直らん時(推測が外れたら総力戦に切り替える)
- それ以外(仕様確定後の実装・UI・取説・指摘済みバグ修正・定型作業)は **🟢Opusソロ**で進める
- レビューは **2〜3体・1観点まで**。品質はレビュー物量でなく **自動テストと実機検証**で担保する
- ユーザーが **"ultracode"** と明示した時だけフル火力でよい

> 新しいモデルが出るまでこのルールを維持する。全Claude利用(Claude Code・claude.aiチャット共通)に適用。
