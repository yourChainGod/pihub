$ErrorActionPreference = 'Stop'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('pihub-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
try {
  Write-Output '[pihub] 已连接，正在准备 GitHub 签名版服务…'

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw 'Node.js 22.19+ is required'
  }
  & $nodeCommand.Source -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=19)?0:1)'
  if ($LASTEXITCODE -ne 0) {
    throw 'Node.js 22.19+ is required'
  }

  $tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
  if (-not $tailscale) {
    $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  }
  if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
    throw 'Tailscale is required'
  }

  $settings = Join-Path $env:USERPROFILE '.pi\agent\settings.json'
  if (Test-Path -LiteralPath $settings -PathType Leaf) {
    $settingsText = [IO.File]::ReadAllText($settings)
    if ($settingsText.Contains('pi-provider-newapi-hdd')) {
      Copy-Item -LiteralPath $settings -Destination ($settings + '.pihub-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
      $value = $settingsText | ConvertFrom-Json
      $value.packages = @($value.packages | Where-Object { -not ([string]$_).Contains('pi-provider-newapi-hdd') })
      [IO.File]::WriteAllText($settings, (($value | ConvertTo-Json -Depth 64) + "`n"), [Text.UTF8Encoding]::new($false))
      Write-Output 'PIHUB_LEGACY_PROVIDER_REMOVED'
    }
  }

  $installer = Join-Path $tmp 'pihub-standalone-bootstrap.mjs'
  [IO.File]::WriteAllBytes($installer, [Convert]::FromBase64String('__STANDALONE_BOOTSTRAP__'))
  if ('__INSTALL_EXTENSIONS__' -eq '1') {
    & $nodeCommand.Source $installer '--with-extensions'
  } else {
    & $nodeCommand.Source $installer
  }
  if ($LASTEXITCODE -ne 0) {
    throw 'Signed PiHub Server installation failed'
  }

  $serveOut = Join-Path $tmp 'serve.out'
  $serveErr = Join-Path $tmp 'serve.err'
  $serve = Start-Process `
    -FilePath $tailscale `
    -ArgumentList @('serve', '--bg', '--https=30141', 'http://127.0.0.1:30141') `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $serveOut `
    -RedirectStandardError $serveErr

  $finished = $serve.WaitForExit(15000)
  if (-not $finished) {
    $serve.Kill()
    $serve.WaitForExit()
  }

  $serveOutput = (@(
    Get-Content -Raw -LiteralPath $serveOut -ErrorAction SilentlyContinue
    Get-Content -Raw -LiteralPath $serveErr -ErrorAction SilentlyContinue
  ) -join "`n").Trim()
  $approval = [regex]::Match($serveOutput, 'https://login\.tailscale\.com/\S+').Value.TrimEnd(')', ']', '}', ',', '.', ';')

  if ($approval) {
    Write-Output "PIHUB_SERVE_APPROVAL=$approval"
  } elseif (-not $finished -or $serve.ExitCode -ne 0) {
    throw "Tailscale Serve configuration failed: $serveOutput"
  }

  Write-Output 'PIHUB_BOOTSTRAP_OK'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
