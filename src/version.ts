import type { RemnawaveClient } from './client.js';

/**
 * Compares the panel version (GET /api/system/metadata) with the contract this build ships.
 * A different major.minor means some tools may be missing or behave differently —
 * the user gets a clear hint which build to download instead of cryptic API errors.
 *
 * The hint depends on how the server was installed (REMNAWAVE_RUNTIME, set by the Docker image and the
 * Claude Desktop extension): a Docker user needs another image tag, an extension user another .mcpb file,
 * a manual install another contract version.
 */

export interface VersionInfo {
    panel?: string;
    contract: string;
    server: string;
    warning?: string;
}

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

export type Runtime = 'docker' | 'mcpb' | 'node';
const IMAGE = 'ghcr.io/3apa3a-3aho3a/remnawave-mcp';

export function runtimeFromEnv(value = process.env.REMNAWAVE_RUNTIME): Runtime {
    const v = (value ?? '').toLowerCase();
    return v === 'docker' || v === 'mcpb' ? v : 'node';
}

function fixHint(panel: string, newer: boolean, runtime: Runtime): string {
    const m = minor(panel);
    const npm = `npm i @remnawave/backend-contract@${panel} --save-exact && npm run build`;
    if (runtime === 'docker')
        return newer
            ? `Use the Docker image for this panel: docker pull ${IMAGE}:${m} (if that tag does not exist yet, use :latest after the next remnawave-mcp release) and change the image tag in the client settings.`
            : `Use the Docker image for this panel: docker pull ${IMAGE}:${m} and change the image tag in the client settings.`;
    if (runtime === 'mcpb')
        return newer
            ? `Install a newer remnawave-mcp release (remnawave-${m}.mcpb from the releases page, when available).`
            : `Download remnawave-${m}.mcpb from the releases page and open it in Claude Desktop.`;
    return newer
        ? `Update remnawave-mcp in the server folder: git pull && npm ci && npm run build. If the latest release does not support this panel yet, run: ${npm}.`
        : `In the server folder run: ${npm}.`;
}

export function compareVersions(panel: string | undefined, contract: string, server: string, runtime: Runtime = 'node'): VersionInfo {
    const info: VersionInfo = { panel, contract, server };
    if (!panel || minor(panel) === minor(contract)) return info;
    const [pMaj, pMin] = panel.split('.').map(Number);
    const [cMaj, cMin] = contract.split('.').map(Number);
    const newer = pMaj > cMaj || (pMaj === cMaj && pMin > cMin);
    info.warning =
        `⚠ Version mismatch: the panel is ${panel}, this remnawave-mcp build is for Remnawave ${minor(contract)} ` +
        `(contract ${contract}). Some tools may fail or be missing. ` +
        fixHint(panel, newer, runtime) +
        ' Tell the user about this once, in their language.';
    return info;
}

export class VersionCheck {
    private result?: Promise<VersionInfo>;

    constructor(
        private client: RemnawaveClient,
        private contract: string,
        private server: string,
        private runtime: Runtime = runtimeFromEnv(),
    ) {}

    /** Asked once per server run; errors (e.g. no "system" scope) are ignored. */
    get(): Promise<VersionInfo> {
        this.result ??= this.client
            .request('GET', '/api/system/metadata')
            .then((m) => compareVersions((m as { version?: string })?.version, this.contract, this.server, this.runtime))
            .catch(() => compareVersions(undefined, this.contract, this.server, this.runtime));
        return this.result;
    }
}
