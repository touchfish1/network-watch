#include "network_watch/application.hpp"

#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>

#include <ctime>
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

std::string format_timestamp(const TimePoint& timestamp) {
    const auto value = Clock::to_time_t(timestamp);
    std::tm tm_value {};
    localtime_r(&value, &tm_value);

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
            output << "\n";
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

NSString* to_ns_string(const std::string& value) {
    return [NSString stringWithUTF8String:value.c_str()];
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
            this->show_monitor_window();
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

    void show_monitor_window() {
        create_monitor_window_if_needed();
        refresh_monitor_window();
        [NSApp activateIgnoringOtherApps:YES];
        [monitor_window_ makeKeyAndOrderFront:nil];
    }

private:
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
        [monitor_window_ setTitle:@"Network Watch Monitor"];
        [monitor_window_ center];
        [monitor_window_ setReleasedWhenClosed:NO];

        NSView* content = [monitor_window_ contentView];

        CGFloat y = 476.0;
        NSTextField* overview_label = make_label(content, NSMakeRect(20, y, 300, 24), 15.0, NSFontWeightSemibold);
        [overview_label setStringValue:@"Overview"];
        y -= 34.0;
        summary_label_ = make_label(content, NSMakeRect(20, y, 720, 22), 13.0, NSFontWeightRegular);
        [summary_label_ setStringValue:@"Waiting for the first metrics sample..."];
        y -= 28.0;
        updated_label_ = make_label(content, NSMakeRect(20, y, 720, 22), 12.0, NSFontWeightRegular);
        [updated_label_ setStringValue:@"Last updated: --"];
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
        [interfaces_label setStringValue:@"Interfaces"];
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
            [summary_label_ setStringValue:@"Waiting for the first metrics sample..."];
            [updated_label_ setStringValue:@"Last updated: --"];
            [cpu_label_ setStringValue:@"CPU: --"];
            [memory_label_ setStringValue:@"Memory: --"];
            [download_label_ setStringValue:@"Download: --"];
            [upload_label_ setStringValue:@"Upload: --"];
            [network_label_ setStringValue:@"Network: --"];
            [[interfaces_text_view_ textStorage] setAttributedString:[[NSAttributedString alloc] initWithString:@"No interface data available yet."]];
            return;
        }

        [summary_label_ setStringValue:to_ns_string(build_tray_summary(*latest).tooltip)];
        [updated_label_ setStringValue:to_ns_string("Last updated: " + format_timestamp(latest->timestamp))];
        [cpu_label_ setStringValue:to_ns_string("CPU: " + format_percent(latest->cpu_usage_percent))];
        [memory_label_ setStringValue:to_ns_string(
            "Memory: " + format_percent(latest->memory_usage_percent) + " (" +
            format_bytes(static_cast<double>(latest->memory_used_bytes)) + " / " +
            format_bytes(static_cast<double>(latest->memory_total_bytes)) + ")")];
        [download_label_ setStringValue:to_ns_string("Download: " + format_rate(latest->download_bytes_per_second))];
        [upload_label_ setStringValue:to_ns_string("Upload: " + format_rate(latest->upload_bytes_per_second))];
        [network_label_ setStringValue:to_ns_string(
            std::string("Network: ") + (latest->network_connected ? "online" : "offline"))];

        [[interfaces_text_view_ textStorage] setAttributedString:[[NSAttributedString alloc]
            initWithString:to_ns_string(build_interfaces_text(*latest))
                    attributes:@{
                        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:12.0 weight:NSFontWeightRegular]
                    }]];
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
        adapter_->show_monitor_window();
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
