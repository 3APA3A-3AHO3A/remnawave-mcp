import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, loadHttpConfig } from '../dist/http.js';
import { createServer } from '../dist/server.js';
import { PII, user } from './helpers.mjs';

const token = 'http-test-token';
const auth = { Authorization: 'Bearer ' + token };
const cfg = {
    baseUrl: 'http://mock', headers: {}, readonly: true, privacy: 'strict', showSecrets: false,
    exclude: new Set(), include: null, maxResponseChars: 60000, compact: true, maxPageSize: 200,
    cooldown: { geocheck: 30, connections: 2 }, timeoutMs: 1000,
};

async function fixture(t) {
    let runs = 0;
    const listener = createHttpServer({ host: '127.0.0.1', port: 0, token }, () => createServer({
        cfg, tools: [], serverVersion: 'test', contractVersion: '3.4.11',
        client: { async request() { return { version: '3.4.11' }; } },
        extras: [{
            name: 'lookup', description: 'Mock lookup', requires: [],
            inputSchema: { type: 'object', properties: { username: { type: 'string' } } },
            async run(_client, args) {
                if (args.username && args.username !== PII.username) throw new Error('Unknown user');
                return { users: [user()] };
            },
        }, {
            name: 'job', description: 'Mock job', requires: [],
            inputSchema: { type: 'object', properties: {} },
            cooldown: { kind: 'geocheck', key: () => 'same-node' },
            async run() { return { run: ++runs }; },
        }],
    }).server);
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
    });
    const url = 'http://127.0.0.1:' + listener.address().port + '/mcp';
    const request = (method, headers = {}, body) => fetch(url, {
        method, headers: { Accept: 'application/json, text/event-stream', ...headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } };
    async function session() {
        const res = await request('POST', auth, initialize);
        assert.equal(res.status, 200);
        const id = res.headers.get('mcp-session-id');
        assert.ok(id);
        const { result } = await res.json();
        const headers = { ...auth, 'Mcp-Session-Id': id, 'MCP-Protocol-Version': result.protocolVersion };
        const ready = await request('POST', headers, { jsonrpc: '2.0', method: 'notifications/initialized' });
        assert.equal(ready.status, 202);
        let seq = 1;
        return { id, headers, async call(name, args = {}) {
            const response = await request('POST', headers, {
                jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args },
            });
            assert.equal(response.status, 200);
            return (await response.json()).result;
        } };
    }
    return { url, request, initialize, session };
}

test('HTTP config is opt-in and requires a separate key', () => {
    assert.throws(() => loadHttpConfig({}), /HTTP_TOKEN/);
    assert.throws(() => loadHttpConfig({ REMNAWAVE_HTTP_TOKEN: token, REMNAWAVE_HTTP_PORT: '0' }), /HTTP_PORT/);
    assert.deepEqual(loadHttpConfig({ REMNAWAVE_HTTP_TOKEN: token }), { host: '127.0.0.1', port: 3001, token });
    const env = { ...process.env, REMNAWAVE_TRANSPORT: 'http' };
    delete env.REMNAWAVE_HTTP_TOKEN;
    const result = spawnSync(process.execPath, ['dist/index.js'], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HTTP_TOKEN/);
});

test('HTTP rejects missing/wrong auth, including GET and DELETE on an existing session', async (t) => {
    const { request, initialize, session } = await fixture(t);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
        const res = await request('POST', headers, initialize);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        await res.text();
    }
    const a = await session();
    for (const method of ['GET', 'DELETE']) {
        const res = await request(method, { 'Mcp-Session-Id': a.id });
        assert.equal(res.status, 401);
        await res.text();
    }
    const origin = await request('POST', { ...auth, Origin: 'https://untrusted.example' }, initialize);
    assert.equal(origin.status, 403);
    await origin.text();
    const unknown = await request('POST', { ...auth, 'Mcp-Session-Id': 'unknown' }, initialize);
    assert.equal(unknown.status, 404);
    await unknown.text();
    const deleted = await request('DELETE', a.headers);
    assert.equal(deleted.status, 200);
    await deleted.text();
    const gone = await request('POST', a.headers, initialize);
    assert.equal(gone.status, 404);
    await gone.text();
});

test('HTTP sessions isolate pseudonym maps and node-job caches', async (t) => {
    const { session } = await fixture(t);
    const a = await session();
    const b = await session();
    assert.notEqual(a.id, b.id);
    const data = (r) => JSON.parse(r.content[0].text);
    const pseudo = data(await a.call('lookup')).users[0].username;
    assert.match(pseudo, /^user~/);
    assert.notEqual(data(await b.call('lookup')).users[0].username, pseudo);
    assert.equal((await a.call('lookup', { username: pseudo })).isError, undefined);
    assert.equal((await b.call('lookup', { username: pseudo })).isError, true);
    assert.equal(data(await a.call('job')).run, 1);
    assert.equal(data(await a.call('job')).cached, true);
    assert.equal(data(await b.call('job')).run, 2);
    assert.equal(data(await b.call('job')).cached, true);
});

test('a standard MCP SDK client can discover and call tools over HTTP', async (t) => {
    const { url } = await fixture(t);
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: auth },
    });
    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        assert.ok(tools.some((tool) => tool.name === 'lookup'));
        const result = await client.callTool({ name: 'lookup', arguments: {} });
        assert.match(JSON.parse(result.content[0].text).users[0].username, /^user~/);
        await transport.terminateSession();
    } finally {
        await client.close();
    }
});

test('HTTP rejects malformed JSON and oversized request bodies', async (t) => {
    const { url, request, initialize } = await fixture(t);
    const headers = { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const malformed = await fetch(url, { method: 'POST', headers, body: '{' });
    assert.equal(malformed.status, 400);
    await malformed.text();
    const oversized = await request('POST', auth, { ...initialize, padding: 'x'.repeat(1024 * 1024) });
    assert.equal(oversized.status, 413);
    await oversized.text();
});
