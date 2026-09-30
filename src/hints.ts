/**
 * Extra warnings in the descriptions of write tools (visible only when REMNAWAVE_READONLY=false),
 * so the assistant knows what is irreversible or replaces data wholesale.
 */

const RULES: [RegExp, string][] = [
    [/^bulk_all_/, 'Applies to ALL users of the panel at once. State the total user count and get an explicit confirmation first.'],
    [/^bulk_.*delete|^delete_|truncate/, 'Irreversible. Show exactly what will be deleted (names/ids, count) and get an explicit confirmation first.'],
    [/^bulk_/, 'Affects many objects at once: list them with their count and get an explicit confirmation first.'],
    [/^update_config_profile$/, 'The `config` you send REPLACES the whole Xray config of the profile: read it with get_config_profile_by_uuid, change only what is needed, send the full result back, show the diff first. All nodes of the profile restart Xray.'],
    [/^update_(subscription_template|snippet)$/, 'Replaces the whole content: read the current version first, change only what is needed, show the diff.'],
    [/^restart_all_nodes$/, 'Every node restarts Xray: ALL clients are disconnected for a moment.'],
    [/^restart_node$/, 'Clients of this node are disconnected for a moment.'],
    [/^(disable|delete)_node$|^bulk_nodes_actions$/, 'Clients of the node lose this server — check that other nodes can take them.'],
    [/^revoke_user_subscription$/, 'The client’s subscription link changes — they must re-import it in their app.'],
    [/^(reset_user_traffic|reset_node_traffic)$/, 'Traffic counters are reset and cannot be restored.'],
    [/^drop_connections$/, 'Disconnects the listed users/IPs immediately.'],
    [/^update_remnawave_settings$|^update_subscription_settings$/, 'Panel-wide settings: read the current values first and change only what was asked.'],
    [/^(update|create)_host$/, 'Host changes go to every client with their next subscription update.'],
];

const GENERAL = 'Write action: confirm with the user before calling.';

export function writeHint(toolName: string): string {
    const hits = RULES.filter(([re]) => re.test(toolName)).map(([, t]) => t);
    return `⚠ ${[GENERAL, ...hits.slice(0, 2)].join(' ')}`;
}
