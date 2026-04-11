#include "network_watch/application.hpp"

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_windows_metrics_provider();

namespace {

constexpr UINT kTrayCallbackMessage = WM_APP + 1;
constexpr UINT kApplySummaryMessage = WM_APP + 2;
constexpr UINT kShowMonitorMessage = WM_APP + 3;
constexpr UINT kMenuSummaryId = 1001;
constexpr UINT kMenuCpuMemoryId = 1002;
constexpr UINT kMenuNetworkId = 1003;
constexpr UINT kMenuOpenId = 1004;
constexpr UINT kMenuQuitId = 1005;
constexpr wchar_t kWindowClassName[] = L"NetworkWatchTrayWindow";

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

std::wstring build_monitor_text(const MetricDelta& latest) {
    std::ostringstream body;
    body << "CPU: " << format_percent(latest.cpu_usage_percent) << "\n"
         << "Memory: " << format_percent(latest.memory_usage_percent) << " ("
         << format_bytes(static_cast<double>(latest.memory_used_bytes)) << " / "
         << format_bytes(static_cast<double>(latest.memory_total_bytes)) << ")\n"
         << "Download: " << format_rate(latest.download_bytes_per_second) << "\n"
         << "Upload: " << format_rate(latest.upload_bytes_per_second) << "\n"
         << "Network: " << (latest.network_connected ? "online" : "offline");
    return utf8_to_wide(body.str());
}

class WindowsTrayAdapter final : public ITrayAdapter {
public:
    WindowsTrayAdapter() = default;

    ~WindowsTrayAdapter() override {
        shutdown();
    }

    void initialize() override {
        if (initialized_) {
            return;
        }

        HINSTANCE instance = GetModuleHandleW(nullptr);

        WNDCLASSEXW window_class {};
        window_class.cbSize = sizeof(window_class);
        window_class.lpfnWndProc = &WindowsTrayAdapter::window_proc;
        window_class.hInstance = instance;
        window_class.lpszClassName = kWindowClassName;
        window_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        RegisterClassExW(&window_class);

        hwnd_ = CreateWindowExW(
            0,
            kWindowClassName,
            L"Network Watch",
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            nullptr,
            nullptr,
            instance,
            this);

        if (hwnd_ == nullptr) {
            throw std::runtime_error("Failed to create Windows tray host window");
        }

        menu_ = CreatePopupMenu();
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuSummaryId, L"Starting...");
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuCpuMemoryId, L"CPU -- | Memory --");
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuNetworkId, L"Network --");
        AppendMenuW(menu_, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu_, MF_STRING, kMenuOpenId, L"Open Monitor");
        AppendMenuW(menu_, MF_STRING, kMenuQuitId, L"Quit");

        tray_icon_.cbSize = sizeof(tray_icon_);
        tray_icon_.hWnd = hwnd_;
        tray_icon_.uID = 1;
        tray_icon_.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        tray_icon_.uCallbackMessage = kTrayCallbackMessage;
        tray_icon_.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        lstrcpynW(tray_icon_.szTip, L"Network Watch", ARRAYSIZE(tray_icon_.szTip));

        if (!Shell_NotifyIconW(NIM_ADD, &tray_icon_)) {
            throw std::runtime_error("Failed to create Windows notification area icon");
        }

        initialized_ = true;
    }

    void update(const TraySummary& summary) override {
        {
            std::scoped_lock lock(mutex_);
            summary_ = summary;
        }
        post_message(kApplySummaryMessage);
    }

    void show_window(const MetricDelta& latest, const HistorySnapshot& history) override {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
        }
        post_message(kShowMonitorMessage);
    }

    void consume_metric_update(const MetricDelta& latest, const HistorySnapshot& history) {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
            summary_ = build_tray_summary(latest);
        }
        post_message(kApplySummaryMessage);
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
        if (hwnd_ != nullptr) {
            DestroyWindow(hwnd_);
            hwnd_ = nullptr;
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
        if (hwnd_ != nullptr) {
            PostMessageW(hwnd_, WM_CLOSE, 0, 0);
        }
    }

private:
    static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM w_param, LPARAM l_param) {
        if (message == WM_NCCREATE) {
            const auto* create = reinterpret_cast<CREATESTRUCTW*>(l_param);
            auto* self = static_cast<WindowsTrayAdapter*>(create->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
            return TRUE;
        }

        auto* self = reinterpret_cast<WindowsTrayAdapter*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (self != nullptr) {
            return self->handle_message(message, w_param, l_param);
        }

        return DefWindowProcW(hwnd, message, w_param, l_param);
    }

    LRESULT handle_message(UINT message, WPARAM w_param, LPARAM l_param) {
        switch (message) {
            case kTrayCallbackMessage:
                if (l_param == WM_RBUTTONUP || l_param == WM_CONTEXTMENU) {
                    show_context_menu();
                    return 0;
                }
                if (l_param == WM_LBUTTONUP || l_param == WM_LBUTTONDBLCLK) {
                    show_monitor_dialog();
                    return 0;
                }
                break;
            case kApplySummaryMessage:
                apply_summary();
                return 0;
            case kShowMonitorMessage:
                show_monitor_dialog();
                return 0;
            case WM_COMMAND:
                switch (LOWORD(w_param)) {
                    case kMenuOpenId:
                        show_monitor_dialog();
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
                DestroyWindow(hwnd_);
                return 0;
            case WM_DESTROY:
                hwnd_ = nullptr;
                PostQuitMessage(0);
                return 0;
            default:
                break;
        }

        return DefWindowProcW(hwnd_, message, w_param, l_param);
    }

    void post_message(UINT message) {
        if (hwnd_ != nullptr) {
            PostMessageW(hwnd_, message, 0, 0);
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

        tray_icon_.uFlags = NIF_TIP | NIF_ICON;
        tray_icon_.hIcon = LoadIconW(nullptr, summary.warning ? IDI_WARNING : IDI_APPLICATION);
        const auto tip = truncate_tip(utf8_to_wide(summary.tooltip.empty() ? summary.title : summary.tooltip));
        lstrcpynW(tray_icon_.szTip, tip.empty() ? L"Network Watch" : tip.c_str(), ARRAYSIZE(tray_icon_.szTip));
        Shell_NotifyIconW(NIM_MODIFY, &tray_icon_);

        if (menu_ != nullptr) {
            ModifyMenuW(menu_, kMenuSummaryId, MF_BYCOMMAND | MF_STRING | MF_GRAYED, kMenuSummaryId, utf8_to_wide(summary.title).c_str());

            if (latest.has_value()) {
                const std::string cpu_line =
                    "CPU " + format_percent(latest->cpu_usage_percent) + " | Memory " + format_percent(latest->memory_usage_percent);
                const std::string network_line =
                    std::string(latest->network_connected ? "Network online | " : "Network offline | ") +
                    "Down " + format_rate(latest->download_bytes_per_second) + " | Up " + format_rate(latest->upload_bytes_per_second);

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
        SetForegroundWindow(hwnd_);
        TrackPopupMenu(menu_, TPM_BOTTOMALIGN | TPM_LEFTALIGN | TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, hwnd_, nullptr);
    }

    void show_monitor_dialog() {
        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
        }

        const std::wstring body = latest.has_value()
            ? build_monitor_text(*latest)
            : L"Waiting for the first metrics sample...";

        MessageBoxW(hwnd_, body.c_str(), L"Network Watch", MB_OK | MB_ICONINFORMATION);
    }

    std::mutex mutex_;
    TraySummary summary_ {};
    std::optional<MetricDelta> latest_ {};
    HistorySnapshot history_ {};

    HWND hwnd_ = nullptr;
    HMENU menu_ = nullptr;
    NOTIFYICONDATAW tray_icon_ {};
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

PlatformComponents create_platform_components(const Settings&) {
    PlatformComponents components;
    components.metrics_provider = create_windows_metrics_provider();
    components.tray_adapter = std::make_unique<WindowsTrayAdapter>();
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
