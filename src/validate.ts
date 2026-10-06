/**
 * Minimal argument check for tools whose input schema is plain JSON Schema (the extra tools)
 * and for unknown top-level arguments of API tools.
 *
 * Why: values of tool arguments end up in request paths. Without a check a value like "../../nodes/…"
 * could reach any panel endpoint, including write ones, even in read-only mode. Arguments may come from
 * text the model has read (client notes, user agents), so they are treated as untrusted.
 */

type Schema = {
    type?: string;
    format?: string;
    minimum?: number;
    maximum?: number;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkValue(name: string, v: unknown, s: Schema): string | null {
    switch (s.type) {
        case 'integer': {
            const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
            if (typeof n !== 'number' || !Number.isInteger(n)) return `${name}: must be an integer`;
            if (s.minimum !== undefined && n < s.minimum) return `${name}: must be ≥ ${s.minimum}`;
            if (s.maximum !== undefined && n > s.maximum) return `${name}: must be ≤ ${s.maximum}`;
            return null;
        }
        case 'number':
            return typeof v === 'number' && Number.isFinite(v) ? null : `${name}: must be a number`;
        case 'boolean':
            return typeof v === 'boolean' ? null : `${name}: must be true or false`;
        case 'string':
            if (typeof v !== 'string' && typeof v !== 'number') return `${name}: must be a string`;
            if (s.format === 'uuid' && !UUID_RE.test(String(v))) return `${name}: must be a UUID`;
            return null;
        default:
            return null;
    }
}

/** Throws a readable error if the arguments do not match the schema. Returns args with integers normalized. */
export function validateArgs(schema: Schema, args: Record<string, unknown>, extraAllowed: string[] = []): Record<string, unknown> {
    const props = schema.properties ?? {};
    const errors: string[] = [];
    for (const r of schema.required ?? []) if (args[r] === undefined || args[r] === null || args[r] === '') errors.push(`${r}: required`);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
        if (!(k in props)) {
            if (extraAllowed.includes(k)) out[k] = v;
            else if (schema.additionalProperties === false) errors.push(`${k}: unknown argument (allowed: ${Object.keys(props).join(', ') || 'none'})`);
            continue;
        }
        if (v === undefined || v === null) continue;
        const err = checkValue(k, v, props[k]);
        if (err) errors.push(err);
        else out[k] = props[k].type === 'integer' ? Number(v) : v;
    }
    if (errors.length) throw new Error(`Invalid arguments:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    return out;
}

/** One path segment: encoded, and never "." or ".." (they would move the request to another endpoint). */
export function seg(v: unknown): string {
    const s = String(v);
    if (s === '' || s === '.' || s === '..') throw new Error(`Invalid path value: "${s}"`);
    return encodeURIComponent(s);
}

/** API tools: types are checked by the contract's zod schemas; here only arguments the tool does not declare are refused. */
export function rejectUnknownArgs(schema: { properties?: unknown }, args: Record<string, unknown>, extraAllowed: string[] = []) {
    const props = Object.keys((schema.properties ?? {}) as object);
    const unknown = Object.keys(args).filter((k) => !props.includes(k) && !extraAllowed.includes(k));
    if (unknown.length)
        throw new Error(`Invalid arguments:\n${unknown.map((k) => `- ${k}: unknown argument (allowed: ${props.join(', ') || 'none'})`).join('\n')}`);
}
