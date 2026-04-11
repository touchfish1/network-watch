#pragma once

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace network_watch {

enum class AppLanguage {
    Auto,
    English,
    SimplifiedChinese,
};

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
    std::optional<std::int64_t> notification_snooze_until_epoch_seconds;
};

struct Settings {
    std::chrono::milliseconds sample_interval {1000};
    std::chrono::milliseconds tray_refresh_interval {2000};
    AppLanguage language = AppLanguage::Auto;
    bool notifications_enabled = true;
    std::optional<std::int64_t> notification_snooze_until_epoch_seconds;
    bool quiet_hours_enabled = false;
    int quiet_hours_start_minute = 22 * 60;
    int quiet_hours_end_minute = 7 * 60;
    bool autostart_enabled = false;
    bool print_tray_updates = true;
    std::vector<AlertRule> alert_rules;
};

std::filesystem::path default_config_path();
Settings default_settings();
std::optional<AlertRule> default_alert_rule(const std::string& rule_id);
Settings load_settings(const std::filesystem::path& path);
void save_settings(const std::filesystem::path& path, const Settings& settings);
std::string to_string(AppLanguage language);
AppLanguage app_language_from_string(const std::string& value);
AppLanguage detect_system_language();
AppLanguage resolve_language(const Settings& settings);
std::string localized_language_name(AppLanguage option, AppLanguage display_language);
std::string localized_app_name(AppLanguage language);
std::string localized_metric_label(AlertMetric metric, AppLanguage language);
std::string localized_metric_short_label(AlertMetric metric, AppLanguage language);
std::string localized_network_state(bool connected, AppLanguage language);
bool quiet_hours_active(
    const Settings& settings,
    std::chrono::system_clock::time_point now = std::chrono::system_clock::now());
bool notifications_allowed(
    const Settings& settings,
    std::chrono::system_clock::time_point now = std::chrono::system_clock::now());
bool alert_rule_notifications_allowed(
    const Settings& settings,
    const std::string& rule_id,
    std::chrono::system_clock::time_point now = std::chrono::system_clock::now());

std::string to_string(AlertMetric metric);
AlertMetric alert_metric_from_string(const std::string& value);

}  // namespace network_watch
