#include "network_watch/alert_engine.hpp"

#include <iomanip>
#include <sstream>

namespace network_watch {

AlertEngine::AlertEngine(std::vector<AlertRule> rules) : rules_(std::move(rules)) {}

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
    output << (state == AlertState::Triggered ? "[ALERT] " : "[RECOVERED] ");
    output << rule.id << " (" << to_string(rule.metric) << ") value=" << std::fixed << std::setprecision(2) << value;
    return output.str();
}

}  // namespace network_watch
