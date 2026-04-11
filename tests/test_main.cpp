#include "test_support.hpp"

void run_alert_engine_tests();
void run_metrics_math_tests();
void run_settings_tests();
void run_updater_tests();

int main() {
    run_alert_engine_tests();
    run_metrics_math_tests();
    run_settings_tests();
    run_updater_tests();
    return network_watch::test::finish();
}
