using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CheatLabHost
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string name);

    public static void Main(string[] args)
    {
        Console.WriteLine(Process.GetCurrentProcess().Id);
        while (true) {
            string line = Console.ReadLine();
            if (line == null || line == "exit") return;
            if (line == "verify") Console.WriteLine(
                (GetModuleHandle(args[0]) != IntPtr.Zero ? "mapped:" : "absent:") +
                Environment.GetEnvironmentVariable("ROXY_LAB_DLL_LOADED"));
        }
    }
}
