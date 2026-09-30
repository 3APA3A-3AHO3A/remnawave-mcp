import * as contract from '@remnawave/backend-contract';
import { z } from 'zod';

/**
 * Every API endpoint in @remnawave/backend-contract is a namespace like
 * GetUserByIdCommand { url, TSQ_url, endpointDetails, Request*Schema, ResponseSchema }.
 * We turn each of them into an MCP tool automatically, so updating the
 * contract version is enough to follow a new Remnawave release.
 */

type AnyZod = z.ZodType;

interface ContractCommand {
    url: string | ((...a: string[]) => string);
    TSQ_url: string;
    endpointDetails: {
        REQUEST_METHOD: string;
        METHOD_DESCRIPTION: string;
        METHOD_LONG_DESCRIPTION?: string;
        SCOPE_KIND: 'read' | 'write' | string;
    };
    RequestParamSchema?: AnyZod;
    RequestQuerySchema?: AnyZod;
    RequestBodySchema?: AnyZod;
}

export interface ApiTool {
    name: string;
    command: string;
    method: string;
    path: string; // e.g. /api/users/:userId
    kind: 'read' | 'write';
    description: string;
    pathParams: string[];
    paramSchema?: AnyZod;
    querySchema?: AnyZod;
    bodySchema?: AnyZod;
    inputSchema: Record<string, unknown>;
}

/** Endpoints that must never be exposed to an LLM (login flows, secrets, token management). */
const ALWAYS_BLOCKED = new Set([
    'LoginCommand',
    'RegisterCommand',
    'OAuth2AuthorizeCommand',
    'OAuth2CallbackCommand',
    'GetPasskeyAuthenticationOptionsCommand',
    'VerifyPasskeyAuthenticationCommand',
    'GetPasskeysCommand',
    'GetPasskeyRegistrationOptionsCommand',
    'VerifyPasskeyRegistrationCommand',
    'UpdatePasskeyCommand',
    'DeletePasskeyCommand',
    'GetOttCommand',
    'GetNodeSecretKeyCommand',
    'CreateApiTokenCommand',
    'DeleteApiTokenCommand',
    'GetApiTokensCommand', // lists token values
    // Replaced by extra tools that start the job and wait for the result:
    'ConnectionsByNodeCommand',
    'ConnectionsByNodeResultCommand',
    'ConnectionsByUserCommand',
    'ConnectionsByUserResultCommand',
    'GeocheckByNodeCommand',
    'GeocheckByNodeResultCommand',
]);

/** Endpoints marked "write" in the contract that do not change anything. */
const EFFECTIVELY_READ = new Set(['TestSrrMatcherCommand']);

export function toolName(commandName: string): string {
    return commandName
        .replace(/Command$/, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase();
}

function jsonSchema(schema: AnyZod): Record<string, unknown> {
    try {
        const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
        delete js.$schema;
        return js;
    } catch {
        return { type: 'object', additionalProperties: true };
    }
}

function objectProps(schema: AnyZod | undefined): { props: Record<string, unknown>; required: string[] } {
    if (!schema) return { props: {}, required: [] };
    const js = jsonSchema(schema);
    return {
        props: (js.properties as Record<string, unknown>) ?? {},
        required: (js.required as string[]) ?? [],
    };
}

function buildInputSchema(pathParams: string[], param?: AnyZod, query?: AnyZod, body?: AnyZod) {
    const p = objectProps(param);
    const q = objectProps(query);
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();

    for (const name of pathParams) {
        properties[name] = p.props[name] ?? { type: 'string', description: `Path parameter ${name}` };
        required.add(name);
    }
    for (const [k, v] of Object.entries(q.props)) properties[k] = v;
    // Query fields with defaults are reported as required by io:'input' only when no default; keep as-is.
    for (const r of q.required) required.add(r);

    if (body) {
        properties.body = { ...jsonSchema(body), description: 'JSON request body' };
        required.add('body');
    }
    return {
        type: 'object',
        properties,
        required: [...required],
        additionalProperties: false,
    };
}

export function buildRegistry(): ApiTool[] {
    const tools: ApiTool[] = [];
    for (const [name, value] of Object.entries(contract as Record<string, unknown>)) {
        const cmd = value as ContractCommand;
        if (!name.endsWith('Command') || !cmd || typeof cmd !== 'object' || !cmd.endpointDetails) continue;
        if (ALWAYS_BLOCKED.has(name)) continue;

        const path = typeof cmd.url === 'string' ? cmd.url : cmd.TSQ_url;
        const pathParams = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
        const d = cmd.endpointDetails;
        const kind = EFFECTIVELY_READ.has(name) || d.SCOPE_KIND === 'read' ? 'read' : 'write';
        const method = d.REQUEST_METHOD.toUpperCase();
        const body = method === 'GET' ? undefined : cmd.RequestBodySchema;

        const description = [
            d.METHOD_DESCRIPTION,
            d.METHOD_LONG_DESCRIPTION,
            `[${kind.toUpperCase()}] ${method} ${path}`,
        ]
            .filter(Boolean)
            .join('\n');

        tools.push({
            name: toolName(name),
            command: name,
            method,
            path,
            kind,
            description,
            pathParams,
            paramSchema: cmd.RequestParamSchema,
            querySchema: cmd.RequestQuerySchema,
            bodySchema: body,
            inputSchema: buildInputSchema(pathParams, cmd.RequestParamSchema, cmd.RequestQuerySchema, body),
        });
    }
    return tools.sort((a, b) => a.name.localeCompare(b.name));
}
