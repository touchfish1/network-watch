#include "network_watch/interfaces.hpp"

#include <memory>

namespace network_watch {

namespace {

class WindowsMetricsProvider final : public IMetricsProvider {
public:
    std::optional<MetricSample> capture() override {
        return std::nullopt;
    }
};

}  // namespace

std::unique_ptr<IMetricsProvider> create_windows_metrics_provider() {
    return std::make_unique<WindowsMetricsProvider>();
}

}  // namespace network_watch
