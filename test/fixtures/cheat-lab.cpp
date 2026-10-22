#include <windows.h>

// Only used by the isolated DLL-loader smoke test, never an external target.
BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH) {
        wchar_t delay[16] = {};
        if (GetEnvironmentVariableW(L"ROXY_LAB_DLL_DELAY", delay, 16))
            Sleep(25000);
        SetEnvironmentVariableW(L"ROXY_LAB_DLL_LOADED", L"owned-fixture");
    }
    return TRUE;
}

extern "C" __declspec(dllexport) int RoxyLabValue() { return 73; }
