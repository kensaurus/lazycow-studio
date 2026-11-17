<#
  Lazycow Studio: can this PC run it? The check before anything is downloaded. Needs nothing but Windows.

  One line, in PowerShell:
    irm https://raw.githubusercontent.com/kensaurus/lazycow-studio/main/scripts/bootstrap/doctor.ps1 | iex
  From the studio folder (windows.ps1 runs this as its step 1):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap\doctor.ps1 [-Json] [-Dir <folder>]

  The core of `npx lazycow doctor` (packages/lazycow/lib/doctor.mjs), same numbers: 64-bit Windows, processor threads,
  memory, free disk where the studio goes, and whether each download host answers (HEAD, 5 s, all at once).
  Exit code 0 READY, 1 SLOW, 2 BLOCKED. Windows PowerShell 5.1 and plain ASCII, like windows.ps1.
  No param() block, so the one-line `irm | iex` form works; flags are read from $args when run as a file.
#>
$ErrorActionPreference = "Continue"
$LcArgs = @($args)
$LcJson = $LcArgs -contains "-Json"
$LcDir = $env:LOCALAPPDATA
$i = [Array]::IndexOf($LcArgs, "-Dir")
if ($i -ge 0 -and $LcArgs.Count -gt $i + 1) { $LcDir = [string]$LcArgs[$i + 1] }

# The studio's limits (server/health.mjs LIMITS) and the install's needs (doctor.mjs INSTALL).
$ThreadsMin = 4; $ThreadsSlow = 8
$RamMin = 6; $RamSlow = 12
$InstallGb = 6; $RendersGb = 20
$DownloadGb = 1.3

# Download hosts (doctor.mjs HOSTS): name, url, what, 1 = the install needs it (else a feature waits).
$LcHosts = @(
  @("github.com", "https://github.com/", "the studio, uv, Python, ffmpeg", 1),
  @("release-assets.githubusercontent.com", "https://release-assets.githubusercontent.com/", "GitHub release downloads", 1),
  @("nodejs.org", "https://nodejs.org/dist/", "Node", 1),
  @("pypi.org", "https://pypi.org/simple/", "Python package index", 1),
  @("files.pythonhosted.org", "https://files.pythonhosted.org/", "Python packages", 1),
  @("download.pytorch.org", "https://download.pytorch.org/whl/cpu/", "PyTorch (footage search)", 1),
  @("registry.npmjs.org", "https://registry.npmjs.org/", "the studio's npm packages", 1),
  @("huggingface.co", "https://huggingface.co/", "the footage-search model", 0),
  @("raw.githubusercontent.com", "https://raw.githubusercontent.com/", "the picture-quality model", 0),
  @("api.openverse.org", "https://api.openverse.org/v1/", "free music", 0)
)

$LcChecks = New-Object System.Collections.ArrayList
function Add-LcCheck([string]$id, [string]$level, [string]$label, [string]$found, [string]$fix) {
  [void]$LcChecks.Add([pscustomobject]@{ id = $id; level = $level; label = $label; found = $found; fix = $fix })
}

# System
$build = [Environment]::OSVersion.Version.Build
$osName = if ($build -ge 22000) { "Windows 11" } else { "Windows 10" }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$archName = switch ($arch) { "AMD64" { "x64" } "ARM64" { "arm64" } default { "x86" } }
if (-not [Environment]::Is64BitOperatingSystem) { Add-LcCheck "system" "blocked" "System" "$osName 32-bit" "Lazycow needs 64-bit Windows 10 or 11." }
elseif ($build -lt 17134) { Add-LcCheck "system" "blocked" "System" "Windows build $build" "Update Windows to 10 version 1803 or newer (the setup needs its built-in curl)." }
elseif ($archName -eq "arm64") { Add-LcCheck "system" "slow" "System" "$osName on ARM" "The setup's tools are x64 builds, so they run under Windows' emulation: everything works, more slowly." }
else { Add-LcCheck "system" "ok" "System" "$osName, 64-bit" "" }

# Processor
$threads = [Environment]::ProcessorCount
$cpu = ""
try { $cpu = ((Get-CimInstance Win32_Processor | Select-Object -First 1).Name -replace '\s+', ' ').Trim() } catch { }
if ($threads -lt $ThreadsMin) { Add-LcCheck "cpu" "blocked" "Processor" "$threads threads $cpu" "Rendering would take well over half an hour a reel. Use a computer with at least 4 cores / 8 threads." }
elseif ($threads -lt $ThreadsSlow) { Add-LcCheck "cpu" "slow" "Processor" "$threads threads $cpu" "Reels render, slowly. Close other heavy apps while the studio renders." }
else { Add-LcCheck "cpu" "ok" "Processor" "$threads threads $cpu" "" }

# Memory
$ramGb = 0
try { $ramGb = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB } catch { }
$ramText = "{0:N0} GB" -f $ramGb
if ($ramGb -eq 0) { Add-LcCheck "ram" "ok" "Memory" "unknown" "" }
elseif ($ramGb -lt $RamMin) { Add-LcCheck "ram" "blocked" "Memory" $ramText "The footage search and the renderer need about 4 GB together. Use a computer with 8 GB or more." }
elseif ($ramGb -lt $RamSlow) { Add-LcCheck "ram" "slow" "Memory" $ramText "Close browser tabs and other apps before making several reels at once." }
else { Add-LcCheck "ram" "ok" "Memory" $ramText "" }

# Free disk where the studio goes
$root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($LcDir))
$freeGb = $null
try { $freeGb = (New-Object IO.DriveInfo($root)).AvailableFreeSpace / 1GB } catch { }
$drive = $root.TrimEnd('\')
$needs = "(needs $InstallGb GB to install, $RendersGb GB for renders)"
if ($null -eq $freeGb) { Add-LcCheck "disk" "ok" "Free space on $drive" "unknown $needs" "" }
elseif ($freeGb -lt $InstallGb) { Add-LcCheck "disk" "blocked" "Free space on $drive" ("{0:N0} GB $needs" -f $freeGb) "Free at least $InstallGb GB there, or install to a bigger drive." }
elseif ($freeGb -lt ($InstallGb + $RendersGb)) { Add-LcCheck "disk" "slow" "Free space on $drive" ("{0:N0} GB $needs" -f $freeGb) "It installs, with room for only a few reels. Free up space, or put the studio's data on a bigger drive." }
else { Add-LcCheck "disk" "ok" "Free space on $drive" ("{0:N0} GB $needs" -f $freeGb) "" }

# Download hosts: one HEAD each, all at once, 5 s. Any HTTP answer counts; only silence does not.
$down = @(); $hardDown = 0; $okCount = 0
try {
  Add-Type -AssemblyName System.Net.Http
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(5)
  $tasks = @()
  foreach ($h in $LcHosts) { $tasks += $client.SendAsync((New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Head, $h[1]))) }
  try { [void][System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks, 7000) } catch { }
  for ($k = 0; $k -lt $LcHosts.Count; $k++) {
    if ($tasks[$k].Status -eq "RanToCompletion") { $okCount++ }
    else { $down += ($LcHosts[$k][0] + " (" + $LcHosts[$k][2] + ")"); if ($LcHosts[$k][3] -eq 1) { $hardDown++ } }
  }
} catch { $down = @("(could not test: " + $_.Exception.Message + ")"); $hardDown = 0 }
if ($down.Count -eq 0) { Add-LcCheck "net" "ok" "Downloads reachable" ("github.com, nodejs.org, pypi.org, ... ({0} of {1})" -f $okCount, $LcHosts.Count) "" }
elseif ($hardDown -gt 0) { Add-LcCheck "net" "blocked" "Downloads" ("no answer from " + ($down -join ", ")) "The install cannot finish without these. Check the internet connection; on a work or school network, ask for these sites to be allowed." }
else { Add-LcCheck "net" "slow" "Downloads" ("no answer from " + ($down -join ", ")) "The install works; the features named wait until these answer. Check a firewall or proxy." }

# Verdict
$rank = @{ ok = 0; slow = 1; blocked = 2 }
$top = 0
foreach ($c in $LcChecks) { if ($rank[$c.level] -gt $top) { $top = $rank[$c.level] } }
$verdict = @("READY", "SLOW", "BLOCKED")[$top]
$worst = @($LcChecks | Where-Object { $rank[$_.level] -eq $top -and $top -gt 0 })
$reason = ($worst | ForEach-Object { $_.label + ": " + $_.found }) -join "; "
$fixText = ($worst | Where-Object { $_.fix } | ForEach-Object { $_.fix }) -join " "

if ($LcJson) {
  [pscustomobject]@{ verdict = $verdict; exitCode = $top; checks = $LcChecks; threads = $threads; ramGb = [Math]::Round($ramGb, 1); freeGb = $freeGb } | ConvertTo-Json -Depth 4
} else {
  Write-Host ("Lazycow check - {0} {1} - {2} threads - {3:N0} GB RAM" -f $osName, $archName, $threads, $ramGb)
  foreach ($c in $LcChecks) {
    $mark = switch ($c.level) { "ok" { "[ok]" } "slow" { "[! ]" } default { "[XX]" } }
    $color = switch ($c.level) { "ok" { "Green" } "slow" { "Yellow" } default { "Red" } }
    $sep = if ($c.label.EndsWith(":")) { " " } else { ": " }
    Write-Host ($mark + " " + $c.label + $sep + $c.found) -ForegroundColor $color
    if ($c.level -ne "ok" -and $c.fix) { Write-Host ("     -> " + $c.fix) -ForegroundColor Cyan }
  }
  $dl = "Install downloads about $DownloadGb GB and takes 10 to 30 minutes."
  if ($verdict -eq "READY") { Write-Host "Verdict: READY. $dl" -ForegroundColor Green }
  elseif ($verdict -eq "SLOW") { Write-Host "Verdict: SLOW. $reason. Lazycow will run, slower or with less room. $dl" -ForegroundColor Yellow }
  else { Write-Host "Verdict: BLOCKED. $reason. What to do: $fixText" -ForegroundColor Red }
  Write-Host "For the processor speed test and a time per reel, once Node is here: npx lazycow doctor" -ForegroundColor Gray
}

# Run as a file: exit with the code. Pasted through `irm | iex`: never close the person's PowerShell window.
if ($MyInvocation.MyCommand.Path) { exit $top } else { $global:LASTEXITCODE = $top }
