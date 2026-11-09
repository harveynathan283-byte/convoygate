#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <ctime>
#include <cctype>
#include <unordered_map>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "user32.lib")

HMODULE g_hModule = NULL;
bool g_bLeaseValid = false;

// Static DRM Cipher Key
const unsigned char DRM_CIPHER_KEY[16] = {
    0x43, 0x6F, 0x6E, 0x76, 0x6F, 0x79, 0x47, 0x61,
    0x74, 0x65, 0x53, 0x65, 0x63, 0x75, 0x72, 0x65
};

std::unordered_map<HANDLE, bool> g_ProtectedHandles;
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
    char path[MAX_PATH];
    GetModuleFileNameA(g_hModule, path, MAX_PATH);
    std::string fullPath(path);
    size_t lastSlash = fullPath.find_last_of("\\/");
    if (lastSlash != std::string::npos) {
        return fullPath.substr(0, lastSlash + 1);
    }
    return ".\\";
}

// 1. Registry MachineGuid
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

// 2. Windows Computer Name (e.g. WIN-CC37CF3B)
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

    // Verify against both identifiers (matches either MachineGuid or ComputerName)
    bool hwidMatches = false;
    if (!leaseHwid.empty()) {
        if (!localGuid.empty() && leaseHwid == localGuid) hwidMatches = true;
        if (!localHost.empty() && (leaseHwid == localHost || leaseHwid.find(localHost) != std::string::npos || localHost.find(leaseHwid) != std::string::npos)) hwidMatches = true;
    }

    if (!hwidMatches) return false;

    long long expiresAt = 0;
    try { expiresAt = std::stoll(expiresAtStr); } catch (...) { return false; }
    long long now = static_cast<long long>(std::time(nullptr));
    if (now >= expiresAt) return false;

    return true;
}

// ---------------------------------------------------------------------------
// Native Win32 File Hooking (Memory Descrambler)
// ---------------------------------------------------------------------------

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
    HANDLE hFile = g_OriginalCreateFileW(
        lpFileName, dwDesiredAccess, dwShareMode,
        lpSecurityAttributes, dwCreationDisposition,
        dwFlagsAndAttributes, hTemplateFile
    );

    if (hFile != INVALID_HANDLE_VALUE && lpFileName != NULL) {
        std::wstring ws(lpFileName);
        if (ws.find(L"\\mod\\") != std::wstring::npos && ws.find(L".scs") != std::wstring::npos) {
            EnterCriticalSection(&g_HandleLock);
            g_ProtectedHandles[hFile] = true;
            LeaveCriticalSection(&g_HandleLock);
        }
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
    LARGE_INTEGER offsetBefore;
    offsetBefore.QuadPart = 0;
    if (lpOverlapped == NULL) {
        LARGE_INTEGER zero;
        zero.QuadPart = 0;
        SetFilePointerEx(hFile, zero, &offsetBefore, FILE_CURRENT);
    } else {
        offsetBefore.LowPart = lpOverlapped->Offset;
        offsetBefore.HighPart = lpOverlapped->OffsetHigh;
    }

    BOOL result = g_OriginalReadFile(hFile, lpBuffer, nNumberOfBytesToRead, lpNumberOfBytesRead, lpOverlapped);

    if (result && lpBuffer != NULL && lpNumberOfBytesRead != NULL && *lpNumberOfBytesRead > 0) {
        bool isProtected = false;
        EnterCriticalSection(&g_HandleLock);
        if (g_ProtectedHandles.find(hFile) != g_ProtectedHandles.end()) {
            isProtected = true;
        }
        LeaveCriticalSection(&g_HandleLock);

        if (isProtected && g_bLeaseValid) {
            unsigned char* buf = reinterpret_cast<unsigned char*>(lpBuffer);
            DWORD bytesRead = *lpNumberOfBytesRead;
            long long startPos = offsetBefore.QuadPart;

            for (DWORD i = 0; i < bytesRead; i++) {
                buf[i] ^= DRM_CIPHER_KEY[(startPos + i) % sizeof(DRM_CIPHER_KEY)] ^ ((startPos + i) & 0xFF);
            }
        }
    }

    return result;
}

BOOL WINAPI HookedCloseHandle(HANDLE hObject) {
    EnterCriticalSection(&g_HandleLock);
    g_ProtectedHandles.erase(hObject);
    LeaveCriticalSection(&g_HandleLock);
    return g_OriginalCloseHandle(hObject);
}

void InstallHooks() {
    HMODULE hExe = GetModuleHandle(NULL);
    if (!hExe) return;

    PIMAGE_DOS_HEADER pDosHeader = (PIMAGE_DOS_HEADER)hExe;
    if (pDosHeader->e_magic != IMAGE_DOS_SIGNATURE) return;

    PIMAGE_NT_HEADERS pNtHeaders = (PIMAGE_NT_HEADERS)((PBYTE)hExe + pDosHeader->e_lfanew);
    if (pNtHeaders->Signature != IMAGE_NT_SIGNATURE) return;

    DWORD importRva = pNtHeaders->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (!importRva) return;

    PIMAGE_IMPORT_DESCRIPTOR pImportDesc = (PIMAGE_IMPORT_DESCRIPTOR)((PBYTE)hExe + importRva);

    for (; pImportDesc->Name; pImportDesc++) {
        const char* pszModName = (const char*)((PBYTE)hExe + pImportDesc->Name);
        if (_stricmp(pszModName, "KERNEL32.dll") == 0) {
            PIMAGE_THUNK_DATA pThunk = (PIMAGE_THUNK_DATA)((PBYTE)hExe + pImportDesc->FirstThunk);
            PIMAGE_THUNK_DATA pOrigThunk = (PIMAGE_THUNK_DATA)((PBYTE)hExe + pImportDesc->OriginalFirstThunk);

            for (; pThunk->u1.Function; pThunk++, pOrigThunk++) {
                if (IMAGE_SNAP_BY_ORDINAL(pOrigThunk->u1.Ordinal)) continue;
                PIMAGE_IMPORT_BY_NAME pImportByName = (PIMAGE_IMPORT_BY_NAME)((PBYTE)hExe + pOrigThunk->u1.AddressOfData);
                const char* pszFuncName = (const char*)pImportByName->Name;

                DWORD oldProtect;
                if (strcmp(pszFuncName, "CreateFileW") == 0) {
                    g_OriginalCreateFileW = (PFN_CreateFileW)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedCreateFileW;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                } else if (strcmp(pszFuncName, "ReadFile") == 0) {
                    g_OriginalReadFile = (PFN_ReadFile)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedReadFile;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                } else if (strcmp(pszFuncName, "CloseHandle") == 0) {
                    g_OriginalCloseHandle = (PFN_CloseHandle)pThunk->u1.Function;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), PAGE_EXECUTE_READWRITE, &oldProtect);
                    pThunk->u1.Function = (ULONG_PTR)HookedCloseHandle;
                    VirtualProtect(&pThunk->u1.Function, sizeof(LPVOID), oldProtect, &oldProtect);
                }
            }
            break;
        }
    }
}

#define SCS_EXPORT extern "C" __declspec(dllexport)

SCS_EXPORT unsigned int scs_telemetry_init(const unsigned int version, const void *const params) {
    return 0;
}

SCS_EXPORT void scs_telemetry_shutdown(void) {}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    if (ul_reason_for_call == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
        InitializeCriticalSection(&g_HandleLock);

        g_bLeaseValid = ValidateActiveLease();

        if (!g_bLeaseValid) {
            MessageBoxA(
                NULL,
                "ConvoyGate Security Check:\n\n"
                "Your 30-day lease key is invalid, missing, or belongs to another machine.\n\n"
                "American Truck Simulator startup blocked.",
                "ConvoyGate - Access Denied",
                MB_ICONSTOP | MB_SYSTEMMODAL | MB_TOPMOST
            );
            TerminateProcess(GetCurrentProcess(), 0xDEAD);
            return FALSE;
        }

        InstallHooks();
    } else if (ul_reason_for_call == DLL_PROCESS_DETACH) {
        DeleteCriticalSection(&g_HandleLock);
    }
    return TRUE;
}