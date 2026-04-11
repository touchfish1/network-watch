#include "network_watch/application.hpp"

#include <atomic>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

namespace network_watch {

std::unique_ptr<IMetricsProvider> create_linux_metrics_provider();

namespace {

std::atomic<bool> g_keep_running {true};

std::string humanize_bytes(std::uint64_t bytes) {
    static const char* units[] = {"B", "KB", "MB", "GB"};
    double value = static_cast<double>(bytes);
    std::size_t unit = 0;
    while (value >= 1024.0 && unit < 3) {
        value /= 1024.0;
        ++unit;
    }
    std::ostringstream output;
    output << std::fixed << std::setprecision(unit == 0 ? 0 : 1) << value << ' ' << units[unit];
    return output.str();
}

class ConsoleTrayAdapter final : public ITrayAdapter {
public:
    explicit ConsoleTrayAdapter(bool print_updates) : print_updates_(print_updates) {}

    void initialize() override {
        std::cout << "network_watch started. Press Ctrl+C to exit, or watch console tray updates.\n";
    }

    void update(const TraySummary& summary) override {
        if (!print_updates_) {
            return;
        }
        std::scoped_lock lock(mutex_);
        std::cout << "[tray] " << summary.title << " | " << summary.tooltip;
        if (summary.warning) {
            std::cout << " | warning";
        }
        std::cout << '\n';
    }

    void show_window(const MetricDelta& latest, const HistorySnapshot& history) override {
        std::scoped_lock lock(mutex_);
        std::cout << "========== monitor ==========\n";
        std::cout << "CPU: " << std::fixed << std::setprecision(1) << latest.cpu_usage_percent << "%\n";
        std::cout << "Memory: " << latest.memory_usage_percent << "% (" << humanize_bytes(latest.memory_used_bytes)
                  << "/" << humanize_bytes(latest.memory_total_bytes) << ")\n";
        std::cout << "Download: " << latest.download_bytes_per_second << " B/s\n";
        std::cout << "Upload: " << latest.upload_bytes_per_second << " B/s\n";
        std::cout << "Interfaces: " << latest.interfaces.size() << '\n';
        std::cout << "Samples: 1m=" << history.last_minute.size()
                  << " 5m=" << history.last_five_minutes.size()
                  << " 30m=" << history.last_thirty_minutes.size() << '\n';
        std::cout << "=============================\n";
    }

    void shutdown() override {
        std::scoped_lock lock(mutex_);
        std::cout << "network_watch stopped.\n";
    }

private:
    bool print_updates_ = true;
    std::mutex mutex_;
};

class ConsoleNotificationAdapter final : public INotificationAdapter {
public:
    void notify(const AlertEvent& event) override {
        std::cerr << event.message << '\n';
    }
};

class LinuxAutostartAdapter final : public IAutostartAdapter {
public:
    bool enable(const std::string& executable_path) override {
        const auto autostart_dir = std::filesystem::path(std::getenv("HOME")) / ".config/autostart";
        const auto file_path = autostart_dir / "network-watch.desktop";
        std::filesystem::create_directories(autostart_dir);
        std::ofstream output(file_path);
        output << "[Desktop Entry]\n";
        output << "Type=Application\n";
        output << "Name=network_watch\n";
        output << "Exec=" << executable_path << '\n';
        output << "X-GNOME-Autostart-enabled=true\n";
        enabled_ = static_cast<bool>(output);
        return enabled_;
    }

    bool disable() override {
        const auto file_path = std::filesystem::path(std::getenv("HOME")) / ".config/autostart/network-watch.desktop";
        enabled_ = false;
        return !std::filesystem::exists(file_path) || std::filesystem::remove(file_path);
    }

    bool is_enabled() const override {
        return enabled_;
    }

private:
    bool enabled_ = false;
};

void handle_signal(int) {
    g_keep_running = false;
}

}  // namespace

PlatformComponents create_platform_components(const Settings& settings) {
    PlatformComponents components;
    components.metrics_provider = create_linux_metrics_provider();
    components.tray_adapter = std::make_unique<ConsoleTrayAdapter>(settings.print_tray_updates);
    components.notification_adapter = std::make_unique<ConsoleNotificationAdapter>();
    components.autostart_adapter = std::make_unique<LinuxAutostartAdapter>();
    return components;
}

Application::Application(Settings settings) : settings_(std::move(settings)) {}

int Application::run() {
    std::signal(SIGINT, handle_signal);
    std::signal(SIGTERM, handle_signal);

    auto components = create_platform_components(settings_);
    components.tray_adapter->initialize();

    if (settings_.autostart_enabled) {
        components.autostart_adapter->enable(std::filesystem::current_path().string() + "/network_watch");
    }

    MonitorService monitor(std::move(components.metrics_provider), settings_);
    monitor.set_metric_listener([tray = components.tray_adapter.get()](const MetricDelta& delta, const HistorySnapshot& history) {
        tray->update(build_tray_summary(delta));
        tray->show_window(delta, history);
    });
    monitor.set_alert_listener([settings = settings_, notification = components.notification_adapter.get()](const AlertEvent& event) {
        if (settings.notifications_enabled) {
            notification->notify(event);
        }
    });

    monitor.start();
    while (g_keep_running) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    monitor.stop();

    components.tray_adapter->shutdown();
    return 0;
}

}  // namespace network_watch
