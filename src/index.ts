#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { buildRegistry } from './registry.js';
import { availableExtras } from './extras.js';
import { createServer } from './server.js';
import { createHttpServer, loadHttpConfig } from './http.js';

// Versions are read from package.json files, so nothing has to be edited by hand after an update.
const require = createRequire(import.meta.url);
const CONTRACT_VERSION: string = require('@remnawave/backend-contract/package.json').version;
const SERVER_VERSION: string = require('../package.json').version;

async function main() {
    const all = buildRegistry();
    const extras = availableExtras();

    if (process.argv.includes('--list-tools')) {
        const list = process.argv.includes('--all') ? all : all.filter((t) => t.kind === 'read' && !t.secret);
        for (const t of list) console.log(`${t.kind.padEnd(5)} ${t.name.padEnd(48)} ${t.method} ${t.path}`);
        for (const e of extras) console.log(`extra ${e.name}`);
        console.log(`\n${list.length} API tools + ${extras.length} extra (contract ${CONTRACT_VERSION})`);
        return;
    }
    if (process.argv.includes('--version')) {
        console.log(`remnawave-mcp ${SERVER_VERSION}, contract ${CONTRACT_VERSION}`);
        return;
    }

    const mode = process.env.REMNAWAVE_TRANSPORT || 'stdio';
    if (mode !== 'stdio' && mode !== 'http') throw new Error('REMNAWAVE_TRANSPORT must be stdio or http');
    const http = mode === 'http' ? loadHttpConfig() : undefined;
    const cfg = loadConfig();
    const opts = { cfg, tools: all, extras, serverVersion: SERVER_VERSION, contractVersion: CONTRACT_VERSION };

    if (http) {
        if (!cfg.readonly || cfg.privacy !== 'strict')
            console.error('WARNING: HTTP mode with write access or relaxed privacy. A leaked HTTP token grants this access; use HTTPS.');
        // Even a configured stdio pseudonym salt must not correlate different HTTP sessions.
        const listener = createHttpServer(http, () =>
            createServer({ ...opts, cfg: { ...cfg, privacySalt: undefined } }).server,
        );
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(http.port, http.host, () => {
                listener.off('error', reject);
                resolve();
            });
        });
        console.error(
            `remnawave-mcp ${SERVER_VERSION}: HTTP on ${http.host}:${http.port}/mcp, ` +
                `${cfg.readonly ? 'read-only' : 'READ-WRITE'}, privacy ${cfg.privacy}`,
        );
        return;
    }

    const { server, toolCount, panels } = createServer(opts);
    await server.connect(new StdioServerTransport());
    console.error(
        `remnawave-mcp ${SERVER_VERSION}: ${toolCount} tools, ${cfg.readonly ? 'read-only' : 'READ-WRITE'}, privacy ${cfg.privacy}, ` +
            (panels.length > 1 ? `${panels.length} panels: ${cfg.panels.map((p) => `${p.name} (${p.baseUrl})`).join(', ')}` : cfg.baseUrl),
    );
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
