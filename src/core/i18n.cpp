#include "network_watch/settings.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <locale>

#if defined(_WIN32)
#include <windows.h>
#endif

namespace network_watch {

namespace {

std::string lowercase(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

AppLanguage detect_from_locale_name(const std::string& locale_name) {
    const auto normalized = lowercase(locale_name);
    if (normalized.find("zh") != std::string::npos || normalized.find("chinese") != std::string::npos) {
        return AppLanguage::SimplifiedChinese;
    }
    return AppLanguage::English;
}

}  // namespace

std::string to_string(AppLanguage language) {
    switch (language) {
        case AppLanguage::Auto:
            return "auto";
        case AppLanguage::English:
            return "en";
        case AppLanguage::SimplifiedChinese:
            return "zh-CN";
    }
    return "auto";
}

AppLanguage app_language_from_string(const std::string& value) {
    const auto normalized = lowercase(value);
    if (normalized == "en" || normalized == "en-us" || normalized == "english") {
        return AppLanguage::English;
    }
    if (normalized == "zh" || normalized == "zh-cn" || normalized == "zh_cn" ||
        normalized == "chinese" || normalized == "simplified_chinese") {
        return AppLanguage::SimplifiedChinese;
    }
    return AppLanguage::Auto;
}

AppLanguage detect_system_language() {
#if defined(_WIN32)
    return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE
        ? AppLanguage::SimplifiedChinese
        : AppLanguage::English;
#else
    const char* locale_name = std::getenv("LC_ALL");
    if (locale_name == nullptr || *locale_name == '\0') {
        locale_name = std::getenv("LC_MESSAGES");
    }
    if (locale_name == nullptr || *locale_name == '\0') {
        locale_name = std::getenv("LANG");
    }
    if (locale_name != nullptr && *locale_name != '\0') {
        return detect_from_locale_name(locale_name);
    }
    try {
        return detect_from_locale_name(std::locale("").name());
    } catch (...) {
        return AppLanguage::English;
    }
#endif
}

AppLanguage resolve_language(const Settings& settings) {
    return settings.language == AppLanguage::Auto ? detect_system_language() : settings.language;
}

std::string localized_language_name(AppLanguage option, AppLanguage display_language) {
    const bool zh = display_language == AppLanguage::SimplifiedChinese;
    switch (option) {
        case AppLanguage::Auto:
            return zh ? "跟随系统" : "System default";
        case AppLanguage::English:
            return "English";
        case AppLanguage::SimplifiedChinese:
            return zh ? "简体中文" : "Simplified Chinese";
    }
    return "System default";
}

std::string localized_app_name(AppLanguage language) {
    return language == AppLanguage::SimplifiedChinese ? "网络监视器" : "Network Watch";
}

std::string localized_metric_label(AlertMetric metric, AppLanguage language) {
    const bool zh = language == AppLanguage::SimplifiedChinese;
    switch (metric) {
        case AlertMetric::CpuUsage:
            return "CPU";
        case AlertMetric::MemoryUsage:
            return zh ? "内存" : "Memory";
        case AlertMetric::DownloadRate:
            return zh ? "下载" : "Download";
        case AlertMetric::UploadRate:
            return zh ? "上传" : "Upload";
        case AlertMetric::NetworkDisconnected:
            return zh ? "网络" : "Network";
    }
    return zh ? "指标" : "Metric";
}

std::string localized_metric_short_label(AlertMetric metric, AppLanguage language) {
    const bool zh = language == AppLanguage::SimplifiedChinese;
    switch (metric) {
        case AlertMetric::CpuUsage:
            return "CPU";
        case AlertMetric::MemoryUsage:
            return zh ? "内存" : "MEM";
        case AlertMetric::DownloadRate:
            return zh ? "下载" : "Down";
        case AlertMetric::UploadRate:
            return zh ? "上传" : "Up";
        case AlertMetric::NetworkDisconnected:
            return zh ? "网络" : "Network";
    }
    return zh ? "指标" : "Metric";
}

std::string localized_network_state(bool connected, AppLanguage language) {
    if (language == AppLanguage::SimplifiedChinese) {
        return connected ? "在线" : "离线";
    }
    return connected ? "online" : "offline";
}

}  // namespace network_watch
