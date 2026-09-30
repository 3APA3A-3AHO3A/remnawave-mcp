import type { RemnawaveClient } from './client.js';

/**
 * Convenience tools on top of the raw API:
 * - background jobs (connections, GeoCheck) are started and polled in one call;
 * - user lookup by any identifier, including Telegram ID and email
 *   (which disappeared as dedicated endpoints in Remnawave 3.x).
 */

export interface ExtraTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run: (client: RemnawaveClient, args: Record<string, unknown>) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const uuidParam = (d: string) => ({ type: 'string', format: 'uuid', description: d });
const timeoutParam = {
    type: 'integer',
    minimum: 5,
    maximum: 120,
    default: 60,
    description: 'Max seconds to wait for the node to answer',
};

export const extraTools: ExtraTool[] = [
    {
        name: 'find_user',
        description:
            'Find users by any identifier: id, username, shortUuid, telegramId, email or tag. ' +
            'Returns full user objects. Use this instead of guessing which endpoint to call.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                username: { type: 'string' },
                shortUuid: { type: 'string' },
                telegramId: { type: 'string', description: 'Telegram numeric ID' },
                email: { type: 'string' },
                tag: { type: 'string' },
            },
            additionalProperties: false,
        },
        async run(client, a) {
            if (a.id !== undefined) return [await client.request('GET', `/api/users/${a.id}`)];
            if (a.username) return [await client.request('GET', `/api/users/by-username/${encodeURIComponent(String(a.username))}`)];
            if (a.shortUuid) return [await client.request('GET', `/api/users/by-short-uuid/${encodeURIComponent(String(a.shortUuid))}`)];
            const query: Record<string, unknown> = { size: 100 };
            if (a.telegramId) query.telegramId = String(a.telegramId);
            else if (a.email) query.email = a.email;
            else if (a.tag) query.tag = a.tag;
            else throw new Error('Pass one of: id, username, shortUuid, telegramId, email, tag');
            const r = (await client.request('GET', '/api/users/stream', query)) as { users: unknown[]; hasMore: boolean };
            return { users: r.users, hasMore: r.hasMore };
        },
    },
    {
        name: 'geocheck_node',
        description:
            'Run GeoCheck on a node and wait for the result (how services see the node IP: country, blocks). ' +
            'The base64 SVG image is dropped, only the raw report is returned. Uses a bit of node traffic.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeUuid: uuidParam('Node UUID (see get_nodes)'),
                ip: { type: 'string', description: 'Optional: check from this outbound IP' },
                interface: { type: 'string', description: 'Optional: check from this network interface' },
                timeoutSec: timeoutParam,
            },
            required: ['nodeUuid'],
            additionalProperties: false,
        },
        async run(client, a) {
            const body: Record<string, unknown> = {};
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
        description: 'Get users currently connected to a node with their IPs and last-seen time (starts a job and waits).',
        inputSchema: {
            type: 'object',
            properties: { nodeUuid: uuidParam('Node UUID'), timeoutSec: timeoutParam },
            required: ['nodeUuid'],
            additionalProperties: false,
        },
        run: (client, a) =>
            runJob(
                client,
                `/api/connections/by-node/${a.nodeUuid}`,
                (id) => `/api/connections/by-node/${id}`,
                undefined,
                Number(a.timeoutSec ?? 60),
            ),
    },
    {
        name: 'user_connections',
        description: "Get a user's current connections (IPs per node) — starts a job and waits for the result.",
        inputSchema: {
            type: 'object',
            properties: { userId: { type: 'integer', description: 'User numeric ID' }, timeoutSec: timeoutParam },
            required: ['userId'],
            additionalProperties: false,
        },
        run: (client, a) =>
            runJob(
                client,
                `/api/connections/by-user/${a.userId}`,
                (id) => `/api/connections/by-user/${id}`,
                undefined,
                Number(a.timeoutSec ?? 60),
            ),
    },
];
