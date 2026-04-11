#pragma once

#include <chrono>
#include <filesystem>
#include <string>
#include <vector>

namespace network_watch {

enum class AlertMetric {
    CpuUsage,
    MemoryUsage,
    DownloadRate,
    UploadRate,
    NetworkDisconnected,
};

struct AlertRule {
    std::string id;
    AlertMetric metric = AlertMetric::CpuUsage;
    double threshold = 0.0;
    bool trigger_when_below = false;
    std::chrono::seconds sustain_for {15};
    std::chrono::seconds cooldown_for {120};
    bool enabled = true;
};

struct Settings {
    std::chrono::milliseconds sample_interval {1000};
    std::chrono::milliseconds tray_refresh_interval {2000};
    bool notifications_enabled = true;
    bool autostart_enabled = false;
    bool print_tray_updates = true;
    std::vector<AlertRule> alert_rules;
};

std::filesystem::path default_config_path();
Settings default_settings();
Settings load_settings(const std::filesystem::path& path);
void save_settings(const std::filesystem::path& path, const Settings& settings);

std::string to_string(AlertMetric metric);
AlertMetric alert_metric_from_string(const std::string& value);

}  // namespace network_watch
