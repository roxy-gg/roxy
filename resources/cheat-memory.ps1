$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'cheat-memory.cs') -ReferencedAssemblies System.Web.Extensions, System.IO.Compression, System.IO.Compression.FileSystem, System.Xml
  [Console]::Out.WriteLine([RoxyCheatMemory]::Run([Console]::In.ReadToEnd()))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
