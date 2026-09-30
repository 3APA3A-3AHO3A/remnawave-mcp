/**
 * Turns API data into text for the chat, as short as possible:
 * - compact JSON (no indentation), null fields dropped;
 * - known duplicates dropped (config profiles repeat every inbound as `rawInbound`);
 * - if the result is still too long, the biggest list is shortened and a note says
 *   "shown N of M" instead of cutting the JSON in the middle.
 */

const DUPLICATE_KEYS = new Set(['rawInbound']);

export function compact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compact);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v === null || v === undefined || DUPLICATE_KEYS.has(k)) continue;
            out[k] = compact(v);
        }
        return out;
    }
    return value;
}

interface Found {
    parent: Record<string, unknown> | unknown[];
    key: string | number;
    path: string;
    arr: unknown[];
    size: number;
}

/** Longest array (by serialized size) anywhere in the value. */
function biggestArray(value: unknown, path = '$'): Found | null {
    let best: Found | null = null;
    const visit = (v: unknown, parent: Found['parent'] | null, key: string | number, p: string) => {
        if (Array.isArray(v)) {
            if (parent && v.length > 1) {
                const size = JSON.stringify(v).length;
                if (!best || size > best.size) best = { parent, key, path: p, arr: v, size };
            }
            v.forEach((x, i) => visit(x, v, i, `${p}[${i}]`));
        } else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v as Record<string, unknown>))
                visit(x, v as Record<string, unknown>, k, `${p}.${k}`);
        }
    };
    visit(value, null, '', path);
    return best;
}

export function render(data: unknown, opts: { max: number; compact: boolean }): string {
    const stringify = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d, null, opts.compact ? 0 : 1));
    let d = opts.compact ? compact(data) : data;
    let text = stringify(d);
    if (text.length <= opts.max || typeof d !== 'object' || d === null) return cut(text, opts.max);

    // Shorten the biggest list step by step; clone first, the caller may reuse the data.
    d = JSON.parse(JSON.stringify(d));
    const notes: string[] = [];
    for (let i = 0; i < 40 && text.length > opts.max; i++) {
        const f = biggestArray(d);
        if (!f || f.arr.length <= 1) break;
        const original = (f as Found & { total?: number }).arr.length;
        const keep = Math.max(1, Math.floor(original / 2));
        const trimmed = f.arr.slice(0, keep);
        (f.parent as Record<string | number, unknown>)[f.key] = trimmed;
        const note = notes.findIndex((n) => n.startsWith(f.path + ':'));
        const total = note >= 0 ? Number(notes[note].split(' of ')[1]) : original;
        const line = `${f.path}: shown ${keep} of ${total}`;
        if (note >= 0) notes[note] = line;
        else notes.push(line);
        text = stringify(d);
    }
    const header = notes.length
        ? `[shortened to fit: ${notes.join('; ')}. Use filters, smaller size/start or a date range for the rest.]\n`
        : '';
    return cut(header + text, opts.max);
}

function cut(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max) + `\n[truncated: ${text.length} chars total. Narrow the request to see the rest.]`;
}
