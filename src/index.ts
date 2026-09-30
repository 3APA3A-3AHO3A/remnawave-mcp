#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { RemnawaveClient } from './client.js';
import { buildRegistry, type ApiTool } from './registry.js';
import { availableExtras } from './extras.js';
import { Privacy } from './redact.js';
import { createRequire } from 'node:module';

// Versions are read from package.json files, so nothing has to be edited by hand after an update.
const require = createRequire(import.meta.url);
const CONTRACT_VERSION: string = require('@remnawave/backend-contract/package.json').version;
const SERVER_VERSION: string = require('../package.json').version;

function selectTools(all: ApiTool[], cfg: ReturnType<typeof loadConfig>) {
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

function format(data: unknown, max: number) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
    if (text.length <= max) return text;
    return (
        text.slice(0, max) +
        `\n\n[truncated: ${text.length} chars total. Narrow the request (size/filters/date range) to see the rest.]`
    );
}

async function main() {
    const all = buildRegistry();
    const extraTools = availableExtras();

    if (process.argv.includes('--list-tools')) {
        const ro = process.argv.includes('--all') ? all : all.filter((t) => t.kind === 'read' && !t.secret);
        for (const t of ro) console.log(`${t.kind.padEnd(5)} ${t.name.padEnd(48)} ${t.method} ${t.path}`);
        for (const e of extraTools) console.log(`extra ${e.name}`);
        console.log(`\n${ro.length} API tools + ${extraTools.length} extra (contract ${CONTRACT_VERSION})`);
        return;
    }

    const cfg = loadConfig();
    const client = new RemnawaveClient(cfg);
    const privacy = new Privacy(cfg.privacy, cfg.privacySalt);
    const nodePrivacy = new Privacy(cfg.privacy === 'strict' ? 'basic' : cfg.privacy);
    const tools = selectTools(all, cfg);
    const extras = extraTools.filter(
        (e) => !cfg.exclude.has(e.name) && (!cfg.include || cfg.include.has(e.name)),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    const extraByName = new Map(extras.map((e) => [e.name, e]));

    const server = new Server(
        { name: 'remnawave', version: SERVER_VERSION },
        {
            capabilities: { tools: {} },
            instructions:
                `Remnawave panel API (contract ${CONTRACT_VERSION}). ` +
                (cfg.readonly ? 'READ-ONLY mode: no changes are possible. ' : 'Write tools are enabled — confirm with the user before any change. ') +
                'In Remnawave 3.x users are addressed by numeric userId (not uuid). ' +
                'To find a user by Telegram ID / email / username use find_user. ' +
                'Nodes, hosts and squads are addressed by uuid — get them via get_nodes / get_hosts first. ' +
                (cfg.privacy === 'off'
                    ? ''
                    : 'Credentials (private keys, passwords, user UUIDs, connection links) are masked as [hidden] on purpose. ') +
                (cfg.privacy === 'strict'
                    ? 'Client personal data (username, email, Telegram ID, IPs, HWID, notes) is replaced with pseudonyms like user~3fa2c1 / ip~91b0d4. ' +
                      'Pseudonyms are stable, so equal pseudonyms mean equal values; you can pass a pseudonym back as a tool argument and it will be resolved locally. ' +
                      'Refer to users by their numeric id or pseudonym, never ask the user to reveal the real data.'
                    : ''),
        },
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
        const args = privacy.restore(req.params.arguments ?? {}) as Record<string, unknown>;
        try {
            let data: unknown;
            let filter = privacy;
            const extra = extraByName.get(name);
            if (extra?.userData === false) filter = nodePrivacy;
            if (extra) data = await extra.run(client, args);
            else {
                const t = byName.get(name);
                if (!t) throw new Error(`Unknown tool: ${name}`);
                data = await callApi(client, t, args);
            }
            const safe = filter.apply(data);
            return { content: [{ type: 'text', text: format(safe, cfg.maxResponseChars) }] };
        } catch (e) {
            return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
        }
    });

    await server.connect(new StdioServerTransport());
    console.error(
        `remnawave-mcp: ${tools.length + extras.length} tools, ${cfg.readonly ? 'read-only' : 'READ-WRITE'}, ${cfg.baseUrl}`,
    );
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
