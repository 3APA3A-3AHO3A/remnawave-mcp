import * as contract from '@remnawave/backend-contract';
import type { RemnawaveClient } from './client.js';

/**
 * Convenience tools on top of the raw API:
 * - background jobs (connections, GeoCheck) are started and polled in one call;
 * - user lookup by any identifier, including Telegram ID and email
 *   (which disappeared as dedicated endpoints in Remnawave 3.x);
 * - ready-made reports that combine several API calls: panel_overview, user_report, sharing_suspects.
 */

export interface ExtraTool {
    name: string;
    /** contract commands this tool relies on; the tool is hidden if the installed contract lacks them */
    requires: string[];
    /** false — response is about our own infrastructure (node IPs), skip personal-data pseudonyms */
    userData?: boolean;
    /** job on a node: repeated calls for the same target within a cooldown return the cached result */
    cooldown?: { kind: 'geocheck' | 'connections'; key: (args: Record<string, unknown>) => string };
    description: string;
    inputSchema: Record<string, unknown>;
    run: (client: RemnawaveClient, args: Record<string, unknown>) => Promise<unknown>;
}

type Obj = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;
const gb = (bytes: unknown) => (typeof bytes === 'number' ? Math.round((bytes / GB) * 100) / 100 : undefined);
const day = (d: Date) => d.toISOString().slice(0, 10);

async function runJob(
    client: RemnawaveClient,
    startPath: string,
    resultPath: (jobId: string) => string,
    body: unknown,
    timeoutSec: number,
) {
    const started = (await client.request('POST', startPath, undefined, body)) as { jobId: string };
    const deadline = Date.now() + timeoutSec * 1000;
    let last: unknown = null;
    while (Date.now() < deadline) {
        await sleep(2000);
        last = await client.request('GET', resultPath(started.jobId));
        const r = last as { isCompleted?: boolean; isFailed?: boolean };
        if (r?.isCompleted || r?.isFailed) return last;
    }
    return { timeout: true, jobId: started.jobId, note: `No result after ${timeoutSec}s`, last };
}

/** Promise.allSettled → { ok: value } | { error } per key, so one 403 doesn't kill a whole report. */
async function settle<T extends Record<string, Promise<unknown>>>(parts: T) {
    const keys = Object.keys(parts);
    const res = await Promise.allSettled(Object.values(parts));
    const out: Record<string, unknown> = {};
    res.forEach((r, i) => {
        out[keys[i]] = r.status === 'fulfilled' ? r.value : { error: (r.reason as Error)?.message ?? String(r.reason) };
    });
    return out as { [K in keyof T]: unknown };
}

async function findUsers(client: RemnawaveClient, a: Obj): Promise<Obj[]> {
    if (a.id !== undefined || a.userId !== undefined)
        return [(await client.request('GET', `/api/users/${a.id ?? a.userId}`)) as Obj];
    if (a.username)
        return [(await client.request('GET', `/api/users/by-username/${encodeURIComponent(String(a.username))}`)) as Obj];
    if (a.shortUuid)
        return [(await client.request('GET', `/api/users/by-short-uuid/${encodeURIComponent(String(a.shortUuid))}`)) as Obj];
    const query: Obj = { size: 100 };
    if (a.telegramId) query.telegramId = String(a.telegramId);
    else if (a.email) query.email = a.email;
    else if (a.tag) query.tag = a.tag;
    else throw new Error('Pass one of: id, username, shortUuid, telegramId, email, tag');
    const r = (await client.request('GET', '/api/users/stream', query)) as { users: Obj[] };
    return r.users;
}

const uuidParam = (d: string) => ({ type: 'string', format: 'uuid', description: d });
const timeoutParam = {
    type: 'integer',
    minimum: 5,
    maximum: 120,
    default: 60,
    description: 'Max seconds to wait for the node to answer',
};
const userIdentProps = {
    id: { type: 'integer', description: 'Panel user ID' },
    username: { type: 'string', description: 'Username or its pseudonym (user~…)' },
    shortUuid: { type: 'string' },
    telegramId: { type: 'string', description: 'Telegram numeric ID or its pseudonym (tg~…)' },
    email: { type: 'string', description: 'E-mail or its pseudonym (email~…)' },
    tag: { type: 'string' },
};

export const extraTools: ExtraTool[] = [
    {
        name: 'find_user',
        requires: ['GetUsersStreamCommand', 'GetUserByIdCommand'],
        description:
            'Find users by any identifier: id, username, shortUuid, telegramId, email or tag. ' +
            'Returns full user objects. Use this instead of guessing which endpoint to call.',
        inputSchema: { type: 'object', properties: userIdentProps, additionalProperties: false },
        async run(client, a) {
            const users = await findUsers(client, a);
            return { users, count: users.length };
        },
    },
    {
        name: 'panel_overview',
        requires: ['GetStatsCommand', 'GetNodesCommand', 'GetUsersCommand'],
        description:
            'One-call panel summary: users by status and online, node list with online/offline state, ' +
            'users online and traffic per node, bandwidth (2 days / 7 days / month) and subscriptions expiring soon. ' +
            'Start here for "how is the panel doing" questions.',
        inputSchema: {
            type: 'object',
            properties: {
                expiringDays: { type: 'integer', minimum: 1, maximum: 60, default: 3, description: 'Look-ahead for expiring subscriptions' },
            },
            additionalProperties: false,
        },
        async run(client, a) {
            const days = Number(a.expiringDays ?? 3);
            const r = await settle({
                stats: client.request('GET', '/api/system/stats', { tz: 'UTC' }),
                nodes: client.request('GET', '/api/nodes/'),
                bandwidth: client.request('GET', '/api/system/stats/bandwidth', { tz: 'UTC' }),
                soon: client.request('GET', '/api/users/', {
                    start: 0,
                    size: 200,
                    filters: [{ id: 'status', value: 'ACTIVE' }],
                    sorting: [{ id: 'expireAt', desc: false }],
                }),
            });

            const nodes = Array.isArray(r.nodes)
                ? (r.nodes as Obj[]).map((n) => ({
                      name: n.name,
                      country: n.countryCode,
                      state: n.isDisabled ? 'disabled' : n.isConnected ? 'online' : 'OFFLINE',
                      usersOnline: n.usersOnline,
                      trafficUsedGb: gb(n.trafficUsedBytes),
                      trafficLimitGb: gb(n.trafficLimitBytes),
                      xray: (n.versions as Obj | null)?.xray,
                      lastStatusMessage: n.isConnected ? undefined : n.lastStatusMessage,
                      uuid: n.uuid,
                  }))
                : r.nodes;

            let expiring: unknown = r.soon;
            const soon = r.soon as { users?: Obj[] };
            if (soon?.users) {
                const limit = Date.now() + days * 86_400_000;
                const list = soon.users
                    .filter((u) => u.expireAt && new Date(String(u.expireAt)).getTime() <= limit)
                    .map((u) => ({ id: u.id, username: u.username, expireAt: u.expireAt, tag: u.tag }));
                expiring = { withinDays: days, count: list.length, users: list };
            }

            const stats = r.stats as Obj;
            return {
                users: stats?.users ?? stats,
                online: stats?.onlineStats,
                panelServer: stats?.memory
                    ? { cpuCores: (stats.cpu as Obj)?.cores, memUsedGb: gb((stats.memory as Obj).used), memTotalGb: gb((stats.memory as Obj).total) }
                    : undefined,
                nodes,
                offlineNodes: Array.isArray(nodes) ? (nodes as Obj[]).filter((n) => n.state === 'OFFLINE').map((n) => n.name) : undefined,
                bandwidth: r.bandwidth,
                expiring,
            };
        },
    },
    {
        name: 'user_report',
        requires: ['GetUserByIdCommand', 'GetUserHwidDevicesCommand', 'GetStatsUserUsageCommand'],
        description:
            'Everything about one client in one call: subscription and status, devices (HWID), traffic per day and per node ' +
            'for the last N days, recent subscription requests (apps, IP pseudonyms). Identify the user by id, username, ' +
            'telegramId, email, shortUuid or a pseudonym.',
        inputSchema: {
            type: 'object',
            properties: { ...userIdentProps, days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } },
            additionalProperties: false,
        },
        async run(client, a) {
            const users = await findUsers(client, a);
            if (users.length !== 1) return { note: `Found ${users.length} users, narrow the search`, users };
            const u = users[0];
            const id = u.id;
            const days = Number(a.days ?? 7);
            const end = new Date();
            const start = new Date(end.getTime() - (days - 1) * 86_400_000);
            const r = await settle({
                devices: client.request('GET', `/api/hwid/devices/${id}`),
                usage: client.request('GET', `/api/bandwidth-stats/users/${id}`, { start: day(start), end: day(end), topNodesLimit: 10 }),
                requests: client.request('GET', `/api/users/${id}/subscription-request-history`),
            });
            return { user: u, devices: r.devices, traffic: { days, ...(r.usage as Obj) }, recentRequests: r.requests };
        },
    },
    {
        name: 'sharing_suspects',
        requires: ['GetSubscriptionRequestHistoryCommand', 'GetTopUsersByHwidDevicesCommand'],
        description:
            'Find clients who probably share their subscription: many different IPs / apps in recent subscription ' +
            'requests, and top users by number of HWID devices. Only counts and pseudonyms are returned. ' +
            'Cheap: reads panel history, does not touch the nodes.',
        inputSchema: {
            type: 'object',
            properties: {
                records: { type: 'integer', minimum: 100, maximum: 1000, default: 1000, description: 'How many latest subscription requests to analyse' },
                minIps: { type: 'integer', minimum: 2, default: 4, description: 'Flag users with at least this many distinct IPs' },
            },
            additionalProperties: false,
        },
        async run(client, a) {
            const size = Number(a.records ?? 1000);
            const minIps = Number(a.minIps ?? 4);
            const r = await settle({
                history: client.request('GET', '/api/subscription-request-history/', { start: 0, size }),
                hwidTop: client.request('GET', '/api/hwid/devices/top-users', { start: 0, size: 20 }),
            });
            const records = ((r.history as { records?: Obj[] })?.records ?? []).filter(
                (x) => !/exporter|monitor|uptime|curl|wget|bot/i.test(String(x.userAgent ?? '')),
            );
            const by = new Map<unknown, { ips: Set<unknown>; apps: Set<string>; requests: number; first: string; last: string }>();
            for (const x of records) {
                const e = by.get(x.userId) ?? { ips: new Set(), apps: new Set(), requests: 0, first: String(x.requestAt), last: String(x.requestAt) };
                e.ips.add(x.requestIp);
                e.apps.add(String(x.userAgent ?? '').split('/')[0] || '?');
                e.requests++;
                if (String(x.requestAt) < e.first) e.first = String(x.requestAt);
                if (String(x.requestAt) > e.last) e.last = String(x.requestAt);
                by.set(x.userId, e);
            }
            const byIps = [...by.entries()]
                .filter(([, e]) => e.ips.size >= minIps)
                .map(([userId, e]) => ({ userId, distinctIps: e.ips.size, apps: [...e.apps], requests: e.requests, period: `${e.first} … ${e.last}` }))
                .sort((x, y) => y.distinctIps - x.distinctIps)
                .slice(0, 30);
            const period = records.length ? `${records[records.length - 1].requestAt} … ${records[0].requestAt}` : undefined;
            return {
                analysedRequests: records.length,
                period,
                note: 'Many IPs can also be mobile internet or travel; treat as a hint, check devices in user_report.',
                byDistinctIps: byIps,
                topByHwidDevices: r.hwidTop,
            };
        },
    },
    {
        name: 'geocheck_node',
        requires: ['GeocheckByNodeCommand', 'GeocheckByNodeResultCommand'],
        userData: false,
        cooldown: { kind: 'geocheck', key: (a) => `geo:${a.nodeUuid}:${a.ip ?? ''}:${a.interface ?? ''}` },
        description:
            'Run GeoCheck on a node and wait for the result (how services see the node IP: country, blocks). ' +
            'The base64 SVG image is dropped, only the raw report is returned. Uses node traffic: repeated calls for ' +
            'the same node within the cooldown return the previous result.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeUuid: uuidParam('Node UUID (see get_nodes / panel_overview)'),
                ip: { type: 'string', description: 'Optional: check from this outbound IP' },
                interface: { type: 'string', description: 'Optional: check from this network interface' },
                timeoutSec: timeoutParam,
            },
            required: ['nodeUuid'],
            additionalProperties: false,
        },
        async run(client, a) {
            const body: Obj = {};
            if (a.ip) body.ip = a.ip;
            if (a.interface) body.interface = a.interface;
            const r = (await runJob(
                client,
                `/api/connections/geocheck/${a.nodeUuid}`,
                (id) => `/api/connections/geocheck/${id}`,
                body,
                Number(a.timeoutSec ?? 60),
            )) as { result?: { image?: unknown } | null };
            if (r?.result && 'image' in r.result) r.result.image = r.result.image ? '[svg omitted]' : null;
            return r;
        },
    },
    {
        name: 'node_connections',
        requires: ['ConnectionsByNodeCommand', 'ConnectionsByNodeResultCommand'],
        cooldown: { kind: 'connections', key: (a) => `node:${a.nodeUuid}` },
        description: 'Get users currently connected to a node with their IPs and last-seen time (starts a job and waits).',
        inputSchema: {
            type: 'object',
            properties: { nodeUuid: uuidParam('Node UUID'), timeoutSec: timeoutParam },
            required: ['nodeUuid'],
            additionalProperties: false,
        },
        run: (client, a) =>
            runJob(client, `/api/connections/by-node/${a.nodeUuid}`, (id) => `/api/connections/by-node/${id}`, undefined, Number(a.timeoutSec ?? 60)),
    },
    {
        name: 'user_connections',
        requires: ['ConnectionsByUserCommand', 'ConnectionsByUserResultCommand'],
        cooldown: { kind: 'connections', key: (a) => `user:${a.userId}` },
        description: "Get a user's current connections (IPs per node) — starts a job and waits for the result.",
        inputSchema: {
            type: 'object',
            properties: { userId: { type: 'integer', description: 'User numeric ID' }, timeoutSec: timeoutParam },
            required: ['userId'],
            additionalProperties: false,
        },
        run: (client, a) =>
            runJob(client, `/api/connections/by-user/${a.userId}`, (id) => `/api/connections/by-user/${id}`, undefined, Number(a.timeoutSec ?? 60)),
    },
];

/** Extra tools supported by the installed contract version. */
export function availableExtras(): ExtraTool[] {
    const c = contract as Record<string, unknown>;
    return extraTools.filter((e) => e.requires.every((r) => r in c));
}
