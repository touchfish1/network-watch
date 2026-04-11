cmake_minimum_required(VERSION 3.20)

project(network_watch VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(NETWORK_WATCH_BUILD_TESTS "Build unit tests" ON)
set(NETWORK_WATCH_RELEASE_VERSION "" CACHE STRING "Override package/release version, usually from a Git tag like v0.1.0")

if(NETWORK_WATCH_RELEASE_VERSION)
    string(REGEX REPLACE "^v" "" NETWORK_WATCH_EFFECTIVE_VERSION "${NETWORK_WATCH_RELEASE_VERSION}")
else()
    set(NETWORK_WATCH_EFFECTIVE_VERSION "${PROJECT_VERSION}")
endif()

add_library(network_watch_core
    src/core/alert_engine.cpp
    src/core/i18n.cpp
    src/core/metrics_math.cpp
    src/core/monitor_service.cpp
    src/core/settings.cpp
)

target_include_directories(network_watch_core PUBLIC include)
target_compile_definitions(network_watch_core PUBLIC NETWORK_WATCH_VERSION="${NETWORK_WATCH_EFFECTIVE_VERSION}")

target_compile_features(network_watch_core PUBLIC cxx_std_20)

if(WIN32)
    add_library(network_watch_platform
        src/platform/windows/windows_metrics_provider.cpp
        src/platform/windows/windows_shell.cpp
    )
elseif(APPLE)
    enable_language(OBJCXX)
    add_library(network_watch_platform
        src/platform/macos/macos_metrics_provider.cpp
        src/platform/macos/macos_shell.mm
    )
else()
    add_library(network_watch_platform
        src/platform/linux/linux_metrics_provider.cpp
        src/platform/linux/linux_shell.cpp
    )
endif()

target_include_directories(network_watch_platform PUBLIC include)
target_link_libraries(network_watch_platform PUBLIC network_watch_core)

if(WIN32)
    target_link_libraries(network_watch_platform PRIVATE iphlpapi shell32 user32 ws2_32 winhttp)
elseif(APPLE)
    find_library(APPKIT_FRAMEWORK AppKit REQUIRED)
    find_library(FOUNDATION_FRAMEWORK Foundation REQUIRED)
    target_link_libraries(network_watch_platform PRIVATE ${APPKIT_FRAMEWORK} ${FOUNDATION_FRAMEWORK})
endif()

add_executable(network_watch src/main.cpp)
target_link_libraries(network_watch PRIVATE network_watch_core network_watch_platform)

if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED IMPORTED_TARGET gtk+-3.0)
    pkg_check_modules(APPINDICATOR REQUIRED IMPORTED_TARGET ayatana-appindicator3-0.1)
    pkg_check_modules(LIBNOTIFY REQUIRED IMPORTED_TARGET libnotify)

    target_link_libraries(
        network_watch_platform
        PUBLIC
            PkgConfig::GTK3
            PkgConfig::APPINDICATOR
            PkgConfig::LIBNOTIFY
    )
endif()

include(GNUInstallDirs)
include(InstallRequiredSystemLibraries)

if(WIN32)
    set(NETWORK_WATCH_INSTALL_RUNTIME_DESTINATION ".")
else()
    set(NETWORK_WATCH_INSTALL_RUNTIME_DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

install(TARGETS network_watch RUNTIME DESTINATION ${NETWORK_WATCH_INSTALL_RUNTIME_DESTINATION})

if(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
    install(PROGRAMS ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS} DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

install(
    FILES
        README.md
        docs/architecture.md
        docs/alerts.md
        docs/implementation-plan.md
        docs/roadmap.md
    DESTINATION ${CMAKE_INSTALL_DATADIR}/network_watch/docs
)

if(NETWORK_WATCH_BUILD_TESTS)
    enable_testing()

    add_executable(network_watch_tests
        tests/test_main.cpp
        tests/test_alert_engine.cpp
        tests/test_metrics_math.cpp
        tests/test_settings.cpp
    )

    target_include_directories(network_watch_tests PRIVATE include tests)
    target_link_libraries(network_watch_tests PRIVATE network_watch_core)

    add_test(NAME network_watch_tests COMMAND network_watch_tests)
endif()

set(CPACK_PACKAGE_NAME "network-watch")
set(CPACK_PACKAGE_VENDOR "touchfish1")
set(CPACK_PACKAGE_CONTACT "touchfish1")
set(CPACK_PACKAGE_VERSION "${NETWORK_WATCH_EFFECTIVE_VERSION}")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Cross-platform tray monitor for CPU, memory, and network activity")
set(CPACK_RESOURCE_FILE_README "${CMAKE_CURRENT_SOURCE_DIR}/README.md")
set(CPACK_STRIP_FILES ON)
set(CPACK_VERBATIM_VARIABLES YES)
set(CPACK_INCLUDE_TOPLEVEL_DIRECTORY ON)
set(CPACK_PACKAGE_INSTALL_DIRECTORY "network-watch")
set(CPACK_PACKAGE_FILE_NAME "network-watch-${NETWORK_WATCH_EFFECTIVE_VERSION}-${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}")

if(WIN32)
    set(CPACK_GENERATOR "NSIS")
    set(CPACK_PACKAGE_EXECUTABLES "network_watch" "Network Watch")
    set(CPACK_CREATE_DESKTOP_LINKS "network_watch")
    set(CPACK_NSIS_DISPLAY_NAME "Network Watch")
    set(CPACK_NSIS_PACKAGE_NAME "Network Watch")
    set(CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL ON)
    set(CPACK_NSIS_MUI_FINISHPAGE_RUN "network_watch.exe")
else()
    set(CPACK_GENERATOR "TGZ")
endif()

include(CPack)
