#include "network_watch/settings.hpp"

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
        make_rule("network_down", AlertMetric::NetworkDisconnected, 0.5, std::chrono::seconds(10), std::chrono::seconds(60), true),
    };
    return settings;
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
    }

    return settings;
}

void save_settings(const std::filesystem::path& path, const Settings& settings) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path);

    output << "sample_interval_ms=" << settings.sample_interval.count() << '\n';
    output << "tray_refresh_interval_ms=" << settings.tray_refresh_interval.count() << '\n';
    output << "notifications_enabled=" << (settings.notifications_enabled ? "true" : "false") << '\n';
    output << "autostart_enabled=" << (settings.autostart_enabled ? "true" : "false") << '\n';
    output << "print_tray_updates=" << (settings.print_tray_updates ? "true" : "false") << '\n';

    for (const auto& rule : settings.alert_rules) {
        const auto prefix = std::string("alert.") + rule.id + ".";
        output << prefix << "enabled=" << (rule.enabled ? "true" : "false") << '\n';
        output << prefix << "threshold=" << rule.threshold << '\n';
        output << prefix << "sustain_sec=" << rule.sustain_for.count() << '\n';
        output << prefix << "cooldown_sec=" << rule.cooldown_for.count() << '\n';
    }
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
