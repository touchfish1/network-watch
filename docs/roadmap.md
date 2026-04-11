# Roadmap

## Phase 1: Foundation

- 初始化 `CMake` 工程
- 建立共享核心数据模型和接口
- 搭建 Linux/macOS/Windows 平台目录
- 提供默认配置和测试骨架

完成标准：

- 项目可配置、可编译
- Linux 路径能跑通基础采样循环

## Phase 2: Monitoring Loop

- 打通 CPU、内存、网络采集
- 计算速率与摘要
- 托盘摘要按固定节奏刷新
- 维护 1/5/30 分钟历史缓存

完成标准：

- 能持续输出网络上下行、CPU、内存摘要
- 历史窗口数据可用于窗口图表

## Phase 3: Native Desktop Shell

- Linux：GTK + AppIndicator
- Windows：Win32 托盘 + 监控窗口
- macOS：NSStatusItem + AppKit 监控窗口

完成标准：

- 三端都具备状态栏入口
- 点击状态栏图标可打开监控窗口

## Phase 4: Alerting and Settings

- 告警阈值设置
- 冷却时间与恢复逻辑
- 桌面通知
- 自启动与设置页

完成标准：

- 告警可配置
- 触发与恢复路径清晰且不轰炸

## Phase 5: Packaging and Hardening

- Windows 安装包
- macOS `.app` / 签名流程
- Linux 包格式或 AppImage
- 长稳测试、睡眠恢复、多网卡兼容

完成标准：

- 三端具备可分发产物
- 常驻运行稳定
