#pragma once

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "network_watch/alert_engine.hpp"
#include "network_watch/interfaces.hpp"
#include "network_watch/metrics_math.hpp"
#include "network_watch/settings.hpp"

namespace network_watch {

class MonitorService {
public:
    using MetricListener = std::function<void(const MetricDelta&, const HistorySnapshot&)>;
    using AlertListener = std::function<void(const AlertEvent&)>;

    MonitorService(std::unique_ptr<IMetricsProvider> provider, Settings settings);
    ~MonitorService();

    void start();
    void stop();

    void set_metric_listener(MetricListener listener);
    void set_alert_listener(AlertListener listener);

    std::optional<MetricDelta> latest_delta() const;
    HistorySnapshot history() const;
    const Settings& settings() const { return settings_; }

private:
    void run();

    std::unique_ptr<IMetricsProvider> provider_;
    Settings settings_;
    AlertEngine alert_engine_;

    mutable std::mutex mutex_;
    std::optional<MetricSample> previous_sample_;
    std::optional<MetricDelta> latest_delta_;
    HistorySnapshot history_;
    MetricListener metric_listener_;
    AlertListener alert_listener_;

    std::atomic<bool> running_ {false};
    std::thread worker_;
};

}  // namespace network_watch
