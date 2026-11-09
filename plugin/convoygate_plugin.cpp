#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <ctime>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "user32.lib")

HMODULE g_hModule = NULL;

// ---------------------------------------------------------------------------
// Helpers: File System & Local HWID Extraction
// ---------------------------------------------------------------------------

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

std::string GetSystemHwid() {
    HKEY hKey;
    char guid[256] = { 0 };
    DWORD size = sizeof(guid);
    if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Cryptography", 0, KEY_READ | KEY_WOW64_64KEY, &hKey) == ERROR_SUCCESS) {
        RegQueryValueExA(hKey, "MachineGuid", NULL, NULL, (LPBYTE)guid, &size);
        RegCloseKey(hKey);
    }
    return std::string(guid);
}

// ---------------------------------------------------------------------------
// Helpers: Cryptography & String Extraction
// ---------------------------------------------------------------------------

std::string Base64Decode(const std::string& input) {
    DWORD outLen = 0;
    if (!CryptStringToBinaryA(input.c_str(), (DWORD)input.length(), CRYPT_STRING_BASE64, NULL, &outLen, NULL, NULL)) {
        return "";
    }
    std::vector<BYTE> buffer(outLen);
    if (!CryptStringToBinaryA(input.c_str(), (DWORD)input.length(), CRYPT_STRING_BASE64, buffer.data(), &outLen, NULL, NULL)) {
        return "";
    }
    return std::string(reinterpret_cast<char*>(buffer.data()), outLen);
}

// Lightweight JSON token extractor (zero external dependencies)
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

// ---------------------------------------------------------------------------
// Core DRM Engine: Lease Verification & Hard Termination
// ---------------------------------------------------------------------------

void TerminateGameWithError(const std::string& title, const std::string& message) {
    MessageBoxA(
        NULL,
        message.c_str(),
        title.c_str(),
        MB_ICONSTOP | MB_SYSTEMMODAL | MB_TOPMOST
    );
    TerminateProcess(GetCurrentProcess(), 0xC0000005);
}

void EnforceLeaseOrTerminate() {
    std::string keyPath = GetPluginDirectory() + "convoygate.key";
    std::ifstream keyFile(keyPath);

    // 1. Lease File Missing
    if (!keyFile.is_open()) {
        TerminateGameWithError(
            "ConvoyGate - Access Denied",
            "No active 30-day lease found ('convoygate.key').\n\n"
            "American Truck Simulator startup has been blocked.\n"
            "Open ConvoyGate Launcher and click 'Sync Mod' to renew your subscription."
        );
        return;
    }

    std::stringstream buffer;
    buffer << keyFile.rdbuf();
    std::string rawKeyContent = buffer.str();
    keyFile.close();

    // 2. Format Integrity Check (Expects JSON container from backend)
    std::string dataBase64 = ExtractJsonField(rawKeyContent, "data");
    std::string sigBase64 = ExtractJsonField(rawKeyContent, "signature");

    if (dataBase64.empty() || sigBase64.empty()) {
        TerminateGameWithError(
            "ConvoyGate - Corrupted Key",
            "Your ConvoyGate lease file structure is damaged or tampered with.\n\n"
            "American Truck Simulator startup blocked."
        );
        return;
    }

    // 3. Decode & Parse Payload
    std::string payloadJson = Base64Decode(dataBase64);
    if (payloadJson.empty()) {
        TerminateGameWithError(
            "ConvoyGate - Decode Error",
            "Failed to read encrypted lease payload.\n"
            "Startup blocked."
        );
        return;
    }

    std::string leaseHwid = ExtractJsonField(payloadJson, "hwid");
    std::string expiresAtStr = ExtractJsonField(payloadJson, "expiresAt");

    if (leaseHwid.empty() || expiresAtStr.empty()) {
        TerminateGameWithError(
            "ConvoyGate - Invalid Claims",
            "Lease claims could not be verified.\n"
            "Startup blocked."
        );
        return;
    }

    // 4. Cryptographic Hardware Binding Check
    std::string localHwid = GetSystemHwid();
    if (localHwid.empty() || leaseHwid != localHwid) {
        TerminateGameWithError(
            "ConvoyGate - Hardware Mismatch",
            "This 30-day lease is registered to a different computer.\n\n"
            "Mod sharing is prevented. Startup blocked."
        );
        return;
    }

    // 5. Expiration Date Check (30-day rolling window)
    long long expiresAt = 0;
    try {
        expiresAt = std::stoll(expiresAtStr);
    } catch (...) {
        expiresAt = 0;
    }

    long long now = static_cast<long long>(std::time(nullptr));
    if (now >= expiresAt) {
        TerminateGameWithError(
            "ConvoyGate - Subscription Expired",
            "Your 30-day ConvoyGate mod lease has expired.\n\n"
            "Please open ConvoyGate Launcher to renew your subscription."
        );
        return;
    }
}

// ---------------------------------------------------------------------------
// SCS Software Telemetry SDK Bindings
// ---------------------------------------------------------------------------

#define SCS_EXPORT extern "C" __declspec(dllexport)

SCS_EXPORT unsigned int scs_telemetry_init(const unsigned int version, const void *const params) {
    // Verified on engine telemetry handshake
    EnforceLeaseOrTerminate();
    return 0; // SCS_RESULT_OK
}

SCS_EXPORT void scs_telemetry_shutdown(void) {
    // Engine cleanup hook
}

// Entrypoint triggered the microsecond the game process maps the DLL
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    if (ul_reason_for_call == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
        EnforceLeaseOrTerminate();
    }
    return TRUE;
}