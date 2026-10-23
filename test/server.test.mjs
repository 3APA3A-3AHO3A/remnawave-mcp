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
                uuid: 'n1', name: 'NL-1', countryCode: 'NL', address: '5.6.7.8', proxyUrl: `socks5://u:${SECRETS.proxyPass}@10.0.0.1:1080`, isConnected: false, isDisabled: false, usersOnline: 0,
                lastStatusMessage: 'timeout', trafficUsedBytes: 1073741824, versions: null, tags: [],
                configProfile: { activeConfigProfileUuid: 'c1', activeInbounds: [{ tag: 'VLESS', port: 443, network: 'raw', security: 'reality', type: 'vless' }] },
                system: { info: { cpus: 2, memoryTotal: 4 * 1073741824, hostname: 'vps-1', cpuModel: 'X'.repeat(3000), networkInterfaces: ['eth0'] }, stats: { memoryUsed: 1073741824, uptime: 86400, loadAvg: [0.1, 0.2, 0.3] } },
            }];
            if (path === '/api/system/stats/bandwidth') return { bandwidthLastTwoDays: {} };
            if (path.startsWith('/api/subscriptions')) return {
                isFound: true, links: [SECRETS.link], ssConfLinks: {}, subscriptionUrl: SECRETS.subUrl,
                user: { shortUuid: SECRETS.shortUuid, username: PII.username, expiresAt: '2026-10-01T00:00:00Z', userStatus: 'ACTIVE', daysLeft: 3 },
            };
            if (path.startsWith('/api/connections/geocheck/11111111-1111-4111-8111-111111111111')) return { jobId: 'j1' };
            if (path === '/api/connections/geocheck/j1') return { isCompleted: true, isFailed: false, result: { success: true, nodeUuid: 'n1', image: { data: 'x' }, rawReport: { ip: '5.6.7.8' } } };
            if (path.startsWith('/api/connections/geocheck/22222222-2222-4222-8222-222222222222')) return { jobId: 'j2' };
            if (path === '/api/connections/geocheck/j2') return { isCompleted: true, isFailed: false, result: { success: true, nodeUuid: 'n2', image: 'x', rawReport: geoReport() } };
            if (method === 'DELETE') return null; // the panel answers deletes with an empty body
            return { path };
        },
    };
}

function geoReport() {
    const hops = Array.from({ length: 12 }, (_, i) => ({ ttl: i + 1, addr: `10.0.0.${i}`, sent: 5, recv: 5, loss: 0, best_ms: 1, avg_ms: 1, worst_ms: 1 }));
    return {
        identity: { ipv4: '5.6.7.8', asn: 1, as_name: 'HOSTER' },
        reputation: { country_code: 'FI', vpn: false, hosting: false },
        geo: {
            services: [
                { id: 'google', name: 'Google', kind: 'country', ipv4: { value: 'RU', country: 'Russia' } },
                { id: 'reddit', name: 'Reddit', kind: 'country', ipv4: { error: 'blocked hosting range' } },
                { id: 'yt_premium', name: 'YouTube Premium', kind: 'availability', ipv4: { value: 'no' } },
            ],
            geoip: [{ id: 'maxmind', name: 'maxmind.com', kind: 'country', ipv4: { value: 'FI', country: 'Finland' } }],
        },
        connectivity_checks: {
            clean: false, ok: 1, altered: 1,
            endpoints: [
                { name: 'Google (Android)', verdict: 'ok', status: 204, expected_status: 204, rtt_ms: 40 },
                { name: 'Apple', verdict: 'altered', status: 302, expected_status: 200, body: '<html>portal</html>' },
            ],
        },
        stash_checks: [{ id: 'gemini', name: 'Gemini', state: 'blocked', region: 'RUS', detail: 'not offered in this country', rtt_ms: 200 }],
        ai_endpoints: [{ id: 'openai', name: 'OpenAI', state: 'reachable', http_status: 401, rtt_ms: 100 }],
        connectivity: {
            score: 83, latency_floor_ms: 7, breakdown: { direct: 1 },
            targets: [{ id: 'cf', name: 'cloudflare.com', verdict: 'transit', score: 88, rtt_ms: 7.7, loss: 0, hops, transits: [{ asn: 6762, name: 'Sparkle' }], notes: ['long note'] }],
        },
        future_section: { kept: true },
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
    for (const bad of ['login', 'get_node_secret_key', 'get_api_tokens', 'create_api_token', 'get_ott', 'create_ssh_ticket', 'evaluate_vault', 'get_api_token_scopes'])
        assert.ok(!names.includes(bad), `exposed: ${bad}`);
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
        ['get_subscription_by_username', { username: PII.username }],
        ['get_nodes', { full: true }],
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
    const first = JSON.parse((await call('geocheck_node', { nodeUuid: '11111111-1111-4111-8111-111111111111' })).text);
    assert.equal(first.result.image, '[svg omitted]');
    assert.equal(first.result.rawReport.ip, '5.6.7.8');
    const starts = log.filter((l) => l.method === 'POST').length;
    const second = JSON.parse((await call('geocheck_node', { nodeUuid: '11111111-1111-4111-8111-111111111111' })).text);
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

test('older panel (manual install): warning gives the npm command for that version', async () => {
    const { call } = await connect(undefined, '3.2.3');
    const { text } = await call('get_nodes', {});
    assert.match(text, /^⚠ Version mismatch: the panel is 3\.2\.3/);
    assert.match(text, /npm i @remnawave\/backend-contract@3\.2\.3 --save-exact/);
});

test('newer panel: warning suggests updating', async () => {
    const { call } = await connect(undefined, '9.1.0');
    const { text } = await call('get_nodes', {});
    assert.match(text, /Update remnawave-mcp in the server folder: git pull/);
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
    assert.match(d('add_users_to_internal_squad'), /ALL users/);
    assert.match(d('add_users_to_external_squad'), /ALL users/);
    assert.match(d('delete_users_from_internal_squad'), /ALL members/);
    assert.match(d('delete_users_from_external_squad'), /ALL members/);
    assert.match(d('plugin_executor'), /blockIps/);
});

test('path traversal through tool arguments is refused and never reaches the panel', async () => {
    const { call, log } = await connect();
    for (const [name, args] of [
        ['find_user', { id: '../tokens' }],
        ['find_user', { username: '..' }],
        ['geocheck_node', { nodeUuid: '../../nodes/actions/restart-all?' }],
        ['node_connections', { nodeUuid: '../../nodes/actions/restart-all?' }],
        ['user_connections', { userId: '../../users/bulk/revoke-subscription?' }],
        ['user_report', { id: '../../tokens' }],
    ]) {
        const before = log.length;
        const r = await call(name, args);
        assert.ok(r.isError, `${name} ${JSON.stringify(args)} should fail: ${r.text}`);
        assert.ok(log.slice(before).every((l) => !/tokens|actions|bulk/.test(l.path)), JSON.stringify(log.slice(before)));
    }
    assert.ok(!log.some((l) => l.method === 'POST'));
});

test('unknown arguments are refused instead of being passed to the panel', async () => {
    const { call, log } = await connect();
    const r = await call('get_users', { size: 1, bogus: 'x' });
    assert.ok(r.isError);
    assert.match(r.text, /bogus: unknown argument/);
    assert.ok(!log.some((l) => l.path === '/api/users/'));
    assert.ok(!(await call('get_nodes', { full: true })).isError);
});

test('HTTP client refuses "." / ".." path segments (last line of defence)', async () => {
    const { RemnawaveClient } = await import('../dist/client.js');
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => (calls.push(String(url)), new Response('{"response":{}}'));
    try {
        const c = new RemnawaveClient({ baseUrl: 'http://mock', headers: {}, timeoutMs: 0 });
        for (const p of ['/api/users/../tokens', '/api/users/%2e%2e/tokens', '/api/users/.']) await assert.rejects(c.request('GET', p), /Refusing/);
        await c.request('GET', '/api/users/5');
        assert.deepEqual(calls, ['http://mock/api/users/5']);
    } finally {
        globalThis.fetch = orig;
    }
});

// ---- several panels ----
async function connectMulti(versions = { main: CONTRACT, second: CONTRACT }, over = {}) {
    const logs = {};
    const clients = {};
    for (const [name, v] of Object.entries(versions)) {
        logs[name] = [];
        clients[name] = mockClient(logs[name], v);
    }
    const { server } = createServer({
        cfg: cfg(over), tools: buildRegistry(), extras: availableExtras(), serverVersion: 't', contractVersion: CONTRACT, clients,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args = {}) => {
        const r = await client.callTool({ name, arguments: args });
        return { text: r.content[0].text, isError: r.isError };
    };
    const body = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1));
    return { client, call, logs, body };
}

test('one panel: tool schemas have no "panel" argument and no list_panels', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.ok(tools.every((t) => !('panel' in (t.inputSchema.properties ?? {}))));
    assert.ok(!tools.some((t) => t.name === 'list_panels'));
});

test('several panels: every tool requires "panel" from the list of names, list_panels is added', async () => {
    const { client } = await connectMulti();
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'list_panels'));
    for (const t of tools.filter((x) => x.name !== 'list_panels')) {
        assert.deepEqual(t.inputSchema.properties.panel.enum, ['main', 'second'], t.name);
        assert.ok(t.inputSchema.required.includes('panel'), t.name);
    }
});

test('several panels: the request goes only to the chosen panel, the answer is labelled', async () => {
    const { call, logs, body } = await connectMulti();
    const r = await call('get_users', { panel: 'second', size: 5 });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /^\[panel: second\]\n/);
    assert.equal(body(r.text).total, 1);
    assert.ok(logs.second.some((l) => l.path === '/api/users/'));
    assert.ok(!logs.main.some((l) => l.path === '/api/users/'));
    assert.ok(!logs.second.find((l) => l.path === '/api/users/').query.panel, '"panel" must not reach the API');
});

test('several panels: missing or unknown panel is refused before any request', async () => {
    const { call, logs } = await connectMulti();
    const none = await call('get_nodes', {});
    assert.ok(none.isError);
    assert.match(none.text, /Specify the panel: panel is one of main, second/);
    const bad = await call('get_nodes', { panel: 'nope' });
    assert.ok(bad.isError);
    assert.match(bad.text, /Unknown panel "nope"/);
    assert.ok(!logs.main.some((l) => l.path === '/api/nodes/') && !logs.second.some((l) => l.path === '/api/nodes/'));
});

test('several panels: extras (panel_overview, find_user) work per panel, versions name the panel', async () => {
    const { call, logs, body } = await connectMulti();
    const o = body((await call('panel_overview', { panel: 'main' })).text);
    assert.equal(o.versions.panelName, 'main');
    const f = await call('find_user', { panel: 'second', telegramId: String(PII.telegramId) });
    assert.ok(!f.isError, f.text);
    assert.ok(logs.second.length > 0);
    assertNoLeak(assert, f.text, [...ALL_SECRETS, ...ALL_PII]);
});

test('several panels: node job cooldown is per panel', async (t) => {
    const { client, call, logs } = await connectMulti();
    if (!(await client.listTools()).tools.some((x) => x.name === 'geocheck_node')) return t.skip('no GeoCheck in this contract');
    const uuid = '11111111-1111-4111-8111-111111111111';
    await call('geocheck_node', { panel: 'main', nodeUuid: uuid });
    const other = await call('geocheck_node', { panel: 'second', nodeUuid: uuid });
    assert.ok(!/"cached":true/.test(other.text), 'same node uuid on another panel is another node');
    assert.equal(logs.second.filter((l) => l.method === 'POST').length, 1);
    const again = await call('geocheck_node', { panel: 'main', nodeUuid: uuid });
    assert.match(again.text, /"cached":true/);
});

test('several panels: version warning only for the panel with another version, list_panels shows versions', async () => {
    const { call } = await connectMulti({ main: CONTRACT, second: '3.2.3' });
    assert.ok(!(await call('get_nodes', { panel: 'main' })).text.includes('Version mismatch'));
    assert.match((await call('get_nodes', { panel: 'second' })).text, /^\[panel: second\]\n⚠ Version mismatch: the panel is 3\.2\.3/);
    assert.match((await call('get_nodes', { panel: 'second' })).text, /about panel "second" only/);
    const list = JSON.parse((await call('list_panels')).text);
    assert.deepEqual(list.panels.map((p) => [p.name, p.panelVersion]), [['main', CONTRACT], ['second', '3.2.3']]);
    assert.ok(list.panels[1].warning && !list.panels[0].warning);
});

test('several panels: pseudonyms still resolve, prompts get a panel argument', async () => {
    const { call, client, logs, body } = await connectMulti();
    const found = body((await call('find_user', { panel: 'main', telegramId: String(PII.telegramId) })).text);
    const r = await call('get_user_by_username', { panel: 'main', username: found.users[0].username });
    assert.ok(!r.isError, r.text);
    assert.ok(logs.main.some((l) => l.path === `/api/users/by-username/${PII.username}`));
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.every((p) => p.arguments.some((a) => a.name === 'panel')));
    const one = await client.getPrompt({ name: 'daily_summary', arguments: { panel: 'second' } });
    assert.match(one.messages[0].content.text, /panel "second" only/);
    const all = await client.getPrompt({ name: 'daily_summary', arguments: {} });
    assert.match(all.messages[0].content.text, /for each panel/);
});

test('unknown body fields are refused instead of being dropped silently', async () => {
    const { call, log } = await connect({ readonly: false });
    const uuid = '15f20d75-2140-4a9c-b6d5-3800f9139ace';
    const r = await call('update_host', { body: { uuid, bogusField: 1 } });
    assert.ok(r.isError);
    assert.match(r.text, /body\.bogusField: unknown field/);
    assert.ok(!log.some((l) => l.path === '/api/hosts/'));
    assert.ok(!(await call('update_host', { body: { uuid, remark: 'ok' } })).isError);
});

test('host and node ports must be 1-65535, the schema shows the range', async () => {
    const { client, call, log } = await connect({ readonly: false });
    const uuid = '15f20d75-2140-4a9c-b6d5-3800f9139ace';
    for (const port of [70000, 0, -1]) {
        const r = await call('update_host', { body: { uuid, port } });
        assert.ok(r.isError, `port ${port} accepted`);
        assert.match(r.text, /body\.port: must be an integer from 1 to 65535/);
    }
    assert.ok(!log.some((l) => l.path === '/api/hosts/'));
    assert.ok(!(await call('update_host', { body: { uuid, port: 8443 } })).isError);
    const tools = (await client.listTools()).tools;
    for (const n of ['create_host', 'update_host', 'update_many_hosts', 'create_node']) {
        const port = tools.find((t) => t.name === n).inputSchema.properties.body.properties.port;
        assert.equal(port.minimum, 1, n);
        assert.equal(port.maximum, 65535, n);
    }
});

test('write calls with an empty panel answer say what was done', async () => {
    const { call } = await connect({ readonly: false });
    const uuid = '15f20d75-2140-4a9c-b6d5-3800f9139ace';
    const host = await call('delete_host', { uuid });
    assert.ok(!host.isError);
    assert.match(host.text, /"ok":\s*true/);
    assert.match(host.text, /DELETE \/api\/hosts\/:uuid/);
    assert.ok(host.text.includes(uuid));
    const snippet = await call('delete_snippet', { body: { name: 'mcp_test_snippet' } });
    assert.ok(snippet.text.includes('mcp_test_snippet'));
});

test('geocheck: compact report by default, raw with full: true, the cache keeps the raw report', async () => {
    const { call, log } = await connect();
    const nodeUuid = '22222222-2222-4222-8222-222222222222';
    const compactText = (await call('geocheck_node', { nodeUuid })).text;
    const rep = JSON.parse(compactText).result.rawReport;
    assert.ok(!compactText.includes('"hops"') && !compactText.includes('10.0.0.'), 'hops must be dropped');
    assert.deepEqual(rep.geo.services, { Google: 'RU', Reddit: 'error: blocked hosting range', 'YouTube Premium': 'no' });
    assert.deepEqual(rep.geo.geoip, { 'maxmind.com': 'FI' });
    assert.deepEqual(rep.connectivity_checks.problems, [{ name: 'Apple', verdict: 'altered', status: 302, expected_status: 200 }]);
    assert.equal(rep.stash_checks.Gemini, 'blocked, RUS, not offered in this country');
    assert.equal(rep.ai_endpoints.OpenAI, 'reachable');
    assert.deepEqual(rep.connectivity.targets, [{ name: 'cloudflare.com', verdict: 'transit', rttMs: 7.7, loss: 0, via: 'Sparkle' }]);
    assert.deepEqual(rep.future_section, { kept: true }, 'unknown sections pass through');
    assert.equal(rep.identity.ipv4, '5.6.7.8', 'node IP is our own infrastructure, not pseudonymized');
    const starts = log.filter((l) => l.method === 'POST').length;
    const raw = JSON.parse((await call('geocheck_node', { nodeUuid, full: true })).text);
    assert.equal(raw.cached, true);
    assert.equal(raw.result.result.rawReport.connectivity.targets[0].hops.length, 12, 'full: true returns the raw cached report');
    assert.equal(log.filter((l) => l.method === 'POST').length, starts, 'full: true does not start a new check');
    const again = (await call('geocheck_node', { nodeUuid })).text;
    assert.ok(JSON.parse(again).cached && !again.includes('"hops"'), 'cached answer is compact too');
    assert.ok(again.length < JSON.stringify(raw).length);
});
