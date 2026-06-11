# リファクタ Phase 0: 安全網 (2026-06-11 着手)

> 計画本体: docs/plans/refactoring-roadmap.md / 暗黙知: docs/plans/refactoring-handoff.md
> 鉄則: バンドルの挙動は1ピクセルも変えない。このフェーズはバンドル非改変。
> (旧 imgPlace Phase1 計画は完了済みのため置き換え。内容は git 履歴参照)

## チェックリスト

- [x] v3.8.0(黒塗り)を main に着地・配布 ← 2026-06-11 完了 (cc50cb6)
- [ ] テスト基盤のセットアップ
  - [ ] package.json + Playwright (devDependency のみ。ランタイム依存ゼロは不変)
  - [ ] .gitignore (node_modules / test-results / playwright-report)
  - [ ] playwright.config.js (serve.js を webServer に、テスト専用ポート)
  - [ ] tests/helpers.js (合成PDF生成・ファイル投入・出力blob捕捉・ピクセル判定の共通部品)
- [ ] スモークテスト第1波 (実証済みの検証コードを移植)
  - [ ] redact.spec — 安全の本丸: クリック黒塗り/重複マージ/別語非統合/no-text誘導/出力の生バイト秘密ゼロ/A3フィット
  - [ ] sanitize.spec — 透かし単独ON/フォント遮断トースト/絵文字除去
  - [ ] pdfedit.spec — 単一PDF並び替え→出力順序/読込失敗のまとめ表示
  - [ ] img2pdf.spec — 画像合わせの横長/EXIF回転の正立
  - [ ] convert.spec — 透過→PDF白背景/同名ZIP連番/巨大画像縮小完走
  - [ ] compress.spec — 全件done再クリックで再圧縮
- [ ] npm test 一発で全部 green
- [ ] release.ps1 (バージョン3点セット+ZIP+整合チェックをワンコマンド)
- [ ] 死蔵ファイル削除 (一覧提示→ユーザー承認後)
  - 候補: pdf_compact_bundle.html.bak.20260515 / pdf_compressor_guide.html / HANDOFF_SPEC.md / PDF Compact.vbs(要確認)
- [ ] コミット・push (バンドル非改変の確認付き)

## レビュー (完了時に記入)
