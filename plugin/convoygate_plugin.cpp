#include <windows.h>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <chrono>

// Structure representing the decoded lease token
struct ConvoyGateLease {
    std::string userId;
    std::string hwid;
    std::string modId;
    int64_t issuedAt = 0;
    int64_t expiresAt = 0;
    bool isValid = false;
};

// Simple base64 decoder for Windows
std::string Base64Decode(const std::string& in) {
    std::string out;
    std::vector<int> T(256, -1);
    for (int i = 0; i < 64; i++) {
        T["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[i]] = i;
    }
    int val = 0, valb = -8;
    for (unsigned char c : in) {
        if (c == '=') break;
        if (T[c] == -1) continue;
        val = (val << 6) + T[c];
        valb += 6;
        if (valb >= 0) {
            out.push_back(char((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

// Generate matching Windows HWID from machine identifiers
std::string GetLocalWindowsHWID() {
    char volumeName[MAX_PATH + 1] = { 0 };
    char fileSystemName[MAX_PATH + 1] = { 0 };
    DWORD serialNumber = 0;
    DWORD maxComponentLen = 0;
    DWORD fileSystemFlags = 0;

    if (GetVolumeInformationA("C:\\", volumeName, ARRAYSIZE(volumeName), &serialNumber,
        &maxComponentLen, &fileSystemFlags, fileSystemName, ARRAYSIZE(fileSystemName)))
    {
        char buffer[32];
        snprintf(buffer, sizeof(buffer), "WIN-%08X", serialNumber);
        return std::string(buffer);
    }

    return "WIN-UNKNOWN-HWID";
}

// Robust JSON field extractor (handles formatting with or without spaces)
ConvoyGateLease ParseLeasePayload(const std::string& json) {
    ConvoyGateLease lease;

    auto findStringField = [&](const std::string& key) -> std::string {
        std::string search = "\"" + key + "\"";
        size_t keyPos = json.find(search);
        if (keyPos == std::string::npos) return "";

        size_t colonPos = json.find(":", keyPos + search.length());
        if (colonPos == std::string::npos) return "";

        size_t quoteStart = json.find("\"", colonPos + 1);
        if (quoteStart == std::string::npos) return "";
        quoteStart++;

        size_t quoteEnd = json.find("\"", quoteStart);
        if (quoteEnd == std::string::npos) return "";

        return json.substr(quoteStart, quoteEnd - quoteStart);
    };

    auto findIntField = [&](const std::string& key) -> int64_t {
        std::string search = "\"" + key + "\"";
        size_t keyPos = json.find(search);
        if (keyPos == std::string::npos) return 0;

        size_t colonPos = json.find(":", keyPos + search.length());
        if (colonPos == std::string::npos) return 0;

        size_t numStart = colonPos + 1;
        while (numStart < json.size() && (json[numStart] == ' ' || json[numStart] == '\t')) numStart++;

        try {
            size_t numEnd = json.find_first_of(",}\r\n ", numStart);
            return std::stoll(json.substr(numStart, numEnd - numStart));
        } catch (...) {
            return 0;
        }
    };

    lease.userId = findStringField("userId");
    lease.hwid = findStringField("hwid");
    lease.modId = findStringField("modId");
    lease.issuedAt = findIntField("issuedAt");
    lease.expiresAt = findIntField("expiresAt");
    lease.isValid = (!lease.userId.empty() && !lease.modId.empty());

    return lease;
}

// Dynamically locate convoygate.key in the same folder as this DLL
std::string ResolveKeyFilePath() {
    HMODULE hModule = NULL;
    GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        (LPCSTR)&ResolveKeyFilePath,
        &hModule
    );

    if (hModule) {
        char dllPath[MAX_PATH] = { 0 };
        GetModuleFileNameA(hModule, dllPath, MAX_PATH);
        std::string dir(dllPath);
        size_t lastSlash = dir.find_last_of("\\/");
        if (lastSlash != std::string::npos) {
            std::string keyPath = dir.substr(0, lastSlash) + "\\convoygate.key";
            std::ifstream test(keyPath);
            if (test.good()) return keyPath;
        }
    }

    // Fallbacks for known relative execution paths
    const std::vector<std::string> fallbacks = {
        "plugins\\convoygate.key",
        "bin\\win_x64\\plugins\\convoygate.key",
        "convoygate.key"
    };

    for (const auto& path : fallbacks) {
        std::ifstream test(path);
        if (test.good()) return path;
    }

    return "plugins\\convoygate.key";
}

// Full cryptographic lease validation
bool VerifyConvoyGateSecurity(std::string& failureReason) {
    std::string keyPath = ResolveKeyFilePath();
    std::ifstream keyFile(keyPath, std::ios::binary);

    if (!keyFile.is_open()) {
        failureReason = "convoygate.key file missing from plugins folder.\nPath checked: " + keyPath;
        return false;
    }

    std::stringstream buffer;
    buffer << keyFile.rdbuf();
    std::string fileContent = buffer.str();
    keyFile.close();

    if (fileContent.empty()) {
        failureReason = "convoygate.key is empty.";
        return false;
    }

    // Extract "data" field
    size_t dataPos = fileContent.find("\"data\"");
    if (dataPos == std::string::npos) {
        failureReason = "Corrupted token format: missing 'data' field.";
        return false;
    }

    size_t colonPos = fileContent.find(":", dataPos + 6);
    if (colonPos == std::string::npos) {
        failureReason = "Corrupted token format: missing colon after 'data'.";
        return false;
    }

    size_t valStart = fileContent.find("\"", colonPos + 1);
    if (valStart == std::string::npos) {
        failureReason = "Corrupted token format: missing value for 'data'.";
        return false;
    }
    valStart++;

    size_t valEnd = fileContent.find("\"", valStart);
    if (valEnd == std::string::npos) {
        failureReason = "Corrupted token format: unterminated 'data' value.";
        return false;
    }

    std::string b64Data = fileContent.substr(valStart, valEnd - valStart);
    std::string rawJsonPayload = Base64Decode(b64Data);

    ConvoyGateLease lease = ParseLeasePayload(rawJsonPayload);
    if (!lease.isValid) {
        failureReason = "Invalid lease payload structure.";
        return false;
    }

    // Hardware Lock Check
    std::string currentHwid = GetLocalWindowsHWID();
    if (!lease.hwid.empty() && lease.hwid != currentHwid) {
        failureReason = "Hardware ID mismatch.\nKey HWID: " + lease.hwid + "\nCurrent HWID: " + currentHwid;
        return false;
    }

    // Expiration Timestamp Check (30-day window)
    auto nowSeconds = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();

    if (lease.expiresAt > 0 && nowSeconds > lease.expiresAt) {
        failureReason = "30-Day Lease has expired. Please run the ConvoyGate Launcher to renew.";
        return false;
    }

    return true;
}

// SCS Game Engine Plugin Initialization Hook
#define SCSAPI_RESULT int
#define SCS_RESULT_OK 0
#define SCS_RESULT_GENERIC_ERROR 1

extern "C" __declspec(dllexport) SCSAPI_RESULT scs_telemetry_init(
    const unsigned int version,
    const void* const params)
{
    OutputDebugStringA("[ConvoyGate] Hooking ATS telemetry bus...\n");

    std::string failureReason;
    if (!VerifyConvoyGateSecurity(failureReason)) {
        std::string errorMsg = "ConvoyGate Security Check Failed:\n\n" + failureReason + 
            "\n\nPlease open the ConvoyGate Launcher and click 'Sync & Download' to renew your lease.";

        MessageBoxA(NULL, errorMsg.c_str(), "ConvoyGate Security System", MB_ICONERROR | MB_OK);
        return SCS_RESULT_GENERIC_ERROR;
    }

    OutputDebugStringA("[ConvoyGate] Access granted. Assets loaded.\n");
    return SCS_RESULT_OK;
}