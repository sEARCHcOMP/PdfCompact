# PDF Compact リリース ワンコマンド化
# 使い方:
#   pwsh build/release.ps1 -Version 3.8.1 -Notes "修正内容..." [-SkipTests]
# やること(順番厳守):
#   1) スモークテスト(npm test)をゲートとして実行 ※ -SkipTests で省略可(非推奨)
#   2) APP_VERSION / version.json / README バッジ&日付 を一括更新
#   3) PDF_Compact.zip を UTF8 ファイル名で再構築(日本語名の文字化け防止)
#   4) 整合チェック(3箇所のバージョンが一致 / ZIP内のbundleが最新と同一)
# バンドルのコード自体は一切書き換えない(version文字列のみ)。

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "",
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$today = Get-Date -Format 'yyyy-MM-dd'

function Fail($msg) { Write-Host "❌ $msg" -ForegroundColor Red; exit 1 }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "バージョンは x.y.z 形式で: $Version" }

# --- 1) バージョン更新(src が真実の源 → ビルドで bundle 生成) ---
# APP_VERSION は src/app/ のどこか(現状 00-core-00-sanitize.js)にある。bundle は build.js の生成物。
# 分割の都度パスが動くため、固定パスでなく src/app/ から自動探索する。
$appjs = Get-ChildItem (Join-Path $root 'src/app') -Filter *.js -Recurse |
  Where-Object { (Get-Content $_.FullName -Raw) -match "const APP_VERSION = '[^']+';" } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $appjs) { Fail "src/app/ に APP_VERSION が見つからない" }
$appSrc = [System.IO.File]::ReadAllText($appjs)
$old = [regex]::Match($appSrc, "const APP_VERSION = '([^']+)';").Groups[1].Value
$appSrc = $appSrc -replace "const APP_VERSION = '[^']+';", "const APP_VERSION = '$Version';"
[System.IO.File]::WriteAllText($appjs, $appSrc)
Write-Host "✓ $(Split-Path $appjs -Leaf) APP_VERSION $old → $Version"

# bundle を src から再ビルド(これで bundle に新バージョンが入る)
Write-Host "▶ ビルド中(src → bundle)..." -ForegroundColor Cyan
node build.js
if ($LASTEXITCODE -ne 0) { Fail "ビルド失敗" }
$bundle = Join-Path $root 'pdf_compact_bundle.html'

# --- 2) テストゲート(ビルド済み bundle に対して) ---
if ($SkipTests) {
  Write-Host "⚠ テストをスキップしました(-SkipTests)。本番リリースでは非推奨" -ForegroundColor Yellow
} else {
  Write-Host "▶ スモークテスト実行中..." -ForegroundColor Cyan
  npx playwright test
  if ($LASTEXITCODE -ne 0) { Fail "テストが失敗。リリース中止(これは安全装置や)" }
  Write-Host "✓ テスト全通過" -ForegroundColor Green
}

$vj = Join-Path $root 'version.json'
$noteText = if ($Notes) { $Notes } else { (Get-Content $vj -Raw | ConvertFrom-Json).notes }
$verObj = [ordered]@{ version = $Version; notes = $noteText; download_path = 'pdf_compact_bundle.html' }
($verObj | ConvertTo-Json -Depth 5) + "`n" | Set-Content -Path $vj -Encoding utf8 -NoNewline
Write-Host "✓ version.json 更新"

$readme = Join-Path $root 'README.md'
if (Test-Path $readme) {
  $r = [System.IO.File]::ReadAllText($readme)
  $r = [regex]::Replace($r, '> \*\*Version [\d.]+\*\* · [\d-]+', "> **Version $Version** · $today", 1)
  $r = [regex]::Replace($r, 'ZIP%20\([\d.]+\)', "ZIP%20($Version)", 1)
  [System.IO.File]::WriteAllText($readme, $r)
  Write-Host "✓ README バージョンバッジ更新(履歴本文は手動で追記すること)"
}

# --- 3) ZIP 再構築(UTF8 ファイル名) ---
$dest = Join-Path $root 'PDF_Compact.zip'
$stage = Join-Path $env:TEMP "pdfc_zip_stage_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($f in @('PDF Compact.bat', 'PDF Compact.exe', 'pdf_compact_bundle.html', 'README.txt', 'version.json')) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src $stage } else { Write-Host "  (省略: $f が無い)" -ForegroundColor DarkGray }
}
if (Test-Path (Join-Path $root 'samples')) {
  New-Item -ItemType Directory -Force (Join-Path $stage 'samples') | Out-Null
  Get-ChildItem (Join-Path $root 'samples') -File | Where-Object { $_.Name -ne '_gen_dummies.js' } |
    Copy-Item -Destination (Join-Path $stage 'samples')
}
if (Test-Path $dest) { Remove-Item -Force $dest -Confirm:$false }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $dest, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
$zipKB = [math]::Round((Get-Item $dest).Length / 1KB)
Remove-Item -Recurse -Force $stage -Confirm:$false
Write-Host "✓ PDF_Compact.zip 再構築 ($zipKB KB)"

# --- 4) 整合チェック ---
$vjVer = (Get-Content $vj -Raw | ConvertFrom-Json).version
$bundleVer = [regex]::Match([System.IO.File]::ReadAllText($bundle), "const APP_VERSION = '([^']+)';").Groups[1].Value
if ($vjVer -ne $Version -or $bundleVer -ne $Version) { Fail "バージョン不一致: bundle=$bundleVer version.json=$vjVer 期待=$Version" }
# ZIP内のbundleが最新と同一か(SHA比較)
$srcHash = (Get-FileHash $bundle -Algorithm SHA256).Hash
$tmp = Join-Path $env:TEMP "pdfc_verify_$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $tmp | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($dest, $tmp)
$zipHash = (Get-FileHash (Join-Path $tmp 'pdf_compact_bundle.html') -Algorithm SHA256).Hash
Remove-Item -Recurse -Force $tmp -Confirm:$false
if ($srcHash -ne $zipHash) { Fail "ZIP内のbundleが最新と一致しない(再構築失敗)" }

Write-Host ""
Write-Host "✅ リリース v$Version 準備完了" -ForegroundColor Green
Write-Host "   次の手順: README履歴に詳細追記 → git add → commit → push origin main(=配布開始)" -ForegroundColor Cyan
