#pragma once

#include "network_watch/interfaces.hpp"
#include "network_watch/monitor_service.hpp"

namespace network_watch {

class Application {
public:
    explicit Application(Settings settings);
    int run();

private:
    Settings settings_;
};

}  // namespace network_watch
