#pragma once

#include <deque>
#include <optional>
#include <string>

#include "network_watch/models.hpp"

namespace network_watch {

std::optional<MetricDelta> compute_metric_delta(const MetricSample& previous, const MetricSample& current);
TraySummary build_tray_summary(const MetricDelta& delta);

template <typename Container>
void trim_history(Container& history, std::chrono::minutes duration) {
    while (!history.empty()) {
        const auto age = history.back().timestamp - history.front().timestamp;
        if (age <= duration) {
            break;
        }
        history.pop_front();
    }
}

}  // namespace network_watch
