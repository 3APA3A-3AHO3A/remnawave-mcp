/**
 * Protects nodes and the panel from an over-eager assistant:
 * - jobs that run on a node (GeoCheck, connection lists) are not repeated for the same
 *   node/user within a cooldown — the previous result is returned instead, marked as cached;
 * - page size of list requests is capped.
 */

interface Entry {
    at: number;
    data: unknown;
}

export class Cooldown {
    private cache = new Map<string, Entry>();

    constructor(private minutes: number) {}

    async run(key: string, fn: () => Promise<unknown>): Promise<unknown> {
        const now = Date.now();
        const hit = this.cache.get(key);
        if (this.minutes > 0 && hit && now - hit.at < this.minutes * 60_000) {
            const ago = Math.round((now - hit.at) / 60_000);
            return {
                cached: true,
                note: `Result from ${ago} min ago (repeat limit: once per ${this.minutes} min for this target, to save node traffic).`,
                result: hit.data,
            };
        }
        const data = await fn();
        // a failed or timed-out job is not a result: the next call must be able to try again
        const r = data as { timeout?: boolean; isFailed?: boolean } | null;
        if (!r?.timeout && !r?.isFailed) this.cache.set(key, { at: now, data });
        return data;
    }
}

/** Clamp `size` in list queries. */
export function capPageSize(args: Record<string, unknown>, max: number): Record<string, unknown> {
    if (max > 0 && 'size' in args && Number(args.size) > max) return { ...args, size: max };
    return args;
}
