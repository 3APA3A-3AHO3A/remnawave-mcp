import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';

function withEnv(env, fn) {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith('REMNAWAVE_') || k.startsWith('CF_')) delete process.env[k];
    Object.assign(process.env, env);
    try { return fn(); } finally { process.env = saved; }
}

test('defaults: read-only, strict privacy, /api suffix stripped', () => {
    const c = withEnv({ REMNAWAVE_BASE_URL: 'https://p.example.com/api/', REMNAWAVE_API_TOKEN: 't' }, loadConfig);
    assert.equal(c.readonly, true);
    assert.equal(c.privacy, 'strict');
    assert.equal(c.baseUrl, 'https://p.example.com');
    assert.equal(c.headers['X-Forwarded-Proto'], undefined);
});

test('empty strings from the Claude extension fall back to defaults', () => {
    const c = withEnv({ REMNAWAVE_BASE_URL: 'https://p', REMNAWAVE_API_TOKEN: 't', REMNAWAVE_PRIVACY: '', REMNAWAVE_READONLY: '', REMNAWAVE_API_KEY: '' }, loadConfig);
    assert.equal(c.privacy, 'strict');
    assert.equal(c.readonly, true);
    assert.equal(c.headers['X-Api-Key'], undefined);
});

test('direct http connection to the panel container adds proxy headers', () => {
    const c = withEnv({ REMNAWAVE_BASE_URL: 'http://remnawave:3000', REMNAWAVE_API_TOKEN: 't' }, loadConfig);
    assert.equal(c.headers['X-Forwarded-Proto'], 'https');
    assert.equal(c.headers['X-Forwarded-For'], '127.0.0.1');
});

test('extra headers from REMNAWAVE_HEADERS', () => {
    const c = withEnv({ REMNAWAVE_BASE_URL: 'https://p', REMNAWAVE_API_TOKEN: 't', REMNAWAVE_HEADERS: '{"X-Test":"1"}' }, loadConfig);
    assert.equal(c.headers['X-Test'], '1');
    assert.throws(() => withEnv({ REMNAWAVE_BASE_URL: 'https://p', REMNAWAVE_API_TOKEN: 't', REMNAWAVE_HEADERS: 'nope' }, loadConfig));
});

// ---- several panels ----
const P1 = { REMNAWAVE_BASE_URL: 'https://a.example.com', REMNAWAVE_API_TOKEN: 'ta' };

test('one panel: default name panel1, panels list has it', () => {
    const c = withEnv(P1, loadConfig);
    assert.deepEqual(c.panels.map((p) => p.name), ['panel1']);
    assert.equal(c.panels[0].baseUrl, c.baseUrl);
});

test('numbered panels: names, own token / API key / Cloudflare headers, order by number', () => {
    const c = withEnv({
        ...P1, REMNAWAVE_NAME: 'Main',
        REMNAWAVE_3_BASE_URL: 'https://c.example.com/api', REMNAWAVE_3_API_TOKEN: 'tc', REMNAWAVE_3_NAME: 'third',
        REMNAWAVE_2_BASE_URL: 'https://b.example.com', REMNAWAVE_2_API_TOKEN: 'tb', REMNAWAVE_2_API_KEY: 'kb',
        REMNAWAVE_2_CF_ACCESS_CLIENT_ID: 'cfid', REMNAWAVE_2_CF_ACCESS_CLIENT_SECRET: 'cfsec',
    }, loadConfig);
    assert.deepEqual(c.panels.map((p) => p.name), ['main', 'panel2', 'third']);
    assert.equal(c.panels[1].headers.Authorization, 'Bearer tb');
    assert.equal(c.panels[1].headers['X-Api-Key'], 'kb');
    assert.equal(c.panels[1].headers['CF-Access-Client-Id'], 'cfid');
    assert.equal(c.panels[0].headers['X-Api-Key'], undefined, 'panel 2 settings must not leak into panel 1');
    assert.equal(c.panels[2].baseUrl, 'https://c.example.com');
});

test('empty extension slots are skipped, half-filled ones are an error', () => {
    const c = withEnv({ ...P1, REMNAWAVE_2_BASE_URL: '', REMNAWAVE_2_API_TOKEN: '', REMNAWAVE_2_NAME: '', REMNAWAVE_3_BASE_URL: '', REMNAWAVE_3_API_TOKEN: '' }, loadConfig);
    assert.equal(c.panels.length, 1);
    assert.throws(() => withEnv({ ...P1, REMNAWAVE_2_BASE_URL: 'https://b' }, loadConfig), /REMNAWAVE_2_API_TOKEN is required/);
    assert.throws(() => withEnv({ ...P1, REMNAWAVE_2_API_TOKEN: 'x' }, loadConfig), /REMNAWAVE_2_BASE_URL is required/);
});

test('panel names: unique and safe', () => {
    assert.throws(() => withEnv({ ...P1, REMNAWAVE_NAME: 'x', REMNAWAVE_2_BASE_URL: 'https://b', REMNAWAVE_2_API_TOKEN: 't', REMNAWAVE_2_NAME: 'X' }, loadConfig), /Two panels are named "x"/);
    assert.throws(() => withEnv({ ...P1, REMNAWAVE_NAME: 'my panel' }, loadConfig), /REMNAWAVE_NAME must be/);
});

test('an unfilled extension placeholder counts as an empty slot', () => {
    const c = withEnv({ ...P1, REMNAWAVE_2_BASE_URL: '${user_config.base_url_2}', REMNAWAVE_2_API_TOKEN: '${user_config.api_token_2}' }, loadConfig);
    assert.equal(c.panels.length, 1);
});
