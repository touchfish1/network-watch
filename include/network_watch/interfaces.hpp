#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "network_watch/models.hpp"

namespace network_watch {

struct AlertEvent;
struct Settings;

class IMetricsProvider {
public:
    virtual ~IMetricsProvider() = default;
    virtual std::optional<MetricSample> capture() = 0;
};

class ITrayAdapter {
public:
    virtual ~ITrayAdapter() = default;
    virtual void initialize() = 0;
    virtual void update(const TraySummary& summary) = 0;
    virtual void show_window(const MetricDelta& latest, const HistorySnapshot& history) = 0;
    virtual void shutdown() = 0;
};

class INotificationAdapter {
public:
    virtual ~INotificationAdapter() = default;
    virtual void notify(const AlertEvent& event) = 0;
};

class IAutostartAdapter {
public:
    virtual ~IAutostartAdapter() = default;
    virtual bool enable(const std::string& executable_path) = 0;
    virtual bool disable() = 0;
    virtual bool is_enabled() const = 0;
};

struct PlatformComponents {
    std::unique_ptr<IMetricsProvider> metrics_provider;
    std::unique_ptr<ITrayAdapter> tray_adapter;
    std::unique_ptr<INotificationAdapter> notification_adapter;
    std::unique_ptr<IAutostartAdapter> autostart_adapter;
};

PlatformComponents create_platform_components(const Settings& settings);

}  // namespace network_watch
