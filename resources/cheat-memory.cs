using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Xml;
using System.Text;
using System.Security.Cryptography;

// Original user-mode implementation. No drivers, debug privilege, cloaking,
// manual mapping, protection bypass, or third-party injector implementation.
public static class RoxyCheatMemory
{
    [StructLayout(LayoutKind.Sequential)]
    struct Region {
        public IntPtr Base, AllocationBase;
        public uint AllocationProtect;
        public UIntPtr Size;
        public uint State, Protect, Type;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process(IntPtr h, out bool wow);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process2(IntPtr h, out ushort processMachine, out ushort nativeMachine);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr h, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr address, out Region region, UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr address, UIntPtr size, uint allocationType, uint protect);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFreeEx(IntPtr h, IntPtr address, UIntPtr size, uint freeType);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr attributes, UIntPtr stackSize, IntPtr start, IntPtr parameter, uint flags, out uint threadId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeThread(IntPtr h, out uint code);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 32 };
    static string Text(IDictionary<string, object> input, string key) {
        object v;
        if (!input.TryGetValue(key, out v) || !(v is string)) throw new ArgumentException("Missing string: " + key);
        return (string)v;
    }
    static int Number(IDictionary<string, object> input, string key, int min, int max) {
        object v;
        if (!input.TryGetValue(key, out v) || !(v is int) || (int)v < min || (int)v > max) throw new ArgumentException("Invalid integer: " + key);
        return (int)v;
    }
    static ulong Address(IDictionary<string, object> input) {
        string text = Text(input, "address");
        ulong value;
        if (!text.StartsWith("0x") || !ulong.TryParse(text.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value) || value > long.MaxValue) throw new ArgumentException("Invalid user-mode address");
        return value;
    }
    static string Hex(ulong value) { return "0x" + value.ToString("x"); }
    static string Bytes(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
    static byte[] ParseBytes(string value) {
        if (value.Length < 2 || value.Length > 131072 || value.Length % 2 != 0) throw new ArgumentException("Write requires 1..65536 bytes");
        return Enumerable.Range(0, value.Length / 2).Select(i => byte.Parse(value.Substring(i * 2, 2), NumberStyles.HexNumber)).ToArray();
    }
    static byte[] Read(IntPtr h, ulong address, int length, out int error) {
        byte[] buffer = new byte[length];
        UIntPtr count;
        bool ok = ReadProcessMemory(h, new IntPtr(checked((long)address)), buffer, new UIntPtr((uint)length), out count);
        error = ok ? 0 : Marshal.GetLastWin32Error();
        Array.Resize(ref buffer, checked((int)count.ToUInt64()));
        return buffer;
    }
    static Region Query(IntPtr h, ulong address) {
        Region r;
        if (VirtualQueryEx(h, new IntPtr(checked((long)address)), out r, new UIntPtr((uint)Marshal.SizeOf(typeof(Region)))) == UIntPtr.Zero) throw new Win32Exception();
        return r;
    }
    static byte[] DllBytes(FileStream file) {
        if (file.Length < 256 || file.Length > 67108864) throw new ArgumentException("DLL must be 256 bytes..64 MiB");
        byte[] data = new byte[(int)file.Length];
        int offset = 0;
        while (offset < data.Length) {
            int read = file.Read(data, offset, data.Length - offset);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
        return data;
    }
    static Dictionary<string, object> DllInfo(string path, byte[] data) {
        if (data[0] != 'M' || data[1] != 'Z') throw new ArgumentException("Not a PE image");
        int pe = BitConverter.ToInt32(data, 0x3c);
        if (pe < 64 || pe > data.Length - 24 || BitConverter.ToUInt32(data, pe) != 0x4550) throw new ArgumentException("Invalid PE header");
        ushort machine = BitConverter.ToUInt16(data, pe + 4), count = BitConverter.ToUInt16(data, pe + 6), optionalSize = BitConverter.ToUInt16(data, pe + 20);
        ushort characteristics = BitConverter.ToUInt16(data, pe + 22);
        if ((characteristics & 0x2000) == 0) throw new ArgumentException("PE image is not marked as a DLL");
        int optional = pe + 24;
        if (optionalSize < 96 || optional > data.Length - optionalSize) throw new ArgumentException("Invalid optional header");
        ushort magic = BitConverter.ToUInt16(data, optional);
        int directory = magic == 0x20b ? 112 : magic == 0x10b ? 96 : 0;
        if (directory == 0 || optionalSize < directory || (machine == 0x8664 && magic != 0x20b) || (machine == 0x14c && magic != 0x10b)) throw new ArgumentException("Unsupported or inconsistent PE layout");
        uint directoryCount = BitConverter.ToUInt32(data, optional + directory - 4);
        if (directoryCount > (optionalSize - directory) / 8) throw new ArgumentException("PE data directories exceed header");
        bool managed = directoryCount > 14 && BitConverter.ToUInt32(data, optional + directory + 14 * 8) != 0;
        int table = optional + optionalSize;
        if (count > 96 || table > data.Length - count * 40) throw new ArgumentException("Invalid section table");
        var sections = new List<object>();
        for (int i = 0; i < count; i++) {
            int at = table + i * 40;
            uint rawSize = BitConverter.ToUInt32(data, at + 16), rawOffset = BitConverter.ToUInt32(data, at + 20);
            if ((ulong)rawOffset + rawSize > (ulong)data.Length) throw new ArgumentException("Section exceeds DLL bytes");
            sections.Add(new { name = Encoding.ASCII.GetString(data, at, 8).TrimEnd('\0'), virtualSize = BitConverter.ToUInt32(data, at + 8), rva = Hex(BitConverter.ToUInt32(data, at + 12)), rawSize, rawOffset, characteristics = Hex(BitConverter.ToUInt32(data, at + 36)) });
        }
        string digest;
        using (var sha = SHA256.Create()) digest = Bytes(sha.ComputeHash(data));
        return new Dictionary<string, object> {
            { "path", path }, { "sha256", digest }, { "bytes", data.Length },
            { "architecture", machine == 0x8664 ? "x64" : machine == 0x14c ? "x86" : machine == 0xaa64 ? "arm64" : "unknown" },
            { "machine", Hex(machine) }, { "managed", managed }, { "sections", sections },
            { "entrypointRva", Hex(BitConverter.ToUInt32(data, optional + 16)) }, { "executed", false },
            { "limitation", "Static bounded PE declarations only, not decompilation, trust/signature verification, import resolution or proof of safe execution. Dependencies are not inspected." }
        };
    }
    static string DllPath(Dictionary<string, object> input) {
        string path = Text(input, "path");
        if (path.Length < 4 || !char.IsLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/') || path.IndexOf('\0') >= 0 || path.Substring(2).Contains(":") || !path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Expected fully qualified absolute local DLL path, not a relative/network/device path");
        path = Path.GetFullPath(path);
        if (path.Length > 2048 || path.StartsWith(@"\\") || path.Substring(2).Contains(":") || new DriveInfo(Path.GetPathRoot(path)).DriveType != DriveType.Fixed) throw new ArgumentException("Invalid or non-local DLL path");
        for (string item = path; item != null; item = Path.GetDirectoryName(item)) {
            if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Reparse-point DLL paths are unsupported");
            if (item == Path.GetPathRoot(item)) break;
        }
        return path;
    }
    static object InspectDll(Dictionary<string, object> input) {
        string path = DllPath(input);
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return DllInfo(path, DllBytes(file));
    }
    static byte[] ModuleBytes(IntPtr handle, ProcessModule module, uint rva, int length) {
        if (length < 0 || (ulong)rva + (ulong)length > (ulong)module.ModuleMemorySize || length > 524288) throw new ArgumentException("Mapped module read exceeds image");
        int error;
        byte[] bytes = Read(handle, (ulong)module.BaseAddress.ToInt64() + rva, length, out error);
        if (error != 0 || bytes.Length != length) throw new InvalidOperationException("Incomplete mapped export read");
        return bytes;
    }
    static string ModuleString(IntPtr handle, ProcessModule module, uint rva) {
        var bytes = new List<byte>();
        for (int i = 0; i < 256; i++) {
            byte value = ModuleBytes(handle, module, checked(rva + (uint)i), 1)[0];
            if (value == 0) return Encoding.ASCII.GetString(bytes.ToArray());
            if (value > 127) throw new ArgumentException("Non-ASCII export name");
            bytes.Add(value);
        }
        throw new ArgumentException("Unterminated mapped export name");
    }
    static IntPtr ResolveLoader(IntPtr handle, Process target, string moduleName, string symbol, int depth) {
        if (depth > 8) throw new InvalidOperationException("Export forwarding exceeds depth budget");
        ProcessModule module = null;
        foreach (ProcessModule candidate in target.Modules) if (string.Equals(candidate.ModuleName, moduleName, StringComparison.OrdinalIgnoreCase) && string.Equals(Path.GetDirectoryName(candidate.FileName), Environment.SystemDirectory, StringComparison.OrdinalIgnoreCase)) { module = candidate; break; }
        if (module == null) throw new InvalidOperationException("Required target system module not found: " + moduleName);
        byte[] dos = ModuleBytes(handle, module, 0, 64);
        if (dos[0] != 'M' || dos[1] != 'Z') throw new ArgumentException("Invalid target DOS header");
        uint pe = BitConverter.ToUInt32(dos, 60);
        byte[] header = ModuleBytes(handle, module, pe, 144);
        if (BitConverter.ToUInt32(header, 0) != 0x4550 || BitConverter.ToUInt16(header, 4) != 0x8664 || BitConverter.ToUInt16(header, 24) != 0x20b || BitConverter.ToUInt16(header, 20) < 120 || BitConverter.ToUInt32(header, 132) < 1) throw new ArgumentException("Expected target native x64 export image");
        uint exportRva = BitConverter.ToUInt32(header, 136), exportSize = BitConverter.ToUInt32(header, 140);
        if (exportSize < 40 || (ulong)exportRva + exportSize > (ulong)module.ModuleMemorySize) throw new ArgumentException("Invalid mapped export directory");
        byte[] exports = ModuleBytes(handle, module, exportRva, 40);
        uint ordinalBase = BitConverter.ToUInt32(exports, 16), functionCount = BitConverter.ToUInt32(exports, 20), nameCount = BitConverter.ToUInt32(exports, 24);
        if (functionCount == 0 || functionCount > 65536 || nameCount > 65536) throw new ArgumentException("Mapped export count exceeds budget");
        byte[] functions = ModuleBytes(handle, module, BitConverter.ToUInt32(exports, 28), checked((int)functionCount * 4));
        int index = -1;
        if (symbol.StartsWith("#")) {
            uint ordinal;
            if (!uint.TryParse(symbol.Substring(1), out ordinal) || ordinal < ordinalBase || ordinal - ordinalBase >= functionCount) throw new ArgumentException("Invalid forwarded ordinal");
            index = (int)(ordinal - ordinalBase);
        } else {
            byte[] names = ModuleBytes(handle, module, BitConverter.ToUInt32(exports, 32), checked((int)nameCount * 4));
            byte[] ordinals = ModuleBytes(handle, module, BitConverter.ToUInt32(exports, 36), checked((int)nameCount * 2));
            int low = 0, high = (int)nameCount - 1;
            while (low <= high) {
                int mid = low + (high - low) / 2;
                int comparison = string.CompareOrdinal(ModuleString(handle, module, BitConverter.ToUInt32(names, mid * 4)), symbol);
                if (comparison == 0) { index = BitConverter.ToUInt16(ordinals, mid * 2); break; }
                if (comparison < 0) low = mid + 1; else high = mid - 1;
            }
        }
        if (index < 0 || index >= functionCount) throw new InvalidOperationException("Target loader export is unavailable");
        uint functionRva = BitConverter.ToUInt32(functions, index * 4);
        if (functionRva >= exportRva && (ulong)functionRva < (ulong)exportRva + exportSize) {
            string forward = ModuleString(handle, module, functionRva);
            int dot = forward.LastIndexOf('.');
            if (dot < 1 || forward.Substring(0, dot).IndexOfAny(new char[] {'/', '\\', ':'}) >= 0) throw new ArgumentException("Invalid export forwarder");
            return ResolveLoader(handle, target, forward.Substring(0, dot) + ".dll", forward.Substring(dot + 1), depth + 1);
        }
        if (functionRva == 0 || functionRva >= module.ModuleMemorySize) throw new ArgumentException("Loader export outside mapped image");
        IntPtr address = new IntPtr(checked(module.BaseAddress.ToInt64() + functionRva));
        Region region = Query(handle, (ulong)address.ToInt64());
        if (region.State != 0x1000 || (region.Protect & 0x100) != 0 || (region.Protect & 0xf0) == 0) throw new InvalidOperationException("Target loader export is not executable committed memory");
        return address;
    }
    static object LoadDll(IntPtr handle, int pid, bool wow, Dictionary<string, object> input) {
        if (wow) throw new ArgumentException("DLL loading currently requires an x64 target");
        string path = DllPath(input);
        // Deny file writes/deletion while hashing and while the loader runs.
        // Dependencies and directory entries are not pinned by this file handle.
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            var info = DllInfo(path, DllBytes(file));
            if ((string)info["architecture"] != "x64" || (bool)info["managed"]) throw new ArgumentException("Only native x64 DLLs are supported");
            if (input.ContainsKey("sha256") && !string.Equals((string)info["sha256"], Text(input, "sha256"), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("DLL hash does not match supplied SHA-256; nothing loaded");
            IntPtr remoteLoader = IntPtr.Zero;
            using (Process target = Process.GetProcessById(pid)) {
                string exe = target.MainModule.FileName;
                if (File.Exists(exe + ".local") || Directory.Exists(exe + ".local")) throw new InvalidOperationException("Application DLL .local redirection is unsupported");
                foreach (ProcessModule m in target.Modules) {
                    if (string.Equals(Path.GetFullPath(m.FileName), path, StringComparison.OrdinalIgnoreCase)) return new { status = "already-loaded", moduleBase = Hex((ulong)m.BaseAddress.ToInt64()), path, sha256 = info["sha256"], dispatched = false, limitation = "Existing module found by path; its mapped bytes and original DLL hash are not verified." };
                }
                remoteLoader = ResolveLoader(handle, target, "kernel32.dll", "LoadLibraryW", 0);
            }
            if (remoteLoader == IntPtr.Zero) throw new InvalidOperationException("Matching target system loader module was not found");
            uint alive;
            if (!GetExitCodeProcess(handle, out alive) || alive != 259) throw new InvalidOperationException("Target exited before DLL dispatch");
            byte[] argument = Encoding.Unicode.GetBytes(path + "\0");
            IntPtr remotePath = VirtualAllocEx(handle, IntPtr.Zero, new UIntPtr((uint)argument.Length), 0x3000, 0x04);
            if (remotePath == IntPtr.Zero) throw new Win32Exception();
            IntPtr thread = IntPtr.Zero;
            bool release = true;
            try {
                UIntPtr written;
                if (!WriteProcessMemory(handle, remotePath, argument, new UIntPtr((uint)argument.Length), out written) || written.ToUInt64() != (ulong)argument.Length) throw new Win32Exception();
                uint threadId;
                thread = CreateRemoteThread(handle, IntPtr.Zero, UIntPtr.Zero, remoteLoader, remotePath, 0, out threadId);
                if (thread == IntPtr.Zero) throw new Win32Exception();
                release = false;
                uint wait = WaitForSingleObject(thread, 10000);
                if (wait != 0) {
                    var unknown = new { status = "unknown", dispatched = true, waitResult = wait, path, sha256 = info["sha256"], threadId, rollback = false, limitation = "Loader thread may still be executing. Helper retains file lock and argument allocation until thread completion or target exit. Do not retry. No thread termination, unload or rollback." };
                    Console.WriteLine(Json.Serialize(unknown));
                    Console.Out.Flush();
                    // Reporting timeout must not release the selected file while
                    // the outstanding loader can still open its pathname.
                    while (WaitForSingleObject(thread, 1000) != 0) {
                        uint processCode;
                        if (!GetExitCodeProcess(handle, out processCode) || processCode != 259) break;
                    }
                    release = true;
                    return unknown;
                }
                release = true;
                uint threadExit;
                if (!GetExitCodeThread(thread, out threadExit)) throw new Win32Exception();
                string moduleBase = null;
                string observationError = null;
                try {
                    using (Process target = Process.GetProcessById(pid)) {
                        foreach (ProcessModule m in target.Modules) if (string.Equals(Path.GetFullPath(m.FileName), path, StringComparison.OrdinalIgnoreCase)) { moduleBase = Hex((ulong)m.BaseAddress.ToInt64()); break; }
                    }
                } catch (Exception e) { observationError = e.Message; }
                return new { status = moduleBase != null ? "loaded" : "unknown", dispatched = true, path, sha256 = info["sha256"], threadId, threadExitCode = threadExit, moduleBase, observationError, rollback = false, limitation = "DLL entrypoints and dependencies execute target code. Module observation is by path, not proof of behavior or mapped-byte identity. Thread exit is a DWORD, not a full x64 module handle. No unload or rollback is provided." };
            } finally {
                if (thread != IntPtr.Zero) CloseHandle(thread);
                if (release) VirtualFreeEx(handle, remotePath, UIntPtr.Zero, 0x8000);
            }
        }
    }
    static object Execute(IntPtr handle, int pid, bool wow, string operation, Dictionary<string, object> input) {
        if (operation == "load_dll") return LoadDll(handle, pid, wow, input);
        if (operation == "scan_values" || operation == "refine_values") return ValueScan(handle, wow ? 4 : 8, operation, input);
        if (operation == "list_modules") {
            using (Process p = Process.GetProcessById(pid)) {
                var modules = p.Modules.Cast<ProcessModule>().Take(1024).Select(m => new { name = m.ModuleName, path = m.FileName, address = Hex((ulong)m.BaseAddress.ToInt64()), size = m.ModuleMemorySize }).ToArray();
                return new { modules, capped = modules.Length == 1024, snapshot = false };
            }
        }
        ulong address = Address(input);
        if (operation == "list_regions") {
            int limit = input.ContainsKey("limit") ? Number(input, "limit", 1, 512) : 128;
            var rows = new List<object>();
            string failure = null;
            for (int i = 0; i < limit; i++) {
                Region r;
                try { r = Query(handle, address); } catch (Win32Exception e) { failure = e.Message; break; }
                ulong start = (ulong)r.Base.ToInt64(), size = r.Size.ToUInt64();
                rows.Add(new { address = Hex(start), size = Hex(size), state = r.State, protection = r.Protect, type = r.Type });
                ulong next = checked(start + size);
                if (next <= address || next > long.MaxValue) { failure = "End of user address range"; break; }
                address = next;
            }
            return new { regions = rows, nextAddress = Hex(address), queryStopped = failure, snapshot = false };
        }
        if (operation == "read_memory") {
            int length = Number(input, "length", 1, 65536), error;
            byte[] data = Read(handle, address, length, out error);
            return new { address = Hex(address), requested = length, bytesRead = data.Length, hex = Bytes(data), complete = data.Length == length && error == 0, win32Error = error, snapshot = false };
        }
        if (operation == "pointer_chain") {
            var offsets = input["offsets"] as ArrayList;
            if (offsets == null || offsets.Count < 1 || offsets.Count > 16) throw new ArgumentException("Invalid offsets");
            var steps = new List<object>();
            foreach (object item in offsets) {
                if (!(item is int)) throw new ArgumentException("Invalid offset");
                int error;
                byte[] bytes = Read(handle, address, wow ? 4 : 8, out error);
                if (bytes.Length != (wow ? 4 : 8) || error != 0) throw new InvalidOperationException("Incomplete pointer read at " + Hex(address));
                ulong pointer = wow ? BitConverter.ToUInt32(bytes, 0) : BitConverter.ToUInt64(bytes, 0);
                long next = checked(checked((long)pointer) + (int)item);
                if (next < 0) throw new ArgumentException("Pointer overflow");
                steps.Add(new { address = Hex(address), pointer = Hex(pointer), offset = item, result = Hex((ulong)next) });
                address = (ulong)next;
            }
            return new { steps, address = Hex(address), pointerSize = wow ? 4 : 8, snapshot = false };
        }
        if (operation == "scan_memory") return Scan(handle, address, input);
        if (operation == "write_memory") {
            byte[] replacement = ParseBytes(Text(input, "data"));
            byte[] expected = input.ContainsKey("expected") ? ParseBytes(Text(input, "expected")) : null;
            if (expected != null && expected.Length != replacement.Length) throw new ArgumentException("Expected/data lengths differ");
            int error;
            byte[] before = Read(handle, address, replacement.Length, out error);
            int beforeError = error;
            if (expected != null && (error != 0 || !before.SequenceEqual(expected))) throw new InvalidOperationException("Expected bytes do not match; nothing written");
            UIntPtr written;
            bool ok = WriteProcessMemory(handle, new IntPtr((long)address), replacement, new UIntPtr((uint)replacement.Length), out written);
            int writeError = ok ? 0 : Marshal.GetLastWin32Error();
            byte[] after = Read(handle, address, replacement.Length, out error);
            return new { address = Hex(address), before = Bytes(before), beforeError, requested = Bytes(replacement), bytesWritten = written.ToUInt64(), after = Bytes(after), verified = ok && written.ToUInt64() == (ulong)replacement.Length && error == 0 && after.SequenceEqual(replacement), win32Error = writeError, readbackError = error, limitation = "Optional expected-byte check and write are not atomic. Windows page/access checks apply; this tool does not change protections. No rollback, including on partial failure or cancellation." };
        }
        throw new ArgumentException("Unknown operation");
    }
    static object Scan(IntPtr handle, ulong address, Dictionary<string, object> input) {
        int length = Number(input, "length", 1, 16777216);
        int limit = input.ContainsKey("limit") ? Number(input, "limit", 1, 512) : 128;
        string[] tokens = Text(input, "pattern").Split(new char[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length < 1 || tokens.Length > 256 || tokens.All(t => t == "??")) throw new ArgumentException("Pattern requires 1..256 pairs and at least one exact byte");
        byte?[] pattern = tokens.Select(t => t == "??" ? (byte?)null : t.Length == 2 ? byte.Parse(t, NumberStyles.HexNumber) : InvalidToken()).ToArray();
        var matches = new List<string>();
        byte[] tail = new byte[0];
        ulong end = checked(address + (ulong)length), cursor = address;
        long bytesRead = 0, unread = 0;
        int failures = 0;
        Stopwatch clock = Stopwatch.StartNew();
        bool capped = false;
        while (cursor < end && clock.ElapsedMilliseconds < 15000 && !capped) {
            // Page-sized reads don't skip a readable next page after a gap.
            int chunk = (int)Math.Min(4096ul - cursor % 4096ul, end - cursor), error;
            byte[] data = Read(handle, cursor, chunk, out error);
            bytesRead += data.Length;
            unread += chunk - data.Length;
            if (error != 0 || data.Length != chunk) failures++;
            byte[] combined = tail.Concat(data).ToArray();
            ulong start = cursor - (ulong)tail.Length;
            for (int i = 0; i <= combined.Length - pattern.Length; i++) {
                bool match = true;
                for (int j = 0; j < pattern.Length; j++) if (pattern[j].HasValue && pattern[j].Value != combined[i + j]) { match = false; break; }
                if (match) { matches.Add(Hex(start + (ulong)i)); if (matches.Count == limit) { capped = true; cursor = start + (ulong)i + 1; break; } }
            }
            tail = data.Length == chunk && error == 0 ? combined.Skip(Math.Max(0, combined.Length - pattern.Length + 1)).ToArray() : new byte[0];
            if (!capped) cursor += (ulong)chunk;
        }
        return new { matches, bytesRead, unreadBytes = unread, failedReads = failures, nextAddress = Hex(cursor), rangeRead = cursor == end, matchesExhaustive = cursor == end && !capped && failures == 0, capped, snapshot = false };
    }
    static byte? InvalidToken() { throw new ArgumentException("Invalid pattern token"); }
    static int NumericSize(string type, int pointerSize) {
        switch (type) {
            case "i8": case "u8": return 1;
            case "i16": case "u16": return 2;
            case "i32": case "u32": case "f32": return 4;
            case "i64": case "u64": case "f64": return 8;
            case "pointer": return pointerSize;
            default: throw new ArgumentException("Expected numeric scan type");
        }
    }
    static string NumericText(string type, byte[] data) {
        switch (type) {
            case "i8": return unchecked((sbyte)data[0]).ToString(CultureInfo.InvariantCulture);
            case "u8": return data[0].ToString(CultureInfo.InvariantCulture);
            case "i16": return BitConverter.ToInt16(data, 0).ToString(CultureInfo.InvariantCulture);
            case "u16": return BitConverter.ToUInt16(data, 0).ToString(CultureInfo.InvariantCulture);
            case "i32": return BitConverter.ToInt32(data, 0).ToString(CultureInfo.InvariantCulture);
            case "u32": return BitConverter.ToUInt32(data, 0).ToString(CultureInfo.InvariantCulture);
            case "i64": return BitConverter.ToInt64(data, 0).ToString(CultureInfo.InvariantCulture);
            case "u64": return BitConverter.ToUInt64(data, 0).ToString(CultureInfo.InvariantCulture);
            case "pointer": return (data.Length == 4 ? BitConverter.ToUInt32(data, 0) : BitConverter.ToUInt64(data, 0)).ToString(CultureInfo.InvariantCulture);
            case "f32": return BitConverter.ToSingle(data, 0).ToString("R", CultureInfo.InvariantCulture);
            case "f64": return BitConverter.ToDouble(data, 0).ToString("R", CultureInfo.InvariantCulture);
            default: throw new ArgumentException("Invalid numeric type");
        }
    }
    static string ScanValue(Dictionary<string, object> input, string type, int size) {
        string value = Text(input, "value");
        if (value.Length > 128) throw new ArgumentException("Numeric value too long");
        if (type == "f32" || type == "f64") {
            double number;
            if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out number) || double.IsInfinity(number) || double.IsNaN(number)) throw new ArgumentException("Expected finite float value");
            if (type == "f32") {
                float single = (float)number;
                if (float.IsInfinity(single)) throw new ArgumentException("Float32 overflow");
                return single.ToString("R", CultureInfo.InvariantCulture);
            }
            return number.ToString("R", CultureInfo.InvariantCulture);
        }
        decimal integer;
        if (type == "pointer" && value.StartsWith("0x")) {
            ulong pointer;
            if (!ulong.TryParse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out pointer)) throw new ArgumentException("Invalid pointer value");
            integer = pointer;
        } else if (!decimal.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out integer)) throw new ArgumentException("Expected decimal integer");
        bool signed = type.StartsWith("i");
        decimal maximum = signed ? size == 8 ? long.MaxValue : (decimal)Math.Pow(2, size * 8 - 1) - 1 : size == 8 ? ulong.MaxValue : (decimal)Math.Pow(2, size * 8) - 1;
        decimal minimum = signed ? -maximum - 1 : 0;
        if (integer < minimum || integer > maximum || decimal.Truncate(integer) != integer) throw new ArgumentException("Value outside scan type range");
        return integer.ToString(CultureInfo.InvariantCulture);
    }
    static bool NumericMatch(string type, string mode, byte[] current, string expected, byte[] previous) {
        if (mode == "unknown") return true;
        if (mode == "changed") return !current.SequenceEqual(previous);
        if (mode == "unchanged") return current.SequenceEqual(previous);
        string left = NumericText(type, current), right = previous == null ? expected : NumericText(type, previous);
        int comparison;
        if (type == "f32" || type == "f64") {
            double a = double.Parse(left, CultureInfo.InvariantCulture), b = double.Parse(right, CultureInfo.InvariantCulture);
            if (double.IsNaN(a) || double.IsNaN(b)) return false;
            comparison = a.CompareTo(b);
        } else comparison = decimal.Parse(left, CultureInfo.InvariantCulture).CompareTo(decimal.Parse(right, CultureInfo.InvariantCulture));
        return mode == "equal" ? comparison == 0 : mode == "greater" || mode == "increased" ? comparison > 0 : comparison < 0;
    }
    static Dictionary<string, object> Candidate(string type, ulong address, byte[] bytes) {
        return new Dictionary<string, object> { { "address", Hex(address) }, { "hex", Bytes(bytes) }, { "value", NumericText(type, bytes) } };
    }
    static object ValueScan(IntPtr handle, int pointerSize, string operation, Dictionary<string, object> input) {
        string type = Text(input, "type"), mode = Text(input, "mode");
        int size = NumericSize(type, pointerSize);
        var candidates = new List<object>();
        Stopwatch clock = Stopwatch.StartNew();
        int failedReads = 0;
        bool refinement = operation == "refine_values";
        string[] modes = refinement ? new[] { "equal", "greater", "less", "changed", "unchanged", "increased", "decreased" } : new[] { "equal", "greater", "less", "unknown" };
        if (!modes.Contains(mode)) throw new ArgumentException("Invalid numeric scan mode");
        string expected = new[] { "equal", "greater", "less" }.Contains(mode) ? ScanValue(input, type, size) : null;
        if (refinement) {
            var previous = input["candidates"] as ArrayList;
            if (previous == null || previous.Count > 8192) throw new ArgumentException("Invalid retained candidates");
            foreach (object item in previous) {
                if (clock.ElapsedMilliseconds > 15000) throw new TimeoutException("Refinement budget exceeded; retained scan remains unchanged");
                var row = item as Dictionary<string, object>;
                if (row == null) throw new ArgumentException("Invalid retained candidate");
                ulong address = Address(row);
                byte[] before = ParseBytes(Text(row, "hex"));
                if (before.Length != size) throw new ArgumentException("Candidate width mismatch");
                int error;
                byte[] bytes = Read(handle, address, size, out error);
                if (error != 0 || bytes.Length != size) { failedReads++; continue; }
                if (NumericMatch(type, mode, bytes, expected, new[] { "equal", "greater", "less" }.Contains(mode) ? null : before)) candidates.Add(Candidate(type, address, bytes));
            }
            return new { candidates, previousCount = previous.Count, failedReads, examined = previous.Count, complete = true, snapshot = false };
        }
        ulong start = Address(input), end = checked(start + (ulong)Number(input, "length", 1, 16777216)), cursor = start;
        if (end > long.MaxValue) throw new ArgumentException("Scan range exceeds user addresses");
        int alignment = input.ContainsKey("alignment") ? Number(input, "alignment", 1, 4096) : size;
        int limit = input.ContainsKey("limit") ? Number(input, "limit", 1, 8192) : 8192;
        long readBytes = 0, skipped = 0;
        bool capped = false;
        while (cursor < end && clock.ElapsedMilliseconds < 15000 && !capped) {
            Region region;
            try { region = Query(handle, cursor); } catch (Win32Exception) { failedReads++; break; }
            ulong regionEnd = Math.Min(end, checked((ulong)region.Base.ToInt64() + region.Size.ToUInt64()));
            if (regionEnd <= cursor) throw new InvalidOperationException("Non-progressing memory region");
            if (region.State != 0x1000 || (region.Protect & 0x101) != 0 || (region.Protect & 0xee) == 0) { skipped += (long)(regionEnd - cursor); cursor = regionEnd; continue; }
            ulong relative = (cursor - start) % (ulong)alignment;
            if (relative != 0) cursor = checked(cursor + (ulong)alignment - relative);
            if (cursor >= regionEnd) { cursor = regionEnd; continue; }
            // Overlap the read by one value width so candidates spanning chunk
            // boundaries are observed without duplicate start addresses.
            int length = (int)Math.Min(65536ul, regionEnd - cursor);
            if ((ulong)length < (ulong)size) { skipped += length; cursor = regionEnd; continue; }
            int error;
            byte[] data = Read(handle, cursor, length, out error);
            readBytes += data.Length;
            if (error != 0 || data.Length != length) failedReads++;
            int index = 0;
            for (; index <= data.Length - size; index += alignment) {
                byte[] bytes = new byte[size];
                Buffer.BlockCopy(data, index, bytes, 0, size);
                if (NumericMatch(type, mode, bytes, expected, null)) {
                    candidates.Add(Candidate(type, cursor + (ulong)index, bytes));
                    if (candidates.Count == limit) { cursor += (ulong)index + (ulong)alignment; capped = true; break; }
                }
            }
            if (!capped) {
                if (data.Length == length && error == 0 && cursor + (ulong)length < regionEnd) cursor += (ulong)Math.Max(alignment, index);
                else { skipped += length - data.Length; cursor += (ulong)length; }
            }
        }
        return new { candidates, address = Hex(start), endAddress = Hex(end), nextAddress = Hex(Math.Min(cursor, end)), bytesRead = readBytes, skippedBytes = skipped, failedReads, capped, rangeTraversed = cursor >= end, exhaustive = cursor >= end && !capped && skipped == 0 && failedReads == 0, snapshot = false, limitation = "Numeric search over explicit readable ranges, not whole-process discovery. Region-spanning values are not scanned. Unknown initial scans retain only the stated candidate budget. Float comparison is exact at the selected width; NaNs never satisfy ordered/equal predicates." };
    }
    static object InspectReclass(string path) {
        if (!Path.IsPathRooted(path) || !path.EndsWith(".rcnet", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Expected absolute .rcnet path");
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (file.Length > 16777216) throw new ArgumentException("Project exceeds 16 MiB");
            using (var archive = new ZipArchive(file, ZipArchiveMode.Read, true)) {
                if (archive.Entries.Count > 256) throw new ArgumentException("Too many ZIP entries");
                var entries = archive.Entries.Where(e => e.FullName == "Data.xml").ToArray();
                if (entries.Length != 1 || entries[0].Length > 4194304) throw new ArgumentException("Expected one bounded Data.xml");
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4194304 };
                var nodes = new List<object>();
                using (var stream = entries[0].Open())
                using (var reader = XmlReader.Create(stream, settings)) {
                    while (reader.Read()) {
                        if (reader.Depth > 64) throw new ArgumentException("XML too deep");
                        if (reader.NodeType != XmlNodeType.Element) continue;
                        var attributes = new Dictionary<string, string>();
                        if (reader.HasAttributes) {
                            if (reader.AttributeCount > 64) throw new ArgumentException("Too many XML attributes");
                            while (reader.MoveToNextAttribute()) attributes[reader.Name] = reader.Value;
                            reader.MoveToElement();
                        }
                        nodes.Add(new { element = reader.Name, depth = reader.Depth, attributes });
                        if (nodes.Count > 4096) throw new ArgumentException("Too many project declarations");
                    }
                }
                string digest;
                file.Position = 0;
                using (var sha = System.Security.Cryptography.SHA256.Create()) digest = Bytes(sha.ComputeHash(file));
                return new { path, sha256 = digest, declarations = nodes, layoutResolved = false, limitation = "Raw declarations only. Offsets, sizes, custom nodes, formulas and class-reference layouts are not evaluated. No extraction, pointer dereference, or live ReClass connection." };
            }
        }
    }
    public static string Run(string request) {
        if (IntPtr.Size != 8) throw new InvalidOperationException("The helper must run as x64");
        var input = Json.Deserialize<Dictionary<string, object>>(request);
        string operation = Text(input, "operation");
        if (operation == "inspect_dll") return Json.Serialize(InspectDll(input));
        if (operation == "inspect_reclass") return Json.Serialize(InspectReclass(Text(input, "path")));
        if (operation == "list_processes") {
            var rows = new List<object>();
            foreach (Process p in Process.GetProcesses().OrderBy(p => p.Id)) {
                using (p) { try { rows.Add(new { pid = p.Id, name = p.ProcessName }); } catch (InvalidOperationException) {} }
                if (rows.Count == 4096) break;
            }
            return Json.Serialize(new { processes = rows, capped = rows.Count == 4096 });
        }
        int pid = Number(input, "pid", 1, int.MaxValue);
        IntPtr handle = OpenProcess(operation == "load_dll" ? 0x43au : operation == "write_memory" ? 0x438u : 0x410u, false, pid);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        try {
            long creation, exit, kernel, user;
            uint code;
            bool wow;
            if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user) || !GetExitCodeProcess(handle, out code) || code != 259 || !IsWow64Process(handle, out wow)) throw new Win32Exception();
            if (operation == "load_dll") {
                ushort processMachine, nativeMachine;
                if (!IsWow64Process2(handle, out processMachine, out nativeMachine) || nativeMachine != 0x8664 || processMachine != 0) throw new InvalidOperationException("DLL loading requires a native AMD64 Windows target; emulated and other architectures are unsupported");
            }
            string identity = creation.ToString(CultureInfo.InvariantCulture);
            if (operation != "open_process" && identity != Text(input, "identity")) throw new InvalidOperationException("Process instance changed; reopen target");
            if (operation == "open_process") {
                using (Process p = Process.GetProcessById(pid)) return Json.Serialize(new { pid, identity, name = p.ProcessName, pointerSize = wow ? 4 : 8 });
            }
            object result = Execute(handle, pid, wow, operation, input);
            if (!GetExitCodeProcess(handle, out code) || code != 259) throw new InvalidOperationException("Target exited during operation; a dispatched write may already have committed");
            return Json.Serialize(result);
        } finally { CloseHandle(handle); }
    }
}
