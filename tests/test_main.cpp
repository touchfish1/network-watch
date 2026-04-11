#include "test_support.hpp"

void run_alert_engine_tests();
void run_metrics_math_tests();
void run_settings_tests();

int main() {
    run_alert_engine_tests();
    run_metrics_math_tests();
    run_settings_tests();
    return network_watch::test::finish();
}
