#include "network_watch/application.hpp"
#include "network_watch/updater.hpp"

#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>

#include <ctime>
#include <cstdio>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_macos_metrics_provider();
class MacOSTrayAdapter;
constexpr const char* kLatestReleaseUrl = "https://github.com/touchfish1/network-watch/releases/latest";
constexpr const char* kLatestReleaseApiUrl = "https://api.github.com/repos/touchfish1/network-watch/releases/latest";

AppLanguage effective_language(const Settings& settings) {
    return resolve_language(settings);
}

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
    localtime_r(&value, &tm_value);

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
            output << "\n";
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

NSString* to_ns_string(const std::string& value) {
    return [NSString stringWithUTF8String:value.c_str()];
}

std::string shell_quote(const std::string& value) {
    std::string quoted = "'";
    for (char ch : value) {
        if (ch == '\'') {
            quoted += "'\\''";
        } else {
            quoted.push_back(ch);
        }
    }
    quoted.push_back('\'');
    return quoted;
}

bool run_command_capture(const std::string& command, std::string& output) {
    FILE* pipe = popen(command.c_str(), "r");
    if (pipe == nullptr) {
        return false;
    }

    output.clear();
    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    return pclose(pipe) == 0;
}

bool download_file_with_curl(const std::string& url, const std::filesystem::path& destination) {
    std::filesystem::create_directories(destination.parent_path());
    const std::string command =
        "curl -fL --connect-timeout 15 --max-time 0 -o " +
        shell_quote(destination.string()) + " " + shell_quote(url) + " >/dev/null 2>&1";
    return std::system(command.c_str()) == 0;
}

struct UpdateCheckResult {
    enum class Status {
        UpToDate,
        Downloaded,
        Failed,
    };

    Status status = Status::Failed;
    ReleaseAssetInfo asset;
    std::filesystem::path installer_path;
    std::string message;
};

UpdateCheckResult check_for_macos_installer_update() {
    UpdateCheckResult result;
    std::string body;
    if (!run_command_capture("curl -fsSL " + shell_quote(kLatestReleaseApiUrl), body)) {
        result.message = "Failed to fetch latest release metadata";
        return result;
    }

    std::string error_message;
    if (!parse_latest_release_asset(body, ReleaseAssetPlatform::MacInstaller, result.asset, error_message)) {
        result.message = std::move(error_message);
        return result;
    }

    if (compare_versions(current_app_version(), result.asset.latest_version) >= 0) {
        result.status = UpdateCheckResult::Status::UpToDate;
        result.message = "Already on the latest version";
        return result;
    }

    result.installer_path = std::filesystem::temp_directory_path() / result.asset.asset_name;
    if (!download_file_with_curl(result.asset.download_url, result.installer_path)) {
        result.message = "Failed to download the macOS installer image";
        return result;
    }

    result.status = UpdateCheckResult::Status::Downloaded;
    result.message = "Update downloaded";
    return result;
}

NSTextField* make_label(NSView* parent, NSRect frame, CGFloat font_size, NSFontWeight weight) {
    NSTextField* label = [[NSTextField alloc] initWithFrame:frame];
    [label setBezeled:NO];
    [label setEditable:NO];
    [label setDrawsBackground:NO];
    [label setSelectable:YES];
    [label setFont:[NSFont systemFontOfSize:font_size weight:weight]];
    [parent addSubview:label];
    return label;
}

}  // namespace network_watch

@interface NetworkWatchStatusDelegate : NSObject <NSApplicationDelegate> {
@private
    network_watch::MacOSTrayAdapter* adapter_;
}
- (instancetype)initWithAdapter:(network_watch::MacOSTrayAdapter*)adapter;
- (void)openMonitor:(id)sender;
- (void)checkUpdates:(id)sender;
- (void)quitApp:(id)sender;
@end

namespace network_watch {

class MacOSTrayAdapter final : public ITrayAdapter {
public:
    explicit MacOSTrayAdapter(Settings settings) : settings_(std::move(settings)) {}

    ~MacOSTrayAdapter() override {
        shutdown();
    }

    void initialize() override {
        if (initialized_) {
            return;
        }

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        delegate_ = [[NetworkWatchStatusDelegate alloc] initWithAdapter:this];
        [NSApp setDelegate:delegate_];

        status_item_ = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
        if (status_item_ == nil) {
            throw std::runtime_error("Failed to create macOS status item");
        }

        const auto language = current_language();
        menu_ = [[NSMenu alloc] initWithTitle:to_ns_string(localized_app_name(language))];

        summary_item_ = [[NSMenuItem alloc]
            initWithTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "启动中..." : "Starting...")
                    action:nil
             keyEquivalent:@""];
        [summary_item_ setEnabled:NO];
        [menu_ addItem:summary_item_];

        cpu_memory_item_ = [[NSMenuItem alloc]
            initWithTitle:to_ns_string("CPU -- | " + std::string(language == AppLanguage::SimplifiedChinese ? "内存" : "Memory") + " --")
                    action:nil
             keyEquivalent:@""];
        [cpu_memory_item_ setEnabled:NO];
        [menu_ addItem:cpu_memory_item_];

        network_item_ = [[NSMenuItem alloc]
            initWithTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "网络 --" : "Network --")
                    action:nil
             keyEquivalent:@""];
        [network_item_ setEnabled:NO];
        [menu_ addItem:network_item_];

        [menu_ addItem:[NSMenuItem separatorItem]];

        NSMenuItem* open_item = [[NSMenuItem alloc]
            initWithTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "打开监控" : "Open Monitor")
                    action:@selector(openMonitor:)
             keyEquivalent:@""];
        [open_item setTarget:delegate_];
        [menu_ addItem:open_item];

        NSMenuItem* update_item = [[NSMenuItem alloc]
            initWithTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "检查更新" : "Check for Updates")
                    action:@selector(checkUpdates:)
             keyEquivalent:@""];
        [update_item setTarget:delegate_];
        [menu_ addItem:update_item];
        update_item_ = update_item;

        NSMenuItem* quit_item = [[NSMenuItem alloc]
            initWithTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "退出" : "Quit")
                    action:@selector(quitApp:)
             keyEquivalent:@""];
        [quit_item setTarget:delegate_];
        [menu_ addItem:quit_item];

        [status_item_ setMenu:menu_];
        [[status_item_ button] setTitle:to_ns_string(language == AppLanguage::SimplifiedChinese ? "启动中..." : "Starting...")];
        [[status_item_ button] setToolTip:to_ns_string(localized_app_name(language))];

        initialized_ = true;
    }

    void update(const TraySummary& summary) override {
        {
            std::scoped_lock lock(mutex_);
            summary_ = summary;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            this->apply_summary();
        });
    }

    void show_window(const MetricDelta& latest, const HistorySnapshot& history) override {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            this->show_monitor_window();
        });
    }

    void consume_metric_update(const MetricDelta& latest, const HistorySnapshot& history) {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
            summary_ = build_tray_summary(latest, current_language());
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            this->apply_summary();
            this->refresh_monitor_window();
        });
    }

    void shutdown() override {
        if (!initialized_) {
            return;
        }

        monitor_window_ = nil;
        summary_label_ = nil;
        updated_label_ = nil;
        cpu_label_ = nil;
        memory_label_ = nil;
        download_label_ = nil;
        upload_label_ = nil;
        network_label_ = nil;
        interfaces_text_view_ = nil;

        if (status_item_ != nil) {
            [[NSStatusBar systemStatusBar] removeStatusItem:status_item_];
            status_item_ = nil;
        }
        menu_ = nil;
        summary_item_ = nil;
        cpu_memory_item_ = nil;
        network_item_ = nil;
        delegate_ = nil;
        initialized_ = false;
    }

    int run_loop() {
        [NSApp run];
        return 0;
    }

    void request_quit() {
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSApp terminate:nil];
        });
    }

    void open_update_page() {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSURL* url = [NSURL URLWithString:to_ns_string(kLatestReleaseUrl)];
            if (url != nil) {
                [[NSWorkspace sharedWorkspace] openURL:url];
            }
        });
    }

    void begin_update_check() {
        {
            std::scoped_lock lock(mutex_);
            if (update_check_in_progress_) {
                return;
            }
            update_check_in_progress_ = true;
        }

        if (update_item_ != nil) {
            [update_item_ setEnabled:NO];
            [update_item_ setTitle:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "检查更新中..." : "Checking for Updates...")];
        }

        std::thread([this]() {
            UpdateCheckResult result = check_for_macos_installer_update();
            {
                std::scoped_lock lock(mutex_);
                pending_update_result_ = std::move(result);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                this->handle_update_check_completed();
            });
        }).detach();
    }

    void show_monitor_window() {
        create_monitor_window_if_needed();
        refresh_monitor_window();
        [NSApp activateIgnoringOtherApps:YES];
        [monitor_window_ makeKeyAndOrderFront:nil];
    }

private:
    AppLanguage current_language() const {
        return effective_language(settings_);
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

        if (update_item_ != nil) {
            [update_item_ setEnabled:YES];
            [update_item_ setTitle:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "检查更新" : "Check for Updates")];
        }

        NSAlert* alert = [[NSAlert alloc] init];
        [alert setAlertStyle:NSAlertStyleInformational];
        [alert setMessageText:to_ns_string(localized_app_name(current_language()))];

        if (result.status == UpdateCheckResult::Status::UpToDate) {
            [alert setInformativeText:to_ns_string(
                current_language() == AppLanguage::SimplifiedChinese
                    ? "当前已经是最新版本。"
                    : "You are already running the latest version.")];
            [alert addButtonWithTitle:@"OK"];
            [alert runModal];
            return;
        }

        if (result.status == UpdateCheckResult::Status::Failed) {
            [alert setAlertStyle:NSAlertStyleWarning];
            [alert setInformativeText:to_ns_string(
                (current_language() == AppLanguage::SimplifiedChinese
                    ? "检查更新失败："
                    : "Failed to check for updates: ") + result.message)];
            [alert addButtonWithTitle:@"OK"];
            [alert runModal];
            return;
        }

        [alert setInformativeText:to_ns_string(
            (current_language() == AppLanguage::SimplifiedChinese
                ? "已下载新版本 "
                : "A new version has been downloaded: ") +
            result.asset.latest_version +
            (current_language() == AppLanguage::SimplifiedChinese
                ? "\n现在打开安装镜像并退出当前应用吗？"
                : "\nOpen the installer image now and quit the current app?"))];
        [alert addButtonWithTitle:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "打开" : "Open")];
        [alert addButtonWithTitle:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "取消" : "Cancel")];
        if ([alert runModal] != NSAlertFirstButtonReturn) {
            return;
        }

        NSURL* installer_url = [NSURL fileURLWithPath:to_ns_string(result.installer_path.string())];
        if (installer_url != nil) {
            [[NSWorkspace sharedWorkspace] openURL:installer_url];
            request_quit();
        }
    }

    void create_monitor_window_if_needed() {
        if (monitor_window_ != nil) {
            return;
        }

        monitor_window_ = [[NSWindow alloc]
            initWithContentRect:NSMakeRect(0, 0, 760, 520)
                      styleMask:(NSWindowStyleMaskTitled |
                                 NSWindowStyleMaskClosable |
                                 NSWindowStyleMaskMiniaturizable |
                                 NSWindowStyleMaskResizable)
                        backing:NSBackingStoreBuffered
                          defer:NO];
        [monitor_window_ setTitle:to_ns_string(localized_app_name(current_language()))];
        [monitor_window_ center];
        [monitor_window_ setReleasedWhenClosed:NO];

        NSView* content = [monitor_window_ contentView];

        CGFloat y = 476.0;
        NSTextField* overview_label = make_label(content, NSMakeRect(20, y, 300, 24), 15.0, NSFontWeightSemibold);
        [overview_label setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "概览" : "Overview")];
        y -= 34.0;
        summary_label_ = make_label(content, NSMakeRect(20, y, 720, 22), 13.0, NSFontWeightRegular);
        [summary_label_ setStringValue:to_ns_string(
            current_language() == AppLanguage::SimplifiedChinese ? "等待第一批指标采样..." : "Waiting for the first metrics sample...")];
        y -= 28.0;
        updated_label_ = make_label(content, NSMakeRect(20, y, 720, 22), 12.0, NSFontWeightRegular);
        [updated_label_ setStringValue:to_ns_string(
            current_language() == AppLanguage::SimplifiedChinese ? "最近更新: --" : "Last updated: --")];
        y -= 38.0;

        cpu_label_ = make_label(content, NSMakeRect(20, y, 330, 22), 13.0, NSFontWeightRegular);
        memory_label_ = make_label(content, NSMakeRect(380, y, 330, 22), 13.0, NSFontWeightRegular);
        y -= 30.0;

        download_label_ = make_label(content, NSMakeRect(20, y, 330, 22), 13.0, NSFontWeightRegular);
        upload_label_ = make_label(content, NSMakeRect(380, y, 330, 22), 13.0, NSFontWeightRegular);
        y -= 30.0;

        network_label_ = make_label(content, NSMakeRect(20, y, 330, 22), 13.0, NSFontWeightRegular);
        y -= 42.0;

        NSTextField* interfaces_label = make_label(content, NSMakeRect(20, y, 300, 24), 15.0, NSFontWeightSemibold);
        [interfaces_label setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "接口" : "Interfaces")];
        y -= 234.0;

        NSScrollView* scroll_view = [[NSScrollView alloc] initWithFrame:NSMakeRect(20, y, 720, 220)];
        [scroll_view setBorderType:NSBezelBorder];
        [scroll_view setHasVerticalScroller:YES];
        [scroll_view setAutohidesScrollers:YES];

        interfaces_text_view_ = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 720, 220)];
        [interfaces_text_view_ setEditable:NO];
        [interfaces_text_view_ setSelectable:YES];
        [interfaces_text_view_ setFont:[NSFont monospacedSystemFontOfSize:12.0 weight:NSFontWeightRegular]];
        [scroll_view setDocumentView:interfaces_text_view_];
        [content addSubview:scroll_view];
    }

    void apply_summary() {
        if (status_item_ == nil) {
            return;
        }

        TraySummary summary;
        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            summary = summary_;
            latest = latest_;
        }

        [[status_item_ button] setTitle:to_ns_string(summary.title.empty() ? localized_app_name(current_language()) : summary.title)];
        [[status_item_ button] setToolTip:to_ns_string(summary.tooltip.empty() ? summary.title : summary.tooltip)];

        if (summary_item_ != nil) {
            [summary_item_ setTitle:to_ns_string(summary.title)];
        }
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

            [cpu_memory_item_ setTitle:to_ns_string(cpu_line)];
            [network_item_ setTitle:to_ns_string(network_line)];
        }
    }

    void refresh_monitor_window() {
        if (monitor_window_ == nil) {
            return;
        }

        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
        }

        if (!latest.has_value()) {
            [summary_label_ setStringValue:to_ns_string(
                current_language() == AppLanguage::SimplifiedChinese ? "等待第一批指标采样..." : "Waiting for the first metrics sample...")];
            [updated_label_ setStringValue:to_ns_string(
                current_language() == AppLanguage::SimplifiedChinese ? "最近更新: --" : "Last updated: --")];
            [cpu_label_ setStringValue:@"CPU: --"];
            [memory_label_ setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "内存: --" : "Memory: --")];
            [download_label_ setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "下载: --" : "Download: --")];
            [upload_label_ setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "上传: --" : "Upload: --")];
            [network_label_ setStringValue:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "网络: --" : "Network: --")];
            [[interfaces_text_view_ textStorage] setAttributedString:[[NSAttributedString alloc]
                initWithString:to_ns_string(current_language() == AppLanguage::SimplifiedChinese ? "暂时没有可用的接口数据。" : "No interface data available yet.")]];
            return;
        }

        [summary_label_ setStringValue:to_ns_string(build_tray_summary(*latest, current_language()).tooltip)];
        [updated_label_ setStringValue:to_ns_string(
            std::string(current_language() == AppLanguage::SimplifiedChinese ? "最近更新: " : "Last updated: ") +
            format_timestamp(latest->timestamp))];
        [cpu_label_ setStringValue:to_ns_string("CPU: " + format_percent(latest->cpu_usage_percent))];
        [memory_label_ setStringValue:to_ns_string(
            localized_metric_label(AlertMetric::MemoryUsage, current_language()) + ": " +
            format_percent(latest->memory_usage_percent) + " (" +
            format_bytes(static_cast<double>(latest->memory_used_bytes)) + " / " +
            format_bytes(static_cast<double>(latest->memory_total_bytes)) + ")")];
        [download_label_ setStringValue:to_ns_string(
            localized_metric_label(AlertMetric::DownloadRate, current_language()) + ": " +
            format_rate(latest->download_bytes_per_second))];
        [upload_label_ setStringValue:to_ns_string(
            localized_metric_label(AlertMetric::UploadRate, current_language()) + ": " +
            format_rate(latest->upload_bytes_per_second))];
        [network_label_ setStringValue:to_ns_string(
            localized_metric_label(AlertMetric::NetworkDisconnected, current_language()) + ": " +
            localized_network_state(latest->network_connected, current_language()))];

        [[interfaces_text_view_ textStorage] setAttributedString:[[NSAttributedString alloc]
            initWithString:to_ns_string(build_interfaces_text(*latest, current_language()))
                    attributes:@{
                        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:12.0 weight:NSFontWeightRegular]
                    }]];
    }

    std::mutex mutex_;
    Settings settings_;
    TraySummary summary_ {};
    std::optional<MetricDelta> latest_ {};
    HistorySnapshot history_ {};

    NSStatusItem* status_item_ = nil;
    NSMenu* menu_ = nil;
    NSMenuItem* summary_item_ = nil;
    NSMenuItem* cpu_memory_item_ = nil;
    NSMenuItem* network_item_ = nil;
    NSMenuItem* update_item_ = nil;
    NSWindow* monitor_window_ = nil;
    NSTextField* summary_label_ = nil;
    NSTextField* updated_label_ = nil;
    NSTextField* cpu_label_ = nil;
    NSTextField* memory_label_ = nil;
    NSTextField* download_label_ = nil;
    NSTextField* upload_label_ = nil;
    NSTextField* network_label_ = nil;
    NSTextView* interfaces_text_view_ = nil;
    NetworkWatchStatusDelegate* delegate_ = nil;
    bool update_check_in_progress_ = false;
    std::optional<UpdateCheckResult> pending_update_result_ {};
    bool initialized_ = false;
};

class MacOSNotificationAdapter final : public INotificationAdapter {
public:
    void notify(const AlertEvent&) override {}
};

class MacOSAutostartAdapter final : public IAutostartAdapter {
public:
    bool enable(const std::string&) override { return false; }
    bool disable() override { return false; }
    bool is_enabled() const override { return false; }
};

PlatformComponents create_platform_components(const Settings& settings) {
    PlatformComponents components;
    components.metrics_provider = create_macos_metrics_provider();
    components.tray_adapter = std::make_unique<MacOSTrayAdapter>(settings);
    components.notification_adapter = std::make_unique<MacOSNotificationAdapter>();
    components.autostart_adapter = std::make_unique<MacOSAutostartAdapter>();
    return components;
}

Application::Application(Settings settings) : settings_(std::move(settings)) {}

int Application::run() {
    @autoreleasepool {
        auto components = create_platform_components(settings_);
        auto* tray = dynamic_cast<MacOSTrayAdapter*>(components.tray_adapter.get());
        if (tray == nullptr) {
            throw std::runtime_error("macOS tray adapter is unavailable");
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
}

}  // namespace network_watch

@implementation NetworkWatchStatusDelegate

- (instancetype)initWithAdapter:(network_watch::MacOSTrayAdapter*)adapter {
    self = [super init];
    if (self != nil) {
        adapter_ = adapter;
    }
    return self;
}

- (void)openMonitor:(id)sender {
    (void)sender;
    if (adapter_ != nullptr) {
        adapter_->show_monitor_window();
    }
}

- (void)checkUpdates:(id)sender {
    (void)sender;
    if (adapter_ != nullptr) {
        adapter_->begin_update_check();
    }
}

- (void)quitApp:(id)sender {
    (void)sender;
    if (adapter_ != nullptr) {
        adapter_->request_quit();
    }
}

@end
