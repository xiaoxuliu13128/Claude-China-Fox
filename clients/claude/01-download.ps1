<#
.SYNOPSIS
  模块 1/5 — 下载并安装 Claude Desktop（绕地区封锁）

.DESCRIPTION
  claude.ai/api/desktop/... 在中国大陆返回 region_unavailable。
  但 winget 清单里的下载域名 downloads.claude.ai 只做了网络阻断，没做地区判定，
  挂代理就能拉。本脚本自动从 winget 清单取真实地址 + 官方 SHA256，下载后双校验
  （哈希 + 数字签名），校验不过直接中止。

.PARAMETER Proxy
  下载用的 HTTP 代理，如 http://127.0.0.1:18081。缺省则直连（大概率失败）。

.PARAMETER Version
  指定版本号，如 4.29.0。缺省则用 winget 清单里的最新版。

.PARAMETER Install
  下载完成后直接静默安装。

.EXAMPLE
  .\01-download.ps1 -Proxy http://127.0.0.1:18081 -Install
#>
[CmdletBinding()]
param(
    [string]$Proxy,
    [string]$Version,
    [switch]$Install,
    [string]$OutDir = "$env:USERPROFILE\Downloads"
)

$ErrorActionPreference = 'Stop'
function Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "        $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  Claude Desktop 下载器" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray

# ── 已装？ ────────────────────────────────────────────
$installed = "$env:LOCALAPPDATA\AnthropicClaude"
if (Test-Path $installed) {
    $vers = Get-ChildItem $installed -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Name -replace '^app-','' }
    Info "已安装版本: $($vers -join ', ')"
    Info "位置: $installed"
    if (-not $Install) {
        Warn "已安装。重装请加 -Install，或先手动卸载。"
    }
}

# ── 从 winget 清单拿地址和哈希 ────────────────────────
Write-Host ""
Write-Host "  [1/3] 查询官方清单" -ForegroundColor Cyan
$url = $null; $sha = $null; $ver = $null

try {
    $w = & winget show Anthropic.Claude --accept-source-agreements 2>&1 | Out-String
    if ($w -match '安装程序 URL[:：]\s*(\S+)')   { $url = $Matches[1].Trim() }
    if ($w -match '安装程序 SHA256[:：]\s*(\w+)') { $sha = $Matches[1].Trim() }
    if ($w -match '版本:\s*(\S+)')                { $ver = $Matches[1].Trim() }
} catch { Warn "winget 查询失败: $($_.Exception.Message)" }

if (-not $url) {
    Warn "拿不到官方地址。降级为手工输入。"
    $url = Read-Host "  粘贴下载地址（downloads.claude.ai/...）"
}
if (-not $sha) { Warn "没有官方 SHA256，下载后只能验签名" }

if ($Version -and $url -match '/x64/([\d.]+)/') { $ver = $Version }
Write-Output "  版本   : $ver"
Write-Output "  地址   : $url"
Write-Output "  SHA256 : $(if ($sha) { $sha.Substring(0,16) + '...' } else { '(无)' })"

# ── 下载 ──────────────────────────────────────────────
Write-Host ""
Write-Host "  [2/3] 下载" -ForegroundColor Cyan
$fileName = "Claude-Desktop-$ver.exe"
$outPath  = Join-Path $OutDir $fileName
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$curlArgs = @('-L','--retry','3','--retry-delay','2','-m','1800','-o',$outPath, $url, '-w','%{http_code} %{size_download}')
if ($Proxy) { $curlArgs = @('-x',$Proxy) + $curlArgs ; Info "经代理: $Proxy" }
else { Warn "未指定 -Proxy，直连大概率失败" }

$curl = "$env:SystemRoot\System32\curl.exe"
$res = & $curl @curlArgs 2>&1 | Out-String
Write-Output "  curl: $($res.Trim())"

if (-not (Test-Path $outPath)) { throw "下载失败：文件不存在" }
$size = (Get-Item $outPath).Length
if ($size -lt 50MB) { throw "下载不完整：只有 $([math]::Round($size/1MB,1)) MB（正常约 237 MB）" }
Ok "下载完成 $([math]::Round($size/1MB,1)) MB -> $outPath"

# ── 双校验 ────────────────────────────────────────────
Write-Host ""
Write-Host "  [3/3] 校验" -ForegroundColor Cyan
$fail = $false

if ($sha) {
    $actual = (Get-FileHash $outPath -Algorithm SHA256).Hash
    if ($actual -eq $sha.ToUpper()) { Ok "SHA256 与官方清单一致" }
    else { Warn "SHA256 不匹配！"; Write-Output "    期望: $sha"; Write-Output "    实际: $actual"; $fail = $true }
} else { Warn "跳过哈希校验（没有官方值）" }

$sig = Get-AuthenticodeSignature $outPath
if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Anthropic') {
    Ok "数字签名有效：Anthropic, PBC"
} else {
    Warn "签名异常：$($sig.Status) / $($sig.SignerCertificate.Subject)"
    $fail = $true
}

if ($fail) { throw "校验失败，已中止。文件保留在 $outPath 供你人工检查" }

# ── 安装 ──────────────────────────────────────────────
if ($Install) {
    Write-Host ""
    Write-Host "  安装中（NSIS 静默，实测约 13 分钟）..." -ForegroundColor Cyan
    Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $outPath -ArgumentList '/S' -Wait -PassThru
    $sw.Stop()
    Ok "安装完成 exit=$($p.ExitCode)  耗时 $([math]::Round($sw.Elapsed.TotalMinutes,1)) 分钟"
    $installedVers = Get-ChildItem $installed -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name -replace '^app-','' }
    Info "已装版本: $($installedVers -join ', ')"
    Info "下一步: .\02-clean.ps1   （清理联网和登录规则）"
} else {
    Write-Host ""
    Ok "下载完成。加 -Install 参数可直接安装，或运行："
    Info "  $outPath"
}
