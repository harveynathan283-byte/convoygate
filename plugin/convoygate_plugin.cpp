#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fstream>
#include <string>
#include <thread>
#include <atomic>

// Include SCS SDK headers
#include "include/scssdk_telemetry.h"
#include "include/eurotrucks2/et2_telemetry_id.h"
#include "include/amtrucks/amtrucks_telemetry_id.h"

static std::atomic<bool> g_authenticated(false);
static scs_log_t g_game_log = nullptr;

// 1. DllMain MUST BE LEAN - DO NOT DO I/O OR NETWORKING HERE
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved) {
    if (ul_reason_for_call == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
    }
    return TRUE;
}

void LogMessage(const scs_log_type_t type, const char* const msg) {
    if (g_game_log) {
        g_game_log(type, msg);
    }
}

// Background worker so ATS main thread NEVER freezes
void ValidateKeyInBackground() {
    try {
        // Read convoygate.key safely without throwing
        std::ifstream keyFile("plugins/convoygate.key");
        if (!keyFile.is_open()) {
            keyFile.open("convoygate.key");
        }

        if (keyFile.is_open()) {
            std::string content((std::istreambuf_iterator<char>(keyFile)),
                                 std::istreambuf_iterator<char>());
            keyFile.close();

            if (!content.empty()) {
                g_authenticated = true;
                LogMessage(SCS_LOG_TYPE_message, "[ConvoyGate] Key validated successfully.");
                return;
            }
        }
        LogMessage(SCS_LOG_TYPE_warning, "[ConvoyGate] convoygate.key missing or empty.");
    } catch (...) {
        LogMessage(SCS_LOG_TYPE_error, "[ConvoyGate] Exception occurred while reading key.");
    }
}

// 2. REQUIRED SCS TELEMETRY ENTRY POINTS
SCS_EXTERNAL scs_status_t scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t* const params) {
    if (version < SCS_TELEMETRY_VERSION_1_00) {
        return SCS_RESULT_unsupported;
    }

    const auto* const version_params = static_cast<const scs_telemetry_init_params_v100_t*>(params);
    if (!version_params) {
        return SCS_RESULT_generic_error;
    }

    g_game_log = version_params->common.log;
    LogMessage(SCS_LOG_TYPE_message, "[ConvoyGate] Telemetry hook initialized.");

    // Spin off validation to background thread so ATS loading is never blocked
    std::thread(ValidateKeyInBackground).detach();

    return SCS_RESULT_ok;
}

SCS_EXTERNAL scs_status_t scs_telemetry_shutdown(void) {
    LogMessage(SCS_LOG_TYPE_message, "[ConvoyGate] Telemetry hook shutdown.");
    g_game_log = nullptr;
    return SCS_RESULT_ok;
}