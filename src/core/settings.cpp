#include "network_watch/settings.hpp"

#include <ctime>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace network_watch {

namespace {

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return {};
    }
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

bool to_bool(const std::string& value) {
    return value == "true" || value == "1" || value == "yes" || value == "on";
}

std::unordered_map<std::string, std::string> read_key_values(const std::filesystem::path& path) {
    std::unordered_map<std::string, std::string> values;
    std::ifstream input(path);
    std::string line;

    while (std::getline(input, line)) {
        const auto comment = line.find('#');
        if (comment != std::string::npos) {
            line = line.substr(0, comment);
        }
        line = trim(line);
        if (line.empty()) {
            continue;
        }

        const auto delimiter = line.find('=');
        if (delimiter == std::string::npos) {
            continue;
        }

        const auto key = trim(line.substr(0, delimiter));
        const auto value = trim(line.substr(delimiter + 1));
        values[key] = value;
    }

    return values;
}

AlertRule make_rule(
    std::string id,
    AlertMetric metric,
    double threshold,
    std::chrono::seconds sustain_for,
    std::chrono::seconds cooldown_for,
    bool trigger_when_below = false) {
    AlertRule rule;
    rule.id = std::move(id);
    rule.metric = metric;
    rule.threshold = threshold;
    rule.sustain_for = sustain_for;
    rule.cooldown_for = cooldown_for;
    rule.trigger_when_below = trigger_when_below;
    rule.enabled = true;
    return rule;
}

std::tm to_local_time(std::time_t value) {
    std::tm result {};
#if defined(_WIN32)
    localtime_s(&result, &value);
#else
    localtime_r(&value, &result);
#endif
    return result;
}

}  // namespace

std::filesystem::path default_config_path() {
#if defined(_WIN32)
    if (const char* app_data = std::getenv("APPDATA")) {
        return std::filesystem::path(app_data) / "network-watch" / "settings.conf";
    }
    return std::filesystem::path("settings.conf");
#elif defined(__APPLE__)
    if (const char* home = std::getenv("HOME")) {
        return std::filesystem::path(home) / "Library/Application Support/network-watch/settings.conf";
    }
    return std::filesystem::path("settings.conf");
#else
    if (const char* config_home = std::getenv("XDG_CONFIG_HOME")) {
        return std::filesystem::path(config_home) / "network-watch" / "settings.conf";
    }
    if (const char* home = std::getenv("HOME")) {
        return std::filesystem::path(home) / ".config/network-watch/settings.conf";
    }
    return std::filesystem::path("settings.conf");
#endif
}

Settings default_settings() {
    Settings settings;
    settings.alert_rules = {
        make_rule("cpu_high", AlertMetric::CpuUsage, 85.0, std::chrono::seconds(15), std::chrono::seconds(120)),
        make_rule("memory_high", AlertMetric::MemoryUsage, 90.0, std::chrono::seconds(20), std::chrono::seconds(180)),
        make_rule("download_spike", AlertMetric::DownloadRate, 50.0 * 1024.0 * 1024.0, std::chrono::seconds(10), std::chrono::seconds(120)),
        make_rule("upload_spike", AlertMetric::UploadRate, 25.0 * 1024.0 * 1024.0, std::chrono::seconds(10), std::chrono::seconds(120)),
        make_rule("network_down", AlertMetric::NetworkDisconnected, 0.5, std::chrono::seconds(10), std::chrono::seconds(60), true),
    };
    return settings;
}

std::optional<AlertRule> default_alert_rule(const std::string& rule_id) {
    const auto settings = default_settings();
    for (const auto& rule : settings.alert_rules) {
        if (rule.id == rule_id) {
            return rule;
        }
    }
    return std::nullopt;
}

Settings load_settings(const std::filesystem::path& path) {
    Settings settings = default_settings();
    if (!std::filesystem::exists(path)) {
        return settings;
    }

    const auto values = read_key_values(path);

    if (const auto it = values.find("sample_interval_ms"); it != values.end()) {
        settings.sample_interval = std::chrono::milliseconds(std::stoll(it->second));
    }
    if (const auto it = values.find("tray_refresh_interval_ms"); it != values.end()) {
        settings.tray_refresh_interval = std::chrono::milliseconds(std::stoll(it->second));
    }
    if (const auto it = values.find("notifications_enabled"); it != values.end()) {
        settings.notifications_enabled = to_bool(it->second);
    }
    if (const auto it = values.find("notification_snooze_until_epoch_seconds"); it != values.end()) {
        const auto raw = std::stoll(it->second);
        if (raw > 0) {
            settings.notification_snooze_until_epoch_seconds = raw;
        }
    }
    if (const auto it = values.find("quiet_hours_enabled"); it != values.end()) {
        settings.quiet_hours_enabled = to_bool(it->second);
    }
    if (const auto it = values.find("quiet_hours_start_minute"); it != values.end()) {
        settings.quiet_hours_start_minute = std::stoi(it->second);
    }
    if (const auto it = values.find("quiet_hours_end_minute"); it != values.end()) {
        settings.quiet_hours_end_minute = std::stoi(it->second);
    }
    if (const auto it = values.find("autostart_enabled"); it != values.end()) {
        settings.autostart_enabled = to_bool(it->second);
    }
    if (const auto it = values.find("print_tray_updates"); it != values.end()) {
        settings.print_tray_updates = to_bool(it->second);
    }

    for (auto& rule : settings.alert_rules) {
        const auto prefix = std::string("alert.") + rule.id + ".";
        if (const auto it = values.find(prefix + "enabled"); it != values.end()) {
            rule.enabled = to_bool(it->second);
        }
        if (const auto it = values.find(prefix + "threshold"); it != values.end()) {
            rule.threshold = std::stod(it->second);
        }
        if (const auto it = values.find(prefix + "sustain_sec"); it != values.end()) {
            rule.sustain_for = std::chrono::seconds(std::stoll(it->second));
        }
        if (const auto it = values.find(prefix + "cooldown_sec"); it != values.end()) {
            rule.cooldown_for = std::chrono::seconds(std::stoll(it->second));
        }
        if (const auto it = values.find(prefix + "notification_snooze_until_epoch_seconds"); it != values.end()) {
            const auto raw = std::stoll(it->second);
            if (raw > 0) {
                rule.notification_snooze_until_epoch_seconds = raw;
            }
        }
    }

    return settings;
}

void save_settings(const std::filesystem::path& path, const Settings& settings) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path);

    output << "sample_interval_ms=" << settings.sample_interval.count() << '\n';
    output << "tray_refresh_interval_ms=" << settings.tray_refresh_interval.count() << '\n';
    output << "notifications_enabled=" << (settings.notifications_enabled ? "true" : "false") << '\n';
    output << "notification_snooze_until_epoch_seconds="
           << (settings.notification_snooze_until_epoch_seconds.has_value() ? *settings.notification_snooze_until_epoch_seconds : 0)
           << '\n';
    output << "quiet_hours_enabled=" << (settings.quiet_hours_enabled ? "true" : "false") << '\n';
    output << "quiet_hours_start_minute=" << settings.quiet_hours_start_minute << '\n';
    output << "quiet_hours_end_minute=" << settings.quiet_hours_end_minute << '\n';
    output << "autostart_enabled=" << (settings.autostart_enabled ? "true" : "false") << '\n';
    output << "print_tray_updates=" << (settings.print_tray_updates ? "true" : "false") << '\n';

    for (const auto& rule : settings.alert_rules) {
        const auto prefix = std::string("alert.") + rule.id + ".";
        output << prefix << "enabled=" << (rule.enabled ? "true" : "false") << '\n';
        output << prefix << "threshold=" << rule.threshold << '\n';
        output << prefix << "sustain_sec=" << rule.sustain_for.count() << '\n';
        output << prefix << "cooldown_sec=" << rule.cooldown_for.count() << '\n';
        output << prefix << "notification_snooze_until_epoch_seconds="
               << (rule.notification_snooze_until_epoch_seconds.has_value() ? *rule.notification_snooze_until_epoch_seconds : 0)
               << '\n';
    }
}

bool quiet_hours_active(const Settings& settings, std::chrono::system_clock::time_point now) {
    if (!settings.quiet_hours_enabled) {
        return false;
    }

    const int start = settings.quiet_hours_start_minute;
    const int end = settings.quiet_hours_end_minute;
    if (start == end) {
        return false;
    }

    const auto current_time = std::chrono::system_clock::to_time_t(now);
    const auto local_tm = to_local_time(current_time);
    const int current_minute = local_tm.tm_hour * 60 + local_tm.tm_min;

    if (start < end) {
        return current_minute >= start && current_minute < end;
    }

    return current_minute >= start || current_minute < end;
}

bool notifications_allowed(const Settings& settings, std::chrono::system_clock::time_point now) {
    if (!settings.notifications_enabled) {
        return false;
    }

    if (settings.notification_snooze_until_epoch_seconds.has_value()) {
        const auto snooze_until = std::chrono::system_clock::time_point(
            std::chrono::seconds(*settings.notification_snooze_until_epoch_seconds));
        if (now < snooze_until) {
            return false;
        }
    }

    return !quiet_hours_active(settings, now);
}

bool alert_rule_notifications_allowed(
    const Settings& settings,
    const std::string& rule_id,
    std::chrono::system_clock::time_point now) {
    if (!notifications_allowed(settings, now)) {
        return false;
    }

    for (const auto& rule : settings.alert_rules) {
        if (rule.id != rule_id) {
            continue;
        }
        if (!rule.notification_snooze_until_epoch_seconds.has_value()) {
            return true;
        }
        const auto snooze_until = std::chrono::system_clock::time_point(
            std::chrono::seconds(*rule.notification_snooze_until_epoch_seconds));
        return now >= snooze_until;
    }

    return true;
}

std::string to_string(AlertMetric metric) {
    switch (metric) {
        case AlertMetric::CpuUsage:
            return "cpu_usage";
        case AlertMetric::MemoryUsage:
            return "memory_usage";
        case AlertMetric::DownloadRate:
            return "download_rate";
        case AlertMetric::UploadRate:
            return "upload_rate";
        case AlertMetric::NetworkDisconnected:
            return "network_disconnected";
    }
    throw std::runtime_error("unknown AlertMetric");
}

AlertMetric alert_metric_from_string(const std::string& value) {
    if (value == "cpu_usage") {
        return AlertMetric::CpuUsage;
    }
    if (value == "memory_usage") {
        return AlertMetric::MemoryUsage;
    }
    if (value == "download_rate") {
        return AlertMetric::DownloadRate;
    }
    if (value == "upload_rate") {
        return AlertMetric::UploadRate;
    }
    if (value == "network_disconnected") {
        return AlertMetric::NetworkDisconnected;
    }
    throw std::runtime_error("unknown AlertMetric string: " + value);
}

}  // namespace network_watch
