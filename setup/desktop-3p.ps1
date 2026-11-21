<#
.SYNOPSIS
  把 Claude Desktop（Code 标签那个完整客户端）接到第三方模型
.DESCRIPTION
  写入 HKCU\SOFTWARE\Policies\Claude 托管策略，应用启动时读取，进入第三方模式。
  托管配置生效后应用不需要 claude.ai 账号，登录页直接消失。

.EXAMPLE
  .\desktop-3p.ps1 -Provider deepseek -Key sk-xxxx
  .\desktop-3p.ps1 -Provider glm -Key xxxx.xxxx
  .\desktop-3p.ps1 -Provider kimi -Key sk-xxxx
  .\desktop-3p.ps1 -Show
  .\desktop-3p.ps1 -Reset
#>
[CmdletBinding()]
param(
    [ValidateSet('deepseek','glm','kimi','custom','')]
    [string]$Provider = '',
    [string]$Key,
    [string]$BaseUrl,
    [string]$Models,
    [switch]$Show,
    [switch]$Reset,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$regPath = 'HKCU:\SOFTWARE\Policies\Claude'
$exe = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'

function Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "        $m" -ForegroundColor DarkGray }

function Restart-App {
    if ($NoRestart) { Info "跳过重启（-NoRestart），改动在下次启动生效"; return }
    Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    if (Test-Path $exe) {
        Start-Process $exe
        Info "已重启 Claude Desktop（配置在启动时读取）"
    } else {
        Warn "找不到 $exe"
    }
}

if ($Reset) {
    if (Test-Path $regPath) {
        Remove-Item $regPath -Recurse -Force
        Ok "已删除 HKCU\SOFTWARE\Policies\Claude —— 应用会回到标准模式（要求 claude.ai 登录）"
    } else { Info "策略键不存在，无需清除" }
    Restart-App
    return
}

if ($Show -or ($Provider -eq '' -and -not $Key)) {
    if (-not (Test-Path $regPath)) {
        Warn "没有托管策略，应用当前是标准模式（需要 claude.ai 账号）"
        Info "接第三方：.\desktop-3p.ps1 -Provider deepseek -Key sk-xxxx"
        return
    }
    Info "HKCU\SOFTWARE\Policies\Claude："
    (Get-ItemProperty $regPath).PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' } |
        ForEach-Object {
            $v = [string]$_.Value
            if ($_.Name -match 'ApiKey|Token' -and $v.Length -gt 12) { $v = $v.Substring(0,8) + '****' + $v.Substring($v.Length-4) }
            Write-Host ("  {0,-32} = {1}" -f $_.Name, $v)
        }
    return
}

$presets = @{
    deepseek = @{
        baseUrl = 'https://api.deepseek.com/anthropic'
        models  = '["deepseek-v4-pro","deepseek-flash"]'
    }
    glm = @{
        baseUrl = 'https://open.bigmodel.cn/api/anthropic'
        models  = '["glm-5.3[1m]","glm-5.3-flash[1m]"]'
    }
    kimi = @{
        baseUrl = 'https://api.moonshot.ai/anthropic'
        models  = '["kimi-k3[1m]"]'
    }
    custom = @{ baseUrl = $BaseUrl; models = $Models }
}

if (-not $presets.ContainsKey($Provider)) { Warn "未知 Provider: $Provider"; return }
if ([string]::IsNullOrWhiteSpace($Key)) { Warn "缺 -Key"; return }

$p = $presets[$Provider]
$finalUrl = if ($p.baseUrl) { $p.baseUrl } else { $BaseUrl }
$finalModels = if ($Models) { $Models } else { $p.models }
if ([string]::IsNullOrWhiteSpace($finalUrl)) { Warn "缺 -BaseUrl"; return }

if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }

$values = [ordered]@{
    'inferenceProvider'           = 'gateway'
    'inferenceGatewayBaseUrl'     = $finalUrl
    'inferenceGatewayApiKey'      = $Key
    'inferenceGatewayAuthScheme'  = 'bearer'
    'deploymentMode'              = '3p'      # 去掉 claude.ai 登录入口
    'disableNonessentialServices' = 'true'
    'disableNonessentialTelemetry'= 'true'
    'skipWebFetchPreflight'       = 'true'
}
if ($finalModels) { $values['inferenceModels'] = $finalModels }

foreach ($k in $values.Keys) {
    New-ItemProperty -Path $regPath -Name $k -Value ([string]$values[$k]) -PropertyType String -Force | Out-Null
}

Ok "已写入托管策略"
Info "provider : $Provider"
Info "base url : $finalUrl"
Info "models   : $finalModels"
Info "key      : $($Key.Substring(0,[Math]::Min(8,$Key.Length)))****"

Restart-App
Write-Host ""
Info "验证：应用右上角不应再出现红色 'Couldn't sign in to Gateway'；"
Info "左侧栏点进 Code 标签即可用图形界面跑 Claude Code。"
