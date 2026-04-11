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

## Config Format

配置文件使用 `key=value`：

```ini
sample_interval_ms=1000
tray_refresh_interval_ms=2000
notifications_enabled=true
autostart_enabled=false
print_tray_updates=true
alert.cpu_high.enabled=true
alert.cpu_high.threshold=85
alert.cpu_high.sustain_sec=15
alert.cpu_high.cooldown_sec=120
```

## Future Extensions

- 支持更多告警类型，如上传速率突增、多网卡断连
- 支持不同严重级别
- 支持静音时间段
- 支持长期历史驱动的自适应阈值
