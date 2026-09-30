import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { RemnawaveClient } from './client.js';
import type { ApiTool } from './registry.js';
import type { ExtraTool } from './extras.js';
import { Privacy } from './redact.js';
import { render } from './format.js';
import { Cooldown, capPageSize } from './limits.js';
import { prompts } from './prompts.js';

export function selectTools(all: ApiTool[], cfg: Config) {
    return all.filter(
        (t) =>
            (!cfg.readonly || t.kind === 'read') &&
            (cfg.showSecrets || !t.secret) &&
            !cfg.exclude.has(t.name) &&
            (!cfg.include || cfg.include.has(t.name)),
    );
}

function fillPath(path: string, args: Record<string, unknown>) {
    return path.replace(/:([A-Za-z0-9_]+)/g, (_, k: string) => {
        const v = args[k];
        if (v === undefined || v === null || v === '') throw new Error(`Missing path parameter "${k}"`);
        return encodeURIComponent(String(v));
    });
}

function validationError(label: string, err: { issues: { path: PropertyKey[]; message: string }[] }) {
    const lines = err.issues.map((i) => `- ${[label, ...i.path.map(String)].join('.')}: ${i.message}`);
    return new Error(`Invalid arguments:\n${lines.join('\n')}`);
}

async function callApi(client: RemnawaveClient, t: ApiTool, args: Record<string, unknown>) {
    if (t.paramSchema) {
        const wire = Object.fromEntries(t.pathParams.map((k) => [k, args[k] === undefined ? undefined : String(args[k])]));
        const r = t.paramSchema.safeParse(wire);
        if (!r.success) throw validationError('path', r.error);
    }
    const path = fillPath(t.path, args);

    const query: Record<string, unknown> = {};
    if (t.querySchema) {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (k !== 'body' && !t.pathParams.includes(k)) raw[k] = v;
        // Query strings are strings on the wire; stringify scalars before validating (schemas use coerce/transform).
        const wire = Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v : String(v)]),
        );
        const r = t.querySchema.safeParse(wire);
        if (!r.success) throw validationError('query', r.error);
        Object.assign(query, raw);
    }

    let body: unknown;
    if (t.bodySchema) {
        body = args.body ?? {};
        const r = t.bodySchema.safeParse(body);
        if (!r.success) throw validationError('body', r.error);
    }

    return client.request(t.method, path, query, body);
}

export function instructions(cfg: Config, contractVersion: string) {
    return (
        `Remnawave panel API (contract ${contractVersion}). ` +
        (cfg.readonly ? 'READ-ONLY mode: no changes are possible. ' : 'Write tools are enabled — confirm with the user before any change. ') +
        'Start with panel_overview for general questions, user_report for one client, sharing_suspects for shared subscriptions. ' +
        'In Remnawave 3.x users are addressed by numeric userId (not uuid). ' +
        'To find a user by Telegram ID / email / username use find_user. ' +
        'Nodes, hosts and squads are addressed by uuid — get them via panel_overview / get_nodes / get_hosts first. ' +
        'GeoCheck and connection lists run on the node and cost traffic: use them only when needed. ' +
        (cfg.privacy === 'off' ? '' : 'Credentials (private keys, passwords, user UUIDs, connection links) are masked as [hidden] on purpose. ') +
        (cfg.privacy === 'strict'
            ? 'Client personal data (username, email, Telegram ID, IPs, HWID, notes) is replaced with pseudonyms like user~3fa2c1 / ip~91b0d4. ' +
              'Pseudonyms are stable, so equal pseudonyms mean equal values; you can pass a pseudonym back as a tool argument and it will be resolved locally. ' +
              'Refer to users by their numeric id or pseudonym, never ask the user to reveal the real data.'
            : '')
    );
}

export function createServer(opts: {
    cfg: Config;
    tools: ApiTool[];
    extras: ExtraTool[];
    serverVersion: string;
    contractVersion: string;
    client?: RemnawaveClient;
}) {
    const { cfg } = opts;
    const client = opts.client ?? new RemnawaveClient(cfg);
    const privacy = new Privacy(cfg.privacy, cfg.privacySalt);
    const nodePrivacy = new Privacy(cfg.privacy === 'strict' ? 'basic' : cfg.privacy);
    const cooldowns = { geocheck: new Cooldown(cfg.cooldown.geocheck), connections: new Cooldown(cfg.cooldown.connections) };
    const tools = selectTools(opts.tools, cfg);
    const extras = opts.extras.filter((e) => !cfg.exclude.has(e.name) && (!cfg.include || cfg.include.has(e.name)));
    const byName = new Map(tools.map((t) => [t.name, t]));
    const extraByName = new Map(extras.map((e) => [e.name, e]));

    const server = new Server(
        { name: 'remnawave', version: opts.serverVersion },
        { capabilities: { tools: {}, prompts: {} }, instructions: instructions(cfg, opts.contractVersion) },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            ...extras.map((e) => ({
                name: e.name,
                description: e.description,
                inputSchema: e.inputSchema,
                annotations: { readOnlyHint: true },
            })),
            ...tools.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                annotations: {
                    readOnlyHint: t.kind === 'read',
                    destructiveHint: t.kind === 'write' && (t.method === 'DELETE' || /delete|revoke|truncate|reset/i.test(t.name)),
                },
            })),
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        try {
            const args = capPageSize(privacy.restore(req.params.arguments ?? {}) as Record<string, unknown>, cfg.maxPageSize);
            let data: unknown;
            let filter = privacy;
            const extra = extraByName.get(name);
            if (extra) {
                if (extra.userData === false) filter = nodePrivacy;
                const run = () => extra.run(client, args);
                data = extra.cooldown ? await cooldowns[extra.cooldown.kind].run(extra.cooldown.key(args), run) : await run();
            } else {
                const t = byName.get(name);
                if (!t) throw new Error(`Unknown tool: ${name}`);
                data = await callApi(client, t, args);
            }
            const text = render(filter.apply(data), { max: cfg.maxResponseChars, compact: cfg.compact });
            return { content: [{ type: 'text', text }] };
        } catch (e) {
            // error texts may quote user data — they go through the privacy filter too
            const msg = e instanceof Error ? e.message : String(e);
            return { isError: true, content: [{ type: 'text', text: privacy.text(msg) }] };
        }
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
        prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments ?? [] })),
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        const p = prompts.find((x) => x.name === req.params.name);
        if (!p) throw new Error(`Unknown prompt: ${req.params.name}`);
        const args = (req.params.arguments ?? {}) as Record<string, string>;
        return {
            description: p.description,
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text(args) } }],
        };
    });

    return { server, toolCount: tools.length + extras.length };
}
