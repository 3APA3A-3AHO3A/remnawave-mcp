import { createHmac, randomBytes } from 'node:crypto';

/**
 * Privacy filter for everything the server sends to the chat.
 *
 * REMNAWAVE_PRIVACY:
 *   strict (default) — credentials hidden + client personal data replaced by pseudonyms;
 *   basic            — only credentials hidden;
 *   off              — raw API responses (not recommended).
 *
 * Credentials (always hidden unless "off"): Reality private keys, node SECRET_KEY, passwords,
 * API keys, user VLESS UUID, subscription links and anything that looks like vless:// ss:// … links.
 *
 * Personal data (strict): username, email, Telegram ID, user description, IP addresses, HWID →
 * stable pseudonyms like "user~3fa2c1", "ip~91b0d4". The same value always gets the same pseudonym
 * while the server runs, so the model can still say "these two users share an IP" without seeing it.
 * Pseudonyms can be passed back as tool arguments — the server swaps them for the real values
 * locally, so the real data never goes through the chat.
 * Subscription short UUID / URL of users are hidden in strict and basic: they give access to the config.
 */

export type PrivacyMode = 'strict' | 'basic' | 'off';

const MASK = '[hidden]';
const SECRET_KEY_RE = /(private_?key|secret|passw(or)?d|api_?key|^token$|^vlessUuid$)/i;
/** Reality short IDs are part of the handshake auth — hide them as well */
const SECRET_LIST_KEYS = new Set(['shortIds']);
/** IPv4 / IPv6, optionally with a CIDR mask; values like "geoip:private" in Xray rules are left alone */
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7})(\/\d{1,3})?$/i;
const IP_FIELDS = new Set(['ip', 'ips', 'requestIp', 'ipAddresses']);
/** long device identifiers inside user agents, e.g. Happ/4.4.1/Android/17891107313301967618 */
const UA_ID_RE = /\b[0-9a-f]{12,}\b/gi;
const LINK_ARRAYS = new Set(['links', 'ssConfLinks']);
const LINK_RE = /\b(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic|wireguard|wg):\/\/\S+/gi;

/** personal-data field → pseudonym prefix */
const PII_FIELDS: Record<string, string> = {
    username: 'user',
    email: 'email',
    allowedEmails: 'email',
    telegramId: 'tg',
    ip: 'ip',
    ips: 'ip',
    requestIp: 'ip',
    ipAddresses: 'ip',
    hwid: 'hwid',
};
/** fields hidden in strict mode only inside user objects */
const USER_ONLY_HIDE = new Set(['shortUuid', 'subscriptionUrl']);
const USER_ONLY_PSEUDO: Record<string, string> = { description: 'note' };

export class Privacy {
    private salt: Buffer;
    private reverse = new Map<string, unknown>();

    constructor(
        public mode: PrivacyMode,
        salt?: string,
    ) {
        this.salt = salt ? Buffer.from(salt) : randomBytes(32);
    }

    private pseudo(prefix: string, value: unknown): unknown {
        if (value === null || value === undefined || value === '') return value;
        if (Array.isArray(value)) return value.map((v) => this.pseudo(prefix, v));
        if (typeof value === 'object') return this.apply(value); // e.g. ips: [{ ip, lastSeen }]
        const token = `${prefix}~${createHmac('sha256', this.salt).update(String(value)).digest('hex').slice(0, 6)}`;
        this.reverse.set(token, value);
        return token;
    }

    /** Pseudonymize only real IP addresses (Xray rules use the same "ip" key for geoip:… lists). */
    private pseudoIp(value: unknown): unknown {
        if (typeof value === 'string') return IP_RE.test(value) ? this.pseudo('ip', value) : value;
        if (Array.isArray(value)) return value.map((v) => this.pseudoIp(v));
        if (value && typeof value === 'object') return this.apply(value);
        return value;
    }

    /** Filter an API response before it goes to the chat. */
    apply(value: unknown, key = '', inUser = false): unknown {
        if (this.mode === 'off' || value === null || value === undefined) return value;
        const strict = this.mode === 'strict';

        if (key && SECRET_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
            return value === '' ? value : MASK;
        }
        if (key && SECRET_LIST_KEYS.has(key) && Array.isArray(value)) {
            return value.map((v) => (v === '' ? v : MASK));
        }
        if (key && LINK_ARRAYS.has(key) && typeof value === 'object') {
            return Array.isArray(value) ? `${MASK} (${value.length} links)` : MASK;
        }
        // subscription short UUID / URL give access to the client's config → a credential
        if (key && inUser && USER_ONLY_HIDE.has(key) && typeof value === 'string') return value === '' ? value : MASK;
        if (strict && key) {
            if (IP_FIELDS.has(key)) return this.pseudoIp(value);
            if (key in PII_FIELDS) return this.pseudo(PII_FIELDS[key], value);
            if (key === 'userAgent' && typeof value === 'string')
                return value.replace(UA_ID_RE, (m) => String(this.pseudo('hwid', m)));
            if (inUser && key in USER_ONLY_PSEUDO && typeof value === 'string')
                return this.pseudo(USER_ONLY_PSEUDO[key], value);
        }
        if (typeof value === 'string') return value.replace(LINK_RE, (_m, p: string) => `${p}://${MASK}`);
        if (Array.isArray(value)) return value.map((v) => this.apply(v, '', inUser));
        if (typeof value === 'object') {
            const obj = value as Record<string, unknown>;
            // user object: has a subscription short UUID or traffic/expiry fields of a user
            const isUser = inUser || ('shortUuid' in obj && ('expireAt' in obj || 'status' in obj));
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) out[k] = this.apply(v, k, isUser);
            return out;
        }
        return value;
    }

    /** Swap pseudonyms in tool arguments back to real values (locally, never through the chat). */
    restore(value: unknown): unknown {
        if (this.mode !== 'strict') return value;
        if (typeof value === 'string') return this.reverse.has(value) ? this.reverse.get(value) : value;
        if (Array.isArray(value)) return value.map((v) => this.restore(v));
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.restore(v);
            return out;
        }
        return value;
    }
}
