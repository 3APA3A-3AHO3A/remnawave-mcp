import test from 'node:test';
import assert from 'node:assert/strict';
import { Privacy } from '../dist/redact.js';
import { SECRETS, PII, user, configProfile, history, assertNoLeak } from './helpers.mjs';

const all = (o) => Object.values(o);

test('strict: no secrets and no personal data in a user object', () => {
    const out = JSON.stringify(new Privacy('strict').apply({ users: [user()] }));
    assertNoLeak(assert, out, [...all(SECRETS), PII.username, PII.email, PII.telegramId, PII.description]);
    assert.match(out, /user~[0-9a-f]{6}/);
    assert.match(out, /"id":5/);
    assert.match(out, /"tag":"VIP"/);
});

test('strict: config profiles hide keys, shortIds and passwords but keep geoip rules and public key', () => {
    const out = JSON.stringify(new Privacy('strict').apply(configProfile()));
    assertNoLeak(assert, out, [SECRETS.privateKey, SECRETS.shortId, SECRETS.realityPassword, SECRETS.salamander]);
    assert.ok(out.includes('geoip:private') && out.includes('geoip:telegram'));
    assert.ok(out.includes('PUBLIC_OK'));
    assert.ok(out.includes('"shortIds":["","[hidden]"]'));
});

test('strict: IPs and device IDs in user agents become pseudonyms, equal values → equal pseudonyms', () => {
    const p = new Privacy('strict');
    const out = p.apply(history());
    const s = JSON.stringify(out);
    assertNoLeak(assert, s, [PII.ip, PII.uaDevice, '198.51.100.2']);
    assert.match(out.records[0].userAgent, /^Happ\/4\.4\.1\/Android\/hwid~[0-9a-f]{6}$/);
    assert.equal(p.apply({ ip: PII.ip }).ip, out.records[0].requestIp);
});

test('strict: pseudonyms passed back are restored locally', () => {
    const p = new Privacy('strict');
    const token = p.apply(user()).username;
    assert.deepEqual(p.restore({ username: token, n: 1, list: [token] }), { username: PII.username, n: 1, list: [PII.username] });
});

test('basic: secrets hidden, personal data visible', () => {
    const out = JSON.stringify(new Privacy('basic').apply(user()));
    assertNoLeak(assert, out, [SECRETS.vlessUuid, SECRETS.trojan, SECRETS.ss, SECRETS.shortUuid, SECRETS.subUrl]);
    assert.ok(out.includes(PII.username) && out.includes(PII.email));
});

test('off: raw data', () => {
    const out = JSON.stringify(new Privacy('off').apply(user()));
    assert.ok(out.includes(SECRETS.vlessUuid) && out.includes(PII.username));
});

test('connection links and node secret keys are hidden anywhere', () => {
    const out = JSON.stringify(
        new Privacy('basic').apply({ links: [SECRETS.link], ssConfLinks: { a: 'ss://x' }, note: `use ${SECRETS.link} now`, secretKey: SECRETS.secretKey }),
    );
    assertNoLeak(assert, out, [SECRETS.vlessUuid, SECRETS.secretKey, 'ss://x']);
});

test('error texts: links, IPs, e-mails and known values are scrubbed', () => {
    const p = new Privacy('strict');
    p.apply(user()); // makes the username known
    const msg = p.text(`User ${PII.username} (${PII.email}) from ${PII.ip} failed: ${SECRETS.link}`);
    assertNoLeak(assert, msg, [PII.username, PII.email, PII.ip, SECRETS.vlessUuid]);
});
