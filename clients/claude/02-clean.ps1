<#
.SYNOPSIS
  模块 2/5 — 清理联网与登录规则

.DESCRIPTION
  让 Claude Desktop 尽量不回连 Anthropic 的服务器，并清掉已有的登录态，
  强制它走本地配置（3P 模式）。

  做三件事：
    1. 注册表策略 —— 关掉非必要流量、遥测、WebFetch 预检
    2. 登录态清理 —— 删掉 claude.ai 的登录凭证和会话缓存
    3. hosts 屏蔽（可选）—— 物理层面切断其余 Anthropic 域名

.PARAMETER BlockHosts
  额外改写 hosts 文件，屏蔽 api.anthropic.com 等域名。
  注意：会让官方登录彻底失效，且改 hosts 需要管理员。

.PARAMETER Restore
  还原：删除本脚本写过的策略、恢复 hosts。

.EXAMPLE
  .\02-clean.ps1
  .\02-clean.ps1 -BlockHosts
  .\02-clean.ps1 -Restore
#>
[CmdletBinding()]
param(
    [switch]$BlockHosts,
    [switch]$Restore
)

$ErrorActionPreference = 'Stop'
function Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "        $m" -ForegroundColor DarkGray }

$regPath  = 'HKCU:\SOFTWARE\Policies\Claude'
$hosts    = "$env:SystemRoot\System32\drivers\etc\hosts"
$marker   = '# >>> fox-clean'
$backup   = Join-Path $env:LOCALAPPDATA 'Claude-China-Fox'

New-Item -ItemType Directory -Force -Path $backup | Out-Null

Write-Host ""
Write-Host "  Claude Desktop 清理器" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray

# ══════════════════════════════════════════════════════
# 还原模式
# ══════════════════════════════════════════════════════
if ($Restore) {
    Write-Host "  还原模式" -ForegroundColor Cyan

    $keys = @('disableNonessentialServices','disableNonessentialTelemetry','skipWebFetchPreflight')
    if (Test-Path $regPath) {
        foreach ($k in $keys) {
            if ((Get-ItemProperty $regPath -Name $k -ErrorAction SilentlyContinue)) {
                Remove-ItemProperty $regPath -Name $k -Force -ErrorAction SilentlyContinue
                Ok "已删除策略 $k"
            }
        }
    }

    if ((Test-Path $hosts) -and (Select-String -Path $hosts -Pattern $marker -Quiet)) {
        $c = Get-Content $hosts -Raw -Encoding UTF8
        $c = [regex]::Replace($c, "(?s)\r?\n?$([regex]::Escape($marker)).*?# <<< fox-clean", '')
        Set-Content $hosts $c -Encoding UTF8 -Force
        Ok "hosts 已清理"
    }

    Write-Host ""
    Ok "还原完成。重启 Claude Desktop 生效。"
    return
}

# ══════════════════════════════════════════════════════
# 1. 备份现有策略
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [1/3] 备份当前配置" -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
if (Test-Path $regPath) {
    $snap = Join-Path $backup "policy-before-clean-$stamp.json"
    (Get-ItemProperty $regPath).PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' } |
        ForEach-Object { [pscustomobject]@{ Name = $_.Name; Value = [string]$_.Value } } |
        ConvertTo-Json -Depth 3 | Set-Content $snap -Encoding UTF8
    Ok "策略已备份 -> $snap"
} else {
    Info "当前没有策略键，跳过备份"
}
if (Test-Path $hosts) { Copy-Item $hosts (Join-Path $backup "hosts.bak-$stamp") -Force; Info "hosts 已备份" }

# ══════════════════════════════════════════════════════
# 2. 写策略：掐掉非必要流量
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [2/3] 写入联网限制策略" -ForegroundColor Cyan

if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
$policy = [ordered]@{
    'disableNonessentialServices'  = 'true'   # 关掉特性开关拉取、变更日志、非核心请求
    'disableNonessentialTelemetry' = 'true'   # 关遥测
    'skipWebFetchPreflight'        = 'true'   # WebFetch 不再回连 api.anthropic.com 做预检
}
foreach ($k in $policy.Keys) {
    New-ItemProperty $regPath -Name $k -Value $policy[$k] -PropertyType String -Force | Out-Null
    Ok "$k = $($policy[$k])"
}

# ══════════════════════════════════════════════════════
# 3. 清登录态
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [3/3] 清理登录态" -ForegroundColor Cyan

$loginPaths = @(
    "$env:APPDATA\Claude\Cache",
    "$env:APPDATA\Claude\Code Cache",
    "$env:APPDATA\Claude\Local Storage",
    "$env:APPDATA\Claude\Session Storage",
    "$env:APPDATA\Claude\Network",
    "$env:LOCALAPPDATA\Claude-3p\Network",
    "$env:LOCALAPPDATA\Claude-3p\Session Storage"
)
Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$cleaned = 0
foreach ($p in $loginPaths) {
    if (Test-Path $p) {
        try {
            Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue |
                Remove-Item -Force -ErrorAction SilentlyContinue
            $cleaned++
            Info "已清 $p"
        } catch { Warn "清理失败: $p" }
    }
}
Ok "清理了 $cleaned 个目录"

# 凭据管理器里的 Claude 条目
$cred = cmdkey /list 2>&1 | Out-String
if ($cred -match 'claude') {
    Info "凭据管理器里有 Claude 相关条目，建议手动清理：控制面板 → 凭据管理器"
}

# ══════════════════════════════════════════════════════
# 可选：hosts 屏蔽
# ══════════════════════════════════════════════════════
if ($BlockHosts) {
    Write-Host ""
    Write-Host "  额外：hosts 屏蔽" -ForegroundColor Cyan
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Warn "改 hosts 需要管理员权限，已跳过"
    } else {
        $domains = @(
            'api.anthropic.com',
            'claude.ai',
            'console.anthropic.com',
            'statsig.anthropic.com',
            'sentry.io'
        )
        $block = "`n$marker`n" + (($domains | ForEach-Object { "127.0.0.1 $_`n0.0.0.0 $_" }) -join "`n") + "`n# <<< fox-clean`n"
        $cur = Get-Content $hosts -Raw -Encoding UTF8
        if ($cur -notmatch [regex]::Escape($marker)) {
            Add-Content $hosts $block -Encoding UTF8 -Force
            Ok "已屏蔽 $($domains.Count) 个域名"
        } else { Info "hosts 已有屏蔽记录，跳过" }
        & ipconfig /flushdns 2>&1 | Out-Null
        Ok "DNS 缓存已刷新"
    }
}

Write-Host ""
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Ok "清理完成"
Info "下一步: .\03-key.ps1 -Provider deepseek -Key sk-xxxx"
Info "还原:   .\02-clean.ps1 -Restore"
