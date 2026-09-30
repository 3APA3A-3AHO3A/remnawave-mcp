import type { RemnawaveClient } from './client.js';

/**
 * Compares the panel version (GET /api/system/metadata) with the contract this build ships.
 * A different major.minor means some tools may be missing or behave differently —
 * the user gets a clear hint which build to download instead of cryptic API errors.
 */

export interface VersionInfo {
    panel?: string;
    contract: string;
    server: string;
    warning?: string;
}

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

export function compareVersions(panel: string | undefined, contract: string, server: string): VersionInfo {
    const info: VersionInfo = { panel, contract, server };
    if (!panel || minor(panel) === minor(contract)) return info;
    const [pMaj, pMin] = panel.split('.').map(Number);
    const [cMaj, cMin] = contract.split('.').map(Number);
    const newer = pMaj > cMaj || (pMaj === cMaj && pMin > cMin);
    info.warning =
        `⚠ Version mismatch: the panel is ${panel}, this remnawave-mcp build is for Remnawave ${minor(contract)} ` +
        `(contract ${contract}). Some tools may fail or be missing. ` +
        (newer
            ? `Update remnawave-mcp (a newer release or remnawave-${minor(panel)}.mcpb), or in a manual install run: npm i @remnawave/backend-contract@${panel} --save-exact.`
            : `Download remnawave-${minor(panel)}.mcpb from the releases page, or in a manual install run: npm i @remnawave/backend-contract@${panel} --save-exact.`) +
        ' Tell the user about this once, in their language.';
    return info;
}

export class VersionCheck {
    private result?: Promise<VersionInfo>;

    constructor(
        private client: RemnawaveClient,
        private contract: string,
        private server: string,
    ) {}

    /** Asked once per server run; errors (e.g. no "system" scope) are ignored. */
    get(): Promise<VersionInfo> {
        this.result ??= this.client
            .request('GET', '/api/system/metadata')
            .then((m) => compareVersions((m as { version?: string })?.version, this.contract, this.server))
            .catch(() => compareVersions(undefined, this.contract, this.server));
        return this.result;
    }
}
