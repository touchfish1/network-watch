#pragma once

#include <string>

namespace network_watch {

enum class ReleaseAssetPlatform {
    WindowsInstaller,
    MacInstaller,
    LinuxInstaller,
};

struct ReleaseAssetInfo {
    std::string latest_version;
    std::string download_url;
    std::string asset_name;
};

std::string current_app_version();
int compare_versions(const std::string& lhs, const std::string& rhs);
bool parse_latest_release_asset(
    const std::string& release_json,
    ReleaseAssetPlatform platform,
    ReleaseAssetInfo& asset,
    std::string& error_message);

}  // namespace network_watch
