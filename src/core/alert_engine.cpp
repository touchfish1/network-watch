#include "network_watch/alert_engine.hpp"

#include <algorithm>
#include <iomanip>
#include <sstream>

namespace network_watch {

namespace {

std::string format_value(AlertMetric metric, double value) {
    std::ostringstream output;
    output << std::fixed;

    switch (metric) {
        case AlertMetric::CpuUsage:
        case AlertMetric::MemoryUsage:
            output << std::setprecision(1) << value << '%';
            return output.str();
        case AlertMetric::DownloadRate:
        case AlertMetric::UploadRate: {
            static const char* units[] = {"B/s", "KB/s", "MB/s", "GB/s"};
            std::size_t unit_index = 0;
            while (value >= 1024.0 && unit_index < 3) {
                value /= 1024.0;
                ++unit_index;
            }
            output << std::setprecision(unit_index == 0 ? 0 : 1) << value << ' ' << units[unit_index];
            return output.str();
        }
        case AlertMetric::NetworkDisconnected:
            return value < 0.5 ? "offline" : "online";
    }
    return "unknown";
}

std::string format_value(AlertMetric metric, double value, AppLanguage language) {
    if (metric == AlertMetric::NetworkDisconnected) {
        return localized_network_state(value >= 0.5, language);
    }

    return format_value(metric, value);
}

}  // namespace

AlertEngine::AlertEngine(std::vector<AlertRule> rules, AppLanguage language)
    : rules_(std::move(rules)), language_(language) {}

std::vector<AlertEvent> AlertEngine::evaluate(const MetricDelta& delta) {
    std::vector<AlertEvent> events;

    for (const auto& rule : rules_) {
        if (!rule.enabled) {
            continue;
        }

        auto& runtime = runtime_[rule.id];
        double current_value = 0.0;
        const bool breaching = is_breaching(rule, delta, current_value);

        if (breaching) {
            if (!runtime.breach_started_at.has_value()) {
                runtime.breach_started_at = delta.timestamp;
            }

            const auto sustained_for = std::chrono::duration_cast<std::chrono::seconds>(
                delta.timestamp - *runtime.breach_started_at);
            const bool cooldown_elapsed =
                !runtime.last_triggered_at.has_value() ||
                (delta.timestamp - *runtime.last_triggered_at) >= rule.cooldown_for;

            if (!runtime.active && sustained_for >= rule.sustain_for && cooldown_elapsed) {
                runtime.active = true;
                runtime.last_triggered_at = delta.timestamp;
                events.push_back(AlertEvent {
                    rule.id,
                    rule.metric,
                    AlertState::Triggered,
                    current_value,
                    delta.timestamp,
                    build_message(rule, AlertState::Triggered, current_value),
                });
            }
            continue;
        }

        runtime.breach_started_at.reset();
        if (runtime.active) {
            runtime.active = false;
            events.push_back(AlertEvent {
                rule.id,
                rule.metric,
                AlertState::Recovered,
                current_value,
                delta.timestamp,
                build_message(rule, AlertState::Recovered, current_value),
            });
        }
    }

    return events;
}

bool AlertEngine::is_breaching(const AlertRule& rule, const MetricDelta& delta, double& current_value) const {
    switch (rule.metric) {
        case AlertMetric::CpuUsage:
            current_value = delta.cpu_usage_percent;
            break;
        case AlertMetric::MemoryUsage:
            current_value = delta.memory_usage_percent;
            break;
        case AlertMetric::DownloadRate:
            current_value = delta.download_bytes_per_second;
            break;
        case AlertMetric::UploadRate:
            current_value = delta.upload_bytes_per_second;
            break;
        case AlertMetric::NetworkDisconnected:
            current_value = delta.network_connected ? 1.0 : 0.0;
            break;
    }

    return rule.trigger_when_below ? current_value < rule.threshold : current_value > rule.threshold;
}

std::string AlertEngine::build_message(const AlertRule& rule, AlertState state, double value) const {
    std::ostringstream output;
    const auto metric = localized_metric_label(rule.metric, language_);
    if (language_ == AppLanguage::SimplifiedChinese) {
        output << metric;
        if (state == AlertState::Triggered) {
            output << " 告警已触发";
        } else {
            output << " 已恢复";
        }
        output << "：当前值 " << format_value(rule.metric, value, language_);
        if (rule.metric != AlertMetric::NetworkDisconnected) {
            output << "，阈值 " << (rule.trigger_when_below ? "< " : "> ")
                   << format_value(rule.metric, rule.threshold, language_);
        }
    } else {
        if (state == AlertState::Triggered) {
            output << metric << " alert triggered";
        } else {
            output << metric << " recovered";
        }
        output << ": current " << format_value(rule.metric, value, language_);
        if (rule.metric != AlertMetric::NetworkDisconnected) {
            output << ", threshold " << (rule.trigger_when_below ? "< " : "> ")
                   << format_value(rule.metric, rule.threshold, language_);
        }
    }
    return output.str();
}

}  // namespace network_watch
