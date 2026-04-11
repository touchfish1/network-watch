#include "network_watch/metrics_math.hpp"
#include "test_support.hpp"

using namespace std::chrono_literals;

namespace {

network_watch::MetricSample make_sample(
    network_watch::TimePoint timestamp,
    network_watch::CpuTimes cpu,
    std::uint64_t memory_total,
    std::uint64_t memory_used,
    std::uint64_t rx,
    std::uint64_t tx) {
    network_watch::MetricSample sample;
    sample.timestamp = timestamp;
    sample.cpu_times = cpu;
    sample.memory.total_bytes = memory_total;
    sample.memory.used_bytes = memory_used;
    sample.memory.used_percent = memory_total == 0 ? 0.0 : static_cast<double>(memory_used) / memory_total * 100.0;
    sample.total_rx_bytes = rx;
    sample.total_tx_bytes = tx;
    sample.network_connected = true;
    return sample;
}

void test_compute_delta() {
    const auto base = network_watch::Clock::now();
    const auto previous = make_sample(base, {100, 0, 50, 850, 0, 0, 0, 0}, 1000, 400, 1000, 2000);
    const auto current = make_sample(base + 1s, {130, 0, 70, 900, 0, 0, 0, 0}, 1000, 500, 4000, 5000);

    const auto delta = network_watch::compute_metric_delta(previous, current);
    network_watch::test::expect(delta.has_value(), "delta should be computed");
    network_watch::test::expect_near(delta->cpu_usage_percent, 50.0, 0.1, "cpu percent should match");
    network_watch::test::expect_near(delta->memory_usage_percent, 50.0, 0.01, "memory percent should match");
    network_watch::test::expect_near(delta->download_bytes_per_second, 3000.0, 0.01, "download rate should match");
    network_watch::test::expect_near(delta->upload_bytes_per_second, 3000.0, 0.01, "upload rate should match");
}

void test_tray_summary() {
    network_watch::MetricDelta delta;
    delta.cpu_usage_percent = 91.0;
    delta.memory_usage_percent = 20.0;
    delta.download_bytes_per_second = 2048.0;
    delta.upload_bytes_per_second = 1024.0;
    delta.network_connected = true;

    const auto summary = network_watch::build_tray_summary(delta);
    network_watch::test::expect(summary.warning, "high cpu should set warning");
    network_watch::test::expect(summary.title.find("CPU") != std::string::npos, "summary title should contain cpu");
    network_watch::test::expect(summary.title.find("MEM") != std::string::npos, "summary title should contain memory");
    network_watch::test::expect(summary.title.find("Down") != std::string::npos, "summary title should contain rate");
    network_watch::test::expect(summary.tooltip.find("Network online") != std::string::npos, "summary tooltip should contain connectivity");
}

}  // namespace

void run_metrics_math_tests() {
    test_compute_delta();
    test_tray_summary();
}
