#include "network_watch/application.hpp"

#include <windows.h>
#include <shellapi.h>

#include <ctime>
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
constexpr UINT kRefreshMonitorMessage = WM_APP + 4;
constexpr UINT kMenuSummaryId = 1001;
constexpr UINT kMenuCpuMemoryId = 1002;
constexpr UINT kMenuNetworkId = 1003;
constexpr UINT kMenuOpenId = 1004;
constexpr UINT kMenuQuitId = 1005;
constexpr wchar_t kHostWindowClassName[] = L"NetworkWatchTrayWindow";
constexpr wchar_t kMonitorWindowClassName[] = L"NetworkWatchMonitorWindow";

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

std::string build_interfaces_text(const MetricDelta& latest) {
    if (latest.interfaces.empty()) {
        return "No active interfaces detected yet.";
    }

    std::ostringstream output;
    bool first = true;
    for (const auto& item : latest.interfaces) {
        if (!first) {
            output << "\r\n";
        }
        first = false;
        output << item.name << " | "
               << (item.is_up ? "up" : "down") << " | "
               << "Down " << format_rate(item.rx_bytes_per_second) << " | "
               << "Up " << format_rate(item.tx_bytes_per_second);
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

void set_control_text(HWND control, const std::string& text) {
    SetWindowTextW(control, utf8_to_wide(text).c_str());
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

        menu_ = CreatePopupMenu();
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuSummaryId, L"Starting...");
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuCpuMemoryId, L"CPU -- | Memory --");
        AppendMenuW(menu_, MF_STRING | MF_GRAYED, kMenuNetworkId, L"Network --");
        AppendMenuW(menu_, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu_, MF_STRING, kMenuOpenId, L"Open Monitor");
        AppendMenuW(menu_, MF_STRING, kMenuQuitId, L"Quit");

        tray_icon_.cbSize = sizeof(tray_icon_);
        tray_icon_.hWnd = host_hwnd_;
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
            summary_ = build_tray_summary(latest);
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
        host_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        host_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        RegisterClassExW(&host_class);

        WNDCLASSEXW monitor_class {};
        monitor_class.cbSize = sizeof(monitor_class);
        monitor_class.lpfnWndProc = &WindowsTrayAdapter::monitor_window_proc;
        monitor_class.hInstance = instance;
        monitor_class.lpszClassName = kMonitorWindowClassName;
        monitor_class.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
        monitor_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
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
        SetForegroundWindow(host_hwnd_);
        TrackPopupMenu(menu_, TPM_BOTTOMALIGN | TPM_LEFTALIGN | TPM_RIGHTBUTTON, cursor.x, cursor.y, 0, host_hwnd_, nullptr);
    }

    void create_monitor_window_if_needed() {
        if (monitor_hwnd_ != nullptr) {
            return;
        }

        HINSTANCE instance = GetModuleHandleW(nullptr);
        monitor_hwnd_ = CreateWindowExW(
            WS_EX_APPWINDOW,
            kMonitorWindowClassName,
            L"Network Watch Monitor",
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
        create_label(L"Overview", 16, y, 680, 22, true, font);
        y += 30;
        summary_label_ = create_label(L"Waiting for the first metrics sample...", 16, y, 700, 22, false, font);
        y += 28;
        updated_label_ = create_label(L"Last updated: --", 16, y, 700, 22, false, font);
        y += 36;

        cpu_label_ = create_label(L"CPU: --", 16, y, 330, 22, false, font);
        memory_label_ = create_label(L"Memory: --", 380, y, 330, 22, false, font);
        y += 30;

        download_label_ = create_label(L"Download: --", 16, y, 330, 22, false, font);
        upload_label_ = create_label(L"Upload: --", 380, y, 330, 22, false, font);
        y += 30;

        network_label_ = create_label(L"Network: --", 16, y, 330, 22, false, font);
        y += 40;

        create_label(L"Interfaces", 16, y, 680, 22, true, font);
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
            set_control_text(summary_label_, "Waiting for the first metrics sample...");
            set_control_text(updated_label_, "Last updated: --");
            set_control_text(cpu_label_, "CPU: --");
            set_control_text(memory_label_, "Memory: --");
            set_control_text(download_label_, "Download: --");
            set_control_text(upload_label_, "Upload: --");
            set_control_text(network_label_, "Network: --");
            set_control_text(interfaces_label_, "No interface data available yet.");
            return;
        }

        set_control_text(summary_label_, build_tray_summary(*latest).tooltip);
        set_control_text(updated_label_, "Last updated: " + format_timestamp(latest->timestamp));
        set_control_text(cpu_label_, "CPU: " + format_percent(latest->cpu_usage_percent));
        set_control_text(
            memory_label_,
            "Memory: " + format_percent(latest->memory_usage_percent) + " (" +
                format_bytes(static_cast<double>(latest->memory_used_bytes)) + " / " +
                format_bytes(static_cast<double>(latest->memory_total_bytes)) + ")");
        set_control_text(download_label_, "Download: " + format_rate(latest->download_bytes_per_second));
        set_control_text(upload_label_, "Upload: " + format_rate(latest->upload_bytes_per_second));
        set_control_text(network_label_, std::string("Network: ") + (latest->network_connected ? "online" : "offline"));
        set_control_text(interfaces_label_, build_interfaces_text(*latest));
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
    TraySummary summary_ {};
    std::optional<MetricDelta> latest_ {};
    HistorySnapshot history_ {};

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
