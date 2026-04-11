#include "network_watch/updater.hpp"

#include "test_support.hpp"

namespace {

void expect_compare(const std::string& lhs, const std::string& rhs, int expected, const std::string& label) {
    const int actual = network_watch::compare_versions(lhs, rhs);
    network_watch::test::expect(actual == expected, label);
}

}  // namespace

void run_updater_tests() {
    using network_watch::ReleaseAssetInfo;
    using network_watch::ReleaseAssetPlatform;

    expect_compare("1.2.3", "1.2.3", 0, "same versions compare equal");
    expect_compare("v1.2.4", "1.2.3", 1, "v prefix is ignored");
    expect_compare("1.2", "1.2.0", 0, "missing version parts default to zero");
    expect_compare("1.2.3-beta1", "1.2.3", 0, "suffixes do not break version parsing");
    expect_compare("1.10.0", "1.2.0", 1, "multi-digit version parts compare numerically");

    {
        const std::string release_json = R"json(
            {
              "tag_name": "v1.3.0",
              "assets": [
                {
                  "browser_download_url": "https://example.com/network-watch-1.3.0-linux-amd64.deb?download=1"
                }
              ]
            }
        )json";

        ReleaseAssetInfo asset;
        std::string error_message;
        const bool ok = network_watch::parse_latest_release_asset(
            release_json,
            ReleaseAssetPlatform::LinuxInstaller,
            asset,
            error_message);
        network_watch::test::expect(ok, "linux release asset should parse");
        network_watch::test::expect(asset.latest_version == "v1.3.0", "latest version should be extracted");
        network_watch::test::expect(
            asset.download_url == "https://example.com/network-watch-1.3.0-linux-amd64.deb?download=1",
            "download url should preserve original value");
        network_watch::test::expect(
            asset.asset_name == "network-watch-1.3.0-linux-amd64.deb",
            "asset name should ignore query parameters");
    }

    {
        const std::string release_json = R"json(
            {
              "tag_name": "v2.0.0",
              "assets": [
                {
                  "browser_download_url": "https://example.com/network-watch-2.0.0-win64.exe"
                },
                {
                  "browser_download_url": "https://example.com/network-watch-2.0.0.dmg"
                }
              ]
            }
        )json";

        ReleaseAssetInfo asset;
        std::string error_message;
        const bool ok = network_watch::parse_latest_release_asset(
            release_json,
            ReleaseAssetPlatform::WindowsInstaller,
            asset,
            error_message);
        network_watch::test::expect(ok, "windows release asset should parse");
        network_watch::test::expect(
            asset.asset_name == "network-watch-2.0.0-win64.exe",
            "windows asset should be selected by platform");
    }

    {
        const std::string release_json = R"json(
            {
              "assets": [
                {
                  "browser_download_url": "https://example.com/network-watch-2.0.0.dmg"
                }
              ]
            }
        )json";

        ReleaseAssetInfo asset;
        std::string error_message;
        const bool ok = network_watch::parse_latest_release_asset(
            release_json,
            ReleaseAssetPlatform::MacInstaller,
            asset,
            error_message);
        network_watch::test::expect(!ok, "missing tag should fail parsing");
        network_watch::test::expect(
            error_message == "Failed to parse latest release tag",
            "missing tag should produce a useful error");
    }

    {
        const std::string release_json = R"json(
            {
              "tag_name": "v2.1.0",
              "assets": [
                {
                  "browser_download_url": "https://example.com/network-watch-2.1.0-source.tar.gz"
                }
              ]
            }
        )json";

        ReleaseAssetInfo asset;
        std::string error_message;
        const bool ok = network_watch::parse_latest_release_asset(
            release_json,
            ReleaseAssetPlatform::LinuxInstaller,
            asset,
            error_message);
        network_watch::test::expect(!ok, "missing platform asset should fail parsing");
        network_watch::test::expect(
            error_message == "Latest release does not contain a matching installer asset",
            "missing asset should produce a useful error");
    }
}
