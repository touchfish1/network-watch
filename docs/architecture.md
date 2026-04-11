# Architecture

## Overview

项目采用三层结构：

1. 共享核心层
2. 平台适配层
3. 平台原生 UI 层

共享核心层只理解“指标、历史、告警、配置”这些业务概念，不直接依赖任一平台 GUI 或系统通知 API。平台差异全部通过抽象接口隔离。

## Shared Core

### Metrics

- `MetricSample` 表示原始采样快照。
- `MetricDelta` 表示相邻采样间计算后的可展示指标。
- `HistorySnapshot` 维护最近 1 分钟、5 分钟、30 分钟三段历史窗口。

### Alert Engine

- 输入：`MetricDelta`
- 输出：`AlertEvent`
- 规则：阈值、持续时间、冷却时间、触发方向
- 状态：每条规则维护 breach 起点、是否处于激活状态、上次触发时间

### Config

- 使用简单 `key=value` 文本格式，避免在基础阶段引入额外依赖。
- 默认配置首次启动时自动生成。
- 平台路径通过 `default_config_path()` 统一处理。
- 运行中的 `MonitorService` 支持热更新采样间隔与告警规则，供桌面设置页即时生效。

## Platform Abstraction

平台抽象接口：

- `IMetricsProvider`
- `ITrayAdapter`
- `INotificationAdapter`
- `IAutostartAdapter`

`create_platform_components()` 负责按平台返回具体实现，应用层只与接口交互。

## Linux Path

当前 Linux 路径已经具备最小闭环：

- `/proc/stat` 读取 CPU 原始计数
- `/proc/meminfo` 读取内存使用
- `/proc/net/dev` + `getifaddrs()` 读取网络流量与接口状态
- Ayatana AppIndicator 托盘标签与菜单
- GTK 监控窗口，包含总览、趋势图、接口列表、设置页和告警面板
- `libnotify` 桌面通知

后续引入 GTK/AppIndicator 时，只需替换 Linux shell 中的 UI 适配器，不需要改共享核心。

## Future GUI Implementation

### Windows

- 指标采集：PDH、IP Helper API、`GlobalMemoryStatusEx`
- 托盘：Win32 `Shell_NotifyIcon`
- 通知：Windows Toast

### macOS

- 指标采集：`host_statistics`、`sysctl`、`getifaddrs`
- 状态栏：`NSStatusItem`
- 通知：UserNotifications

### Linux

- 托盘：Ayatana AppIndicator / StatusNotifierItem
- 窗口：GTK
- 通知：`libnotify`

## Threading Model

- 后台线程负责定时采样与告警评估。
- UI 主线程只消费 `MetricDelta` 和 `AlertEvent`。
- 历史缓存与最新状态由 `MonitorService` 内部互斥保护。

这种设计使采集与绘制解耦，后续 GUI 落地时不需要重新设计核心并发模型。
