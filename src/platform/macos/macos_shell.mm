#include "network_watch/application.hpp"

#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>

#include <algorithm>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_macos_metrics_provider();

namespace {

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

NSString* to_ns_string(const std::string& value) {
    return [NSString stringWithUTF8String:value.c_str()];
}

std::string build_monitor_text(const MetricDelta& latest) {
    std::ostringstream body;
    body << "CPU: " << format_percent(latest.cpu_usage_percent) << "\n"
         << "Memory: " << format_percent(latest.memory_usage_percent) << " ("
         << format_bytes(static_cast<double>(latest.memory_used_bytes)) << " / "
         << format_bytes(static_cast<double>(latest.memory_total_bytes)) << ")\n"
         << "Download: " << format_rate(latest.download_bytes_per_second) << "\n"
         << "Upload: " << format_rate(latest.upload_bytes_per_second) << "\n"
         << "Network: " << (latest.network_connected ? "online" : "offline");
    return body.str();
}

class MacOSTrayAdapter;

@interface NetworkWatchStatusDelegate : NSObject <NSApplicationDelegate>
- (instancetype)initWithAdapter:(network_watch::MacOSTrayAdapter*)adapter;
- (void)openMonitor:(id)sender;
- (void)quitApp:(id)sender;
@end

class MacOSTrayAdapter final : public ITrayAdapter {
public:
    MacOSTrayAdapter() = default;

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

        menu_ = [[NSMenu alloc] initWithTitle:@"Network Watch"];

        summary_item_ = [[NSMenuItem alloc] initWithTitle:@"Starting..." action:nil keyEquivalent:@""];
        [summary_item_ setEnabled:NO];
        [menu_ addItem:summary_item_];

        cpu_memory_item_ = [[NSMenuItem alloc] initWithTitle:@"CPU -- | Memory --" action:nil keyEquivalent:@""];
        [cpu_memory_item_ setEnabled:NO];
        [menu_ addItem:cpu_memory_item_];

        network_item_ = [[NSMenuItem alloc] initWithTitle:@"Network --" action:nil keyEquivalent:@""];
        [network_item_ setEnabled:NO];
        [menu_ addItem:network_item_];

        [menu_ addItem:[NSMenuItem separatorItem]];

        NSMenuItem* open_item = [[NSMenuItem alloc] initWithTitle:@"Open Monitor" action:@selector(openMonitor:) keyEquivalent:@""];
        [open_item setTarget:delegate_];
        [menu_ addItem:open_item];

        NSMenuItem* quit_item = [[NSMenuItem alloc] initWithTitle:@"Quit" action:@selector(quitApp:) keyEquivalent:@""];
        [quit_item setTarget:delegate_];
        [menu_ addItem:quit_item];

        [status_item_ setMenu:menu_];
        [[status_item_ button] setTitle:@"Starting..."];
        [[status_item_ button] setToolTip:@"Network Watch"];

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
          this->present_monitor();
        });
    }

    void consume_metric_update(const MetricDelta& latest, const HistorySnapshot& history) {
        {
            std::scoped_lock lock(mutex_);
            latest_ = latest;
            history_ = history;
            summary_ = build_tray_summary(latest);
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          this->apply_summary();
        });
    }

    void shutdown() override {
        if (!initialized_) {
            return;
        }

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

    void present_monitor() {
        std::optional<MetricDelta> latest;
        {
            std::scoped_lock lock(mutex_);
            latest = latest_;
        }

        NSAlert* alert = [[NSAlert alloc] init];
        [alert setMessageText:@"Network Watch"];
        [alert setInformativeText:latest.has_value()
            ? to_ns_string(build_monitor_text(*latest))
            : @"Waiting for the first metrics sample..."];
        [alert addButtonWithTitle:@"OK"];
        [NSApp activateIgnoringOtherApps:YES];
        [alert runModal];
    }

private:
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

        [[status_item_ button] setTitle:to_ns_string(summary.title.empty() ? "Network Watch" : summary.title)];
        [[status_item_ button] setToolTip:to_ns_string(summary.tooltip.empty() ? summary.title : summary.tooltip)];

        if (summary_item_ != nil) {
            [summary_item_ setTitle:to_ns_string(summary.title)];
        }
        if (latest.has_value()) {
            const std::string cpu_line =
                "CPU " + format_percent(latest->cpu_usage_percent) + " | Memory " + format_percent(latest->memory_usage_percent);
            const std::string network_line =
                std::string(latest->network_connected ? "Network online | " : "Network offline | ") +
                "Down " + format_rate(latest->download_bytes_per_second) + " | Up " + format_rate(latest->upload_bytes_per_second);

            [cpu_memory_item_ setTitle:to_ns_string(cpu_line)];
            [network_item_ setTitle:to_ns_string(network_line)];
        }
    }

    std::mutex mutex_;
    TraySummary summary_ {};
    std::optional<MetricDelta> latest_ {};
    HistorySnapshot history_ {};

    NSStatusItem* status_item_ = nil;
    NSMenu* menu_ = nil;
    NSMenuItem* summary_item_ = nil;
    NSMenuItem* cpu_memory_item_ = nil;
    NSMenuItem* network_item_ = nil;
    NetworkWatchStatusDelegate* delegate_ = nil;
    bool initialized_ = false;
};

@implementation NetworkWatchStatusDelegate {
    network_watch::MacOSTrayAdapter* adapter_;
}

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
        adapter_->present_monitor();
    }
}

- (void)quitApp:(id)sender {
    (void)sender;
    if (adapter_ != nullptr) {
        adapter_->request_quit();
    }
}

@end

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

}  // namespace

PlatformComponents create_platform_components(const Settings&) {
    PlatformComponents components;
    components.metrics_provider = create_macos_metrics_provider();
    components.tray_adapter = std::make_unique<MacOSTrayAdapter>();
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
