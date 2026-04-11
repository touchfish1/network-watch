#include "network_watch/application.hpp"

#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>

#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_windows_metrics_provider();

namespace {

AppLanguage effective_language(const Settings& settings) {
    return resolve_language(settings);
}

constexpr UINT kTrayCallbackMessage = WM_APP + 1;
constexpr UINT kApplySummaryMessage = WM_APP + 2;
constexpr UINT kShowMonitorMessage = WM_APP + 3;
constexpr UINT kRefreshMonitorMessage = WM_APP + 4;
constexpr UINT kMenuSummaryId = 1001;
constexpr UINT kMenuCpuMemoryId = 1002;
constexpr UINT kMenuNetworkId = 1003;
constexpr UINT kMenuOpenId = 1004;
constexpr UINT kMenuQuitId = 1005;
constexpr UINT kMenuCheckUpdatesId = 1006;
constexpr UINT kUpdateCheckCompletedMessage = WM_APP + 5;
constexpr wchar_t kHostWindowClassName[] = L"NetworkWatchTrayWindow";
constexpr wchar_t kMonitorWindowClassName[] = L"NetworkWatchMonitorWindow";
constexpr wchar_t kReleaseApiHost[] = L"api.github.com";
constexpr wchar_t kReleaseApiPath[] = L"/repos/touchfish1/network-watch/releases/latest";

std::string format_bytes(double bytes) {
    static const char* units[] = {"B", "KB", "MB", "GB", "TB"};
    std::size_t unit_index = 0;

    while (bytes >= 1024.0 && unit_index < 4) {
        bytes /= 1024.0;
        ++unit_index;
    }

    std::ostringstream output;
    output << std::fixed << std::setprecision(unit_index == 0 ? 0 : 1) << bytes << ' ' << units[unit_index];
    return output.str();
}

std::string format_rate(double bytes_per_second) {
    return format_bytes(bytes_per_second) + "/s";
}

std::string format_percent(double value) {
    std::ostringstream output;
    output << std::fixed << std::setprecision(1) << value << '%';
    return output.str();
}

std::string format_timestamp(const TimePoint& timestamp) {
    const auto value = Clock::to_time_t(timestamp);
    std::tm tm_value {};
    localtime_s(&tm_value, &value);

    std::ostringstream output;
    output << std::put_time(&tm_value, "%Y-%m-%d %H:%M:%S");
    return output.str();
}

std::string build_interfaces_text(const MetricDelta& latest, AppLanguage language) {
    if (latest.interfaces.empty()) {
        return language == AppLanguage::SimplifiedChinese ? "暂未检测到活跃网络接口。" : "No active interfaces detected yet.";
    }

    std::ostringstream output;
    bool first = true;
    for (const auto& item : latest.interfaces) {
        if (!first) {
            output << "\r\n";
        }
        first = false;
        output << item.name << " | "
               << (item.is_up
                       ? (language == AppLanguage::SimplifiedChinese ? "启用" : "up")
                       : (language == AppLanguage::SimplifiedChinese ? "停用" : "down"))
               << " | "
               << localized_metric_short_label(AlertMetric::DownloadRate, language) << ' '
               << format_rate(item.rx_bytes_per_second) << " | "
               << localized_metric_short_label(AlertMetric::UploadRate, language) << ' '
               << format_rate(item.tx_bytes_per_second);
        if (!item.address.empty()) {
            output << " | " << item.address;
        }
    }
    return output.str();
}

std::wstring utf8_to_wide(const std::string& value) {
    if (value.empty()) {
        return {};
    }

    const int required = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, nullptr, 0);
    if (required <= 1) {
        return {};
    }

    std::wstring result(static_cast<std::size_t>(required), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, result.data(), required);
    result.resize(static_cast<std::size_t>(required - 1));
    return result;
}

std::wstring truncate_tip(const std::wstring& text) {
    constexpr std::size_t kMaxTipLength = 127;
    if (text.size() <= kMaxTipLength) {
        return text;
    }
    return text.substr(0, kMaxTipLength - 3) + L"...";
}

std::string current_app_version() {
#ifdef NETWORK_WATCH_VERSION
    return NETWORK_WATCH_VERSION;
#else
    return "0.0.0";
#endif
}

std::string trim_version_prefix(std::string value) {
    if (!value.empty() && (value.front() == 'v' || value.front() == 'V')) {
        value.erase(value.begin());
    }
    return value;
}

int compare_versions(const std::string& lhs, const std::string& rhs) {
    std::istringstream lhs_stream(trim_version_prefix(lhs));
    std::istringstream rhs_stream(trim_version_prefix(rhs));
    for (;;) {
        std::string lhs_token;
        std::string rhs_token;
        const bool has_lhs = static_cast<bool>(std::getline(lhs_stream, lhs_token, '.'));
        const bool has_rhs = static_cast<bool>(std::getline(rhs_stream, rhs_token, '.'));
        if (!has_lhs && !has_rhs) {
            break;
        }

        const int lhs_value = lhs_token.empty() ? 0 : std::stoi(lhs_token);
        const int rhs_value = rhs_token.empty() ? 0 : std::stoi(rhs_token);
        if (lhs_value != rhs_value) {
            return lhs_value < rhs_value ? -1 : 1;
        }
    }

    return 0;
}

std::string json_unescape(const std::string& value) {
    std::string result;
    result.reserve(value.size());

    bool escaping = false;
    for (char ch : value) {
        if (escaping) {
            switch (ch) {
                case '\\': result.push_back('\\'); break;
                case '"': result.push_back('"'); break;
                case '/': result.push_back('/'); break;
                case 'n': result.push_back('\n'); break;
                case 'r': result.push_back('\r'); break;
                case 't': result.push_back('\t'); break;
                default: result.push_back(ch); break;
            }
            escaping = false;
            continue;
        }
        if (ch == '\\') {
            escaping = true;
            continue;
        }
        result.push_back(ch);
    }

    return result;
}

bool extract_json_string(const std::string& json, const std::string& key, std::size_t start, std::string& value, std::size_t* next_pos = nullptr) {
    const auto key_pattern = std::string("\"") + key + "\"";
    const auto key_pos = json.find(key_pattern, start);
    if (key_pos == std::string::npos) {
        return false;
    }

    const auto colon_pos = json.find(':', key_pos + key.size() + 2);
    const auto open_quote = json.find('\"', colon_pos + 1);
    if (colon_pos == std::string::npos || open_quote == std::string::npos) {
        return false;
    }

    std::string raw_value;
    bool escaping = false;
    for (std::size_t index = open_quote + 1; index < json.size(); ++index) {
        const char ch = json[index];
        if (!escaping && ch == '\"') {
            value = json_unescape(raw_value);
            if (next_pos != nullptr) {
                *next_pos = index + 1;
            }
            return true;
        }
        raw_value.push_back(ch);
        escaping = (!escaping && ch == '\\');
    }

    return false;
}

bool http_get_text(const std::wstring& host, const std::wstring& path, std::string& body, std::string& error_message) {
    auto session = WinHttpOpen(L"NetworkWatchUpdater/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (session == nullptr) {
        error_message = "WinHttpOpen failed";
        return false;
    }

    auto close_handles = [&]() {
        WinHttpCloseHandle(session);
    };

    HINTERNET connection = WinHttpConnect(session, host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (connection == nullptr) {
        error_message = "WinHttpConnect failed";
        close_handles();
        return false;
    }

    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
    if (request == nullptr) {
        error_message = "WinHttpOpenRequest failed";
        WinHttpCloseHandle(connection);
        close_handles();
        return false;
    }

    const std::wstring headers =
        L"User-Agent: NetworkWatch/" + utf8_to_wide(current_app_version()) + L"\r\n"
        L"Accept: application/vnd.github+json\r\n"
        L"X-GitHub-Api-Version: 2022-11-28\r\n";

    bool ok = WinHttpSendRequest(request, headers.c_str(), static_cast<DWORD>(headers.size()), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
              WinHttpReceiveResponse(request, nullptr);

    if (!ok) {
        error_message = "WinHTTP request failed";
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        close_handles();
        return false;
    }

    DWORD status_code = 0;
    DWORD status_size = sizeof(status_code);
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status_code, &status_size, WINHTTP_NO_HEADER_INDEX) ||
        status_code != 200) {
        error_message = "GitHub API returned HTTP " + std::to_string(status_code);
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        close_handles();
        return false;
    }

    body.clear();
    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available)) {
            error_message = "WinHttpQueryDataAvailable failed";
            break;
        }
        if (available == 0) {
            ok = true;
            break;
        }

        std::string chunk(available, '\0');
        DWORD downloaded = 0;
        if (!WinHttpReadData(request, chunk.data(), available, &downloaded)) {
            error_message = "WinHttpReadData failed";
            ok = false;
            break;
        }
        chunk.resize(downloaded);
        body += chunk;
        ok = true;
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    close_handles();
    return ok;
}

bool download_file_https(const std::string& url, const std::filesystem::path& destination, std::string& error_message) {
    URL_COMPONENTSW components {};
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = static_cast<DWORD>(-1);
    components.dwHostNameLength = static_cast<DWORD>(-1);
    components.dwUrlPathLength = static_cast<DWORD>(-1);
    components.dwExtraInfoLength = static_cast<DWORD>(-1);

    auto wide_url = utf8_to_wide(url);
    if (!WinHttpCrackUrl(wide_url.c_str(), 0, 0, &components)) {
        error_message = "WinHttpCrackUrl failed";
        return false;
    }

    const std::wstring host(components.lpszHostName, components.dwHostNameLength);
    std::wstring path(components.lpszUrlPath, components.dwUrlPathLength);
    if (components.dwExtraInfoLength > 0) {
        path.append(components.lpszExtraInfo, components.dwExtraInfoLength);
    }

    auto session = WinHttpOpen(L"NetworkWatchUpdater/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (session == nullptr) {
        error_message = "WinHttpOpen failed";
        return false;
    }

    HINTERNET connection = WinHttpConnect(session, host.c_str(), components.nPort, 0);
    if (connection == nullptr) {
        error_message = "WinHttpConnect failed";
        WinHttpCloseHandle(session);
        return false;
    }

    const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (request == nullptr) {
        error_message = "WinHttpOpenRequest failed";
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }

    DWORD redirect_policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirect_policy, sizeof(redirect_policy));

    const std::wstring headers = L"User-Agent: NetworkWatch/" + utf8_to_wide(current_app_version()) + L"\r\n";
    bool ok = WinHttpSendRequest(request, headers.c_str(), static_cast<DWORD>(headers.size()), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
              WinHttpReceiveResponse(request, nullptr);
    if (!ok) {
        error_message = "Download request failed";
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }

    std::filesystem::create_directories(destination.parent_path());
    std::ofstream output(destination, std::ios::binary);
    if (!output) {
        error_message = "Failed to create downloaded installer file";
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }

    for (;;) {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available)) {
            error_message = "WinHttpQueryDataAvailable failed";
            ok = false;
            break;
        }
        if (available == 0) {
            ok = true;
            break;
        }

        std::vector<char> buffer(available);
        DWORD downloaded = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &downloaded)) {
            error_message = "WinHttpReadData failed";
            ok = false;
            break;
        }
        output.write(buffer.data(), downloaded);
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    output.close();

    if (!ok) {
        std::error_code ignored;
        std::filesystem::remove(destination, ignored);
    }
    return ok;
}

struct UpdateCheckResult {
    enum class Status {
        UpToDate,
        Downloaded,
        Failed,
    };

    Status status = Status::Failed;
    std::string latest_version;
    std::wstring installer_path;
    std::string message;
};

UpdateCheckResult check_for_installer_update() {
    UpdateCheckResult result;
    std::string body;
    std::string error_message;
    if (!http_get_text(kReleaseApiHost, kReleaseApiPath, body, error_message)) {
        result.message = std::move(error_message);
        return result;
    }

    if (!extract_json_string(body, "tag_name", 0, result.latest_version, nullptr)) {
        result.message = "Failed to parse latest release tag";
        return result;
    }

    if (compare_versions(current_app_version(), result.latest_version) >= 0) {
        result.status = UpdateCheckResult::Status::UpToDate;
        result.message = "Already on the latest version";
        return result;
    }

    std::size_t search_pos = 0;
    std::string download_url;
    while (extract_json_string(body, "browser_download_url", search_pos, download_url, &search_pos)) {
        const bool is_windows_installer =
            download_url.ends_with(".exe") &&
            (download_url.find("Windows") != std::string::npos || download_url.find("windows") != std::string::npos);
        if (is_windows_installer) {
            break;
        }
        download_url.clear();
    }

    if (download_url.empty()) {
        result.message = "Latest release does not contain a Windows installer asset";
        return result;
    }

    const auto filename_pos = download_url.find_last_of('/');
    const auto filename = filename_pos == std::string::npos ? "network-watch-update.exe" : download_url.substr(filename_pos + 1);
    wchar_t temp_path_buffer[MAX_PATH] = {};
    if (GetTempPathW(MAX_PATH, temp_path_buffer) == 0) {
        result.message = "Failed to locate Windows temp directory";
        return result;
    }

    result.installer_path = std::filesystem::path(temp_path_buffer) / utf8_to_wide(filename);
    if (!download_file_https(download_url, result.installer_path, error_message)) {
        result.message = std::move(error_message);
        result.installer_path.clear();
        return result;
    }

    result.status = UpdateCheckResult::Status::Downloaded;
    result.message = "Update downloaded";
    return result;
}

void set_control_text(HWND control, const std::string& text) {
    SetWindowTextW(control, utf8_to_wide(text).c_str());
}

class WindowsTrayAdapter final : public ITrayAdapter {
public:
    explicit WindowsTrayAdapter(Settings settings) : settings_(std::move(settings)) {}

    ~WindowsTrayAdapter() override {
        shutdown();
    }

    void initialize() override {
        if (initialized_) {
            return;
        }

        register_window_classes();

        HINSTANCE instance = GetModuleHandleW(nullptr);
        host_hwnd_ = CreateWindowExW(
            0,
            kHostWindowClassName,
            L"Network Watch Host",
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            nullptr,
            nullptr,
            instance,
            this);

        if (host_hwnd_ == nullptr) {
            throw std::runtime_error("Failed to create Windows tray host window");
        }

        const auto language = current_language();
        menu_ = CreatePopupMenu();
        AppendMenuW(
            menu_,
            MF_STRING | MF_GRAYED,
            kMenuSummaryId,
            utf8_to_wide(language == AppLanguage::SimplifiedChinese ? "启动中..." : "Starting...").c_str());
        AppendMenuW(
            menu_,
            MF_STRING | MF_GRAYED,
            kMenuCpuMemoryId,
            utf8_to_wide("CPU -- | " + std::string(language == AppLanguage::SimplifiedChinese ? "内存" : "Memory") + " --").c_str());
        AppendMenuW(
            menu_,
            MF_STRING | MF_GRAYED,
            kMenuNetworkId,
            utf8_to_wide(std::string(language == AppLanguage::SimplifiedChinese ? "网络 --" : "Network --")).c_str());
        AppendMenuW(menu_, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(
            menu_,
            MF_STRING,
            kMenuOpenId,
            utf8_to_wide(language == AppLanguage::SimplifiedChinese ? "打开监控" : "Open Monitor").c_str());
        AppendMenuW(
            menu_,
            MF_STRING,
            kMenuCheckUpdatesId,
            utf8_to_wide(language == AppLanguage::SimplifiedChinese ? "检查更新" : "Check for Updates").c_str());
        AppendMenuW(
            menu_,
            MF_STRING,
            kMenuQuitId,
            utf8_to_wide(language == AppLanguage::SimplifiedChinese ? "退出" : "Quit").c_str());

        tray_icon_.cbSize = sizeof(tray_icon_);
        tray_icon_.hWnd = host_hwnd_;
        tray_icon_.uID = 1;
        tray_icon_.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        tray_icon_.uCallbackMessage = kTrayCallbackMessage;
        tray_icon_.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
        lstrcpynW(tray_icon_.szTip, utf8_to_wide(localized_app_name(language)).c_str(), ARRAYSIZE(tray_icon_.szTip));
        tray_icon_.uVersion = NOTIFYICON_VERSION_4;

        if (!Shell_NotifyIconW(NIM_ADD, &tray_icon_)) {
            throw std::runtime_error("Failed to create Windows notification area icon");
        }
        Shell_NotifyIconW(NIM_SETVERSION, &tray_icon_);

        initialized_ = true;
    }

    void update(const TraySummary& summary) override {
        {
            std::scoped_lock lock(mutex_);
            summary_ = summary;
        }
        post_host_message(kApplySummaryMessage);
    }

    void show_window(const MetricDelta& latest, const HistorySnapshot& history) override {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
        }
        post_host_message(kShowMonitorMessage);
    }

    void consume_metric_update(const MetricDelta& latest, const HistorySnapshot& history) {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
            summary_ = build_tray_summary(latest, current_language());
        }
        post_host_message(kApplySummaryMessage);
        post_host_message(kRefreshMonitorMessage);
    }

    void shutdown() override {
        if (!initialized_) {
            return;
        }

        if (tray_icon_.hWnd != nullptr) {
            Shell_NotifyIconW(NIM_DELETE, &tray_icon_);
            tray_icon_.hWnd = nullptr;
        }
        if (menu_ != nullptr) {
            DestroyMenu(menu_);
            menu_ = nullptr;
        }
        destroy_monitor_window();
        if (host_hwnd_ != nullptr) {
            DestroyWindow(host_hwnd_);
            host_hwnd_ = nullptr;
        }

        initialized_ = false;
    }

    int run_loop() {
        MSG message {};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return 0;
    }

    void request_quit() {
        if (host_hwnd_ != nullptr) {
            PostMessageW(host_hwnd_, WM_CLOSE, 0, 0);
        }
    }

private:
    AppLanguage current_language() const {
        return effective_language(settings_);
    }

    static LRESULT CALLBACK host_window_proc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
        if (message == WM_NCCREATE) {
            const auto* create = reinterpret_cast<CREATESTRUCTW*>(l_param);
            auto* self = static_cast<WindowsTrayAdapter*>(create->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
            return TRUE;
        }

        auto* self = reinterpret_cast<WindowsTrayAdapter*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (self != nullptr) {
            return self->handle_host_message(message, w_param, l_param);
        }

        return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    static LRESULT CALLBACK monitor_window_proc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
        if (message == WM_NCCREATE) {
            const auto* create = reinterpret_cast<CREATESTRUCTW*>(l_param);
            auto* self = static_cast<WindowsTrayAdapter*>(create->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
            return TRUE;
        }

        auto* self = reinterpret_cast<WindowsTrayAdapter*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (self != nullptr) {
            return self->handle_monitor_message(hwnd, message, w_param, l_param);
        }

        return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    void register_window_classes() {
        HINSTANCE instance = GetModuleHandleW(nullptr);

        WNDCLASSEXW host_class {};
        host_class.cbSize = sizeof(host_class);
        host_class.lpfnWndProc = &WindowsTrayAdapter::host_window_proc;
        host_class.hInstance = instance;
        host_class.lpszClassName = kHostWindowClassName;
        host_class.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
        host_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
        RegisterClassExW(&host_class);

        WNDCLASSEXW monitor_class {};
        monitor_class.cbSize = sizeof(monitor_class);
        monitor_class.lpfnWndProc = &WindowsTrayAdapter::monitor_window_proc;
        monitor_class.hInstance = instance;
        monitor_class.lpszClassName = kMonitorWindowClassName;
        monitor_class.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
        monitor_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
        monitor_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        RegisterClassExW(&monitor_class);
    }

    LRESULT handle_host_message(UINT message, WPARAM w_param, LPARAM l_param) {
        switch (message) {
            case kTrayCallbackMessage:
                if (l_param == WM_RBUTTONUP || l_param == WM_CONTEXTMENU) {
                    show_context_menu();
                    return 0;
                }
                if (l_param == WM_LBUTTONUP || l_param == WM_LBUTTONDBLCLK) {
                    show_monitor_window();
                    return 0;
                }
                break;
            case kApplySummaryMessage:
                apply_summary();
                return 0;
            case kShowMonitorMessage:
                show_monitor_window();
                return 0;
            case kRefreshMonitorMessage:
                refresh_monitor_window();
                return 0;
            case WM_COMMAND:
                switch (LOWORD(w_param)) {
                    case kMenuOpenId:
                        show_monitor_window();
                        return 0;
                    case kMenuCheckUpdatesId:
                        begin_update_check();
                        return 0;
                    case kMenuQuitId:
                        request_quit();
                        return 0;
                    default:
                        break;
                }
                break;
            case WM_CLOSE:
                if (tray_icon_.hWnd != nullptr) {
                    Shell_NotifyIconW(NIM_DELETE, &tray_icon_);
                    tray_icon_.hWnd = nullptr;
                }
                destroy_monitor_window();
                DestroyWindow(host_hwnd_);
                return 0;
            case kUpdateCheckCompletedMessage:
                handle_update_check_completed();
                return 0;
            case WM_DESTROY:
                host_hwnd_ = nullptr;
                PostQuitMessage(0);
                return 0;
            default:
                break;
        }

        return DefWindowProcW(host_hwnd_, message, w_param, l_param);
    }

    LRESULT handle_monitor_message(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
        switch (message) {
            case WM_CLOSE:
                ShowWindow(hwnd, SW_HIDE);
                return 0;
            default:
                break;
        }

        return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    void post_host_message(UINT message) {
        if (host_hwnd_ != nullptr) {
            PostMessageW(host_hwnd_, message, 0, 0);
        }
    }

    void apply_summary() {
        TraySummary summary;
        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            summary = summary_;
            latest = latest_;
        }

        tray_icon_.uFlags = NIF_TIP | NIF_ICON | NIF_SHOWTIP;
        tray_icon_.hIcon = LoadIcon(nullptr, summary.warning ? IDI_WARNING : IDI_APPLICATION);
        const auto tip = truncate_tip(utf8_to_wide(summary.tooltip.empty() ? summary.title : summary.tooltip));
        lstrcpynW(
            tray_icon_.szTip,
            tip.empty() ? utf8_to_wide(localized_app_name(current_language())).c_str() : tip.c_str(),
            ARRAYSIZE(tray_icon_.szTip));
        Shell_NotifyIconW(NIM_MODIFY, &tray_icon_);

        if (menu_ != nullptr) {
            ModifyMenuW(menu_, kMenuSummaryId, MF_BYCOMMAND | MF_STRING | MF_GRAYED, kMenuSummaryId, utf8_to_wide(summary.title).c_str());

            if (latest.has_value()) {
                const std::string cpu_line =
                    "CPU " + format_percent(latest->cpu_usage_percent) + " | " +
                    localized_metric_label(AlertMetric::MemoryUsage, current_language()) + ' ' +
                    format_percent(latest->memory_usage_percent);
                const std::string network_line =
                    localized_metric_label(AlertMetric::NetworkDisconnected, current_language()) + ' ' +
                    localized_network_state(latest->network_connected, current_language()) + " | " +
                    localized_metric_short_label(AlertMetric::DownloadRate, current_language()) + ' ' +
                    format_rate(latest->download_bytes_per_second) + " | " +
                    localized_metric_short_label(AlertMetric::UploadRate, current_language()) + ' ' +
                    format_rate(latest->upload_bytes_per_second);

                ModifyMenuW(menu_, kMenuCpuMemoryId, MF_BYCOMMAND | MF_STRING | MF_GRAYED, kMenuCpuMemoryId, utf8_to_wide(cpu_line).c_str());
                ModifyMenuW(menu_, kMenuNetworkId, MF_BYCOMMAND | MF_STRING | MF_GRAYED, kMenuNetworkId, utf8_to_wide(network_line).c_str());
            }
        }
    }

    void show_context_menu() {
        if (menu_ == nullptr) {
            return;
        }

        apply_summary();

        POINT cursor {};
        GetCursorPos(&cursor);
        SetForegroundWindow(host_hwnd_);
        TrackPopupMenu(menu_, TPM_BOTTOMALIGN | TPM_LEFTALIGN | TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, host_hwnd_, nullptr);
    }

    void set_update_menu_label(const std::string& text, bool enabled) {
        if (menu_ == nullptr) {
            return;
        }
        ModifyMenuW(menu_, kMenuCheckUpdatesId, MF_BYCOMMAND | MF_STRING | (enabled ? 0 : MF_GRAYED), kMenuCheckUpdatesId, utf8_to_wide(text).c_str());
    }

    void begin_update_check() {
        {
            std::scoped_lock lock(mutex_);
            if (update_check_in_progress_) {
                return;
            }
            update_check_in_progress_ = true;
        }

        set_update_menu_label(current_language() == AppLanguage::SimplifiedChinese ? "检查更新中..." : "Checking for Updates...", false);
        std::thread([this]() {
            UpdateCheckResult result = check_for_installer_update();
            {
                std::scoped_lock lock(mutex_);
                pending_update_result_ = std::move(result);
            }
            post_host_message(kUpdateCheckCompletedMessage);
        }).detach();
    }

    void handle_update_check_completed() {
        UpdateCheckResult result;
        {
            std::scoped_lock lock(mutex_);
            update_check_in_progress_ = false;
            if (!pending_update_result_.has_value()) {
                return;
            }
            result = std::move(*pending_update_result_);
            pending_update_result_.reset();
        }

        set_update_menu_label(current_language() == AppLanguage::SimplifiedChinese ? "检查更新" : "Check for Updates", true);

        if (result.status == UpdateCheckResult::Status::UpToDate) {
            MessageBoxW(
                host_hwnd_,
                utf8_to_wide(
                    current_language() == AppLanguage::SimplifiedChinese
                        ? "当前已经是最新版本。"
                        : "You are already running the latest version.")
                    .c_str(),
                utf8_to_wide(localized_app_name(current_language())).c_str(),
                MB_OK | MB_ICONINFORMATION);
            return;
        }

        if (result.status == UpdateCheckResult::Status::Failed) {
            const auto message =
                (current_language() == AppLanguage::SimplifiedChinese
                     ? "检查更新失败："
                     : "Failed to check for updates: ") +
                result.message;
            MessageBoxW(
                host_hwnd_,
                utf8_to_wide(message).c_str(),
                utf8_to_wide(localized_app_name(current_language())).c_str(),
                MB_OK | MB_ICONERROR);
            return;
        }

        const auto prompt =
            (current_language() == AppLanguage::SimplifiedChinese
                 ? "已下载新版本 "
                 : "A new version has been downloaded: ") +
            result.latest_version +
            (current_language() == AppLanguage::SimplifiedChinese
                 ? "\n现在启动安装程序并退出当前应用吗？"
                 : "\nLaunch the installer now and close the current app?");
        const int choice = MessageBoxW(
            host_hwnd_,
            utf8_to_wide(prompt).c_str(),
            utf8_to_wide(localized_app_name(current_language())).c_str(),
            MB_YESNO | MB_ICONQUESTION);
        if (choice != IDYES) {
            return;
        }

        ShellExecuteW(nullptr, L"open", result.installer_path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        request_quit();
    }

    void create_monitor_window_if_needed() {
        if (monitor_hwnd_ != nullptr) {
            return;
        }

        HINSTANCE instance = GetModuleHandleW(nullptr);
        monitor_hwnd_ = CreateWindowExW(
            WS_EX_APPWINDOW,
            kMonitorWindowClassName,
            utf8_to_wide(localized_app_name(current_language())).c_str(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            760,
            520,
            nullptr,
            nullptr,
            instance,
            this);

        if (monitor_hwnd_ == nullptr) {
            throw std::runtime_error("Failed to create Windows monitor window");
        }

        HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));

        int y = 16;
        create_label(utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "概览" : "Overview").c_str(), 16, y, 680, 22, true, font);
        y += 30;
        summary_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "等待第一批指标采样..." : "Waiting for the first metrics sample...").c_str(),
            16,
            y,
            700,
            22,
            false,
            font);
        y += 28;
        updated_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "最近更新: --" : "Last updated: --").c_str(),
            16,
            y,
            700,
            22,
            false,
            font);
        y += 36;

        cpu_label_ = create_label(L"CPU: --", 16, y, 330, 22, false, font);
        memory_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "内存: --" : "Memory: --").c_str(),
            380,
            y,
            330,
            22,
            false,
            font);
        y += 30;

        download_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "下载: --" : "Download: --").c_str(),
            16,
            y,
            330,
            22,
            false,
            font);
        upload_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "上传: --" : "Upload: --").c_str(),
            380,
            y,
            330,
            22,
            false,
            font);
        y += 30;

        network_label_ = create_label(
            utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "网络: --" : "Network: --").c_str(),
            16,
            y,
            330,
            22,
            false,
            font);
        y += 40;

        create_label(utf8_to_wide(current_language() == AppLanguage::SimplifiedChinese ? "接口" : "Interfaces").c_str(), 16, y, 680, 22, true, font);
        y += 28;

        interfaces_label_ = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            L"EDIT",
            L"",
            WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL,
            16,
            y,
            700,
            220,
            monitor_hwnd_,
            nullptr,
            instance,
            nullptr);
        SendMessageW(interfaces_label_, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    }

    HWND create_label(const wchar_t* text, int x, int y, int width, int height, bool bold, HFONT fallback_font) {
        HINSTANCE instance = GetModuleHandleW(nullptr);
        HWND control = CreateWindowExW(
            0,
            L"STATIC",
            text,
            WS_CHILD | WS_VISIBLE,
            x,
            y,
            width,
            height,
            monitor_hwnd_,
            nullptr,
            instance,
            nullptr);
        SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(fallback_font), TRUE);
        if (bold) {
            if (header_font_ == nullptr) {
                NONCLIENTMETRICSW metrics {};
                metrics.cbSize = sizeof(metrics);
                if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) {
                    metrics.lfMessageFont.lfWeight = FW_BOLD;
                    header_font_ = CreateFontIndirectW(&metrics.lfMessageFont);
                }
            }
            if (header_font_ != nullptr) {
                SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(header_font_), TRUE);
            }
        }
        return control;
    }

    void show_monitor_window() {
        create_monitor_window_if_needed();
        refresh_monitor_window();
        ShowWindow(monitor_hwnd_, SW_SHOW);
        SetForegroundWindow(monitor_hwnd_);
    }

    void refresh_monitor_window() {
        if (monitor_hwnd_ == nullptr) {
            return;
        }

        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
        }

        if (!latest.has_value()) {
            set_control_text(summary_label_, current_language() == AppLanguage::SimplifiedChinese ? "等待第一批指标采样..." : "Waiting for the first metrics sample...");
            set_control_text(updated_label_, current_language() == AppLanguage::SimplifiedChinese ? "最近更新: --" : "Last updated: --");
            set_control_text(cpu_label_, "CPU: --");
            set_control_text(memory_label_, current_language() == AppLanguage::SimplifiedChinese ? "内存: --" : "Memory: --");
            set_control_text(download_label_, current_language() == AppLanguage::SimplifiedChinese ? "下载: --" : "Download: --");
            set_control_text(upload_label_, current_language() == AppLanguage::SimplifiedChinese ? "上传: --" : "Upload: --");
            set_control_text(network_label_, current_language() == AppLanguage::SimplifiedChinese ? "网络: --" : "Network: --");
            set_control_text(interfaces_label_, current_language() == AppLanguage::SimplifiedChinese ? "暂时没有可用的接口数据。" : "No interface data available yet.");
            return;
        }

        set_control_text(summary_label_, build_tray_summary(*latest, current_language()).tooltip);
        set_control_text(
            updated_label_,
            std::string(current_language() == AppLanguage::SimplifiedChinese ? "最近更新: " : "Last updated: ") +
                format_timestamp(latest->timestamp));
        set_control_text(cpu_label_, "CPU: " + format_percent(latest->cpu_usage_percent));
        set_control_text(
            memory_label_,
            localized_metric_label(AlertMetric::MemoryUsage, current_language()) + ": " +
                format_percent(latest->memory_usage_percent) + " (" +
                format_bytes(static_cast<double>(latest->memory_used_bytes)) + " / " +
                format_bytes(static_cast<double>(latest->memory_total_bytes)) + ")");
        set_control_text(download_label_, localized_metric_label(AlertMetric::DownloadRate, current_language()) + ": " + format_rate(latest->download_bytes_per_second));
        set_control_text(upload_label_, localized_metric_label(AlertMetric::UploadRate, current_language()) + ": " + format_rate(latest->upload_bytes_per_second));
        set_control_text(
            network_label_,
            localized_metric_label(AlertMetric::NetworkDisconnected, current_language()) + ": " +
                localized_network_state(latest->network_connected, current_language()));
        set_control_text(interfaces_label_, build_interfaces_text(*latest, current_language()));
    }

    void destroy_monitor_window() {
        if (header_font_ != nullptr) {
            DeleteObject(header_font_);
            header_font_ = nullptr;
        }
        if (monitor_hwnd_ != nullptr) {
            DestroyWindow(monitor_hwnd_);
            monitor_hwnd_ = nullptr;
        }
        summary_label_ = nullptr;
        updated_label_ = nullptr;
        cpu_label_ = nullptr;
        memory_label_ = nullptr;
        download_label_ = nullptr;
        upload_label_ = nullptr;
        network_label_ = nullptr;
        interfaces_label_ = nullptr;
    }

    std::mutex mutex_;
    Settings settings_;
    TraySummary summary_ {};
    std::optional<MetricDelta> latest_ {};
    HistorySnapshot history_ {};
    bool update_check_in_progress_ = false;
    std::optional<UpdateCheckResult> pending_update_result_ {};

    HWND host_hwnd_ = nullptr;
    HWND monitor_hwnd_ = nullptr;
    HMENU menu_ = nullptr;
    NOTIFYICONDATAW tray_icon_ {};
    HFONT header_font_ = nullptr;

    HWND summary_label_ = nullptr;
    HWND updated_label_ = nullptr;
    HWND cpu_label_ = nullptr;
    HWND memory_label_ = nullptr;
    HWND download_label_ = nullptr;
    HWND upload_label_ = nullptr;
    HWND network_label_ = nullptr;
    HWND interfaces_label_ = nullptr;

    bool initialized_ = false;
};

class WindowsNotificationAdapter final : public INotificationAdapter {
public:
    void notify(const AlertEvent&) override {}
};

class WindowsAutostartAdapter final : public IAutostartAdapter {
public:
    bool enable(const std::string&) override { return false; }
    bool disable() override { return false; }
    bool is_enabled() const override { return false; }
};

}  // namespace

PlatformComponents create_platform_components(const Settings& settings) {
    PlatformComponents components;
    components.metrics_provider = create_windows_metrics_provider();
    components.tray_adapter = std::make_unique<WindowsTrayAdapter>(settings);
    components.notification_adapter = std::make_unique<WindowsNotificationAdapter>();
    components.autostart_adapter = std::make_unique<WindowsAutostartAdapter>();
    return components;
}

Application::Application(Settings settings) : settings_(std::move(settings)) {}

int Application::run() {
    auto components = create_platform_components(settings_);
    auto* tray = dynamic_cast<WindowsTrayAdapter*>(components.tray_adapter.get());
    if (tray == nullptr) {
        throw std::runtime_error("Windows tray adapter is unavailable");
    }

    components.tray_adapter->initialize();

    MonitorService monitor(std::move(components.metrics_provider), settings_);
    monitor.set_metric_listener([tray](const MetricDelta& delta, const HistorySnapshot& history) {
        tray->consume_metric_update(delta, history);
    });
    monitor.set_alert_listener([notification = components.notification_adapter.get()](const AlertEvent& event) {
        if (notification != nullptr) {
            notification->notify(event);
        }
    });

    monitor.start();
    const int exit_code = tray->run_loop();
    monitor.stop();
    components.tray_adapter->shutdown();
    return exit_code;
}

}  // namespace network_watch
