#include "network_watch/settings.hpp"
#include "test_support.hpp"

#include <ctime>
#include <filesystem>

namespace {

void test_default_settings_have_rules() {
    const auto settings = network_watch::default_settings();
    network_watch::test::expect(settings.alert_rules.size() >= 5, "default settings should include alert rules");
}

void test_save_and_load_round_trip() {
    auto settings = network_watch::default_settings();
    settings.sample_interval = std::chrono::milliseconds(1500);
    settings.language = network_watch::AppLanguage::SimplifiedChinese;
    settings.notifications_enabled = false;
    settings.notification_snooze_until_epoch_seconds = 123456789;
    settings.quiet_hours_enabled = true;
    settings.quiet_hours_start_minute = 23 * 60;
    settings.quiet_hours_end_minute = 6 * 60;
    settings.alert_rules.front().notification_snooze_until_epoch_seconds = 999999;
    settings.alert_rules.front().threshold = 77.0;

    const auto path = std::filesystem::temp_directory_path() / "network_watch_settings_test.conf";
    network_watch::save_settings(path, settings);
    const auto loaded = network_watch::load_settings(path);

    network_watch::test::expect(loaded.sample_interval == settings.sample_interval, "sample interval should round-trip");
    network_watch::test::expect(loaded.language == settings.language, "language should round-trip");
    network_watch::test::expect(loaded.notifications_enabled == settings.notifications_enabled, "notification flag should round-trip");
    network_watch::test::expect(
        loaded.notification_snooze_until_epoch_seconds == settings.notification_snooze_until_epoch_seconds,
        "notification snooze should round-trip");
    network_watch::test::expect(loaded.quiet_hours_enabled == settings.quiet_hours_enabled, "quiet hours flag should round-trip");
    network_watch::test::expect(loaded.quiet_hours_start_minute == settings.quiet_hours_start_minute, "quiet hours start should round-trip");
    network_watch::test::expect(loaded.quiet_hours_end_minute == settings.quiet_hours_end_minute, "quiet hours end should round-trip");
    network_watch::test::expect(
        loaded.alert_rules.front().notification_snooze_until_epoch_seconds ==
            settings.alert_rules.front().notification_snooze_until_epoch_seconds,
        "rule-level notification snooze should round-trip");
    network_watch::test::expect_near(
        loaded.alert_rules.front().threshold,
        settings.alert_rules.front().threshold,
        0.001,
        "alert threshold should round-trip");

    std::filesystem::remove(path);
}

void test_default_alert_rule_lookup() {
    const auto rule = network_watch::default_alert_rule("upload_spike");
    network_watch::test::expect(rule.has_value(), "default rule lookup should find upload_spike");
    network_watch::test::expect(rule->metric == network_watch::AlertMetric::UploadRate, "lookup should return matching rule");

    const auto missing = network_watch::default_alert_rule("missing_rule");
    network_watch::test::expect(!missing.has_value(), "lookup should return empty for unknown rule");
}

void test_language_helpers() {
    auto settings = network_watch::default_settings();
    settings.language = network_watch::AppLanguage::English;
    network_watch::test::expect(
        network_watch::resolve_language(settings) == network_watch::AppLanguage::English,
        "explicit language should bypass auto detection");
    network_watch::test::expect(
        network_watch::app_language_from_string("zh-CN") == network_watch::AppLanguage::SimplifiedChinese,
        "language parser should recognize zh-CN");
}

void test_notifications_allowed_respects_snooze() {
    auto settings = network_watch::default_settings();
    settings.notifications_enabled = true;
    settings.notification_snooze_until_epoch_seconds = 200;

    const auto before = std::chrono::system_clock::time_point(std::chrono::seconds(100));
    const auto after = std::chrono::system_clock::time_point(std::chrono::seconds(250));

    network_watch::test::expect(!network_watch::notifications_allowed(settings, before), "snoozed notifications should be suppressed");
    network_watch::test::expect(network_watch::notifications_allowed(settings, after), "notifications should resume after snooze window");
}

void test_quiet_hours_active_across_midnight() {
    auto settings = network_watch::default_settings();
    settings.quiet_hours_enabled = true;
    settings.quiet_hours_start_minute = 22 * 60;
    settings.quiet_hours_end_minute = 7 * 60;

    std::tm tm_value {};
    tm_value.tm_year = 126;
    tm_value.tm_mon = 0;
    tm_value.tm_mday = 1;
    tm_value.tm_hour = 23;
    tm_value.tm_min = 30;
    const auto active = std::chrono::system_clock::from_time_t(std::mktime(&tm_value));

    tm_value.tm_hour = 12;
    tm_value.tm_min = 15;
    const auto inactive = std::chrono::system_clock::from_time_t(std::mktime(&tm_value));

    network_watch::test::expect(network_watch::quiet_hours_active(settings, active), "quiet hours should apply late at night");
    network_watch::test::expect(!network_watch::quiet_hours_active(settings, inactive), "quiet hours should not apply at noon");
}

void test_alert_rule_notifications_allowed_respects_rule_snooze() {
    auto settings = network_watch::default_settings();
    settings.notifications_enabled = true;
    settings.alert_rules.front().notification_snooze_until_epoch_seconds = 300;

    const auto before = std::chrono::system_clock::time_point(std::chrono::seconds(100));
    const auto after = std::chrono::system_clock::time_point(std::chrono::seconds(500));

    network_watch::test::expect(
        !network_watch::alert_rule_notifications_allowed(settings, settings.alert_rules.front().id, before),
        "rule snooze should suppress matching notifications");
    network_watch::test::expect(
        network_watch::alert_rule_notifications_allowed(settings, settings.alert_rules.front().id, after),
        "rule snooze should expire for matching notifications");
    network_watch::test::expect(
        network_watch::alert_rule_notifications_allowed(settings, "unknown_rule", before),
        "unknown rules should fall back to global notification policy");
}

}  // namespace

void run_settings_tests() {
    test_default_settings_have_rules();
    test_save_and_load_round_trip();
    test_default_alert_rule_lookup();
    test_language_helpers();
    test_notifications_allowed_respects_snooze();
    test_quiet_hours_active_across_midnight();
    test_alert_rule_notifications_allowed_respects_rule_snooze();
}
