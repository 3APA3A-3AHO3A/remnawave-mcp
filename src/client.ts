import type { Config } from './config.js';

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export class RemnawaveClient {
    constructor(private cfg: Config) {}

    async request(method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<unknown> {
        const url = new URL(this.cfg.baseUrl + path);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v === undefined || v === null) continue;
            // Contract query schemas JSON-parse arrays/objects (TanStack filters, sorting).
            url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }

        const res = await fetch(url, {
            method,
            headers: this.cfg.headers,
            body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });

        const text = await res.text();
        let data: unknown = text;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            /* keep text */
        }

        if (!res.ok) {
            const msg =
                (data && typeof data === 'object' && 'message' in data && String((data as { message: unknown }).message)) ||
                (typeof data === 'string' && data.slice(0, 500)) ||
                res.statusText;
            throw new ApiError(res.status, `Remnawave API ${res.status}: ${msg}`);
        }
        // All Remnawave responses are wrapped in { response: ... }
        if (data && typeof data === 'object' && 'response' in data) return (data as { response: unknown }).response;
        return data;
    }
}
