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

/**
 * GeoCheck report without the traceroutes: the raw report is ~45 KB (every hop to ~20 sites), the compact one
 * keeps what answers "how do services see this node": identity, reputation, country per service/GeoIP base,
 * connectivity and blocks, and one line per route target (verdict, latency, loss, transit).
 * Unknown parts of the report pass through unchanged, so a newer node version loses nothing.
 */
const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** [{name, ipv4: {value, country} | {error}}] → { name: "FI" | "yes" | "error: …" } */
function byName(list: unknown): unknown {
    if (!Array.isArray(list)) return list;
    return Object.fromEntries(
        list.map((x: Obj) => {
            const v = (x?.ipv4 ?? {}) as Obj;
            const val = v.value ?? (v.error ? `error: ${String(v.error)}` : null);
            return [String(x?.name ?? x?.id), val];
        }),
    );
}

export function compactGeoReport(rep: Obj): Obj {
    const out: Obj = {};
    for (const [k, v] of Object.entries(rep)) {
        const o = (v ?? {}) as Obj;
        switch (k) {
            case 'geo':
                out.geo = Object.fromEntries(Object.entries(o).map(([g, list]) => [g, byName(list)]));
                break;
            case 'connectivity_checks': {
                const eps = Array.isArray(o.endpoints) ? (o.endpoints as Obj[]) : [];
                out[k] = {
                    ...pick(o, ['clean', 'plain_http_blocked', 'ok', 'captive_portal', 'altered', 'unreachable']),
                    problems: eps.filter((e) => e.verdict !== 'ok').map((e) => pick(e, ['name', 'verdict', 'status', 'expected_status'])),
                };
                break;
            }
            case 'stash_checks':
            case 'ai_endpoints':
                out[k] = Array.isArray(v)
                    ? Object.fromEntries(
                          (v as Obj[]).map((x) => [String(x.name ?? x.id), [x.state, x.region, x.detail].filter(Boolean).join(', ')]),
                      )
                    : v;
                break;
            case 'connectivity':
                out[k] = {
                    ...pick(o, ['score', 'latency_floor_ms', 'breakdown']),
                    targets: Array.isArray(o.targets)
                        ? (o.targets as Obj[]).map((t) => ({
                              name: t.name,
                              verdict: t.verdict,
                              rttMs: t.rtt_ms,
                              loss: t.loss,
                              ...(Array.isArray(t.transits) && t.transits.length
                                  ? { via: (t.transits as Obj[]).map((x) => x.name).join(', ') }
                                  : {}),
                          }))
                        : o.targets,
                };
                break;
            default:
                out[k] = v;
        }
    }
    return out;
}

/** geocheck_node answer (job result or a cached wrapper around it) with a compact report. */
export function compactGeocheck(data: unknown): unknown {
    const d = data as Obj | null;
    if (!d || typeof d !== 'object') return data;
    if (d.cached && d.result) return { ...d, result: compactGeocheck(d.result) };
    const r = d.result as Obj | null | undefined;
    if (!r || typeof r !== 'object' || !r.rawReport || typeof r.rawReport !== 'object') return data;
    return { ...d, result: { ...r, rawReport: compactGeoReport(r.rawReport as Obj) } };
}
