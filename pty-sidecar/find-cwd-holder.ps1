# Copied verbatim from C:/dev/scripts/find-cwd-holder.ps1 (validated there against a known-held
# directory) so it ships with the wcc-worktrees CLI, which runs it to split "Permission denied" into
# its two causes: a process's cwd inside the directory, or a service's handle on it.
#
# Which process has its CURRENT WORKING DIRECTORY inside a given path?
#
# A process whose cwd is a directory pins that directory's name: the contents stay
# writable but the folder cannot be renamed or moved. Nothing in WMI, Get-Process or
# the Restart Manager exposes a cwd:
#   - Win32_Process gives CommandLine, never the working directory
#   - Restart Manager (RstrtMgr.dll) does not report directory/cwd handles at all
#     (verified against a known-held directory: it reported "no holders")
#
# So this reads it where it actually lives: the target process's PEB.
#   PROCESS_BASIC_INFORMATION.PebBaseAddress  (NtQueryInformationProcess)
#   PEB + 0x20                                -> RTL_USER_PROCESS_PARAMETERS*
#   RTL_USER_PROCESS_PARAMETERS + 0x38        -> CurrentDirectory.DosPath (UNICODE_STRING)
#   UNICODE_STRING: Length @ +0x00 (USHORT), Buffer @ +0x08 (PWSTR)
# x64 offsets. Same-user processes need no elevation; anything we cannot open is reported
# as unreadable rather than silently skipped, because a silent skip looks like "not it".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\scripts\find-cwd-holder.ps1 <path> [<path> ...]

param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Paths)

Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Peb {
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr info, int len, out int ret);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);

    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;

    static IntPtr ReadPtr(IntPtr h, IntPtr at) {
        byte[] b = new byte[8]; IntPtr got;
        if (!ReadProcessMemory(h, at, b, 8, out got)) return IntPtr.Zero;
        return (IntPtr)BitConverter.ToInt64(b, 0);
    }

    /// The process's current directory, or null if it cannot be read.
    public static string CurrentDirectory(int pid) {
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (h == IntPtr.Zero) return null;
        try {
            IntPtr pbi = Marshal.AllocHGlobal(48);
            try {
                int ret;
                if (NtQueryInformationProcess(h, 0, pbi, 48, out ret) != 0) return null;
                IntPtr peb = Marshal.ReadIntPtr(pbi, 8);           // PebBaseAddress
                if (peb == IntPtr.Zero) return null;
                IntPtr parms = ReadPtr(h, (IntPtr)(peb.ToInt64() + 0x20));
                if (parms == IntPtr.Zero) return null;
                IntPtr us = (IntPtr)(parms.ToInt64() + 0x38);      // CurrentDirectory.DosPath
                byte[] lenBuf = new byte[2]; IntPtr got;
                if (!ReadProcessMemory(h, us, lenBuf, 2, out got)) return null;
                int len = BitConverter.ToUInt16(lenBuf, 0);
                if (len <= 0 || len > 4096) return null;
                IntPtr buf = ReadPtr(h, (IntPtr)(us.ToInt64() + 0x08));
                if (buf == IntPtr.Zero) return null;
                byte[] str = new byte[len];
                if (!ReadProcessMemory(h, buf, str, len, out got)) return null;
                return Encoding.Unicode.GetString(str);
            } finally { Marshal.FreeHGlobal(pbi); }
        } finally { CloseHandle(h); }
    }
}
'@

$norm = { param($p) ($p -replace '[\\/]+', '\').TrimEnd('\').ToLowerInvariant() }

$targets = @($Paths | ForEach-Object { & $norm $_ })
$hits = @(); $unreadable = 0; $checked = 0

foreach ($p in (Get-Process)) {
    $checked++
    $cwd = $null
    try { $cwd = [Peb]::CurrentDirectory($p.Id) } catch { }
    if (-not $cwd) { $unreadable++; continue }
    $n = & $norm $cwd
    foreach ($t in $targets) {
        if ($n -eq $t -or $n.StartsWith($t + '\')) {
            $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction SilentlyContinue).CommandLine
            $hits += [pscustomobject]@{ Pid = $p.Id; Name = $p.ProcessName; Cwd = $cwd; Cmd = $cl }
        }
    }
}

Write-Output "scanned $checked processes; $unreadable could not be read (protected or 32/64-bit mismatch)"
if ($hits.Count -eq 0) { Write-Output 'NO process has its cwd inside the given path(s)' }
else {
    foreach ($h in $hits) {
        Write-Output ('  pid {0}  {1}' -f $h.Pid, $h.Name)
        Write-Output ('      cwd: {0}' -f $h.Cwd)
        if ($h.Cmd) { Write-Output ('      cmd: {0}' -f $h.Cmd.Substring(0, [Math]::Min(160, $h.Cmd.Length))) }
    }
}
