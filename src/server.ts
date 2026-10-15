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
import { buildPrompts } from './prompts.js';
import { VersionCheck } from './version.js';
import { VIEWS } from './views.js';
import { writeHint } from './hints.js';
import { rejectUnknownArgs, validateArgs } from './validate.js';

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

export function instructions(cfg: Config, contractVersion: string, panels: string[] = []) {
    return (
        `Remnawave panel API (contract ${contractVersion}). ` +
        (panels.length > 1
            ? `Several panels are connected: ${panels.join(', ')}. Every tool has a required "panel" argument — use the panel the user means; ` +
              'if it is unclear, ask, or query each panel and label the results by panel (list_panels shows them). ' +
              'Users, nodes, uuids and ids belong to one panel: never pass an id from one panel to another. '
            : '') +
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

interface Panel {
    name: string;
    client: RemnawaveClient;
    versions: VersionCheck;
}

const LIST_PANELS = 'list_panels';

export function createServer(opts: {
    cfg: Config;
    tools: ApiTool[];
    extras: ExtraTool[];
    serverVersion: string;
    contractVersion: string;
    /** single-panel tests: client of the (only) panel */
    client?: RemnawaveClient;
    /** multi-panel tests: client per panel name, in order */
    clients?: Record<string, RemnawaveClient>;
}) {
    const { cfg } = opts;
    const panelCfgs = cfg.panels?.length ? cfg.panels : [{ name: 'panel1', baseUrl: cfg.baseUrl, headers: cfg.headers }];
    const panels: Panel[] = (
        opts.clients
            ? Object.entries(opts.clients).map(([name, client]) => ({ name, client }))
            : panelCfgs.map((p, i) => ({
                  name: p.name,
                  client: (i === 0 && opts.client) || new RemnawaveClient({ baseUrl: p.baseUrl, headers: p.headers, timeoutMs: cfg.timeoutMs }),
              }))
    ).map((p) => ({ ...p, versions: new VersionCheck(p.client, opts.contractVersion, opts.serverVersion) }));
    const names = panels.map((p) => p.name);
    const multi = panels.length > 1;

    // One filter for all panels: a pseudonym is derived from the value itself, so equal pseudonyms always
    // mean equal values (also across panels) and a pseudonym is restored to the right value whatever panel it came from.
    const privacy = new Privacy(cfg.privacy, cfg.privacySalt);
    const nodePrivacy = new Privacy(cfg.privacy === 'strict' ? 'basic' : cfg.privacy);
    const cooldowns = { geocheck: new Cooldown(cfg.cooldown.geocheck), connections: new Cooldown(cfg.cooldown.connections) };
    const tools = selectTools(opts.tools, cfg);
    const visible = (name: string) => !cfg.exclude.has(name) && (!cfg.include || cfg.include.has(name));
    const extras = opts.extras.filter((e) => visible(e.name));
    const listPanels = multi && visible(LIST_PANELS);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const extraByName = new Map(extras.map((e) => [e.name, e]));
    const prompts = buildPrompts(names);

    /** With several panels every tool gets a required "panel" argument limited to the configured names. */
    const withPanel = (schema: Record<string, unknown>) =>
        multi
            ? {
                  ...schema,
                  properties: {
                      panel: { type: 'string', enum: names, description: `Remnawave panel to query: ${names.join(', ')}` },
                      ...((schema.properties as object) ?? {}),
                  },
                  required: ['panel', ...(((schema.required as string[]) ?? []).filter((r) => r !== 'panel'))],
              }
            : schema;

    /** With several panels a contract change for one of them would break the others — say so next to the version hint. */
    const warning = (v: { warning?: string } | undefined, p: Panel) =>
        v?.warning && multi
            ? `${v.warning} Note: this is about panel "${p.name}" only. The other connected panels share this build, so changing its contract version ` +
              'would break them — keep the build that matches most panels and connect this panel through a separate server, or update the panels to the same version.'
            : v?.warning;

    function pickPanel(value: unknown): Panel {
        if (!multi) return panels[0];
        const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
        const p = panels.find((x) => x.name === name);
        if (p) return p;
        throw new Error(
            name
                ? `Unknown panel "${name}". Connected panels: ${names.join(', ')}.`
                : `Specify the panel: panel is one of ${names.join(', ')}. If the user did not say which, ask or query each panel.`,
        );
    }

    const server = new Server(
        { name: 'remnawave', version: opts.serverVersion },
        { capabilities: { tools: {}, prompts: {} }, instructions: instructions(cfg, opts.contractVersion, names) },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            ...(listPanels
                ? [
                      {
                          name: LIST_PANELS,
                          description: 'Connected Remnawave panels: name and panel version. Pass the name as "panel" to the other tools.',
                          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                          annotations: { readOnlyHint: true },
                      },
                  ]
                : []),
            ...extras.map((e) => ({
                name: e.name,
                description: e.description,
                inputSchema: withPanel(e.inputSchema),
                annotations: { readOnlyHint: true },
            })),
            ...tools.map((t) => ({
                name: t.name,
                description:
                    (VIEWS[t.name] ? `${t.description}\nReturns a compact view; pass full: true for the raw panel response.` : t.description) +
                    (t.kind === 'write' ? `\n${writeHint(t.name)}` : ''),
                inputSchema: withPanel(
                    VIEWS[t.name]
                        ? {
                              ...t.inputSchema,
                              properties: {
                                  ...(t.inputSchema.properties as object),
                                  full: { type: 'boolean', default: false, description: 'Return the raw panel response (large)' },
                              },
                          }
                        : t.inputSchema,
                ),
                annotations: {
                    readOnlyHint: t.kind === 'read',
                    destructiveHint: t.kind === 'write' && (t.method === 'DELETE' || /delete|revoke|truncate|reset/i.test(t.name)),
                },
            })),
        ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        let panel: Panel | undefined;
        // with several panels every answer says which panel it is about
        const label = () => (multi && panel ? `[panel: ${panel.name}]\n` : '');
        try {
            if (name === LIST_PANELS && listPanels) {
                const list = await Promise.all(
                    panels.map(async (p) => {
                        const v = await p.versions.get();
                        return { name: p.name, panelVersion: v.panel ?? 'unknown (panel unreachable or no "system" scope)', warning: warning(v, p) };
                    }),
                );
                return { content: [{ type: 'text', text: render({ panels: list, mcpContract: opts.contractVersion }, { max: cfg.maxResponseChars, compact: cfg.compact }) }] };
            }
            const restored = privacy.restore(req.params.arguments ?? {}) as Record<string, unknown>;
            let rest = restored;
            if (multi) {
                const { panel: wanted, ...others } = restored;
                panel = pickPanel(wanted);
                rest = others;
            } else panel = panels[0];
            const { client, versions } = panel;
            const args = capPageSize(rest, cfg.maxPageSize);
            let data: unknown;
            let filter = privacy;
            const extra = extraByName.get(name);
            if (extra) {
                if (extra.userData === false) filter = nodePrivacy;
                const checked = validateArgs(extra.inputSchema, args);
                const run = () => extra.run(client, checked);
                data = extra.cooldown
                    ? await cooldowns[extra.cooldown.kind].run(`${panel.name}:${extra.cooldown.key(args)}`, run)
                    : await run();
            } else {
                const t = byName.get(name);
                if (!t) throw new Error(`Unknown tool: ${name}`);
                // only arguments the tool declares reach the panel; `full` is ours (compact views)
                rejectUnknownArgs(t.inputSchema, args, VIEWS[name] ? ['full'] : []);
                const { full, ...apiArgs } = args;
                data = await callApi(client, t, VIEWS[name] ? apiArgs : args);
                if (VIEWS[name] && full !== true) data = VIEWS[name](data);
            }
            const v = await versions.get();
            if (name === 'panel_overview' && data && typeof data === 'object')
                data = {
                    versions: { ...(multi ? { panelName: panel.name } : {}), panel: v.panel, mcpContract: v.contract, mcpServer: v.server },
                    ...(data as object),
                };
            let text = render(filter.apply(data), { max: cfg.maxResponseChars, compact: cfg.compact });
            const w = warning(v, panel);
            if (w) text = `${w}\n${text}`;
            return { content: [{ type: 'text', text: label() + text }] };
        } catch (e) {
            // error texts may quote user data — they go through the privacy filter too
            const msg = e instanceof Error ? e.message : String(e);
            const w = panel ? warning(await panel.versions.get().catch(() => undefined), panel) : undefined;
            const text = label() + (w ? `${w}\n` : '') + privacy.text(msg);
            return { isError: true, content: [{ type: 'text', text }] };
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

    return { server, toolCount: tools.length + extras.length + (listPanels ? 1 : 0), panels: names };
}
