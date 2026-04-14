//! Windows 网络连接表采集（TCP）。
//!
//! 目前提供“连接总数 + 状态分布”能力，用于在控制中心展示。
//! 这里优先实现 TCP（含 IPv4/IPv6）。UDP 没有类似 TCP state 的分布口径，因此暂不纳入。
//!
//! 权衡：
//! - 不做进程映射（PID→进程名）以降低复杂度与权限/性能风险
//! - 只统计 state 数量，避免暴露远端 IP 等隐私信息

#![cfg(target_os = "windows")]

use std::{collections::BTreeMap, mem, ptr};

use windows_sys::Win32::{
    Foundation::ERROR_INSUFFICIENT_BUFFER,
    NetworkManagement::IpHelper::GetExtendedTcpTable,
    Networking::WinSock::{AF_INET, AF_INET6},
};

/// 连接状态计数（用于序列化给前端）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConnectionStateCount {
    pub state: String,
    pub count: u32,
}

/// TCP 连接统计（总数 + 状态分布）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ConnectionsSnapshot {
    pub total: u32,
    pub by_state: Vec<ConnectionStateCount>,
}

/// 采集 TCP 连接状态分布（IPv4+IPv6）。
pub fn get_connections_snapshot() -> Option<ConnectionsSnapshot> {
    let mut counts = BTreeMap::<String, u32>::new();
    let mut total = 0_u32;

    if let Some((t, map)) = collect_tcp_states(u32::from(AF_INET), 5) {
        total = total.saturating_add(t);
        merge_counts(&mut counts, map);
    }
    if let Some((t, map)) = collect_tcp_states(u32::from(AF_INET6), 5) {
        total = total.saturating_add(t);
        merge_counts(&mut counts, map);
    }

    if total == 0 && counts.is_empty() {
        return None;
    }

    let by_state = counts
        .into_iter()
        .map(|(state, count)| ConnectionStateCount { state, count })
        .collect::<Vec<_>>();

    Some(ConnectionsSnapshot { total, by_state })
}

fn merge_counts(target: &mut BTreeMap<String, u32>, incoming: BTreeMap<String, u32>) {
    for (state, count) in incoming {
        *target.entry(state).or_insert(0) = target
            .get(&state)
            .copied()
            .unwrap_or(0)
            .saturating_add(count);
    }
}

/// 使用 GetExtendedTcpTable 读取 TCP 连接表，并统计 state 分布。
///
/// `table_class` 选择 OWNER_PID_ALL（5），即使我们不使用 PID，也能保证表结构一致。
fn collect_tcp_states(
    address_family: u32,
    table_class: i32,
) -> Option<(u32, BTreeMap<String, u32>)> {
    // 两次调用：先取 buffer size，再实际读取。
    let mut size: u32 = 0;
    let ret = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut size as *mut u32,
            0,
            address_family,
            table_class,
            0,
        )
    };
    if ret != ERROR_INSUFFICIENT_BUFFER || size == 0 {
        return None;
    }

    let mut buf = vec![0_u8; size as usize];
    let ret = unsafe {
        GetExtendedTcpTable(
            buf.as_mut_ptr() as _,
            &mut size as *mut u32,
            0,
            address_family,
            table_class,
            0,
        )
    };
    if ret != 0 {
        return None;
    }

    // 表结构：DWORD dwNumEntries; Row[dwNumEntries]
    if buf.len() < mem::size_of::<u32>() {
        return None;
    }

    let count = unsafe { *(buf.as_ptr() as *const u32) } as usize;
    let mut counts = BTreeMap::<String, u32>::new();

    // 这里不依赖具体 Row struct（IPv4/IPv6 不同），只读取 state 字段的 DWORD。
    // OWNER_PID_ALL 的行结构：state 在行首（dwState），因此用偏移 0 读取。
    let row_size = if address_family == u32::from(AF_INET) {
        // MIB_TCPROW_OWNER_PID: 24 bytes (state + 4 DWORDs + pid)
        24
    } else {
        // MIB_TCP6ROW_OWNER_PID: 56 bytes (state + local/remote addr/port + pid)
        56
    };

    let mut total = 0_u32;
    let base = mem::size_of::<u32>();
    for i in 0..count {
        let offset = base + i * row_size;
        if offset + 4 > buf.len() {
            break;
        }
        let state = unsafe { *(buf.as_ptr().add(offset) as *const u32) };
        let state_name = tcp_state_name(state).to_string();
        *counts.entry(state_name).or_insert(0) += 1;
        total += 1;
    }

    Some((total, counts))
}

fn tcp_state_name(state: u32) -> &'static str {
    // https://learn.microsoft.com/en-us/windows/win32/api/tcpmib/ns-tcpmib-mib_tcprow
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RECEIVED",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT_1",
        7 => "FIN_WAIT_2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNKNOWN",
    }
}

