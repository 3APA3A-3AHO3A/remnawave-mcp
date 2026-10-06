// Shared fixtures: realistic panel data full of secrets and personal data.
export const SECRETS = {
    privateKey: 'PRIVATE_KEY_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortId: '6a8f14406a3e5b0c',
    realityPassword: 'REALITY_PASSWORD_zzz',
    salamander: 'SALAMANDER_PASS_yyy',
    vlessUuid: '11111111-2222-4333-8444-555555555555',
    trojan: 'TROJAN_PASS_xxx',
    ss: 'SS_PASS_www',
    shortUuid: 'SubShortUuidQwerty',
    subUrl: 'https://sub.example.com/SubShortUuidQwerty',
    link: 'vless://11111111-2222-4333-8444-555555555555@1.2.3.4:443?security=reality#Node',
    secretKey: 'NODE_SECRET_KEY_vvv',
    cascadeUuid: '926ae3c6-0000-4f0d-868a-000000000001',
    extUuid: '79bf1ae9-0000-41f0-b69a-000000000002',
    hysteriaAuth: 'HYSTERIA_AUTH_uuu',
};
export const PII = {
    username: 'ivan_petrov',
    email: 'ivan.petrov@mail.ru',
    telegramId: 987654321,
    description: 'Иван, тел +79990001122',
    ip: '203.0.113.77',
    hwid: 'a1b2c3d4e5f6a7b8c9d0',
    uaDevice: '17891107313301967618',
};

export const user = () => ({
    id: 5,
    shortUuid: SECRETS.shortUuid,
    username: PII.username,
    email: PII.email,
    telegramId: PII.telegramId,
    description: PII.description,
    status: 'ACTIVE',
    expireAt: '2026-10-01T00:00:00.000Z',
    tag: 'VIP',
    vlessUuid: SECRETS.vlessUuid,
    trojanPassword: SECRETS.trojan,
    ssPassword: SECRETS.ss,
    subscriptionUrl: SECRETS.subUrl,
    lastTriggeredThreshold: null,
});

export const configProfile = () => ({
    uuid: 'c1',
    name: 'EU',
    config: {
        inbounds: [
            {
                tag: 'VLESS',
                streamSettings: {
                    realitySettings: {
                        privateKey: SECRETS.privateKey,
                        publicKey: 'PUBLIC_OK',
                        shortIds: ['', SECRETS.shortId],
                        password: SECRETS.realityPassword,
                        serverNames: ['node.example.com'],
                    },
                    finalmask: { udp: [{ type: 'salamander', settings: { password: SECRETS.salamander } }] },
                },
            },
        ],
        routing: { rules: [{ ip: ['geoip:private'], outboundTag: 'BLOCK' }, { ip: ['geoip:telegram'], balancerTag: 'eu' }] },
    },
    inbounds: [{ uuid: 'i1', rawInbound: { streamSettings: { realitySettings: { privateKey: SECRETS.privateKey } } } }],
});

/** Snippets: outbounds of a node-to-node cascade carry real credentials. */
export const snippets = () => ({
    total: 2,
    snippets: [
        {
            name: 'outbound-ru',
            snippet: [
                {
                    tag: 'outbound-ru-1',
                    protocol: 'vless',
                    settings: { id: SECRETS.cascadeUuid, flow: 'xtls-rprx-vision', port: 443, address: '203.0.113.10', encryption: 'none' },
                    streamSettings: { security: 'reality', realitySettings: { shortId: SECRETS.shortId, password: SECRETS.realityPassword, serverName: 'gw.example.com' } },
                },
                {
                    tag: 'outbound-sh-1',
                    protocol: 'hysteria',
                    settings: { port: 443, address: '203.0.113.11', version: 2 },
                    streamSettings: { hysteriaSettings: { auth: SECRETS.hysteriaAuth, version: 2 } },
                },
                {
                    tag: 'ext-proxy-1',
                    protocol: 'vless',
                    settings: { vnext: [{ port: 443, address: '203.0.113.12', users: [{ id: SECRETS.extUuid, flow: 'xtls-rprx-vision', encryption: 'none' }] }] },
                    streamSettings: { realitySettings: { publicKey: 'PUBLIC_OK', serverName: 'node.example.net' } },
                },
            ],
        },
        { name: 'balancer-ru', snippet: [{ tag: 'balancer-ru', selector: ['outbound-ru'], strategy: { type: 'leastLoad' } }] },
    ],
});

/** Client template: SOCKS "auth" is a mode name, not a secret. */
export const template = () => ({
    templateJson: { inbounds: [{ tag: 'socks', protocol: 'socks', settings: { udp: true, auth: 'noauth' } }] },
});

export const history = () => ({
    total: 3,
    records: [
        { id: 3, userId: 5, requestAt: '2026-09-30T11:00:03Z', requestIp: PII.ip, userAgent: `Happ/4.4.1/Android/${PII.uaDevice}` },
        { id: 2, userId: 5, requestAt: '2026-09-30T11:00:02Z', requestIp: '198.51.100.2', userAgent: 'INCY/3.5.4/android' },
        { id: 1, userId: 9, requestAt: '2026-09-30T11:00:01Z', requestIp: '10.0.0.1', userAgent: 'Blackbox Exporter/0.27.0' },
    ],
});

/** Assert that none of the values appears anywhere in the text. */
export function assertNoLeak(assert, text, values) {
    for (const v of values) assert.ok(!text.includes(String(v)), `leaked: ${v}\n--- in ---\n${text.slice(0, 2000)}`);
}
