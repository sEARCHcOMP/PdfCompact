# リファクタ Phase 0: 安全網 (2026-06-11 着手)

> 計画本体: docs/plans/refactoring-roadmap.md / 暗黙知: docs/plans/refactoring-handoff.md
> 鉄則: バンドルの挙動は1ピクセルも変えない。このフェーズはバンドル非改変。
> (旧 imgPlace Phase1 計画は完了済みのため置き換え。内容は git 履歴参照)

## チェックリスト

- [x] v3.8.0(黒塗り)を main に着地・配布 ← 2026-06-11 完了 (cc50cb6)
- [x] テスト基盤のセットアップ
  - [x] package.json + Playwright (devDependency のみ。ランタイム依存ゼロは不変)
  - [x] .gitignore (node_modules / test-results / playwright-report)
  - [x] playwright.config.js (serve.js を webServer に、テスト専用ポート)
  - [x] tests/helpers.js (合成PDF生成・ファイル投入・出力blob捕捉・ピクセル判定の共通部品)
- [x] スモークテスト第1波 (15テスト・全モード)
  - [x] redact.spec — 安全の本丸: クリック黒塗り/重複マージ/別語非統合/no-text誘導/出力の生バイト秘密ゼロ/A3フィット
  - [x] sanitize.spec — 透かし単独ON/フォント遮断トースト/絵文字除去
  - [x] pdfedit.spec — 単一PDF並び替え→出力順序/読込失敗のまとめ表示
  - [x] img2pdf.spec — 画像合わせの横長/EXIF回転の正立
  - [x] convert.spec — 透過→PDF白背景/同名ZIP連番/巨大画像縮小完走
  - [x] compress.spec — 全件done再クリックで再圧縮
- [x] npm test 一発で全部 green (15 passed, 約40秒)
- [x] release.ps1 (build/release.ps1・v3.8.0で空打ち検証済み)
- [x] 死蔵ファイル削除 (4件・ユーザー承認後に削除完了)
  - 削除済: bak / pdf_compressor_guide.html / HANDOFF_SPEC.md / PDF_Compact展開残骸。PDF Compact.vbs は現役ランチャーのため保持
- [x] コミット (バンドル非改変を確認)

## レビュー (Phase 0 完了 2026-06-11)

- **テスト基盤**: Playwright で6モード15テスト、npm test 一発で約40秒 green。今日までに直した39バグの代表シナリオを移植(偽リダクション検査=生バイト走査が黒塗りの番犬)。
- **リリース自動化**: build/release.ps1 がテストゲート→バージョン3点同期→ZIP再構築(UTF8)→SHA整合チェックまでワンコマンド。
- **掃除**: 死蔵4件をユーザー承認の上で削除。serve.js を追跡対象化、.gitignore 新設。
- **不変条件**: bundle のコードは1バイトも変えていない(version文字列すら触らず)。
- **次**: Phase 1(ビルド工程の導入 = src/ 分割 + 連結build.js)。テストという防波堤ができたので分割に着手できる。
