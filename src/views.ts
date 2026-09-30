/**
 * Short views of big panel responses. The raw node object is ~4 KB (system info, every inbound
 * in full, provider, plugin…) — the compact one keeps what is needed to answer questions about
 * nodes. The tool gets a `full: true` parameter to return the raw response when really needed.
 */

type Obj = Record<string, unknown>;
const GB = 1024 ** 3;
const gb = (b: unknown) => (typeof b === 'number' ? Math.round((b / GB) * 100) / 100 : undefined);

export function compactNode(n: Obj): Obj {
    const sys = (n.system ?? {}) as Obj;
    const info = (sys.info ?? {}) as Obj;
    const stats = (sys.stats ?? {}) as Obj;
    const versions = (n.versions ?? {}) as Obj;
    const cp = (n.configProfile ?? {}) as Obj;
    return {
        uuid: n.uuid,
        name: n.name,
        country: n.countryCode,
        address: n.address,
        port: n.port,
        state: n.isDisabled ? 'disabled' : n.isConnected ? 'online' : n.isConnecting ? 'connecting' : 'OFFLINE',
        lastStatusMessage: n.isConnected ? undefined : n.lastStatusMessage,
        lastStatusChange: n.lastStatusChange,
        usersOnline: n.usersOnline,
        trafficUsedGb: gb(n.trafficUsedBytes),
        trafficLimitGb: gb(n.trafficLimitBytes) || undefined,
        trafficResetDay: n.trafficResetDay,
        consumptionMultiplier: n.consumptionMultiplier,
        tags: Array.isArray(n.tags) && n.tags.length ? n.tags : undefined,
        inbounds: Array.isArray(cp.activeInbounds) ? (cp.activeInbounds as Obj[]).map((i) => i.tag) : undefined,
        configProfileUuid: cp.activeConfigProfileUuid,
        provider: (n.provider as Obj | null)?.name,
        xray: versions.xray,
        node: versions.node,
        xrayUptimeHours: typeof n.xrayUptime === 'number' ? Math.round(n.xrayUptime / 36) / 100 : undefined,
        server: sys.info
            ? {
                  cpus: info.cpus,
                  memTotalGb: gb(info.memoryTotal),
                  memUsedGb: gb(stats.memoryUsed),
                  load: stats.loadAvg,
                  uptimeDays: typeof stats.uptime === 'number' ? Math.round(stats.uptime / 864) / 100 : undefined,
              }
            : undefined,
        note: n.note,
    };
}

/** tool name → compact view of its response */
export const VIEWS: Record<string, (data: unknown) => unknown> = {
    get_nodes: (d) => (Array.isArray(d) ? d.map((n) => compactNode(n as Obj)) : d),
    get_node: (d) => (d && typeof d === 'object' && !Array.isArray(d) ? compactNode(d as Obj) : d),
};
