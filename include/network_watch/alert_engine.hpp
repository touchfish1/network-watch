#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "network_watch/models.hpp"
#include "network_watch/settings.hpp"

namespace network_watch {

enum class AlertState {
    Triggered,
    Recovered,
};

struct AlertEvent {
    std::string rule_id;
    AlertMetric metric = AlertMetric::CpuUsage;
    AlertState state = AlertState::Triggered;
    double current_value = 0.0;
    TimePoint timestamp {};
    std::string message;
};

class AlertEngine {
public:
    explicit AlertEngine(std::vector<AlertRule> rules, AppLanguage language = AppLanguage::English);

    std::vector<AlertEvent> evaluate(const MetricDelta& delta);
    const std::vector<AlertRule>& rules() const { return rules_; }

private:
    struct RuleRuntime {
        bool active = false;
        std::optional<TimePoint> breach_started_at;
        std::optional<TimePoint> last_triggered_at;
    };

    bool is_breaching(const AlertRule& rule, const MetricDelta& delta, double& current_value) const;
    std::string build_message(const AlertRule& rule, AlertState state, double value) const;

    std::vector<AlertRule> rules_;
    AppLanguage language_ = AppLanguage::English;
    std::unordered_map<std::string, RuleRuntime> runtime_;
};

}  // namespace network_watch
