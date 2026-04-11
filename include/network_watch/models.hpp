#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <string>
#include <vector>

namespace network_watch {

using Clock = std::chrono::system_clock;
using TimePoint = Clock::time_point;

struct CpuTimes {
    std::uint64_t user = 0;
    std::uint64_t nice = 0;
    std::uint64_t system = 0;
    std::uint64_t idle = 0;
    std::uint64_t iowait = 0;
    std::uint64_t irq = 0;
    std::uint64_t softirq = 0;
    std::uint64_t steal = 0;
};

struct MemoryStats {
    std::uint64_t total_bytes = 0;
    std::uint64_t used_bytes = 0;
    double used_percent = 0.0;
};

struct NetworkInterfaceSample {
    std::string name;
    std::uint64_t rx_bytes = 0;
    std::uint64_t tx_bytes = 0;
    bool is_up = false;
    std::string address;
};

struct MetricSample {
    TimePoint timestamp {};
    CpuTimes cpu_times {};
    MemoryStats memory {};
    std::uint64_t total_rx_bytes = 0;
    std::uint64_t total_tx_bytes = 0;
    bool network_connected = false;
    std::vector<NetworkInterfaceSample> interfaces {};
};

struct InterfaceDelta {
    std::string name;
    double rx_bytes_per_second = 0.0;
    double tx_bytes_per_second = 0.0;
    bool is_up = false;
    std::string address;
};

struct MetricDelta {
    TimePoint timestamp {};
    double cpu_usage_percent = 0.0;
    double memory_usage_percent = 0.0;
    std::uint64_t memory_used_bytes = 0;
    std::uint64_t memory_total_bytes = 0;
    double download_bytes_per_second = 0.0;
    double upload_bytes_per_second = 0.0;
    bool network_connected = false;
    std::vector<InterfaceDelta> interfaces {};
};

struct TraySummary {
    std::string title;
    std::string tooltip;
    bool warning = false;
};

struct HistorySnapshot {
    std::deque<MetricDelta> last_minute;
    std::deque<MetricDelta> last_five_minutes;
    std::deque<MetricDelta> last_thirty_minutes;
};

}  // namespace network_watch
