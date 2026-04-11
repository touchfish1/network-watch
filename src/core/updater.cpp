#include "network_watch/updater.hpp"

#include <sstream>
#include <string>

namespace network_watch {

namespace {

std::string trim_version_prefix(std::string value) {
    if (!value.empty() && (value.front() == 'v' || value.front() == 'V')) {
        value.erase(value.begin());
    }
    return value;
}

std::string json_unescape(const std::string& value) {
    std::string result;
    result.reserve(value.size());

    bool escaping = false;
    for (char ch : value) {
        if (escaping) {
            switch (ch) {
                case '\\': result.push_back('\\'); break;
                case '"': result.push_back('"'); break;
                case '/': result.push_back('/'); break;
                case 'n': result.push_back('\n'); break;
                case 'r': result.push_back('\r'); break;
                case 't': result.push_back('\t'); break;
                default: result.push_back(ch); break;
            }
            escaping = false;
            continue;
        }
        if (ch == '\\') {
            escaping = true;
            continue;
        }
        result.push_back(ch);
    }

    return result;
}

bool extract_json_string(const std::string& json, const std::string& key, std::size_t start, std::string& value, std::size_t* next_pos = nullptr) {
    const auto key_pattern = std::string("\"") + key + "\"";
    const auto key_pos = json.find(key_pattern, start);
    if (key_pos == std::string::npos) {
        return false;
    }

    const auto colon_pos = json.find(':', key_pos + key_pattern.size());
    const auto open_quote = json.find('"', colon_pos + 1);
    if (colon_pos == std::string::npos || open_quote == std::string::npos) {
        return false;
    }

    std::string raw_value;
    bool escaping = false;
    for (std::size_t index = open_quote + 1; index < json.size(); ++index) {
        const char ch = json[index];
        if (!escaping && ch == '"') {
            value = json_unescape(raw_value);
            if (next_pos != nullptr) {
                *next_pos = index + 1;
            }
            return true;
        }
        raw_value.push_back(ch);
        escaping = (!escaping && ch == '\\');
    }

    return false;
}

bool matches_platform_asset(const std::string& url, ReleaseAssetPlatform platform) {
    switch (platform) {
        case ReleaseAssetPlatform::WindowsInstaller:
            return url.ends_with(".exe") &&
                (url.find("Windows") != std::string::npos || url.find("windows") != std::string::npos);
        case ReleaseAssetPlatform::MacInstaller:
            return url.ends_with(".dmg");
        case ReleaseAssetPlatform::LinuxInstaller:
            return url.ends_with(".deb");
    }
    return false;
}

}  // namespace

std::string current_app_version() {
#ifdef NETWORK_WATCH_VERSION
    return NETWORK_WATCH_VERSION;
#else
    return "0.0.0";
#endif
}

int compare_versions(const std::string& lhs, const std::string& rhs) {
    std::istringstream lhs_stream(trim_version_prefix(lhs));
    std::istringstream rhs_stream(trim_version_prefix(rhs));
    for (;;) {
        std::string lhs_token;
        std::string rhs_token;
        const bool has_lhs = static_cast<bool>(std::getline(lhs_stream, lhs_token, '.'));
        const bool has_rhs = static_cast<bool>(std::getline(rhs_stream, rhs_token, '.'));
        if (!has_lhs && !has_rhs) {
            break;
        }

        const int lhs_value = lhs_token.empty() ? 0 : std::stoi(lhs_token);
        const int rhs_value = rhs_token.empty() ? 0 : std::stoi(rhs_token);
        if (lhs_value != rhs_value) {
            return lhs_value < rhs_value ? -1 : 1;
        }
    }

    return 0;
}

bool parse_latest_release_asset(
    const std::string& release_json,
    ReleaseAssetPlatform platform,
    ReleaseAssetInfo& asset,
    std::string& error_message) {
    asset = {};

    if (!extract_json_string(release_json, "tag_name", 0, asset.latest_version, nullptr)) {
        error_message = "Failed to parse latest release tag";
        return false;
    }

    std::size_t search_pos = 0;
    while (extract_json_string(release_json, "browser_download_url", search_pos, asset.download_url, &search_pos)) {
        if (matches_platform_asset(asset.download_url, platform)) {
            const auto filename_pos = asset.download_url.find_last_of('/');
            asset.asset_name = filename_pos == std::string::npos
                ? asset.download_url
                : asset.download_url.substr(filename_pos + 1);
            return true;
        }
        asset.download_url.clear();
    }

    error_message = "Latest release does not contain a matching installer asset";
    return false;
}

}  // namespace network_watch
