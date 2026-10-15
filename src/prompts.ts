/**
 * Ready-made request templates. In Claude Desktop they appear in the "+" menu of the chat
 * as clickable items, so common checks don't have to be typed every time.
 */

export interface PromptDef {
    name: string;
    title: string;
    description: string;
    arguments?: { name: string; description: string; required?: boolean }[];
    text: (args: Record<string, string>) => string;
}

const LANG = 'Answer in the language the user writes in (Russian if unsure). Be brief: a short summary first, details after.';

const BASE: PromptDef[] = [
    {
        name: 'daily_summary',
        title: 'Сводка по панели / Panel summary',
        description: 'Users, online, offline nodes, traffic, subscriptions expiring soon',
        text: () =>
            `Call panel_overview (expiringDays: 3) and give me a daily summary of the Remnawave panel: ` +
            `active / online users, offline or disabled nodes (with the status message), nodes with the most users online, ` +
            `traffic for the last 2 and 7 days, subscriptions expiring within 3 days. Point out anything unusual. ${LANG}`,
    },
    {
        name: 'client_review',
        title: 'Разбор клиента / Client review',
        description: 'Subscription, devices, traffic and recent requests of one client',
        arguments: [
            { name: 'user', description: 'Panel user ID, username, Telegram ID or pseudonym', required: true },
        ],
        text: (a) =>
            `Call user_report for the client "${a.user}" (if it is a number, try it as the panel id first, then as telegramId). ` +
            `Summarise: status and expiry, traffic trend and top nodes, devices and apps, how many different IPs recent requests came from, ` +
            `anything that looks like a problem (expired, limit reached, no connections, suspected sharing). ${LANG}`,
    },
    {
        name: 'sharing_audit',
        title: 'Кто делится подпиской / Sharing audit',
        description: 'Clients with many IPs or devices',
        text: () =>
            `Call sharing_suspects and list the clients most likely sharing their subscription, with the reason for each ` +
            `(distinct IPs, apps, devices). Remember mobile internet also changes IPs — rank by confidence. ${LANG}`,
    },
    {
        name: 'node_check',
        title: 'Проверка нод / Node check',
        description: 'Offline nodes, load balance, optional GeoCheck of one node',
        arguments: [{ name: 'node', description: 'Node name for GeoCheck (optional)' }],
        text: (a) =>
            `Call panel_overview and review the nodes: offline or disabled ones, uneven load (users online per node), ` +
            `nodes close to their traffic limit. ` +
            (a.node
                ? `Then run geocheck_node for the node "${a.node}" (find its uuid in the overview) and explain the result. `
                : `Do not run GeoCheck unless I ask. `) +
            LANG,
    },
];

/**
 * Prompts for the configured panels. With several panels every prompt gets an optional "panel" argument:
 * given — the check runs on that panel; empty — on every panel, results labelled by panel.
 */
export function buildPrompts(panels: string[] = []): PromptDef[] {
    if (panels.length < 2) return BASE;
    const list = panels.join(', ');
    const arg = { name: 'panel', description: `Panel: ${list} (empty — all panels)` };
    return BASE.map((p) => ({
        ...p,
        arguments: [...(p.arguments ?? []), arg],
        text: (a) => {
            const panel = (a.panel ?? '').trim().toLowerCase();
            const scope = panels.includes(panel)
                ? `Work with the panel "${panel}" only: pass panel: "${panel}" to every tool. `
                : `Several panels are connected (${list}): do this for each panel (pass panel to every tool) and label every part of the answer with the panel name. `;
            return scope + p.text(a);
        },
    }));
}

/** Prompts of a single-panel setup (kept for compatibility). */
export const prompts: PromptDef[] = BASE;
