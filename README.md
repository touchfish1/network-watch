# Network Watch

一个基于 `Tauri v2 + React + TypeScript + Rust(sysinfo)` 的三端桌面悬浮监控工具，目标平台为 `macOS / Windows / Linux`。

当前版本为 `v0.3.38`，已经从首版 MVP 演进为带托盘、自动更新、主题切换、吸边停靠和多平台发布流水线的桌面悬浮监控工具，用于常驻展示整机 `CPU`、`内存`、`网络上下行速率`，并提供展开态总览与趋势详情。

## 当前状态

- 已完成 `Tauri v2 + React + TS + Rust(sysinfo)` 工程初始化
- 已完成 Rust 侧系统采样、前端事件推送和趋势数据维护
- 已完成双行紧凑状态条、展开态总览卡片和趋势详情
- 已完成状态条拖动、点击展开、自动吸附到工作区边缘
- 已完成按任务栏 / 状态栏可用区域展开，避免被系统栏遮挡
- 已完成托盘显示/隐藏、开机启动、退出菜单
- 已完成关闭窗口隐藏到托盘和收起态常驻置顶
- 已完成窗口状态持久化、在线升级和多主题切换
- 已完成 GitHub Actions `Windows / macOS / Linux` 自动打包发布流水线
- 已完成新版项目图标资源重绘与打包接入

更完整的需求记录、决策过程、实现进度、验证结果和后续待办见：

- [项目日志](./docs/project-log.md)

## 技术栈

- 桌面容器：`Tauri v2`
- 前端：`React 19 + TypeScript + Vite`
- 后端：`Rust`
- 系统监控：`sysinfo`
- Tauri 插件：
  - `tauri-plugin-autostart`
  - `tauri-plugin-updater`
  - `tauri-plugin-window-state`
  - `tauri-plugin-positioner`
  - `tauri-plugin-process`

## 已实现功能

- 无边框、置顶、透明背景的小组件窗口
- 默认收起态显示双行纯文本状态条和关键指标摘要
- 收起态拖动与展开操作已拆分，避免交互冲突
- 吸附到任务栏/状态栏边缘，展开时自动避开系统栏工作区
- 展开态显示系统总览、在线升级、主题切换和趋势图
- 每 `1 秒` 采样并刷新指标
- 托盘左键切换窗口显示/隐藏
- 托盘菜单支持显示/隐藏、开机启动、退出
- 关闭主窗口时不退出进程，而是隐藏到托盘
- 自动保存窗口位置和尺寸
- 支持 GitHub Release 在线检查更新、下载和自动重启安装
- 支持 `赛博朋克 / 日式 / 中国风 / 欧美风` 主题切换
- 已接入 GitHub Actions 自动构建并上传 Release

## 本地开发

安装依赖：

```bash
npm install
```

启动前端开发服务器：

```bash
npm run dev
```

启动 Tauri 桌面开发模式：

```bash
npm run tauri dev
```

构建前端：

```bash
npm run build
```

构建桌面应用：

```bash
npm run tauri build -- --debug
```

## 已验证命令

- `npm run build`
- `cargo check`
- `npm run tauri build -- --debug`

Windows 调试打包产物位于：

- `src-tauri/target/debug/bundle/msi/`
- `src-tauri/target/debug/bundle/nsis/`

Release 流水线位于：

- [release.yml](/d:/opensource/network-watch/.github/workflows/release.yml)

## 文档维护约定

后续所有与本项目有关的新增需求、讨论结论、阶段进展、已完成功能、验证结果和待办事项，统一记录到 [项目日志](./docs/project-log.md)。

约定的记录方式如下：

- 有新的需求讨论时，追加“讨论记录 / 决策结果”
- 有新的实现落地时，追加“完成内容 / 影响范围 / 验证情况”
- 有新的功能阶段完成时，更新“当前状态”和“功能清单”
- 有新的待办或风险时，追加“后续任务 / 风险说明”
