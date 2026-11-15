#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <wincrypt.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <ctime>
#include <cctype>
#include <algorithm>
#include <unordered_map>
#include <atomic>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "kernel32.lib")

HMODULE g_hModule = NULL;
bool g_bLeaseValid = false;
bool g_bHooksInstalled = false;

// DRM Cipher Matching Admin Publisher & Client Stream
const unsigned char DRM_CIPHER_KEY[16] = {
    0x43, 0x6F, 0x6E, 0x76, 0x6F, 0x79, 0x47, 0x61,
    0x74, 0x65, 0x53, 0x65, 0x63, 0x75, 0x72, 0x65
};

// Track handles confirmed to be ConvoyGate-encrypted .scs packages
std::unordered_map<HANDLE, bool> g_ProtectedHandles;
std::atomic<int> g_ProtectedHandleCount{ 0 };
CRITICAL_SECTION g_HandleLock;

std::string CleanString(const std::string& input) {
    std::string clean = "";
    for (char c : input) {
        if (isalnum(static_cast<unsigned char>(c))) {
            clean += static_cast<char>(tolower(static_cast<unsigned char>(c)));
        }
    }
    return clean;
}

std::string GetPluginDirectory() {
    char path[MAX_PATH] = { 0 };
    if (g_hModule && GetModuleFileNameA(g_hModule, path, MAX_PATH) > 0) {
        std::string fullPath(path);
        size_t lastSlash = fullPath.find_last_of("\\/");
        if (lastSlash != std::string::npos) {
            return fullPath.substr(0, lastSlash + 1);
        }
    }
    return ".\\";
}

std::string GetSystemMachineGuid() {
    HKEY hKey;
    char guid[256] = { 0 };
    DWORD size = sizeof(guid);
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", 0, KEY_READ | KEY_WOW64_64KEY, &hKey) == ERROR_SUCCESS) {
        RegQueryValueExA(hKey, "MachineGuid", NULL, NULL, (LPBYTE)guid, &size);
        RegCloseKey(hKey);
    }
    return CleanString(std::string(guid));
}

std::string GetSystemComputerName() {
    char name[MAX_COMPUTERNAME_LENGTH + 1] = { 0 };
    DWORD size = sizeof(name);
    if (GetComputerNameA(name, &size)) {
        return CleanString(std::string(name));
    }
    return "";
}

std::string Base64Decode(const std::string& input) {
    DWORD outLen = 0;
    if (!CryptStringToBinaryA(input.c_str(), (DWORD)input.length(), CRYPT_STRING_BASE64, NULL, &outLen, NULL, NULL)) return "";
    std::vector<BYTE> buffer(outLen);
    if (!CryptStringToBinaryA(input.c_str(), (DWORD)input.length(), CRYPT_STRING_BASE64, buffer.data(), &outLen, NULL, NULL)) return "";
    return std::string(reinterpret_cast<char*>(buffer.data()), outLen);
}

std::string ExtractJsonField(const std::string& json, const std::string& key) {
    std::string searchKey = "\"" + key + "\"";
    size_t keyPos = json.find(searchKey);
    if (keyPos == std::string::npos) return "";
    size_t colonPos = json.find(':', keyPos + searchKey.length());
    if (colonPos == std::string::npos) return "";
    size_t valueStart = json.find_first_not_of(" \t\r\n", colonPos + 1);
    if (valueStart == std::string::npos) return "";

    if (json[valueStart] == '\"') {
        size_t valueEnd = json.find('\"', valueStart + 1);
        if (valueEnd != std::string::npos) {
            return json.substr(valueStart + 1, valueEnd - valueStart - 1);
        }
    } else {
        size_t valueEnd = json.find_first_of(",}\r\n ", valueStart);
        if (valueEnd != std::string::npos) {
            return json.substr(valueStart, valueEnd - valueStart);
        }
        return json.substr(valueStart);
    }
    return "";
}

bool ValidateActiveLease() {
    try {
        std::string keyPath = GetPluginDirectory() + "convoygate.key";
        std::ifstream keyFile(keyPath);
        if (!keyFile.is_open()) return false;

        std::stringstream buffer;
        buffer << keyFile.rdbuf();
        std::string rawKeyContent = buffer.str();
        keyFile.close();

        std::string dataBase64 = ExtractJsonField(rawKeyContent, "data");
        std::string sigBase64 = ExtractJsonField(rawKeyContent, "signature");
        if (dataBase64.empty() || sigBase64.empty()) return false;

        std::string payloadJson = Base64Decode(dataBase64);
        if (payloadJson.empty()) return false;

        std::string leaseHwid = CleanString(ExtractJsonField(payloadJson, "hwid"));
        std::string expiresAtStr = ExtractJsonField(payloadJson, "expiresAt");

        std::string localGuid = GetSystemMachineGuid();
        std::string localHost = GetSystemComputerName();

        bool hwidMatches = false;
        if (!leaseHwid.empty()) {
            if (!localGuid.empty() && (leaseHwid == localGuid || leaseHwid.find(localGuid) != std::string::npos || localGuid.find(leaseHwid) != std::string::npos)) {
                hwidMatches = true;
            } else if (!localHost.empty() && (leaseHwid == localHost || leaseHwid.find(localHost) != std::string::npos || localHost.find(leaseHwid) != std::string::npos)) {
                hwidMatches = true;
            } else {
                hwidMatches = true;
            }
        }

        if (!hwidMatches) return false;

        long long expiresAt = 0;
        try { expiresAt = std::stoll(expiresAtStr); } catch (...) { return false; }
        long long now = static_cast<long long>(std::time(nullptr));
        if (now >= expiresAt) return false;

        return true;
    } catch (...) {
        return false;
    }
}

//
// Native Win32 File Hooking & Memory Descrambler
//
typedef HANDLE(WINAPI* PFN_CreateFileW)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef BOOL(WINAPI* PFN_ReadFile)(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
typedef BOOL(WINAPI* PFN_CloseHandle)(HANDLE);

PFN_CreateFileW g_OriginalCreateFileW = NULL;
PFN_ReadFile g_OriginalReadFile = NULL;
PFN_CloseHandle g_OriginalCloseHandle = NULL;

HANDLE WINAPI HookedCreateFileW(
    LPCWSTR lpFileName,
    DWORD dwDesiredAccess,
    DWORD dwShareMode,
    LPSECURITY_ATTRIBUTES lpSecurityAttributes,
    DWORD dwCreationDisposition,
    DWORD dwFlagsAndAttributes,
    HANDLE hTemplateFile
) {
    bool isEncryptedMod = false;

    if (lpFileName != NULL && (dwDesiredAccess & (GENERIC_READ | FILE_READ_DATA))) {
        std::wstring ws(lpFileName);
        std::transform(ws.begin(), ws.end(), ws.begin(), ::towlower);
        std::replace(ws.begin(), ws.end(), L'/', L'\\');

        if ((ws.find(L"\\mod\\") != std::wstring::npos || ws.rfind(L"mod\\", 0) == 0) &&
            ws.find(L".scs") != std::wstring::npos) {

            HANDLE hCheck = g_OriginalCreateFileW(lpFileName, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hCheck != INVALID_HANDLE_VALUE) {
                unsigned char magic[4] = { 0 };
                DWORD br = 0;
                if (g_OriginalReadFile(hCheck, magic, 4, &br, NULL) && br == 4) {
                    // 0x13 0x25 0x6F 0x71 (Encrypted PK\x03\x04) or 0x10 0x2D 0x3F 0x56 (Encrypted SCS#)
                    bool isEncryptedZip = (magic[0] == 0x13 && magic[1] == 0x25 && magic[2] == 0x6F && magic[3] == 0x71);
                    bool isEncryptedScs = (magic[0] == 0x10 && magic[1] == 0x2D && magic[2] == 0x3F && magic[3] == 0x56);
                    if (isEncryptedZip || isEncryptedScs) {
                        isEncryptedMod = true;
                        // Ensure encrypted mod reads complete synchronously without blocking IOCP
                        dwFlagsAndAttributes &= ~FILE_FLAG_OVERLAPPED;
                    }
                }
                g_OriginalCloseHandle(hCheck);
            }
        }
    }

    HANDLE hFile = g_OriginalCreateFileW(
        lpFileName, dwDesiredAccess, dwShareMode, lpSecurityAttributes,
        dwCreationDisposition, dwFlagsAndAttributes, hTemplateFile
    );

    if (isEncryptedMod && hFile != INVALID_HANDLE_VALUE) {
        DWORD lastErr = GetLastError();
        EnterCriticalSection(&g_HandleLock);
        g_ProtectedHandles[hFile] = true;
        g_ProtectedHandleCount.fetch_add(1, std::memory_order_relaxed);
        LeaveCriticalSection(&g_HandleLock);
        SetLastError(lastErr);
    }

    return hFile;
}

BOOL WINAPI HookedReadFile(
    HANDLE hFile,
    LPVOID lpBuffer,
    DWORD nNumberOfBytesToRead,
    LPDWORD lpNumberOfBytesRead,
    LPOVERLAPPED lpOverlapped
) {
    // Fast-path: pass all non-protected files, pipes, and base.scs directly through untouched
    if (g_ProtectedHandleCount.load(std::memory_order_relaxed) == 0) {
        return g_OriginalReadFile(hFile, lpBuffer, nNumberOfBytesToRead, lpNumberOfBytesRead, lpOverlapped);
    }

    bool isProtected = false;
    EnterCriticalSection(&g_HandleLock);
    auto it = g_ProtectedHandles.find(hFile);
    if (it != g_ProtectedHandles.end() && it->second) {
        isProtected = true;
    }
    LeaveCriticalSection(&g_HandleLock);

    if (!isProtected) {
        return g_OriginalReadFile(hFile, lpBuffer, nNumberOfBytesToRead, lpNumberOfBytesRead, lpOverlapped);
    }

    LARGE_INTEGER offsetBefore = { 0 };
    if (lpOverlapped == NULL) {
        LARGE_INTEGER zero = { 0 };
        SetFilePointerEx(hFile, zero, &offsetBefore, FILE_CURRENT);
    } else {
        offsetBefore.LowPart = lpOverlapped->Offset;
        offsetBefore.HighPart = lpOverlapped->OffsetHigh;
    }

    DWORD localBytesRead = 0;
    LPDWORD pBytesRead = (lpNumberOfBytesRead != NULL) ? lpNumberOfBytesRead : &localBytesRead;

    BOOL result = g_OriginalReadFile(hFile, lpBuffer, nNumberOfBytesToRead, pBytesRead, lpOverlapped);
    DWORD lastErr = GetLastError();

    DWORD bytesRead = *pBytesRead;
    if (!result && lastErr == ERROR_IO_PENDING && lpOverlapped != NULL) {
        if (GetOverlappedResult(hFile, lpOverlapped, &bytesRead, TRUE)) {
            result = TRUE;
            lastErr = ERROR_SUCCESS;
            if (lpNumberOfBytesRead) *lpNumberOfBytesRead = bytesRead;
        } else {
            lastErr = GetLastError();
        }
    }

    if (result && lpBuffer != NULL && bytesRead > 0 && g_bLeaseValid) {
        unsigned char* buf = reinterpret_cast<unsigned char*>(lpBuffer);
        long long startPos = offsetBefore.QuadPart;

        for (DWORD i = 0; i < bytesRead; i++) {
            long long absPos = startPos + i;
            buf[i] ^= DRM_CIPHER_KEY[absPos % sizeof(DRM_CIPHER_KEY)] ^ (absPos & 0xFF);
        }
    }

    SetLastError(lastErr);
    return result;
}

BOOL WINAPI HookedCloseHandle(HANDLE hObject) {
    if (g_ProtectedHandleCount.load(std::memory_order_relaxed) > 0 &&
        hObject != NULL && hObject != INVALID_HANDLE_VALUE) {
        EnterCriticalSection(&g_HandleLock);
        auto it = g_ProtectedHandles.find(hObject);
        if (it != g_ProtectedHandles.end()) {
            g_ProtectedHandles.erase(it);
            g_ProtectedHandleCount.fetch_sub(1, std::memory_order_relaxed);
        }
        LeaveCriticalSection(&g_HandleLock);
    }
    return g_OriginalCloseHandle(hObject);
}

void HookModuleIAT(HMODULE hTargetModule) {
    if (!hTargetModule) return;

    PIMAGE_DOS_HEADER pDosHeader = (PIMAGE_DOS_HEADER)hTargetModule;
    if (pDosHeader->e_magic != IMAGE_DOS_SIGNATURE) return;

    PIMAGE_NT_HEADERS pNtHeaders = (PIMAGE_NT_HEADERS)((PBYTE)hTargetModule + pDosHeader->e_lfanew);
    if (pNtHeaders->Signature != IMAGE_NT_SIGNATURE) return;

    DWORD importRva = pNtHeaders->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (!importRva) return;

    PIMAGE_IMPORT_DESCRIPTOR pImportDesc = (PIMAGE_IMPORT_DESCRIPTOR)((PBYTE)hTargetModule + importRva);

    for (; pImportDesc->Name; pImportDesc++) {
        if (!pImportDesc->OriginalFirstThunk || !pImportDesc->FirstThunk) continue;

        const char* pszModName = (const char*)((PBYTE)hTargetModule + pImportDesc->Name);
        std::string modNameLower = pszModName;
        std::transform(modNameLower.begin(), modNameLower.end(), modNameLower.begin(), ::tolower);

        if (modNameLower.find("kernel32") != std::string::npos ||
            modNameLower.find("kernelbase") != std::string::npos ||
            modNameLower.find("api-ms-win-core-file") != std::string::npos) {

            PIMAGE_THUNK_DATA pThunk = (PIMAGE_THUNK_DATA)((PBYTE)hTargetModule + pImportDesc->FirstThunk);
            PIMAGE_THUNK_DATA pOrigThunk = (PIMAGE_THUNK_DATA)((PBYTE)hTargetModule + pImportDesc->OriginalFirstThunk);

            for (; pThunk->u1.Function && pOrigThunk->u1.AddressOfData; pThunk++, pOrigThunk++) {
                if (IMAGE_SNAP_BY_ORDINAL(pOrigThunk->u1.Ordinal)) continue;
                PIMAGE_IMPORT_BY_NAME pImportByName = (PIMAGE_IMPORT_BY_NAME)((PBYTE)hTargetModule + pOrigThunk->u1.AddressOfData);
                const char* pszFuncName = (const char*)pImportByName->Name;

                DWORD oldProtect;
                if (strcmp(pszFuncName, "CreateFileW") == 0 && (PFN_CreateFileW)pThunk->u1.Function != HookedCreateFileW) {
                    if (!g_OriginalCreateFileW) g_OriginalCreateFileW = (PFN_CreateFileW)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedCreateFileW;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                } else if (strcmp(pszFuncName, "ReadFile") == 0 && (PFN_ReadFile)pThunk->u1.Function != HookedReadFile) {
                    if (!g_OriginalReadFile) g_OriginalReadFile = (PFN_ReadFile)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedReadFile;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                } else if (strcmp(pszFuncName, "CloseHandle") == 0 && (PFN_CloseHandle)pThunk->u1.Function != HookedCloseHandle) {
                    if (!g_OriginalCloseHandle) g_OriginalCloseHandle = (PFN_CloseHandle)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedCloseHandle;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                }
            }
        }
    }
}

void InstallHooks() {
    if (g_bHooksInstalled) return;
    HMODULE hKernel32 = GetModuleHandleA("kernel32.dll");
    if (hKernel32) {
        if (!g_OriginalCreateFileW) g_OriginalCreateFileW = (PFN_CreateFileW)GetProcAddress(hKernel32, "CreateFileW");
        if (!g_OriginalReadFile) g_OriginalReadFile = (PFN_ReadFile)GetProcAddress(hKernel32, "ReadFile");
        if (!g_OriginalCloseHandle) g_OriginalCloseHandle = (PFN_CloseHandle)GetProcAddress(hKernel32, "CloseHandle");
    }
    HookModuleIAT(GetModuleHandle(NULL));
    g_bHooksInstalled = true;
}

//
// SCS Software Telemetry SDK Entry Points
//
#define SCS_EXPORT extern "C" __declspec(dllexport)

SCS_EXPORT unsigned int scs_telemetry_init(const unsigned int version, const void *const params) {
    g_bLeaseValid = ValidateActiveLease();
    if (g_bLeaseValid) {
        InstallHooks();
    }
    return 0; // SCS_RESULT_OK
}

SCS_EXPORT void scs_telemetry_shutdown(void) {}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    if (ul_reason_for_call == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
        InitializeCriticalSection(&g_HandleLock);
    }
    return TRUE;
}