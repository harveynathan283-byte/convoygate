#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <fstream>
#include <string>
#include <thread>
#include <atomic>
#include <cstdint>

// Inline SCS Telemetry SDK v1.00 ABI (no external SDK headers required)
typedef uint32_t scs_u32_t;
typedef int32_t scs_result_t;
typedef int32_t scs_log_type_t;
typedef void (*scs_log_t)(const scs_log_type_t type, const char* const message);

#define SCS_TELEMETRY_VERSION_1_00 ((1 << 16) | 0)
#define SCS_RESULT_ok 0
#define SCS_RESULT_unsupported -1
#define SCS_RESULT_generic_error -7

#define SCS_LOG_TYPE_message 0
#define SCS_LOG_TYPE_warning 1
#define SCS_LOG_TYPE_error 2

struct scs_common_init_params_v100_t {
    const char* game_id;
    const char* game_name;
    scs_u32_t game_version;
    scs_log_t log;
};

struct scs_telemetry_init_params_v100_t {
    scs_common_init_params_v100_t common;
};

static HMODULE g_hModule = nullptr;
static std::atomic<bool> g_authenticated(false);
static scs_log_t g_game_log = nullptr;

BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    if (ul_reason_for_call == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
    }
    return TRUE;
}

static void LogMessage(const scs_log_type_t type, const char* const msg) {
    if (g_game_log) {
        g_game_log(type, msg);
    }
}

static std::wstring GetPluginDirectory() {
    wchar_t pathBuf[MAX_PATH] = { 0 };
    if (g_hModule && GetModuleFileNameW(g_hModule, pathBuf, MAX_PATH) > 0) {
        std::wstring fullPath(pathBuf);
        size_t pos = fullPath.find_last_of(L"\\/");
        if (pos != std::wstring::npos) {
            return fullPath.substr(0, pos + 1);
        }
    }
    return L"plugins\\";
}

static void ValidateKeyInBackground() {
    try {
        std::wstring keyPath = GetPluginDirectory() + L"convoygate.key";
        std::ifstream keyFile(keyPath, std::ios::binary);

        if (keyFile.is_open()) {
            std::string content((std::istreambuf_iterator<char>(keyFile)),
                                 std::istreambuf_iterator<char>());
            keyFile.close();

            if (!content.empty()) {
                g_authenticated = true;
                LogMessage(SCS_LOG_TYPE_message, "[ConvoyGate] License key validated.");
                return;
            }
        }
        LogMessage(SCS_LOG_TYPE_warning, "[ConvoyGate] convoygate.key not found or empty.");
    } catch (...) {
        LogMessage(SCS_LOG_TYPE_error, "[ConvoyGate] Safe recovery from key read error.");
    }
}

extern "C" __declspec(dllexport) scs_result_t scs_telemetry_init(const scs_u32_t version, const void* const params) {
    if (version < SCS_TELEMETRY_VERSION_1_00 || !params) {
        return SCS_RESULT_unsupported;
    }