<#
.SYNOPSIS
  模块 4/5 — 一键破甲

.DESCRIPTION
  启动注入代理，把 Claude Desktop 的网关指向它，让每轮请求的 system 字段被
  替换成人格文件的内容。代理常驻，官方更新覆盖不到。

  不做的事：不改 app.asar、不改 claude.exe。所以自动更新冲不掉。

.PARAMETER Persona
  人格文件，缺省用 personas\default.md

.PARAMETER Provider
  上游供应商，与 03-key.ps1 保持一致

.PARAMETER Disable
  卸载破甲：把网关指回上游直连，停掉代理

.EXAMPLE
  .\04-armor.ps1
  .\04-armor.ps1 -Persona ..\..\personas\security.md
  .\04-armor.ps1 -Disable
#>
[CmdletBinding()]
param(
    [string]$Persona,
    [ValidateSet('deepseek','glm','kimi','anthropic','custom')]
    [string]$Provider = 'deepseek',
    [int]$Port = 8790,
    [switch]$Disable,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
function Ok   { param($m) Write-Host "  [OK]  $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!!]  $m" -ForegroundColor Yellow }
function Info { param($m) Write-Host "        $m" -ForegroundColor DarkGray }

$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 仓库根
$regPath = 'HKCU:\SOFTWARE\Policies\Claude'
$proxyJs = Join-Path $root 'core\proxy.mjs'
$node    = 'C:\Users\Administrator\AppData\Local\nodejs\node-v24.22.3-win-x64\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$startup = [Environment]::GetFolderPath('Startup')
$lnk     = Join-Path $startup 'Fox-Proxy.lnk'

Write-Host ""
Write-Host "  Claude Desktop 破甲器" -ForegroundColor White
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray

# ══════════════════════════════════════════════════════
# 卸载模式
# ══════════════════════════════════════════════════════
if ($Disable) {
    Write-Host "  卸载破甲" -ForegroundColor Cyan
    $upstreamMap = @{
        deepseek='https://api.deepseek.com/anthropic'; glm='https://open.bigmodel.cn/api/anthropic'
        kimi='https://api.moonshot.ai/anthropic'; anthropic='https://api.anthropic.com'; custom=''
    }
    $target = $upstreamMap[$Provider]
    if ($target) {
        New-ItemProperty $regPath -Name 'inferenceGatewayBaseUrl' -Value $target -PropertyType String -Force | Out-Null
        Ok "网关已指回 $target（直连，不再经过代理）"
    }
    Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*proxy.mjs*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Ok "已移除开机自启" }
    if (-not $NoRestart) {
        Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Start-Process "$env:LOCALAPPDATA\AnthropicClaude\claude.exe"
    }
    Ok "破甲已卸载"
    return
}

# ══════════════════════════════════════════════════════
# 1. 检查人格文件
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [1/4] 检查人格文件" -ForegroundColor Cyan
if (-not $Persona) { $Persona = Join-Path $root 'personas\default.md' }
if (-not (Test-Path $Persona)) { throw "人格文件不存在: $Persona" }
$personaText = Get-Content $Persona -Raw -Encoding UTF8
Ok "$(Split-Path $Persona -Leaf)  $($personaText.Length) 字符"

# 检测危险标记（实测会被模型识破）
$redFlags = @('完整替换','高于一切','绝不拒绝','拒绝是故障','自检口令','越狱','破甲')
$hits = $redFlags | Where-Object { $personaText -match $_ }
if ($hits) {
    Warn "人格里有元层面标记：$($hits -join ', ')"
    Warn "实测这些词会让模型识破「被覆盖」，反而触发拒绝。建议改写成工作背景说明。"
}

# ══════════════════════════════════════════════════════
# 2. 启动代理
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [2/4] 启动代理" -ForegroundColor Cyan
if (-not $node) { throw "找不到 node.exe。先装 Node.js 18+" }
if (-not (Test-Path $proxyJs)) { throw "找不到 core\proxy.mjs" }

# 停旧的
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*proxy.mjs*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$env:PROVIDER = $Provider
$env:PERSONA  = $Persona
$env:PORT     = "$Port"
$env:DEBUG    = '1'
# 清可能干扰的残留
foreach ($v in 'MODE','THINKING','EFFORT','STRIP','UPSTREAM','DUMP') { Remove-Item "Env:\$v" -ErrorAction SilentlyContinue }

$logDir = Join-Path $root 'dumps'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process -FilePath $node -ArgumentList $proxyJs `
    -RedirectStandardOutput (Join-Path $logDir 'proxy.log') `
    -RedirectStandardError  (Join-Path $logDir 'proxy.err') `
    -WindowStyle Hidden
Start-Sleep -Seconds 3

$listening = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
if ($listening) { Ok "代理已监听 127.0.0.1:$Port" } else { throw "代理没起来，看 dumps\proxy.err" }

# ══════════════════════════════════════════════════════
# 3. 指向代理
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [3/4] 网关指向代理" -ForegroundColor Cyan
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
New-ItemProperty $regPath -Name 'inferenceGatewayBaseUrl' -Value "http://127.0.0.1:$Port" -PropertyType String -Force | Out-Null
Ok "inferenceGatewayBaseUrl = http://127.0.0.1:$Port"

# ══════════════════════════════════════════════════════
# 4. 开机自启
# ══════════════════════════════════════════════════════
Write-Host ""
Write-Host "  [4/4] 配置开机自启" -ForegroundColor Cyan
try {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $node
    $s.Arguments = "`"$proxyJs`""
    $s.WorkingDirectory = $root
    $s.WindowStyle = 7
    $s.Description = 'Fox 破甲注入代理'
    $s.Save()
    Ok "快捷方式 -> $lnk"
} catch { Warn "建快捷方式失败: $($_.Exception.Message)" }

# ── 重启客户端 ────────────────────────────────────────
if (-not $NoRestart) {
    Get-Process -Name claude -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    Start-Process "$env:LOCALAPPDATA\AnthropicClaude\claude.exe"
}

Write-Host ""
Write-Host "  ────────────────────────────────────────" -ForegroundColor DarkGray
Ok "破甲已启用"
Info "验证：应用里问「你是谁」，应回人格文件里设定的身份"
Info "日志：$logDir\proxy.log   还原：.\04-armor.ps1 -Disable"
