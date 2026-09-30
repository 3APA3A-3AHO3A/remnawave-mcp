// End-to-end: real MCP server + MCP client over an in-memory transport, panel API mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';
import { createServer } from '../dist/server.js';
import { buildRegistry } from '../dist/registry.js';
import { availableExtras } from '../dist/extras.js';
import { SECRETS, PII, user, configProfile, history, assertNoLeak } from './helpers.mjs';

function cfg(over = {}) {
    return {
        baseUrl: 'http://mock', headers: {}, readonly: true, privacy: 'strict', showSecrets: false,
        exclude: new Set(), include: null, maxResponseChars: 60000, compact: true, maxPageSize: 200,
        cooldown: { geocheck: 30, connections: 2 }, timeoutMs: 1000, ...over,
    };
}

function mockClient(log, panelVersion = '3.4.4') {
    return {
        async request(method, path, query, body) {
            log.push({ method, path, query, body });
            if (path === '/api/system/metadata') return { version: panelVersion };
            if (path === '/api/users/stream') return { users: [user()], nextCursor: null, hasMore: false };
            if (path.startsWith('/api/users/by-username/')) {
                if (decodeURIComponent(path.split('/').pop()) !== PII.username) throw new Error(`User ${decodeURIComponent(path.split('/').pop())} not found`);
                return user();
            }
            if (path === '/api/users/5') return user();
            if (path === '/api/users/') return { total: 1, users: [user()] };
            if (path === '/api/config-profiles/') return { total: 1, configProfiles: [configProfile()] };
            if (path === '/api/subscription-request-history/') return history();
            if (path === '/api/users/5/subscription-request-history') return history().records;
            if (path === '/api/hwid/devices/5') return { total: 1, devices: [{ hwid: PII.hwid, userAgent: `Happ/1/${PII.uaDevice}` }] };
            if (path.startsWith('/api/bandwidth-stats/users/5')) return { categories: [], sparklineData: [], topNodes: [] };
            if (path === '/api/hwid/devices/top-users') return { users: [{ userId: 5, username: PII.username, devicesCount: 7 }] };
            if (path === '/api/system/stats') return { users: { statusCounts: { ACTIVE: 1 }, totalUsers: 1 }, onlineStats: { onlineNow: 1 }, memory: { used: 1, total: 2 }, cpu: { cores: 4 } };
            if (path === '/api/nodes/') return [{
                uuid: 'n1', name: 'NL-1', countryCode: 'NL', address: '5.6.7.8', isConnected: false, isDisabled: false, usersOnline: 0,
                lastStatusMessage: 'timeout', trafficUsedBytes: 1073741824, versions: null, tags: [],
                configProfile: { activeConfigProfileUuid: 'c1', activeInbounds: [{ tag: 'VLESS', port: 443, network: 'raw', security: 'reality', type: 'vless' }] },
                system: { info: { cpus: 2, memoryTotal: 4 * 1073741824, hostname: 'vps-1', cpuModel: 'X'.repeat(3000), networkInterfaces: ['eth0'] }, stats: { memoryUsed: 1073741824, uptime: 86400, loadAvg: [0.1, 0.2, 0.3] } },
            }];
            if (path === '/api/system/stats/bandwidth') return { bandwidthLastTwoDays: {} };
            if (path.startsWith('/api/connections/geocheck/n1')) return { jobId: 'j1' };
            if (path === '/api/connections/geocheck/j1') return { isCompleted: true, isFailed: false, result: { success: true, nodeUuid: 'n1', image: { data: 'x' }, rawReport: { ip: '5.6.7.8' } } };
            return { path };
        },
    };
}

const CONTRACT = createRequire(import.meta.url)('@remnawave/backend-contract/package.json').version;

async function connect(over, panelVersion = CONTRACT) {
    const log = [];
    const { server } = createServer({
        cfg: cfg(over), tools: buildRegistry(), extras: availableExtras(), serverVersion: 't', contractVersion: CONTRACT, client: mockClient(log, panelVersion),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args = {}) => {
        const r = await client.callTool({ name, arguments: args });
        return { text: r.content[0].text, isError: r.isError };
    };
    return { client, call, log };
}

const ALL_SECRETS = Object.values(SECRETS);
const ALL_PII = [PII.username, PII.email, PII.telegramId, PII.description, PII.ip, PII.hwid, PII.uaDevice];

test('read-only by default: no write tools, no blocked or secret-only tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(tools.length > 50);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint));
    for (const bad of ['login', 'get_node_secret_key', 'get_api_tokens', 'create_api_token', 'get_ott', 'delete_user', 'update_user', 'get_connection_keys_by_user_id', 'get_raw_subscription_by_short_uuid'])
        assert.ok(!names.includes(bad), `exposed: ${bad}`);
    for (const good of ['panel_overview', 'user_report', 'sharing_suspects', 'find_user', 'get_nodes'])
        assert.ok(names.includes(good), `missing: ${good}`);
});

test('write mode still never exposes login / secrets / tokens', async () => {
    const { client } = await connect({ readonly: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('update_user'));
    for (const bad of ['login', 'get_node_secret_key', 'get_api_tokens', 'create_api_token', 'get_ott']) assert.ok(!names.includes(bad));
});

test('no leaks through any read tool response', async () => {
    const { call } = await connect();
    for (const [name, args] of [
        ['find_user', { telegramId: String(PII.telegramId) }],
        ['get_user_by_id', { userId: 5 }],
        ['get_users', { size: 10 }],
        ['get_config_profiles', {}],
        ['get_subscription_request_history', { size: 3 }],
        ['user_report', { id: 5 }],
        ['sharing_suspects', {}],
        ['panel_overview', {}],
    ]) {
        const { text, isError } = await call(name, args);
        assert.ok(!isError, `${name}: ${text}`);
        assertNoLeak(assert, text, [...ALL_SECRETS, ...ALL_PII]);
    }
});

test('control: with privacy off the same data IS visible (the leak test is not vacuous)', async () => {
    const { call } = await connect({ privacy: 'off', showSecrets: true });
    const { text } = await call('get_user_by_id', { userId: 5 });
    assert.ok(text.includes(PII.username) && text.includes(SECRETS.vlessUuid));
});

test('pseudonym round trip: tool argument is resolved locally', async () => {
    const { call, log } = await connect();
    const found = JSON.parse((await call('find_user', { telegramId: String(PII.telegramId) })).text);
    const pseudo = found.users[0].username;
    assert.match(pseudo, /^user~/);
    const r = await call('get_user_by_username', { username: pseudo });
    assert.ok(!r.isError, r.text);
    assert.ok(log.some((l) => l.path === `/api/users/by-username/${PII.username}`));
});

test('error messages are scrubbed', async () => {
    const { call } = await connect();
    await call('find_user', { telegramId: String(PII.telegramId) });
    // the panel error quotes the requested name, which contains a known real username
    const r = await call('get_user_by_username', { username: `${PII.username}_2` });
    assert.ok(r.isError);
    assert.match(r.text, /not found/);
    assertNoLeak(assert, r.text, [PII.username]);
});

test('page size is capped before reaching the panel', async () => {
    const { call, log } = await connect();
    await call('get_users', { size: 1000 });
    assert.equal(log.find((l) => l.path === '/api/users/').query.size, 200);
});

test('geocheck: cooldown returns cached result, node IPs are not pseudonymized, image dropped', async (t) => {
    const { client, call, log } = await connect();
    if (!(await client.listTools()).tools.some((x) => x.name === 'geocheck_node'))
        return t.skip('GeoCheck is not in this contract version (added in Remnawave 3.4)');
    const first = JSON.parse((await call('geocheck_node', { nodeUuid: 'n1' })).text);
    assert.equal(first.result.image, '[svg omitted]');
    assert.equal(first.result.rawReport.ip, '5.6.7.8');
    const starts = log.filter((l) => l.method === 'POST').length;
    const second = JSON.parse((await call('geocheck_node', { nodeUuid: 'n1' })).text);
    assert.equal(second.cached, true);
    assert.equal(log.filter((l) => l.method === 'POST').length, starts);
});

test('panel_overview marks offline nodes', async () => {
    const { call } = await connect();
    const o = JSON.parse((await call('panel_overview', {})).text);
    assert.deepEqual(o.offlineNodes, ['NL-1']);
    assert.equal(o.versions.panel, CONTRACT);
    assert.equal(o.nodes[0].trafficUsedGb, 1);
});

test('prompts are listed and rendered', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'daily_summary'));
    const p = await client.getPrompt({ name: 'client_review', arguments: { user: '5' } });
    assert.match(p.messages[0].content.text, /user_report/);
});

test('same panel version: no warning', async () => {
    const { call } = await connect();
    const { text } = await call('panel_overview', {});
    assert.ok(!text.includes('Version mismatch'));
});

test('older panel: warning points to the right build', async () => {
    const { call } = await connect(undefined, '3.2.3');
    const { text } = await call('get_nodes', {});
    assert.match(text, /^⚠ Version mismatch: the panel is 3\.2\.3/);
    assert.match(text, /remnawave-3\.2\.mcpb/);
});

test('newer panel: warning suggests updating', async () => {
    const { call } = await connect(undefined, '9.1.0');
    const { text } = await call('get_nodes', {});
    assert.match(text, /Update remnawave-mcp/);
});

test('get_nodes: compact by default, raw with full: true', async () => {
    const { call } = await connect();
    const compact = JSON.parse((await call('get_nodes', {})).text);
    assert.deepEqual(compact[0].inbounds, ['VLESS']);
    assert.equal(compact[0].state, 'OFFLINE');
    assert.equal(compact[0].server.memTotalGb, 4);
    const rawText = (await call('get_nodes', { full: true })).text;
    assert.ok(rawText.length > JSON.stringify(compact).length * 3);
    assert.ok(JSON.parse(rawText)[0].system.info.hostname);
});

test('write tools carry warnings only in write mode', async () => {
    const ro = (await (await connect()).client.listTools()).tools;
    assert.ok(ro.every((t) => !t.description.includes('⚠')));
    const rw = (await (await connect({ readonly: false })).client.listTools()).tools;
    const d = (n) => rw.find((t) => t.name === n).description;
    assert.match(d('update_config_profile'), /REPLACES the whole Xray config/);
    assert.match(d('bulk_all_extend_expiration_date'), /ALL users/);
    assert.match(d('delete_user'), /Irreversible/);
    assert.match(d('update_user'), /confirm with the user/);
});
