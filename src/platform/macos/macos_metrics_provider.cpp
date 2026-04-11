#include "network_watch/interfaces.hpp"

#include <memory>

namespace network_watch {

namespace {

class MacOSMetricsProvider final : public IMetricsProvider {
public:
    std::optional<MetricSample> capture() override {
        return std::nullopt;
    }
};

}  // namespace

std::unique_ptr<IMetricsProvider> create_macos_metrics_provider() {
    return std::make_unique<MacOSMetricsProvider>();
}

}  // namespace network_watch
