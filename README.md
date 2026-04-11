# network_watch

`network_watch` 是一个用 C++ 构建的跨平台系统状态栏监控器项目，目标平台为 Linux、macOS 和 Windows。项目采用“共享核心 + 分平台原生壳层”的结构：共享核心负责指标采集调度、历史缓存、告警和配置，平台层负责托盘、窗口、通知与开机自启。

当前仓库已提供：

- `CMake` 工程骨架
- 共享核心的数据模型、告警引擎、监控服务、配置读写
- Linux `/proc` 指标采集实现
- Linux GTK/AppIndicator 托盘壳层，含监控窗口、趋势图、设置页和告警面板
- Windows/macOS 原生壳层与采集层骨架
- 基础测试与详细设计文档

## Quick Start

### 1. 安装基础依赖

Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build pkg-config
```

如果后续要实现 Linux 原生托盘窗口，建议再安装：

```bash
sudo apt-get install -y libgtk-3-dev libayatana-appindicator3-dev libnotify-dev
```

### 2. 配置与构建

```bash
cmake -S . -B build -G Ninja
cmake --build build
```

### 3. 运行

```bash
./build/network_watch
```

程序首次启动会自动生成默认配置文件：

- Linux: `~/.config/network-watch/settings.conf`
- macOS: `~/Library/Application Support/network-watch/settings.conf`
- Windows: `%APPDATA%/network-watch/settings.conf`

### 4. 运行测试

```bash
ctest --test-dir build --output-on-failure
```

## Project Layout

```text
include/network_watch/     Public headers
src/core/                  Shared monitoring core
src/platform/linux/        Linux provider and shell
src/platform/macos/        macOS scaffolding
src/platform/windows/      Windows scaffolding
tests/                     Minimal unit tests
docs/                      Architecture and planning docs
```

## Current Status

当前版本更接近“可运行的架构起点”而不是完整桌面产品：

- Linux 上已经具备 GTK/AppIndicator 托盘、监控窗口、趋势图、接口列表、设置页和告警面板
- 告警、历史缓存、配置读写、自启动开关、通知开关、全局通知静音、规则级通知静音、静音时段和运行时规则更新已经打通
- Windows/macOS 仍然保留原生壳层骨架，等待后续补齐平台实现

详见：

- [架构设计](docs/architecture.md)
- [路线图](docs/roadmap.md)
- [告警说明](docs/alerts.md)
- [实施计划](docs/implementation-plan.md)

## GitHub Actions Release

仓库包含 [`.github/workflows/release.yml`](.github/workflows/release.yml)，用于在 GitHub Actions 上完成以下流程：

- 在 `v*` 标签推送时自动构建 Linux、macOS、Windows 三个平台
- 运行测试
- 使用 `cpack` 产出平台归档包
- 将归档包上传到对应的 GitHub Release

### 触发方式

自动触发：

```bash
git tag v0.1.0
git push origin v0.1.0
```

手动触发：

- 在 GitHub Actions 页面运行 `Release` workflow
- 输入要发布的标签，例如 `v0.1.0`

### Linux Runner Dependencies

Linux 打包任务会自动安装：

- `ninja-build`
- `pkg-config`
- `libgtk-3-dev`
- `libayatana-appindicator3-dev`
- `libnotify-dev`

### Release Artifacts

当前 GitHub Actions 会生成与平台对应的原生安装分发产物：

- Linux: `.deb`
- macOS: `.dmg`
- Windows: NSIS 安装程序 `.exe`

如果后续需要扩展分发渠道，也可以在现有 workflow 上继续增加 AppImage、`.pkg`、MSI 等额外产物。
