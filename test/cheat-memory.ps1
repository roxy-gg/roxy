$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../resources/cheat-memory.cs') -ReferencedAssemblies System.Web.Extensions, System.IO.Compression, System.IO.Compression.FileSystem, System.Xml
function Assert($value, $message) { if (!$value) { throw $message } }
function Invoke-Memory($value) { [RoxyCheatMemory]::Run(($value | ConvertTo-Json -Compress)) | ConvertFrom-Json }
$target = Invoke-Memory @{ operation = 'open_process'; pid = $PID }
Assert ($target.pid -eq $PID -and $target.pointerSize -eq 8) 'Own-process target identity'
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(65536)
$directory = Join-Path ([IO.Path]::GetTempPath()) ('roxy-memory-' + [Guid]::NewGuid())
try {
  $base = $buffer.ToInt64()
  $address = '0x' + $base.ToString('x')
  $zero = New-Object byte[] 65536
  [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buffer, $zero.Length)
  [Runtime.InteropServices.Marshal]::WriteByte($buffer, 0, 1)
  [Runtime.InteropServices.Marshal]::WriteByte($buffer, 1, 2)
  $read = Invoke-Memory @{ operation = 'read_memory'; pid = $PID; identity = $target.identity; address = $address; length = 2 }
  Assert ($read.complete -and $read.hex -eq '0102') 'Exact read'
  $patch = Invoke-Memory @{ operation = 'write_memory'; pid = $PID; identity = $target.identity; address = $address; expected = '0102'; data = '0304' }
  Assert ($patch.verified -and $patch.bytesWritten -eq 2 -and $patch.after -eq '0304') 'Own allocation write and readback'
  $rejected = $false
  try { Invoke-Memory @{ operation = 'write_memory'; pid = $PID; identity = $target.identity; address = $address; expected = '0102'; data = 'ffff' } } catch { $rejected = $true }
  Assert $rejected 'Expected-byte mismatch refuses patch'
  $rejected = $false
  try { Invoke-Memory @{ operation = 'read_memory'; pid = $PID; identity = 'wrong'; address = $address; length = 2 } } catch { $rejected = $true }
  Assert $rejected 'Wrong creation time refuses memory access'
  $regions = Invoke-Memory @{ operation = 'list_regions'; pid = $PID; identity = $target.identity; address = $address; limit = 1 }
  Assert ($regions.regions.Count -eq 1) 'VirtualQueryEx region'
  $partial = Invoke-Memory @{ operation = 'read_memory'; pid = $PID; identity = $target.identity; address = '0x1'; length = 2 }
  Assert (!$partial.complete -and $partial.bytesRead -eq 0 -and $partial.hex -eq '') 'Unreadable address never fabricated zeros'
  $boundary = 4096 - ($base % 4096)
  [Runtime.InteropServices.Marshal]::WriteByte($buffer, ($boundary - 1), 0xaa)
  [Runtime.InteropServices.Marshal]::WriteByte($buffer, $boundary, 0xbb)
  [Runtime.InteropServices.Marshal]::WriteByte($buffer, ($boundary + 1), 0xcc)
  $scan = Invoke-Memory @{ operation = 'scan_memory'; pid = $PID; identity = $target.identity; address = $address; length = 8192; pattern = 'aa ?? cc'; limit = 2 }
  Assert ($scan.matchesExhaustive -and $scan.matches.Count -eq 1 -and $scan.matches[0] -eq ('0x' + ($base + $boundary - 1).ToString('x'))) 'Wildcard scan crossing a page'
  $capped = Invoke-Memory @{ operation = 'scan_memory'; pid = $PID; identity = $target.identity; address = $address; length = 8192; pattern = '00'; limit = 1 }
  Assert ($capped.capped -and !$capped.matchesExhaustive) 'Scan cap preserves partial coverage'
  [Runtime.InteropServices.Marshal]::WriteIntPtr($buffer, 64, [IntPtr]($base + 128))
  $chain = Invoke-Memory @{ operation = 'pointer_chain'; pid = $PID; identity = $target.identity; address = ('0x' + ($base + 64).ToString('x')); offsets = @(4) }
  Assert ($chain.address -eq ('0x' + ($base + 132).ToString('x'))) 'Pointer chain dereference plus offset'
  [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buffer, $zero.Length)
  $large = Invoke-Memory @{ operation = 'write_memory'; pid = $PID; identity = $target.identity; address = $address; expected = ('00' * 65536); data = ('5a' * 65536) }
  Assert ($large.verified -and $large.bytesWritten -eq 65536 -and $large.after -eq ('5a' * 65536)) 'Real 64 KiB data write and readback'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $project = Join-Path $directory 'fixture.rcnet'
  $zip = [IO.Compression.ZipFile]::Open($project, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $writer = New-Object IO.StreamWriter($zip.CreateEntry('Data.xml').Open())
    try { $writer.Write('<reclass version="1"><classes><class name="Fixture"><node type="UInt32Node" /></class></classes></reclass>') } finally { $writer.Dispose() }
  } finally { $zip.Dispose() }
  $imported = Invoke-Memory @{ operation = 'inspect_reclass'; path = $project }
  Assert (!$imported.layoutResolved -and $imported.declarations.Count -eq 4 -and $imported.sha256.Length -eq 64) 'Bounded offline ReClass declarations and hash'
  Write-Output 'MEMORY HELPER OK: own test allocation only, exact/partial reads, expected-byte patch/readback, process identity, regions, page-boundary AOB, result caps, pointer chain, ReClass ZIP'
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  if (Test-Path $directory) { Remove-Item $directory -Recurse -Force }
}
