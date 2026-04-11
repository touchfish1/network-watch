#include "network_watch/interfaces.hpp"

#include <winsock2.h>
#include <windows.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <ws2tcpip.h>

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace network_watch {

namespace {

std::uint64_t filetime_to_uint64(const FILETIME& value) {
    ULARGE_INTEGER result {};
    result.LowPart = value.dwLowDateTime;
    result.HighPart = value.dwHighDateTime;
    return result.QuadPart;
}

std::string wide_to_utf8(const wchar_t* value) {
    if (value == nullptr || *value == L'\0') {
        return {};
    }

    const int required = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (required <= 1) {
        return {};
    }

    std::string result(static_cast<std::size_t>(required), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), required, nullptr, nullptr);
    result.resize(static_cast<std::size_t>(required - 1));
    return result;
}

class WindowsMetricsProvider final : public IMetricsProvider {
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
        FILETIME idle {};
        FILETIME kernel {};
        FILETIME user {};
        if (!GetSystemTimes(&idle, &kernel, &user)) {
            return false;
        }

        const auto idle_ticks = filetime_to_uint64(idle);
        const auto kernel_ticks = filetime_to_uint64(kernel);
        times.user = filetime_to_uint64(user);
        times.system = kernel_ticks > idle_ticks ? kernel_ticks - idle_ticks : 0;
        times.idle = idle_ticks;
        return true;
    }

    static bool read_memory(MemoryStats& memory) {
        MEMORYSTATUSEX state {};
        state.dwLength = sizeof(state);
        if (!GlobalMemoryStatusEx(&state)) {
            return false;
        }

        memory.total_bytes = state.ullTotalPhys;
        memory.used_bytes = state.ullTotalPhys - state.ullAvailPhys;
        memory.used_percent = state.ullTotalPhys == 0
            ? 0.0
            : static_cast<double>(memory.used_bytes) / static_cast<double>(state.ullTotalPhys) * 100.0;
        return memory.total_bytes > 0;
    }

    static bool read_network(MetricSample& sample) {
        std::unordered_map<NET_IFINDEX, std::string> interface_addresses;
        ULONG address_buffer_size = 16 * 1024;
        std::vector<unsigned char> address_buffer(address_buffer_size);
        auto* adapter_addresses = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(address_buffer.data());

        ULONG address_result = GetAdaptersAddresses(
            AF_UNSPEC,
            GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
            nullptr,
            adapter_addresses,
            &address_buffer_size);

        if (address_result == ERROR_BUFFER_OVERFLOW) {
            address_buffer.resize(address_buffer_size);
            adapter_addresses = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(address_buffer.data());
            address_result = GetAdaptersAddresses(
                AF_UNSPEC,
                GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER,
                nullptr,
                adapter_addresses,
                &address_buffer_size);
        }

        if (address_result == NO_ERROR) {
            for (auto* adapter = adapter_addresses; adapter != nullptr; adapter = adapter->Next) {
                for (auto* unicast = adapter->FirstUnicastAddress; unicast != nullptr; unicast = unicast->Next) {
                    if (unicast->Address.lpSockaddr == nullptr) {
                        continue;
                    }

                    char buffer[INET6_ADDRSTRLEN] = {};
                    const int family = unicast->Address.lpSockaddr->sa_family;
                    void* address_data = nullptr;
                    if (family == AF_INET) {
                        address_data = &reinterpret_cast<sockaddr_in*>(unicast->Address.lpSockaddr)->sin_addr;
                    } else if (family == AF_INET6) {
                        address_data = &reinterpret_cast<sockaddr_in6*>(unicast->Address.lpSockaddr)->sin6_addr;
                    }

                    if (address_data == nullptr) {
                        continue;
                    }

                    if (InetNtopA(family, address_data, buffer, sizeof(buffer)) != nullptr) {
                        if (adapter->IfIndex != 0 && !interface_addresses.contains(adapter->IfIndex)) {
                            interface_addresses.emplace(adapter->IfIndex, buffer);
                        }
                        if (adapter->Ipv6IfIndex != 0 && !interface_addresses.contains(adapter->Ipv6IfIndex)) {
                            interface_addresses.emplace(adapter->Ipv6IfIndex, buffer);
                        }
                        break;
                    }
                }
            }
        }

        MIB_IF_TABLE2* interface_table = nullptr;
        if (GetIfTable2(&interface_table) != NO_ERROR || interface_table == nullptr) {
            return false;
        }

        for (ULONG index = 0; index < interface_table->NumEntries; ++index) {
            const auto& row = interface_table->Table[index];
            if (row.Type == IF_TYPE_SOFTWARE_LOOPBACK || row.Type == IF_TYPE_TUNNEL) {
                continue;
            }

            NetworkInterfaceSample item;
            item.name = wide_to_utf8(row.Alias);
            if (item.name.empty()) {
                item.name = wide_to_utf8(row.Description);
            }
            item.rx_bytes = row.InOctets;
            item.tx_bytes = row.OutOctets;
            item.is_up = row.OperStatus == IfOperStatusUp;

            if (const auto address = interface_addresses.find(row.InterfaceIndex); address != interface_addresses.end()) {
                item.address = address->second;
            }

            sample.total_rx_bytes += item.rx_bytes;
            sample.total_tx_bytes += item.tx_bytes;
            sample.network_connected = sample.network_connected || item.is_up;
            sample.interfaces.push_back(std::move(item));
        }

        FreeMibTable(interface_table);
        return true;
    }
};

}  // namespace

std::unique_ptr<IMetricsProvider> create_windows_metrics_provider() {
    return std::make_unique<WindowsMetricsProvider>();
}

}  // namespace network_watch
