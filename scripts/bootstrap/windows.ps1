<#
  Lazycow Studio Setup for Windows (what "Start Lazycow.cmd" runs the first time).

  It downloads one pinned copy of Node, uv (which brings Python) and, if you say yes, ffmpeg, checks each against the
  SHA-256 in versions.json, and keeps them in %LOCALAPPDATA%\Lazycow. Nothing is installed for the whole computer, no
  admin rights are needed, and PATH is not changed. Then it installs the studio's packages, makes a desktop and Start
  menu shortcut, and opens the studio. Run it again any time: every step that is already done is skipped.

  Works in Windows PowerShell 5.1 (built into Windows 10 and 11). Plain ASCII only, so it reads the same in every console.
#>
param([string]$Data = "", [string]$Footage = "", [switch]$Yes, [switch]$NoShortcuts, [switch]$NoOpen)
# -Yes takes every suggestion; -NoShortcuts and -NoOpen are for test runs (scripts/bootstrap/README.md).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest's own bar is very slow in 5.1; curl.exe draws ours
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$V = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot "versions.json") | ConvertFrom-Json
$LC = Join-Path $env:LOCALAPPDATA "Lazycow"
$Log = Join-Path $LC "setup.log"
$Steps = 8
New-Item -ItemType Directory -Force -Path $LC | Out-Null

# --- 1997 called. It wants its installer back. -------------------------------------------------------------------
try {
  $raw = $Host.UI.RawUI
  $raw.WindowTitle = "Lazycow Studio Setup"
  $raw.BackgroundColor = "DarkBlue"; $raw.ForegroundColor = "White"
  Clear-Host
} catch { }

function Say([string]$text, [string]$color = "White") { Write-Host $text -ForegroundColor $color; Add-Content -Path $Log -Value $text }
function Step([int]$n, [string]$what) { Say ""; Say ("[{0}/{1}] {2}" -f $n, $Steps, $what) "Yellow" }
function Ok([string]$what) { Say ("      OK  " + $what) "Green" }
function Fail([string]$what, [string]$fix) {
  Say ""
  Say ("  !!  " + $what) "Red"
  if ($fix) { Say ("      What to do: " + $fix) "Cyan" }
  Say ("      The whole story is in " + $Log) "Gray"
  Say ""
  Read-Host "Press Enter to close this window"
  exit 1
}
function Ask([string]$question, [string]$default) {
  if ($Yes) { return $default }
  $a = Read-Host ("      " + $question + " [" + $default + "]")
  if ([string]::IsNullOrWhiteSpace($a)) { return $default } else { return $a.Trim().Trim('"') }
}

# A program's output goes to the log (and the screen with -Show); only its exit code decides. Windows PowerShell 5.1
# turns any stderr line of a native program into a stopping error under "Stop", and uv and npm print progress there.
function Run([string]$exe, [string[]]$argv, [switch]$Show) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try {
    & $exe @argv 2>&1 | ForEach-Object {
      $line = "$_"
      Add-Content -Path $Log -Value $line
      if ($Show) { Write-Host ("      " + $line) -ForegroundColor Gray }
    }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

function Fetch([string]$url, [string]$sha, [string]$name) {
  $out = Join-Path $LC ("download\" + $name)
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  if ((Test-Path $out) -and ((Get-FileHash $out -Algorithm SHA256).Hash -ieq $sha)) { Ok "$name (already downloaded)"; return $out }
  Say ("      downloading " + $name + " ...") "Gray"
  & curl.exe -L --fail --retry 3 --retry-delay 2 -# -o $out $url
  if ($LASTEXITCODE -ne 0) { Fail "Could not download $name." "Check the internet connection, then double-click Start Lazycow again. It carries on where it stopped." }
  $got = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($got -ine $sha) {
    Remove-Item $out -Force
    Fail "$name did not match its fingerprint (SHA-256), so it was deleted and not used." "Try again later. If it keeps happening, tell us on GitHub: the download may have been changed on its way to you."
  }
  Ok "$name (fingerprint checked)"
  return $out
}

Set-Content -Path $Log -Value ("Lazycow Studio setup " + (Get-Date -Format s))
Say "  +------------------------------------------------------------------+" "Cyan"
Say "  |                                                                  |" "Cyan"
Say "  |    L A Z Y C O W   S T U D I O          S E T U P                |" "Cyan"
Say "  |    Your footage. Your PC. You just say yes.                      |" "Cyan"
Say "  |                                                                  |" "Cyan"
Say "  +------------------------------------------------------------------+" "Cyan"
Say "   Did you read README.TXT first? Good. (If not: it is short. And funny.)"
Say "   This takes 10 to 30 minutes and downloads about 1.5 GB. Get a coffee."
Say "   Lazy Kenji is already on the bean bag."

# 1. This PC ------------------------------------------------------------------------------------------------------
Step 1 "Looking at this PC"
if (-not [Environment]::Is64BitOperatingSystem) { Fail "Lazycow Studio needs 64-bit Windows." "Use a 64-bit Windows 10 or 11 PC." }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Fail "curl.exe is missing (it ships with Windows 10 1803 and newer)." "Update Windows, then try again." }
$free = (Get-PSDrive -Name ($env:LOCALAPPDATA.Substring(0, 1))).Free / 1GB
if ($free -lt 6) { Fail ("Only {0:N1} GB free on drive {1}." -f $free, $env:LOCALAPPDATA.Substring(0, 1)) "Free at least 6 GB (20 GB is better for renders), then try again." }
Ok ("64-bit Windows, {0:N0} GB free" -f $free)

# 2. Where things go ----------------------------------------------------------------------------------------------
Step 2 "Choosing folders"
$envFile = Join-Path $Root ".env"
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^STUDIO_DATA=(.*)$' | Select-Object -First 1
  if ($line -and -not $Data) { $Data = $line.Matches[0].Groups[1].Value.Trim('"') }
}
if (-not $Data) {
  Say "      Where should the studio keep what it makes (reels, renders, settings)? It can grow to many GB."
  $Data = Ask "Data folder" (Join-Path $env:USERPROFILE "Lazycow Studio")
}
if (-not $Footage -and -not (Test-Path $envFile)) {
  Say "      Where are your photos and videos? The studio only reads them; it never moves or changes them."
  $defaultFootage = Join-Path $env:USERPROFILE "Videos"
  if (-not (Test-Path $defaultFootage)) { $defaultFootage = Join-Path $Data "footage" }
  $Footage = Ask "Footage folder" $defaultFootage
}
New-Item -ItemType Directory -Force -Path $Data | Out-Null
Ok ("data: " + $Data)
if ($Footage) { Ok ("footage: " + $Footage) }

# 3. Node ---------------------------------------------------------------------------------------------------------
Step 3 ("Node " + $V.node.version + " (runs the studio)")
$nodeDir = Join-Path $LC "node"
$nodeExe = Join-Path $nodeDir "node.exe"
$nodeOk = (Test-Path $nodeExe) -and ((& $nodeExe --version) -eq ("v" + $V.node.version))
if (-not $nodeOk) {
  $zip = Fetch $V.node."win-x64".url $V.node."win-x64".sha256 ("node-v" + $V.node.version + "-win-x64.zip")
  $tmp = Join-Path $LC "unpack-node"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Join-Path $tmp $V.node."win-x64".dir) $nodeDir
  Remove-Item $tmp -Recurse -Force
}
Ok ("node " + (& $nodeExe --version))
$env:PATH = $nodeDir + ";" + $env:PATH   # this window only

# 4. uv and Python ------------------------------------------------------------------------------------------------
Step 4 ("Python " + $V.python + " (the studio's engine), installed by uv " + $V.uv.version)
$uvDir = Join-Path $LC "uv"
$uvExe = Join-Path $uvDir "uv.exe"
$uvOk = (Test-Path $uvExe) -and ((& $uvExe --version) -match [regex]::Escape($V.uv.version))
if (-not $uvOk) {
  $zip = Fetch $V.uv."win-x64".url $V.uv."win-x64".sha256 ("uv-" + $V.uv.version + "-windows.zip")
  if (Test-Path $uvDir) { Remove-Item $uvDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $uvDir -Force
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $LC "python"
$env:UV_CACHE_DIR = Join-Path $LC "uv-cache"
$env:UV_NO_MODIFY_PATH = "1"
$venv = Join-Path $Data "venv"
$py = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $py)) {
  [void](Run $uvExe @("python", "install", $V.python))
  [void](Run $uvExe @("venv", $venv, "--python", $V.python))
  if (-not (Test-Path $py)) { Fail "Could not make the Python environment." "Look at the end of the log file, or ask on GitHub with it." }
}
Say "      installing the studio's Python packages (the search model alone is ~300 MB) ..." "Gray"
if ((Run $uvExe @("pip", "sync", "--python", $py, "--torch-backend", "cpu", "--require-hashes", (Join-Path $Root "py\requirements-win.lock"))) -ne 0) { Fail "The Python packages did not install." "Check the internet connection and run it again; it resumes. The log says which package failed." }
Ok ("python " + ((& $py --version) -replace "Python ", "") + ", packages checked against their hashes")

# 5. ffmpeg -------------------------------------------------------------------------------------------------------
Step 5 "ffmpeg (cuts and encodes the video)"
$bin = Join-Path $Data "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$ff = Join-Path $bin "ffmpeg.exe"
if (Test-Path $ff) { Ok "ffmpeg already in $bin" }
else {
  Say "      ffmpeg is free software under the GPL (this build includes the x264 encoder)."
  Say ("      Download the official-style build " + $V.ffmpeg.version + " from gyan.dev's GitHub (about 100 MB)?")
  $a = Ask "Download ffmpeg? (Y/n)" "Y"
  if ($a -match '^[Nn]') {
    Say "      Skipped. Put ffmpeg.exe and ffprobe.exe in $bin before making reels." "Cyan"
  } else {
    $zip = Fetch $V.ffmpeg."win-x64".url $V.ffmpeg."win-x64".sha256 ("ffmpeg-" + $V.ffmpeg.version + "-essentials.zip")
    $tmp = Join-Path $LC "unpack-ffmpeg"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Join-Path $tmp $V.ffmpeg."win-x64".dir
    Copy-Item (Join-Path $src "bin\ffmpeg.exe"), (Join-Path $src "bin\ffprobe.exe") $bin -Force
    if (Test-Path (Join-Path $src "LICENSE")) { Copy-Item (Join-Path $src "LICENSE") (Join-Path $bin "ffmpeg-LICENSE.txt") -Force }
    Set-Content -Path (Join-Path $bin "ffmpeg-SOURCE.txt") -Value ("ffmpeg " + $V.ffmpeg.version + ". " + $V.ffmpeg.licence)
    Remove-Item $tmp -Recurse -Force
    Ok ("ffmpeg " + $V.ffmpeg.version + " in " + $bin)
  }
}

# 6. The studio's own packages ------------------------------------------------------------------------------------
Step 6 "The studio's packages (npm)"
Push-Location $Root
try {
  if ((Run (Join-Path $nodeDir "npm.cmd") @("ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error")) -ne 0) { Fail "npm could not install the studio's packages." "Check the internet connection and try again. The log has npm's own message." }
  Ok "packages installed"

  # 7. The studio's own setup: .env, folders, the picture-quality model, free music --------------------------
  Step 7 "Settings, the picture-quality model and some free music"
  $setupArgs = @("scripts\setup.mjs", "--data", $Data)
  if ($Footage) { $setupArgs += @("--footage", $Footage) }
  $env:STUDIO_PY = $py
  $env:STUDIO_TOOLS = $bin
  [void](Run $nodeExe $setupArgs -Show)
} finally { Pop-Location }

# 8. Shortcuts ----------------------------------------------------------------------------------------------------
Step 8 "Shortcuts"
if ($NoShortcuts) { Ok "skipped (-NoShortcuts)" } else {
$shell = New-Object -ComObject WScript.Shell
$icon = Join-Path $Root "server\brand\favicon.ico"
foreach ($where in @([Environment]::GetFolderPath("Desktop"), (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $where "Lazycow Studio.lnk"))
  $lnk.TargetPath = $nodeExe
  $lnk.Arguments = '"' + (Join-Path $Root "scripts\app.mjs") + '"'
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = $icon
  $lnk.WindowStyle = 7
  $lnk.Description = "Lazycow Studio: your footage, made into short videos"
  $lnk.Save()
}
Ok "Lazycow Studio on your desktop and in the Start menu"
}
Set-Content -Path (Join-Path $LC "installed.json") -Value (@{ root = $Root; data = $Data; node = $V.node.version; uv = $V.uv.version; at = (Get-Date -Format s) } | ConvertTo-Json)

Say ""
Say "  +------------------------------------------------------------------+" "Green"
Say "  |   SETUP COMPLETE.                                                |" "Green"
Say "  |   No serial number. No CD key. No crack. It is free. Really.     |" "Green"
Say "  |   Next time: double-click Lazycow Studio on your desktop.        |" "Green"
Say "  +------------------------------------------------------------------+" "Green"
Say ""
Say "   Opening the studio... Lazy Kenji will show you around."
if (-not $NoOpen) { & $nodeExe (Join-Path $Root "scripts\app.mjs"); Start-Sleep -Seconds 3 }
