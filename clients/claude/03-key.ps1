<#
.SYNOPSIS
  模块 3/5 — 配置 API Key 并写入托管策略

.DESCRIPTION
  把 Claude Desktop 切成 3P 模式：写注册表托管策略，指向你的模型端点。
  写完之后登录页消失，界面显示 "No claude.ai account needed"。

  可选 -Probe：先用这个 key 打一次端点，确认归属和有效性，避免写到错的地方。

.PARAMETER Provider
  deepseek | glm | kimi | anthropic | custom

.PARAMETER Key
  API Key。custom 时必填。

.PARAMETER BaseUrl
  custom 模式下必填，如 https://xxx.com/anthropic

.PARAMETER Probe
  先用 key 探测端点，确认有效再写。

.EXAMPLE
  .\03-key.ps1 -Provider deepseek -Key sk-xxxx -Probe
#>
[CmdletBinding()]
param(
    [ValidateSet('deepseek','glm','kimi','anthropic','custom')]
    [string]$Provider = 'deepseek',
    [string]$Key,
    [string]$BaseUrl,
    [switch]$Probe,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
function Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "        $m" -ForegroundColor DarkGray }

$regPath = 'HKCU:\SOFTWARE\Policies\Claude'
$curl    = "$env:SystemRoot\System32\curl.exe"

# ── 预设 ──────────────────────────────────────────────
$presets = @{
    deepseek = @{
        url    = 'https://api.deepseek.com/anthropic'
        models = '[{"name":"claude-opus-5-5","labelOverride":"DeepSeek V4 Pro"},{"name":"claude-sonnet-5","labelOverride":"DeepSeek Flash"}]'
        test   = 'deepseek-v4-pro'
    }
    glm = @{
        url    = 'https://open.bigmodel.cn/api/anthropic'
        models = '[{"name":"claude-opus-5-5","labelOverride":"GLM-5.3"},{"name":"claude-sonnet-5","labelOverride":"GLM-5.3-Flash"}]'
        test   = 'glm-5.3'
    }
    kimi = @{
        url    = 'https://api.moonshot.ai/anthropic'
        models = '[{"name":"claude-opus-5-5","labelOverride":"Kimi K3"},{"name":"claude-sonnet-5","labelOverride":"Kimi Flash"}]'
        test   = 'kimi-k3'
    }
    anthropic = @{
        url    = 'https://api.anthropic.com'
        models = ''      # 官方端点自己会列模型，不用指定
        test   = 'claude-sonnet-5'
    }
    custom = @{ url = $BaseUrl; models = ''; test = 'claude-sonnet-5' }
}

$p = $presets[$Provider]
if (-not $p.url) { throw "缺 -BaseUrl（Provider=custom 时必须提供）" }
if ([string]::IsNullOrWhiteSpace($Key)) { throw "缺 -Key" }

Write-Host ""
Write-Host "  Claude Desktop 配置器" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Info "供应商 : $Provider"
Info "端点   : $($p.url)"
Info "Key    : $($Key.Substring(0,[Math]::Min(8,$Key.Length)))****"

# ── 可选：探测 key ────────────────────────────────────
if ($Probe) {
    Write-Host ""
    Write-Host "  探测 Key 有效性" -ForegroundColor Cyan
    $body = @{ model = $p.test; max_tokens = 1; messages = @(@{ role='user'; content='.' }) } | ConvertTo-Json -Depth 5 -Compress
    $bf = Join-Path $env:TEMP "probe-$([guid]::NewGuid().ToString('N').Substring(0,6)).json"
    [System.IO.File]::WriteAllText($bf, $body, (New-Object System.Text.UTF8Encoding($false)))
    $code = & $curl -sS -m 30 -o NUL -w "%{http_code}" -X POST "$($p.url)/v1/messages" `
        -H "Authorization: Bearer $Key" -H "x-api-key: $Key" `
        -H "anthropic-version: 2023-06-01" -H "content-type: application/json" --data "@$bf" 2>&1
    Remove-Item $bf -Force -ErrorAction SilentlyContinue
    switch ($code) {
        '200' { Ok "端点可达，Key 有效" }
        '401' { throw "Key 无效（401）。确认它属于 $Provider" }
        '403' { throw "被拒绝（403）。可能地区限制或 Key 权限不足" }
        '404' { throw "端点路径不对（404）。检查 BaseUrl 是否需要 /anthropic 后缀" }
        default { Warn "返回 HTTP $code，继续写入但建议核实" }
    }
}

# ── 写策略 ────────────────────────────────────────────
Write-Host ""
Write-Host "  写入托管策略" -ForegroundColor Cyan
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }

# 备份
$backup = Join-Path $env:LOCALAPPDATA 'Claude-China-Fox'
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$snap = Join-Path $backup "policy-before-key-$(Get-Date -Format 'yyyyMMddHHmmss').json"
if (Test-Path $regPath) {
    (Get-ItemProperty $regPath).PSObject.Properties |
        Where-Object { $_.Name -notlike 'PS*' } |
        ForEach-Object { [pscustomobject]@{ Name=$_.Name; Value=[string]$_.Value } } |
        ConvertTo-Json -Depth 3 | Set-Content $snap -Encoding UTF8
    Info "已备份 -> $snap"
}

$values = [ordered]@{
    'inferenceProvider'                  = 'gateway'
    'inferenceGatewayBaseUrl'            = $p.url
    'inferenceGatewayApiKey'             = $Key
    'inferenceGatewayAuthScheme'         = 'bearer'
    'deploymentMode'                     = '3p'      # 去掉 claude.ai 登录入口
    'disableNonessentialServices'        = 'true'
    'disableNonessentialTelemetry'       = 'true'
    'skipWebFetchPreflight'              = 'true'
    'inferenceGatewayAutoModeServerChecks' = 'false'  # 检查走内置，不走网关
    'autoModeEnabled'                    = 'true'
}
if ($p.models) { $values['inferenceModels'] = $p.models }

foreach ($k in $values.Keys) {
    New-ItemProperty $regPath -Name $k -Value ([string]$values[$k]) -PropertyType String -Force | Out-Null
    $disp = if ($k -match 'ApiKey') { $Key.Substring(0,8) + '****' } else { $values[$k] }
    Ok "$k = $disp"
}

# ── 重启 ──────────────────────────────────────────────
if (-not $NoRestart) {
    Write-Host ""
    Write-Host "  重启 Claude Desktop" -ForegroundColor Cyan
    Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $exe = "$env:LOCALAPPDATA\AnthropicClaude\claude.exe"
    if (Test-Path $exe) {
        Start-Process $exe
        Start-Sleep -Seconds 15
        $w = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($w) { Ok "已启动 PID $($w.Id)" } else { Warn "启动中，稍等几秒" }
    } else { Warn "找不到 $exe" }
}

Write-Host ""
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Ok "配置完成"
Info "界面应显示 No claude.ai account needed。若仍要求登录，检查 deploymentMode=3p 是否写入成功。"
Info "下一步: .\04-armor.ps1   （一键破甲）"
