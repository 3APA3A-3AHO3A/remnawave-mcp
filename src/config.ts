/** One Remnawave panel: address, auth headers and the name the assistant uses to pick it. */
export interface PanelConfig {
    name: string;
    baseUrl: string;
    headers: Record<string, string>;
}

export interface Config {
    /** first panel (kept at the top level for single-panel setups and older code) */
    baseUrl: string;
    headers: Record<string, string>;
    /** all configured panels, the first one is the same as baseUrl/headers above */
    panels: PanelConfig[];
    /** true — only tools with kind "read" are exposed */
    readonly: boolean;
    /** strict (default) | basic | off — see src/redact.ts */
    privacy: 'strict' | 'basic' | 'off';
    privacySalt?: string;
    /** privacy === 'off': credential-only tools are exposed too */
    showSecrets: boolean;
    exclude: Set<string>;
    include: Set<string> | null;
    maxResponseChars: number;
    /** compact JSON without nulls/duplicates (default true) */
    compact: boolean;
    /** max `size` for list requests (0 = no cap) */
    maxPageSize: number;
    /** minutes between repeated node jobs for the same target */
    cooldown: { geocheck: number; connections: number };
    timeoutMs: number;
}

function num(v: string | undefined, def: number): number {
    const n = Number(v);
    return v && Number.isFinite(n) && n >= 0 ? n : def;
}

function csv(v: string | undefined): string[] {
    return (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Panel N from the environment. Panel 1 uses the plain names (REMNAWAVE_BASE_URL, REMNAWAVE_API_TOKEN, …),
 * panel 2+ the same names with the number after REMNAWAVE_ (REMNAWAVE_2_BASE_URL, REMNAWAVE_2_API_TOKEN, …);
 * Cloudflare Access for panel 2+ — REMNAWAVE_2_CF_ACCESS_CLIENT_ID / _SECRET.
 * Returns null for an empty slot (the Claude extension passes "" for fields left blank).
 */
/** "" and an unfilled "${user_config.…}" placeholder of the Claude extension both mean "not set". */
const value = (v: string | undefined) => (v && !/^\$\{user_config\.[\w-]+\}$/.test(v) ? v : undefined);

function loadPanel(n: number): PanelConfig | null {
    const env = (key: string) => value(process.env[n === 1 ? `REMNAWAVE_${key}` : `REMNAWAVE_${n}_${key}`]);
    const cf = (key: string) => value(process.env[n === 1 ? `CF_ACCESS_${key}` : `REMNAWAVE_${n}_CF_ACCESS_${key}`]);
    const label = n === 1 ? 'REMNAWAVE_' : `REMNAWAVE_${n}_`;
    const baseUrl = env('BASE_URL');
    const apiToken = env('API_TOKEN');
    if (!baseUrl && !apiToken && n > 1) return null;
    if (!baseUrl) throw new Error(`${label}BASE_URL is required (e.g. https://panel.example.com)`);
    if (!apiToken) throw new Error(`${label}API_TOKEN is required`);

    const name = (env('NAME') ?? `panel${n}`).trim().toLowerCase();
    if (!NAME_RE.test(name))
        throw new Error(`${label}NAME must be 1–32 characters: latin letters, digits, "-" or "_" (got "${name}")`);

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
    };
    const apiKey = env('API_KEY');
    if (apiKey) headers['X-Api-Key'] = apiKey;
    // Direct connection to the panel container (http://remnawave:3000 inside the Docker network):
    // the panel expects the headers a reverse proxy would normally add.
    if (/^http:\/\//i.test(baseUrl)) {
        headers['X-Forwarded-Proto'] = 'https';
        headers['X-Forwarded-For'] = '127.0.0.1';
    }
    // Any extra headers, JSON: {"Header-Name": "value"}
    const extra = env('HEADERS');
    if (extra) {
        try {
            Object.assign(headers, JSON.parse(extra));
        } catch {
            throw new Error(`${label}HEADERS must be JSON, e.g. {"X-Custom": "value"}`);
        }
    }
    const cfId = cf('CLIENT_ID');
    const cfSecret = cf('CLIENT_SECRET');
    if (cfId) headers['CF-Access-Client-Id'] = cfId;
    if (cfSecret) headers['CF-Access-Client-Secret'] = cfSecret;

    // Contract routes already start with /api — strip it if the user added it.
    return { name, baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/api$/, ''), headers };
}

/** Panel 1 is required; panels 2, 3, … are picked up from REMNAWAVE_<n>_BASE_URL (gaps in numbering are fine). */
export function loadPanels(): PanelConfig[] {
    const numbers = new Set<number>();
    for (const key of Object.keys(process.env)) {
        const m = key.match(/^REMNAWAVE_(\d+)_(BASE_URL|API_TOKEN)$/);
        if (m && Number(m[1]) >= 2) numbers.add(Number(m[1]));
    }
    const panels = [1, ...[...numbers].sort((a, b) => a - b)].map(loadPanel).filter((p): p is PanelConfig => p !== null);
    const seen = new Set<string>();
    for (const p of panels) {
        if (seen.has(p.name))
            throw new Error(`Two panels are named "${p.name}" — give each panel its own name (REMNAWAVE_NAME, REMNAWAVE_2_NAME, …)`);
        seen.add(p.name);
    }
    return panels;
}

export function loadConfig(): Config {
    const panels = loadPanels();

    // Safe by default: write tools appear only with REMNAWAVE_READONLY=false.
    const readonly = (process.env.REMNAWAVE_READONLY || 'true').toLowerCase() !== 'false';
    // `||` instead of `??`: Claude extensions pass empty strings for fields left blank.
    let privacy = (process.env.REMNAWAVE_PRIVACY || 'strict').toLowerCase();
    if ((process.env.REMNAWAVE_SHOW_SECRETS ?? '').toLowerCase() === 'true') privacy = 'off';
    if (!['strict', 'basic', 'off'].includes(privacy))
        throw new Error('REMNAWAVE_PRIVACY must be strict, basic or off');
    const showSecrets = privacy === 'off';
    const include = csv(process.env.REMNAWAVE_TOOLS_INCLUDE);

    return {
        baseUrl: panels[0].baseUrl,
        headers: panels[0].headers,
        panels,
        readonly,
        privacy: privacy as Config['privacy'],
        privacySalt: process.env.REMNAWAVE_PRIVACY_SALT || undefined,
        showSecrets,
        exclude: new Set(csv(process.env.REMNAWAVE_TOOLS_EXCLUDE)),
        include: include.length ? new Set(include) : null,
        maxResponseChars: num(process.env.REMNAWAVE_MAX_RESPONSE_CHARS, 60000),
        compact: (process.env.REMNAWAVE_COMPACT || 'true').toLowerCase() !== 'false',
        maxPageSize: num(process.env.REMNAWAVE_MAX_PAGE_SIZE, 200),
        cooldown: {
            geocheck: num(process.env.REMNAWAVE_GEOCHECK_COOLDOWN_MIN, 30),
            connections: num(process.env.REMNAWAVE_CONNECTIONS_COOLDOWN_MIN, 2),
        },
        timeoutMs: num(process.env.REMNAWAVE_TIMEOUT_MS, 30000),
    };
}
