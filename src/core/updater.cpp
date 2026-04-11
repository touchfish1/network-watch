#include "network_watch/updater.hpp"

#include <cctype>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

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

std::string ascii_lower(std::string value) {
    for (char& ch : value) {
        ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    }
    return value;
}

std::string_view filename_from_url(std::string_view url) {
    const auto query_pos = url.find_first_of("?#");
    if (query_pos != std::string_view::npos) {
        url = url.substr(0, query_pos);
    }

    const auto slash_pos = url.find_last_of('/');
    return slash_pos == std::string_view::npos ? url : url.substr(slash_pos + 1);
}

bool has_suffix(std::string_view value, std::string_view suffix) {
    return value.size() >= suffix.size() &&
        value.substr(value.size() - suffix.size()) == suffix;
}

bool contains_any(std::string_view value, const std::vector<std::string_view>& tokens) {
    for (const auto token : tokens) {
        if (value.find(token) != std::string_view::npos) {
            return true;
        }
    }
    return false;
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

int parse_version_component(const std::string& token) {
    long long value = 0;
    bool has_digits = false;

    for (char ch : token) {
        if (!std::isdigit(static_cast<unsigned char>(ch))) {
            break;
        }
        has_digits = true;
        value = value * 10 + (ch - '0');
        if (value > std::numeric_limits<int>::max()) {
            return std::numeric_limits<int>::max();
        }
    }

    return has_digits ? static_cast<int>(value) : 0;
}

bool matches_platform_asset(const std::string& url, ReleaseAssetPlatform platform) {
    const auto lowercase_url = ascii_lower(url);
    const auto filename = filename_from_url(lowercase_url);

    switch (platform) {
        case ReleaseAssetPlatform::WindowsInstaller:
            return (has_suffix(filename, ".exe") || has_suffix(filename, ".msi")) &&
                contains_any(filename, {"windows", "win32", "win64", "x64", "amd64"});
        case ReleaseAssetPlatform::MacInstaller:
            return (has_suffix(filename, ".dmg") || has_suffix(filename, ".pkg")) &&
                !contains_any(filename, {"windows", "linux"});
        case ReleaseAssetPlatform::LinuxInstaller:
            return (has_suffix(filename, ".deb") || has_suffix(filename, ".appimage") || has_suffix(filename, ".rpm")) &&
                !contains_any(filename, {"windows", "macos", "darwin", "osx"});
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

        const int lhs_value = parse_version_component(lhs_token);
        const int rhs_value = parse_version_component(rhs_token);
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
            asset.asset_name = std::string(filename_from_url(asset.download_url));
            return true;
        }
        asset.download_url.clear();
    }

    error_message = "Latest release does not contain a matching installer asset";
    return false;
}

}  // namespace network_watch
