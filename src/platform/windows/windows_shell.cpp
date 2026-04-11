#include "network_watch/application.hpp"

#include <iostream>
#include <memory>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_windows_metrics_provider();

namespace {

class WindowsTrayAdapter final : public ITrayAdapter {
public:
    void initialize() override {}
    void update(const TraySummary&) override {}
    void show_window(const MetricDelta&, const HistorySnapshot&) override {}
    void shutdown() override {}
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
    std::cerr << "Windows native shell is scaffolded but not implemented yet.\n";
    return 1;
}

}  // namespace network_watch
