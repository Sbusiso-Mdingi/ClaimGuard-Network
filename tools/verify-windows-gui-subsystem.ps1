param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

$resolvedPath = Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop
$bytes = [IO.File]::ReadAllBytes($resolvedPath)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
  throw "$ExecutablePath is not a valid Windows PE executable."
}

$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$optionalHeaderOffset = $peOffset + 24
if ($peOffset -lt 0 -or $optionalHeaderOffset + 70 -gt $bytes.Length) {
  throw "$ExecutablePath has an invalid PE header offset."
}

$peSignature = [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4)
if ($peSignature -ne "PE`0`0") {
  throw "$ExecutablePath does not contain a valid PE signature."
}

$optionalHeaderMagic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
if ($optionalHeaderMagic -notin @(0x10b, 0x20b)) {
  throw "$ExecutablePath has an unsupported PE optional-header format."
}

$windowsGuiSubsystem = 2
$subsystem = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 68)
if ($subsystem -ne $windowsGuiSubsystem) {
  throw "$ExecutablePath uses PE subsystem $subsystem instead of Windows GUI subsystem 2. A console window would open with the application."
}

Write-Host "$ExecutablePath uses the Windows GUI subsystem."
