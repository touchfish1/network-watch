# Network Watch 优化与新功能执行文档

更新时间：2026-04-14  
范围：Tauri v2 + React/TypeScript + Rust(sysinfo)  

## 目标与原则

### 目标
- **指标可信**：网络“速率”展示与趋势必须反映真实 B/s，而不是累计字节。
- **更省电**：隐藏到托盘时减少采样与系统调用。
- **更安全**：生产环境恢复最小可用 CSP 基线，不破坏开发体验。
- **可验收**：每个改动都有明确的验收步骤与回滚点。

### 不做/暂缓
- 不引入大规模架构重构（如把 `src/App.tsx` 全量拆分）作为本轮主目标。
- 不做进程级网络（跨平台与权限复杂度太高），仅列为未来方向。

## 现状要点（来自代码阅读）

- 前端主要逻辑集中在 `src/App.tsx`：监听 `system-snapshot`、维护 300 点 history、展示 DOWN/UP 与趋势图。
- 后端采样在 `src-tauri/src/lib.rs` 的 `start_sampler`：每 1 秒刷新 CPU/MEM/Networks 并 `emit("system-snapshot")`。
- **关键问题**：后端发送的 `network_download/network_upload` 来自 `sysinfo::Networks` 的 `received()/transmitted()` **累计字节**，前端却用 `formatRate(...)/s` 当“速率”展示。
- 安全配置：`src-tauri/tauri.conf.json` 中 `"app.security.csp": null`（CSP 关闭）。

## Phase 1（P0）：修正网络速率语义（必须做）

### 需求
- UI 上的 `DOWN/UP` 与网络趋势必须是 **实时速率（bytes/sec）**。
- 速率计算必须考虑采样 jitter（不要假设严格 1s）。
- 必须处理计数器重置/回绕（当前累计小于上次累计时）。

### 方案（选用）
- **后端计算速率并发送**（推荐）：
  - 维持上一次累计值与上一次时间戳。
  - 每次采样：`rate = max(curr - prev, 0) / dt_seconds`。
  - `SystemSnapshot` 仍使用字段名 `network_download/network_upload`，但语义变为 **B/s**（保持前端类型不变，减少改动面）。

### 涉及文件
- `src-tauri/src/lib.rs`
- `src/App.tsx`（仅需确认展示文本与 format 函数语义一致；若字段语义改变但名称不变，需要文案一致）

### 验收标准
- **折叠态**：`DOWN`/`UP` 数值会随网络活动上下波动，不会单调递增。
- **展开态**：“网络趋势”折线在无流量时接近 0，有下载时上行/下行分别上升。
- **边界**：应用启动后的第一条速率可以是 0（因为无 prev）；网络断开/重连不会出现巨大负值或爆表尖峰（按重置处理）。

### 回滚策略
- 若出现平台差异导致速率不可用，可临时回退为“累计字节”并移除 `/s` 文案（但本轮默认不采用）。

## Phase 2（P1）：隐藏到托盘时降频/暂停采样（建议做）

### 需求
- 窗口隐藏时降低采样频率（例如 5s）或暂停采样。
- 窗口显示时立即恢复 1s 并尽快推送一次 snapshot。

### 方案（选用）
- 后端 sampler 线程中根据窗口 `is_visible()` 决定 sleep 时长：
  - visible: 1s
  - hidden: 5s（可后续配置化）

### 涉及文件
- `src-tauri/src/lib.rs`

### 验收标准
- 手动隐藏窗口到托盘后，系统资源占用可观察下降（至少减少 sysinfo refresh 次数）。
- 重新显示后 1s 内能看到 `lastUpdated` 刷新。

## Phase 3（P1）：恢复生产 CSP 基线（建议做）

### 需求
- 生产环境不再使用 `csp: null`。
- 不破坏 Vite dev（`devUrl`）与现有内联样式/资源加载。

### 方案（草案）
- 设置一个保守 CSP（允许自身资源、允许 `unsafe-inline` style 以兼容当前 CSS/注入；脚本尽量收紧）。
- 如 dev 受影响，再做 dev/prod 分离（只在 prod 开 CSP）。

### 涉及文件
- `src-tauri/tauri.conf.json`

### 验收标准
- `npm run tauri dev` 可正常启动并展示 UI。
- 打包应用功能不受影响（本地 build 验证）。

## 后续新功能方向（不在本轮实现）

- **阈值告警 + 系统通知**（CPU/MEM/上下行）
- **网络适配器选择**（总和 / 指定网卡 / 过滤虚拟网卡）
- **历史持久化与回放**（小时/天）
- **导出 CSV/JSON、复制摘要**
- **快捷键**（展开/收起、锁定位置）
- **布局预设**（紧凑/双行/显示项可配置）

