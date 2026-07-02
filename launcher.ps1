# PDF Compact launcher (PowerShell, exe 化用)
# 起動 → 配布サーバから最新バージョン取得 → 新版あれば自動 DL + 上書き → ブラウザでバンドル開く
# ps2exe で .exe にコンパイル (-noConsole)。BASE URL は base64 で隠蔽

$ErrorActionPreference = 'SilentlyContinue'
# 実行ファイル(.exe)のフォルダに移動
try {
    $exeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $exeDir) { $exeDir = [System.AppContext]::BaseDirectory }
    Set-Location $exeDir
} catch { }

# base URL (base64 隠蔽)。平文URLは exe に埋まるためコメントにも書かない
$base = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String('aHR0cHM6Ly9wZGZjb21wYWN0LnBhZ2VzLmRldi8=')
)

try {
    $m = Invoke-WebRequest -Uri ($base + 'version.json') -UseBasicParsing -TimeoutSec 5 |
         ConvertFrom-Json
    $lv = '0.0.0'
    if (Test-Path 'pdf_compact_bundle.html') {
        $c = Get-Content 'pdf_compact_bundle.html' -Raw -Encoding UTF8
        if ($c -match "const APP_VERSION = '(\d+\.\d+\.\d+)'") { $lv = $Matches[1] }
    }
    if ([version]$m.version -gt [version]$lv) {
        Invoke-WebRequest -Uri ($base + $m.download_path) -OutFile 'pdf_compact_bundle.html.new' -UseBasicParsing -TimeoutSec 60
        if (Test-Path 'pdf_compact_bundle.html') { Remove-Item 'pdf_compact_bundle.html' -Force }
        Rename-Item 'pdf_compact_bundle.html.new' 'pdf_compact_bundle.html'
    }
} catch {
    # ネットエラーは黙殺
}

# バンドルが存在すればブラウザで開く、無ければエラー
if (Test-Path 'pdf_compact_bundle.html') {
    Start-Process 'pdf_compact_bundle.html'
} else {
    [System.Windows.Forms.MessageBox]::Show(
        'Download failed. Please check internet connection and try again.',
        'PDF Compact',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
}
