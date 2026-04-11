#pragma once

#include <cmath>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>

namespace network_watch::test {

inline int& failures() {
    static int value = 0;
    return value;
}

inline void expect(bool condition, const std::string& message) {
    if (!condition) {
        ++failures();
        std::cerr << "EXPECT FAILED: " << message << '\n';
    }
}

inline void expect_near(double actual, double expected, double tolerance, const std::string& message) {
    if (std::fabs(actual - expected) > tolerance) {
        ++failures();
        std::cerr << "EXPECT FAILED: " << message << " actual=" << actual << " expected=" << expected << '\n';
    }
}

inline int finish() {
    if (failures() == 0) {
        std::cout << "All tests passed\n";
    }
    return failures() == 0 ? 0 : 1;
}

}  // namespace network_watch::test
