#include "network_watch/interfaces.hpp"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <mach/mach.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <sys/sysctl.h>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <string>

namespace network_watch {

namespace {

class MacOSMetricsProvider final : public IMetricsProvider {
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
        host_cpu_load_info_data_t cpu_info {};
        mach_msg_type_number_t count = HOST_CPU_LOAD_INFO_COUNT;
        const kern_return_t result = host_statistics(
            mach_host_self(),
            HOST_CPU_LOAD_INFO,
            reinterpret_cast<host_info_t>(&cpu_info),
            &count);

        if (result != KERN_SUCCESS) {
            return false;
        }

        times.user = cpu_info.cpu_ticks[CPU_STATE_USER];
        times.nice = cpu_info.cpu_ticks[CPU_STATE_NICE];
        times.system = cpu_info.cpu_ticks[CPU_STATE_SYSTEM];
        times.idle = cpu_info.cpu_ticks[CPU_STATE_IDLE];
        return true;
    }

    static bool read_memory(MemoryStats& memory) {
        std::uint64_t total_bytes = 0;
        std::size_t total_size = sizeof(total_bytes);
        if (sysctlbyname("hw.memsize", &total_bytes, &total_size, nullptr, 0) != 0) {
            return false;
        }

        vm_statistics64_data_t vm_info {};
        mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
        if (host_statistics64(
                mach_host_self(),
                HOST_VM_INFO64,
                reinterpret_cast<host_info64_t>(&vm_info),
                &count) != KERN_SUCCESS) {
            return false;
        }

        vm_size_t page_size = 0;
        if (host_page_size(mach_host_self(), &page_size) != KERN_SUCCESS) {
            return false;
        }

        const std::uint64_t used_pages =
            static_cast<std::uint64_t>(vm_info.active_count) +
            static_cast<std::uint64_t>(vm_info.wire_count) +
            static_cast<std::uint64_t>(vm_info.compressor_page_count);

        memory.total_bytes = total_bytes;
        memory.used_bytes = std::min(total_bytes, used_pages * static_cast<std::uint64_t>(page_size));
        memory.used_percent = total_bytes == 0
            ? 0.0
            : static_cast<double>(memory.used_bytes) / static_cast<double>(total_bytes) * 100.0;
        return memory.total_bytes > 0;
    }

    static bool read_network(MetricSample& sample) {
        std::map<std::string, NetworkInterfaceSample> interfaces;

        ifaddrs* addresses = nullptr;
        if (getifaddrs(&addresses) != 0) {
            return false;
        }

        for (auto* current = addresses; current != nullptr; current = current->ifa_next) {
            if (current->ifa_name == nullptr) {
                continue;
            }

            auto& item = interfaces[current->ifa_name];
            item.name = current->ifa_name;
            item.is_up = (current->ifa_flags & IFF_UP) != 0;

            if (current->ifa_addr == nullptr) {
                continue;
            }

            if (current->ifa_addr->sa_family == AF_LINK && current->ifa_data != nullptr) {
                const auto* link_data = reinterpret_cast<if_data*>(current->ifa_data);
                item.rx_bytes = link_data->ifi_ibytes;
                item.tx_bytes = link_data->ifi_obytes;
            } else if (current->ifa_addr->sa_family == AF_INET) {
                char buffer[INET_ADDRSTRLEN] = {};
                const auto* addr = reinterpret_cast<sockaddr_in*>(current->ifa_addr);
                if (inet_ntop(AF_INET, &addr->sin_addr, buffer, sizeof(buffer)) != nullptr) {
                    item.address = buffer;
                }
            }
        }

        freeifaddrs(addresses);

        for (auto& [name, item] : interfaces) {
            if ((name == "lo0") || (item.is_up == false && item.rx_bytes == 0 && item.tx_bytes == 0)) {
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

std::unique_ptr<IMetricsProvider> create_macos_metrics_provider() {
    return std::make_unique<MacOSMetricsProvider>();
}

}  // namespace network_watch
