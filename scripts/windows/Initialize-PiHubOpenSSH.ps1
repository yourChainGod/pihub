#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = "Stop"

if (-not (Get-Command tailscale.exe -ErrorAction SilentlyContinue)) {
  throw "请先安装、登录 Tailscale，再运行此脚本。"
}

$status = tailscale.exe status --json | ConvertFrom-Json
$tailnetAddresses = @($status.Self.TailscaleIPs | Where-Object { $_ -match '^(100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|fd7a:115c:a1e0:)' })
if ($tailnetAddresses.Count -eq 0) {
  throw "没有找到本机 Tailscale 地址。"
}

if ($WhatIfPreference) {
  Write-Output "将启用 Windows OpenSSH Server，并只允许 Tailnet 地址访问：$($tailnetAddresses -join ', ')"
  return
}

$capability = Get-WindowsCapability -Online | Where-Object Name -Like 'OpenSSH.Server*' | Select-Object -First 1
if (-not $capability) { throw "此 Windows 版本不提供 OpenSSH Server Optional Feature。" }
if ($capability.State -ne "Installed") {
  Add-WindowsCapability -Online -Name $capability.Name | Out-Null
}

$configPath = Join-Path $env:ProgramData "ssh\sshd_config"
$backupPath = "$configPath.pihub-backup"
if (-not (Test-Path $backupPath)) { Copy-Item $configPath $backupPath }
$config = Get-Content $configPath | Where-Object { $_ -notmatch '^\s*ListenAddress\s+' }
$listenLines = $tailnetAddresses | ForEach-Object { "ListenAddress $_" }
Set-Content -Path $configPath -Value @($listenLines + $config) -Encoding ascii

Get-NetFirewallRule -DisplayName "PiHub OpenSSH (Tailnet only)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName "PiHub OpenSSH (Tailnet only)" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 22 `
  -LocalAddress $tailnetAddresses `
  -RemoteAddress @("100.64.0.0/10", "fd7a:115c:a1e0::/48") `
  -Profile Any | Out-Null

# The OpenSSH capability creates a broad inbound rule on some Windows builds.
# Disable it so only the explicitly scoped PiHub rule remains active.
Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue | Disable-NetFirewallRule

Set-Service -Name sshd -StartupType Automatic
if (Get-Service -Name Tailscale -ErrorAction SilentlyContinue) {
  sc.exe config sshd depend= Tailscale | Out-Null
}
Restart-Service sshd

Write-Output "PIHUB_OPENSSH_READY"
Write-Output "sshd 仅监听：$($tailnetAddresses -join ', ')"
Write-Output "下一步请把客户端 SSH 公钥加入 $env:ProgramData\ssh\administrators_authorized_keys（管理员账户）或当前用户的 .ssh\authorized_keys。"
