#include "network_watch/metrics_math.hpp"

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <unordered_map>

namespace network_watch {

namespace {

double bytes_per_second(std::uint64_t current, std::uint64_t previous, double seconds) {
    if (seconds <= 0.0 || current < previous) {
        return 0.0;
    }
    return static_cast<double>(current - previous) / seconds;
}

double cpu_usage(const CpuTimes& previous, const CpuTimes& current) {
    const auto previous_idle = previous.idle + previous.iowait;
    const auto current_idle = current.idle + current.iowait;

    const auto previous_non_idle =
        previous.user + previous.nice + previous.system + previous.irq + previous.softirq + previous.steal;
    const auto current_non_idle =
        current.user + current.nice + current.system + current.irq + current.softirq + current.steal;

    const auto previous_total = previous_idle + previous_non_idle;
    const auto current_total = current_idle + current_non_idle;

    if (current_total <= previous_total) {
        return 0.0;
    }

    const auto total_delta = static_cast<double>(current_total - previous_total);
    const auto idle_delta = static_cast<double>(current_idle - previous_idle);
    return std::clamp((total_delta - idle_delta) / total_delta * 100.0, 0.0, 100.0);
}

std::string format_rate(double bytes) {
    static const char* units[] = {"B/s", "KB/s", "MB/s", "GB/s"};
    std::size_t unit_index = 0;
    while (bytes >= 1024.0 && unit_index < 3) {
        bytes /= 1024.0;
        ++unit_index;
    }

    std::ostringstream output;
    output << std::fixed << std::setprecision(unit_index == 0 ? 0 : 1) << bytes << ' ' << units[unit_index];
    return output.str();
}

}  // namespace

std::optional<MetricDelta> compute_metric_delta(const MetricSample& previous, const MetricSample& current) {
    const auto elapsed = std::chrono::duration<double>(current.timestamp - previous.timestamp).count();
    if (elapsed <= 0.0) {
        return std::nullopt;
    }

    MetricDelta delta;
    delta.timestamp = current.timestamp;
    delta.cpu_usage_percent = cpu_usage(previous.cpu_times, current.cpu_times);
    delta.memory_usage_percent = current.memory.used_percent;
    delta.memory_used_bytes = current.memory.used_bytes;
    delta.memory_total_bytes = current.memory.total_bytes;
    delta.download_bytes_per_second = bytes_per_second(current.total_rx_bytes, previous.total_rx_bytes, elapsed);
    delta.upload_bytes_per_second = bytes_per_second(current.total_tx_bytes, previous.total_tx_bytes, elapsed);
    delta.network_connected = current.network_connected;

    std::unordered_map<std::string, NetworkInterfaceSample> previous_interfaces;
    for (const auto& item : previous.interfaces) {
        previous_interfaces[item.name] = item;
    }

    for (const auto& item : current.interfaces) {
        InterfaceDelta entry;
        entry.name = item.name;
        entry.is_up = item.is_up;
        entry.address = item.address;

        if (const auto it = previous_interfaces.find(item.name); it != previous_interfaces.end()) {
            entry.rx_bytes_per_second = bytes_per_second(item.rx_bytes, it->second.rx_bytes, elapsed);
            entry.tx_bytes_per_second = bytes_per_second(item.tx_bytes, it->second.tx_bytes, elapsed);
        }

        delta.interfaces.push_back(std::move(entry));
    }

    return delta;
}

TraySummary build_tray_summary(const MetricDelta& delta) {
    TraySummary summary;
    summary.warning = delta.cpu_usage_percent >= 85.0 || delta.memory_usage_percent >= 90.0 || !delta.network_connected;

    std::ostringstream title;
    title << "Down " << format_rate(delta.download_bytes_per_second) << " | Up " << format_rate(delta.upload_bytes_per_second);
    summary.title = title.str();

    std::ostringstream tooltip;
    tooltip << "CPU " << std::fixed << std::setprecision(1) << delta.cpu_usage_percent << "%, "
            << "Memory " << delta.memory_usage_percent << "%, "
            << "Network " << (delta.network_connected ? "online" : "offline");
    summary.tooltip = tooltip.str();

    return summary;
}

}  // namespace network_watch
