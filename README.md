# Network Watch

一个基于 `Tauri v2 + React + TypeScript + Rust(sysinfo)` 的三端桌面悬浮监控工具，目标平台为 `macOS / Windows / Linux`。

当前版本实现的是第一版 MVP：常驻桌面的轻量悬浮窗，用于展示整机 `CPU`、`内存`、`网络上下行速率`，并支持托盘驻留、开机启动、窗口置顶、位置记忆和展开态趋势图。

## 当前状态

- 已完成 `Tauri v2 + React + TS` 工程初始化
- 已完成 Rust 侧系统采样与前端事件推送链路
- 已完成悬浮窗默认态和展开态 UI
- 已将默认态调整为紧凑状态条，点击后展开详情
- 已将默认停靠位置调整为右下角，贴近任务栏使用
- 已完成托盘显示/隐藏、开机启动、退出菜单
- 已完成关闭窗口隐藏到托盘
- 已完成窗口状态持久化和首次右上角停靠
- 已完成 Windows 本地构建与安装包打包验证

更完整的需求记录、决策过程、实现进度、验证结果和后续待办见：

- [项目日志](./docs/project-log.md)

## 技术栈

- 桌面容器：`Tauri v2`
- 前端：`React 19 + TypeScript + Vite`
- 后端：`Rust`
- 系统监控：`sysinfo`
- Tauri 插件：
  - `tauri-plugin-autostart`
  - `tauri-plugin-window-state`
  - `tauri-plugin-positioner`

## 已实现功能

- 无边框、置顶、透明背景的小组件窗口
- 默认收起态显示一行状态条和关键指标摘要
- 收起态拖动与展开操作已拆分，避免交互冲突
- 展开态显示 CPU、内存、网络趋势图
- 每 `1 秒` 采样并刷新指标
- 托盘左键切换窗口显示/隐藏
- 托盘菜单支持显示/隐藏、开机启动、退出
- 关闭主窗口时不退出进程，而是隐藏到托盘
- 自动保存窗口位置和尺寸

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

## 文档维护约定

后续所有与本项目有关的新增需求、讨论结论、阶段进展、已完成功能、验证结果和待办事项，统一记录到 [项目日志](./docs/project-log.md)。

约定的记录方式如下：

- 有新的需求讨论时，追加“讨论记录 / 决策结果”
- 有新的实现落地时，追加“完成内容 / 影响范围 / 验证情况”
- 有新的功能阶段完成时，更新“当前状态”和“功能清单”
- 有新的待办或风险时，追加“后续任务 / 风险说明”
