#include "network_watch/monitor_service.hpp"

#include <chrono>

namespace network_watch {

MonitorService::MonitorService(std::unique_ptr<IMetricsProvider> provider, Settings settings)
    : provider_(std::move(provider)), settings_(std::move(settings)), alert_engine_(settings_.alert_rules) {}

MonitorService::~MonitorService() {
    stop();
}

void MonitorService::start() {
    if (running_.exchange(true)) {
        return;
    }
    worker_ = std::thread(&MonitorService::run, this);
}

void MonitorService::stop() {
    if (!running_.exchange(false)) {
        return;
    }
    if (worker_.joinable()) {
        worker_.join();
    }
}

void MonitorService::set_metric_listener(MetricListener listener) {
    std::scoped_lock lock(mutex_);
    metric_listener_ = std::move(listener);
}

void MonitorService::set_alert_listener(AlertListener listener) {
    std::scoped_lock lock(mutex_);
    alert_listener_ = std::move(listener);
}

std::optional<MetricDelta> MonitorService::latest_delta() const {
    std::scoped_lock lock(mutex_);
    return latest_delta_;
}

HistorySnapshot MonitorService::history() const {
    std::scoped_lock lock(mutex_);
    return history_;
}

void MonitorService::run() {
    while (running_) {
        const auto captured = provider_->capture();
        if (captured.has_value()) {
            std::optional<MetricDelta> delta;
            MetricListener metric_listener;
            AlertListener alert_listener;
            HistorySnapshot history_copy;
            std::vector<AlertEvent> events;

            {
                std::scoped_lock lock(mutex_);
                if (previous_sample_.has_value()) {
                    delta = compute_metric_delta(*previous_sample_, *captured);
                }
                previous_sample_ = captured;

                if (delta.has_value()) {
                    latest_delta_ = delta;
                    history_.last_minute.push_back(*delta);
                    history_.last_five_minutes.push_back(*delta);
                    history_.last_thirty_minutes.push_back(*delta);

                    trim_history(history_.last_minute, std::chrono::minutes(1));
                    trim_history(history_.last_five_minutes, std::chrono::minutes(5));
                    trim_history(history_.last_thirty_minutes, std::chrono::minutes(30));

                    events = alert_engine_.evaluate(*delta);
                    metric_listener = metric_listener_;
                    alert_listener = alert_listener_;
                    history_copy = history_;
                }
            }

            if (delta.has_value() && metric_listener) {
                metric_listener(*delta, history_copy);
            }
            if (alert_listener) {
                for (const auto& event : events) {
                    alert_listener(event);
                }
            }
        }

        std::this_thread::sleep_for(settings_.sample_interval);
    }
}

}  // namespace network_watch
