#include "network_watch/settings.hpp"
#include "test_support.hpp"

#include <filesystem>

namespace {

void test_default_settings_have_rules() {
    const auto settings = network_watch::default_settings();
    network_watch::test::expect(settings.alert_rules.size() >= 4, "default settings should include alert rules");
}

void test_save_and_load_round_trip() {
    auto settings = network_watch::default_settings();
    settings.sample_interval = std::chrono::milliseconds(1500);
    settings.notifications_enabled = false;
    settings.alert_rules.front().threshold = 77.0;

    const auto path = std::filesystem::temp_directory_path() / "network_watch_settings_test.conf";
    network_watch::save_settings(path, settings);
    const auto loaded = network_watch::load_settings(path);

    network_watch::test::expect(loaded.sample_interval == settings.sample_interval, "sample interval should round-trip");
    network_watch::test::expect(loaded.notifications_enabled == settings.notifications_enabled, "notification flag should round-trip");
    network_watch::test::expect_near(
        loaded.alert_rules.front().threshold,
        settings.alert_rules.front().threshold,
        0.001,
        "alert threshold should round-trip");

    std::filesystem::remove(path);
}

}  // namespace

void run_settings_tests() {
    test_default_settings_have_rules();
    test_save_and_load_round_trip();
}
