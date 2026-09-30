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
