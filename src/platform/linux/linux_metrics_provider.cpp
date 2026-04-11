#include "network_watch/interfaces.hpp"
#include "network_watch/settings.hpp"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>

#include <chrono>
#include <fstream>
#include <map>
#include <optional>
#include <sstream>
#include <string>

namespace network_watch {

namespace {

class LinuxMetricsProvider final : public IMetricsProvider {
public:
    std::optional<MetricSample> capture() override {
        MetricSample sample;
        sample.timestamp = Clock::now();

        if (!read_cpu(sample.cpu_times) || !read_memory(sample.memory) || !read_network(sample)) {
            return std::nullopt;
        }

        return sample;
    }

private:
    static bool read_cpu(CpuTimes& times) {
        std::ifstream input("/proc/stat");
        std::string label;
        input >> label;
        if (label != "cpu") {
            return false;
        }

        input >> times.user >> times.nice >> times.system >> times.idle >> times.iowait >> times.irq >> times.softirq >> times.steal;
        return static_cast<bool>(input);
    }

    static bool read_memory(MemoryStats& memory) {
        std::ifstream input("/proc/meminfo");
        if (!input) {
            return false;
        }

        std::uint64_t total_kb = 0;
        std::uint64_t available_kb = 0;
        std::string key;
        std::uint64_t value = 0;
        std::string unit;

        while (input >> key >> value >> unit) {
            if (key == "MemTotal:") {
                total_kb = value;
            } else if (key == "MemAvailable:") {
                available_kb = value;
            }
        }

        memory.total_bytes = total_kb * 1024;
        memory.used_bytes = (total_kb - available_kb) * 1024;
        memory.used_percent = total_kb == 0 ? 0.0 : static_cast<double>(total_kb - available_kb) / total_kb * 100.0;
        return memory.total_bytes > 0;
    }

    static bool read_network(MetricSample& sample) {
        std::map<std::string, NetworkInterfaceSample> interfaces;
        std::ifstream input("/proc/net/dev");
        if (!input) {
            return false;
        }

        std::string line;
        std::getline(input, line);
        std::getline(input, line);

        while (std::getline(input, line)) {
            const auto delimiter = line.find(':');
            if (delimiter == std::string::npos) {
                continue;
            }

            auto name = line.substr(0, delimiter);
            name.erase(0, name.find_first_not_of(" \t"));
            name.erase(name.find_last_not_of(" \t") + 1);

            std::istringstream stats(line.substr(delimiter + 1));
            NetworkInterfaceSample item;
            item.name = name;
            std::uint64_t ignored = 0;
            stats >> item.rx_bytes;
            for (int i = 0; i < 7; ++i) {
                stats >> ignored;
            }
            stats >> item.tx_bytes;
            interfaces[name] = item;
        }

        ifaddrs* addresses = nullptr;
        if (getifaddrs(&addresses) == 0) {
            for (auto* current = addresses; current != nullptr; current = current->ifa_next) {
                if (current->ifa_name == nullptr) {
                    continue;
                }

                auto it = interfaces.find(current->ifa_name);
                if (it == interfaces.end()) {
                    continue;
                }

                it->second.is_up = (current->ifa_flags & IFF_RUNNING) != 0;

                if (current->ifa_addr == nullptr) {
                    continue;
                }

                if (current->ifa_addr->sa_family == AF_INET) {
                    char buffer[INET_ADDRSTRLEN] = {};
                    const auto* addr = reinterpret_cast<sockaddr_in*>(current->ifa_addr);
                    if (inet_ntop(AF_INET, &addr->sin_addr, buffer, sizeof(buffer)) != nullptr) {
                        it->second.address = buffer;
                    }
                }
            }
            freeifaddrs(addresses);
        }

        for (auto& [name, item] : interfaces) {
            if (name == "lo") {
                continue;
            }
            sample.total_rx_bytes += item.rx_bytes;
            sample.total_tx_bytes += item.tx_bytes;
            sample.network_connected = sample.network_connected || item.is_up;
            sample.interfaces.push_back(std::move(item));
        }

        return true;
    }
};

}  // namespace

std::unique_ptr<IMetricsProvider> create_linux_metrics_provider() {
    return std::make_unique<LinuxMetricsProvider>();
}

}  // namespace network_watch
