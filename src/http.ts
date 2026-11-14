import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpListener, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpConfig {
    host: string;
    port: number;
    token: string;
}

export function loadHttpConfig(env = process.env): HttpConfig {
    const token = env.REMNAWAVE_HTTP_TOKEN;
    if (!token || !/^[A-Za-z0-9._~+/=-]+$/.test(token))
        throw new Error('REMNAWAVE_HTTP_TOKEN is required in HTTP mode (use a separate, random Bearer token)');
    const port = Number(env.REMNAWAVE_HTTP_PORT || '3001');
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('REMNAWAVE_HTTP_PORT must be an integer between 1 and 65535');
    return { host: env.REMNAWAVE_HTTP_HOST || '127.0.0.1', port, token };
}

const MAX_SESSIONS = 32;
const MAX_BODY = 1024 * 1024;
const IDLE_MS = 30 * 60_000;
const MAX_REQUESTS = 64;
const hash = (s: string) => createHash('sha256').update(s).digest();

interface Session {
    transport: StreamableHTTPServerTransport;
    server: Server;
    lastActive: number;
}

function fail(res: ServerResponse, status: number, message: string) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

class BodyError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                chunks.length = 0;
                reject(new BodyError(413, 'Request body too large'));
            } else chunks.push(chunk);
        });
        req.once('end', () => {
            if (size > MAX_BODY) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new BodyError(400, 'Invalid JSON'));
            }
        });
        req.once('error', reject);
        req.once('aborted', () => reject(new Error('Request aborted')));
    });
}

/** One MCP server per session: privacy maps, node-job caches and version checks are never shared. */
export function createHttpServer(cfg: HttpConfig, makeServer: () => Server) {
    if (!cfg.token || !/^[A-Za-z0-9._~+/=-]+$/.test(cfg.token))
        throw new Error('REMNAWAVE_HTTP_TOKEN is required in HTTP mode');
    const expected = hash(cfg.token);
    const sessions = new Map<string, Session>();
    let pending = 0;
    let active = 0;

    async function closeSession(id: string, session: Session) {
        if (sessions.get(id) === session) sessions.delete(id);
        await session.server.close();
    }

    async function route(req: IncomingMessage, res: ServerResponse) {
        if (req.url !== '/mcp') return fail(res, 404, 'Not found');

        // This endpoint is for native/server-side clients, not browser cross-origin requests.
        // Reject Origin rather than enabling CORS or relying on the reverse proxy for this check.
        if (req.headers.origin !== undefined) return fail(res, 403, 'Origin not allowed');

        const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(req.headers.authorization ?? '');
        if (!match || !timingSafeEqual(hash(match[1]), expected)) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            return fail(res, 401, 'Unauthorized');
        }
        if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
            res.setHeader('Allow', 'POST, GET, DELETE');
            return fail(res, 405, 'Method not allowed');
        }
        if (active >= MAX_REQUESTS) return fail(res, 503, 'Too many requests');
        active++;
        res.once('close', () => active--);

        const id = req.headers['mcp-session-id'];
        if (Array.isArray(id)) return fail(res, 400, 'Invalid session ID');
        const session = id ? sessions.get(id) : undefined;
        if (id && !session) return fail(res, 404, 'Session not found');

        let body: unknown;
        if (req.method === 'POST') {
            if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
                return fail(res, 415, 'Expected application/json');
            body = await readBody(req);
        }
        if (session) {
            // It may have expired while the request body was being read.
            if (sessions.get(id!) !== session) return fail(res, 404, 'Session not found');
            session.lastActive = Date.now();
            res.once('close', () => { session.lastActive = Date.now(); });
            await session.transport.handleRequest(req, res, body);
            if (req.method === 'DELETE' && res.statusCode < 300 && sessions.get(id!) === session)
                await closeSession(id!, session);
            return;
        }
        if (req.method !== 'POST' || !isInitializeRequest(body))
            return fail(res, 400, 'Initialize a session first');
        if (sessions.size + pending >= MAX_SESSIONS) return fail(res, 503, 'Too many sessions');

        pending++;
        let initialized = false;
        const sessionId = randomUUID();
        let next: Session | undefined;
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
                enableJsonResponse: true,
                onsessioninitialized: (sid) => {
                    initialized = true;
                    pending--;
                    sessions.set(sid, next!);
                },
            });
            next = { transport, server: makeServer(), lastActive: Date.now() };
            const current = next;
            transport.onclose = () => {
                if (sessions.get(sessionId) === current) sessions.delete(sessionId);
            };
            await current.server.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch (e) {
            if (next) await closeSession(sessionId, next);
            throw e;
        } finally {
            if (!initialized) {
                pending--;
                if (next) await closeSession(sessionId, next);
            }
        }
    }

    const listener = createHttpListener({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
        route(req, res).catch((e: unknown) => {
            if (e instanceof BodyError) {
                if (e.status === 413) res.setHeader('Connection', 'close');
                fail(res, e.status, e.message);
            } else fail(res, 500, 'Internal server error');
        });
    });
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [id, session] of sessions)
            if (now - session.lastActive >= IDLE_MS) void closeSession(id, session).catch(() => {});
    }, 60_000);
    timer.unref();
    listener.once('close', () => {
        clearInterval(timer);
        for (const [id, session] of sessions) void closeSession(id, session).catch(() => {});
    });
    return listener;
}
