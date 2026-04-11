# Alerts

## Default Rules

默认规则如下：

- `cpu_high`
  - 指标：CPU 使用率
  - 阈值：85%
  - 持续时间：15 秒
  - 冷却时间：120 秒
- `memory_high`
  - 指标：内存使用率
  - 阈值：90%
  - 持续时间：20 秒
  - 冷却时间：180 秒
- `download_spike`
  - 指标：下载速率
  - 阈值：50 MB/s
  - 持续时间：10 秒
  - 冷却时间：120 秒
- `upload_spike`
  - 指标：上传速率
  - 阈值：25 MB/s
  - 持续时间：10 秒
  - 冷却时间：120 秒
- `network_down`
  - 指标：网络连接状态
  - 阈值：`< 0.5`
  - 持续时间：10 秒
  - 冷却时间：60 秒

## Rule Semantics

- 阈值：触发比较基准
- `trigger_when_below`：是否采用“小于阈值触发”
- `sustain_for`：连续 breach 多久才真正触发
- `cooldown_for`：已触发后，在冷却期内不重复发送同类告警
- 恢复：当指标回到安全区间时发送一条恢复事件

当前 Linux 桌面实现支持在设置页中直接修改以下字段并即时应用：

- 启用开关
- 阈值
- 持续时间
- 冷却时间
- 全局采样间隔
- 托盘刷新间隔

托盘菜单还支持通知控制：

- 直接启用或禁用桌面通知
- 临时静音 30 分钟
- 临时静音 2 小时
- 手动恢复通知

每条告警规则还支持单独通知静音：

- 在设置页中对单条规则临时静音 30 分钟
- 单独恢复该规则的桌面通知
- 规则静音不会影响告警历史记录，只影响桌面通知弹出

设置页还支持静音时段：

- 启用或关闭 quiet hours
- 配置开始时间和结束时间
- 支持跨午夜时段，例如 `22:00` 到 `07:00`

## Config Format

配置文件使用 `key=value`：

```ini
sample_interval_ms=1000
tray_refresh_interval_ms=2000
notifications_enabled=true
notification_snooze_until_epoch_seconds=0
quiet_hours_enabled=false
quiet_hours_start_minute=1320
quiet_hours_end_minute=420
autostart_enabled=false
print_tray_updates=true
alert.cpu_high.enabled=true
alert.cpu_high.threshold=85
alert.cpu_high.sustain_sec=15
alert.cpu_high.cooldown_sec=120
alert.cpu_high.notification_snooze_until_epoch_seconds=0
```

## Future Extensions

- 支持更多告警类型，如上传速率突增、多网卡断连
- 支持不同严重级别
- 支持静音时间段
- 支持长期历史驱动的自适应阈值
