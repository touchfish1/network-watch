#include "network_watch/application.hpp"
#include "network_watch/settings.hpp"

#include <exception>
#include <filesystem>
#include <iostream>

int main() {
    try {
        const auto config_path = network_watch::default_config_path();
        auto settings = network_watch::load_settings(config_path);
        if (!std::filesystem::exists(config_path)) {
            network_watch::save_settings(config_path, settings);
        }

        network_watch::Application app(std::move(settings));
        return app.run();
    } catch (const std::exception& error) {
        std::cerr << "Fatal error: " << error.what() << '\n';
        return 1;
    }
}
