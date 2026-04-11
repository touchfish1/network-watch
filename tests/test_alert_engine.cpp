#include "network_watch/alert_engine.hpp"
#include "test_support.hpp"

using namespace std::chrono_literals;

namespace {

network_watch::MetricDelta make_delta(network_watch::TimePoint timestamp, double cpu, double memory, bool network_connected = true) {
    network_watch::MetricDelta delta;
    delta.timestamp = timestamp;
    delta.cpu_usage_percent = cpu;
    delta.memory_usage_percent = memory;
    delta.network_connected = network_connected;
    return delta;
}

void test_alert_triggers_after_sustain() {
    network_watch::AlertRule rule;
    rule.id = "cpu";
    rule.metric = network_watch::AlertMetric::CpuUsage;
    rule.threshold = 80.0;
    rule.sustain_for = 2s;
    rule.cooldown_for = 60s;

    network_watch::AlertEngine engine({rule});
    const auto base = network_watch::Clock::now();

    auto events = engine.evaluate(make_delta(base, 81.0, 40.0));
    network_watch::test::expect(events.empty(), "alert should not trigger immediately");

    events = engine.evaluate(make_delta(base + 1s, 82.0, 40.0));
    network_watch::test::expect(events.empty(), "alert should wait for sustain window");

    events = engine.evaluate(make_delta(base + 2s, 83.0, 40.0));
    network_watch::test::expect(events.size() == 1, "alert should trigger after sustain window");
    network_watch::test::expect(events.front().state == network_watch::AlertState::Triggered, "alert state should be triggered");
}

void test_alert_recovers() {
    network_watch::AlertRule rule;
    rule.id = "network";
    rule.metric = network_watch::AlertMetric::NetworkDisconnected;
    rule.threshold = 0.5;
    rule.trigger_when_below = true;
    rule.sustain_for = 1s;
    rule.cooldown_for = 10s;

    network_watch::AlertEngine engine({rule});
    const auto base = network_watch::Clock::now();

    engine.evaluate(make_delta(base, 20.0, 20.0, false));
    auto events = engine.evaluate(make_delta(base + 1s, 20.0, 20.0, false));
    network_watch::test::expect(events.size() == 1, "network alert should trigger");

    events = engine.evaluate(make_delta(base + 2s, 20.0, 20.0, true));
    network_watch::test::expect(events.size() == 1, "network alert should recover");
    network_watch::test::expect(events.front().state == network_watch::AlertState::Recovered, "alert state should be recovered");
}

void test_alert_message_is_human_readable() {
    network_watch::AlertRule rule;
    rule.id = "memory";
    rule.metric = network_watch::AlertMetric::MemoryUsage;
    rule.threshold = 90.0;
    rule.sustain_for = 1s;
    rule.cooldown_for = 30s;

    network_watch::AlertEngine engine({rule});
    const auto base = network_watch::Clock::now();

    engine.evaluate(make_delta(base, 10.0, 95.0));
    auto events = engine.evaluate(make_delta(base + 1s, 10.0, 95.0));
    network_watch::test::expect(events.size() == 1, "memory alert should trigger");
    network_watch::test::expect(events.front().message.find("Memory alert triggered") != std::string::npos, "message should use human-readable label");
    network_watch::test::expect(events.front().message.find("95.0%") != std::string::npos, "message should include formatted value");
}

}  // namespace

void run_alert_engine_tests() {
    test_alert_triggers_after_sustain();
    test_alert_recovers();
    test_alert_message_is_human_readable();
}
