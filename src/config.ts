export interface Config {
    baseUrl: string;
    headers: Record<string, string>;
    /** true — only tools with kind "read" are exposed */
    readonly: boolean;
    exclude: Set<string>;
    include: Set<string> | null;
    maxResponseChars: number;
    timeoutMs: number;
}

function csv(v: string | undefined): string[] {
    return (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

export function loadConfig(): Config {
    const baseUrl = process.env.REMNAWAVE_BASE_URL;
    const apiToken = process.env.REMNAWAVE_API_TOKEN;
    if (!baseUrl) throw new Error('REMNAWAVE_BASE_URL is required (e.g. https://panel.example.com)');
    if (!apiToken) throw new Error('REMNAWAVE_API_TOKEN is required');

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
    };
    if (process.env.REMNAWAVE_API_KEY) headers['X-Api-Key'] = process.env.REMNAWAVE_API_KEY;
    if (process.env.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    if (process.env.CF_ACCESS_CLIENT_SECRET)
        headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;

    // Safe by default: write tools appear only with REMNAWAVE_READONLY=false.
    const readonly = (process.env.REMNAWAVE_READONLY ?? 'true').toLowerCase() !== 'false';
    const include = csv(process.env.REMNAWAVE_TOOLS_INCLUDE);

    return {
        // Contract routes already start with /api — strip it if the user added it.
        baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/api$/, ''),
        headers,
        readonly,
        exclude: new Set(csv(process.env.REMNAWAVE_TOOLS_EXCLUDE)),
        include: include.length ? new Set(include) : null,
        maxResponseChars: Number(process.env.REMNAWAVE_MAX_RESPONSE_CHARS ?? 60000),
        timeoutMs: Number(process.env.REMNAWAVE_TIMEOUT_MS ?? 30000),
    };
}
