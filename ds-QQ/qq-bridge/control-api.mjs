/**
 * 桥接的本地控制接口：只监听 127.0.0.1，带 token，供 MCP 工具服务器调用。
 *
 * 为什么不让 MCP 服务器自己连 OneBot：
 *   - 白名单、群缓冲、发送日志、读空气状态都在桥接进程里，重复一份就会走样；
 *   - NapCat 只该有一个“主人”，多开 WS 客户端会让策略分散。
 *
 * 这里只做 HTTP 路由与鉴权，真正的动作由 bridge.mjs 注入的 handlers 执行。
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MAX_BODY = 64 * 1024;
const CONSOLE_TTL_MS = 12 * 60 * 60 * 1000;
const CONSOLE_ROUTES = new Set(['/fish/chats', '/fish/status', '/fish/memory', '/fish/diary', '/fish/inbox', '/fish/settings']);

export function newToken() {
  return randomBytes(16).toString('hex');
}

function sameToken(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * @param {object} opts
 * @param {string} opts.token 访问令牌
 * @param {object} opts.handlers { status, send, recent, groups }
 * @param {number} [opts.port] 0 表示随机端口
 * @param {string} [opts.host]
 */
export function startControlServer({ token, handlers, port = 3102, host = '127.0.0.1', now = () => Date.now() }) {
  if (!token) throw new Error('control server 需要 token');
  const consoleSessions = new Map();
  function cleanConsoleSessions() {
    for (const [value, expiry] of consoleSessions) if (expiry <= now()) consoleSessions.delete(value);
  }
  function isLocalConsoleRequest(req) {
    const address = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
    const port = server.address()?.port;
    const validHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const host = req.headers.host;
    // Literal loopback hosts prevent a rebound third-party hostname from
    // obtaining a session. A custom header forces cross-origin preflight.
    return validHosts.includes(host) && req.headers.origin === `http://${host}`
      && req.headers['sec-fetch-site'] === 'same-origin' && req.headers['x-qq-console'] === '1'
      && !req.headers['x-qq-context'];
  }

  const server = createServer(async (req, res) => {
    const requestController = new AbortController();
    res.once('close', () => { if (!res.writableEnded) requestController.abort(); });
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (req.method === 'POST' && url.pathname === '/fish/session') {
      if (!isLocalConsoleRequest(req)) return json(res, 403, { ok: false, error: '请从本机观测台打开' });
      cleanConsoleSessions();
      while (consoleSessions.size >= 32) consoleSessions.delete(consoleSessions.keys().next().value);
      const consoleToken = newToken();
      const expiresAt = now() + CONSOLE_TTL_MS;
      consoleSessions.set(consoleToken, expiresAt);
      return json(res, 200, { ok: true, token: consoleToken, expiresAt });
    }
    if (req.method === 'GET' && (url.pathname === '/fish' || url.pathname === '/fish/')) {
      try {
        const page = await readFile(new URL('./fish-console.html', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': page.length,
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'" });
        return res.end(page);
      } catch { return json(res, 503, { ok: false, error: '观测台暂时不可用' }); }
    }
    cleanConsoleSessions();
    const masterAccess = sameToken(req.headers['x-qq-token'], token);
    const consoleAccess = consoleSessions.has(req.headers['x-qq-token']);
    if (!masterAccess && !consoleAccess) return json(res, 401, { ok: false, error: 'bad token' });
    if (!masterAccess && (!CONSOLE_ROUTES.has(url.pathname) || req.headers['x-qq-context'])) {
      return json(res, 403, { ok: false, error: '观测台令牌仅用于观测台' });
    }

    try {
      const context = handlers.authorize ? await handlers.authorize(req.headers['x-qq-context'], url.pathname) : undefined;
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, { ok: true, ...(await handlers.status(context)) });
      }
      if (req.method === 'GET' && url.pathname === '/groups') {
        return json(res, 200, { ok: true, ...(await handlers.groups(context)) });
      }
      if (req.method === 'GET' && url.pathname === '/recent') {
        const group = url.searchParams.get('group');
        const limit = Number(url.searchParams.get('limit')) || 10;
        if (!group) return json(res, 400, { ok: false, error: '缺少 group 参数' });
        return json(res, 200, { ok: true, ...(await handlers.recent({ group, limit }, context)) });
      }
      if (req.method === 'POST' && url.pathname === '/send') {
        const body = await readJson(req);
        const result = await handlers.send(body, context, { signal: requestController.signal });
        return json(res, result?.ok === false ? 403 : 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/stickers/search' && handlers.findSticker) {
        return json(res, 200, await handlers.findSticker({ query: url.searchParams.get('query') || '', limit: url.searchParams.get('limit') }, context));
      }
      if (req.method === 'POST' && url.pathname === '/stickers/send' && handlers.sendSticker) {
        const result = await handlers.sendSticker(await readJson(req), context, { signal: requestController.signal });
        return json(res, result?.ok === false ? 403 : 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/fish/tool' && handlers.fishTool) {
        const result = await handlers.fishTool(await readJson(req), context, { signal: requestController.signal });
        return json(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/qzone/status' && handlers.qzoneStatus) {
        return json(res, 200, { ok: true, ...await handlers.qzoneStatus(context) });
      }
      if (req.method === 'POST' && url.pathname === '/qzone/post' && handlers.qzonePost) {
        return json(res, 200, await handlers.qzonePost(await readJson(req), context, { signal: requestController.signal }));
      }
      const operation = url.pathname.match(/^\/fish\/(chats|status|memory|diary|inbox|settings)$/)?.[1];
      if (operation && handlers.fishAdmin && ((req.method === 'GET' && operation !== 'settings') || (req.method === 'POST' && operation === 'settings'))) {
        const body = req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
        if (req.method === 'GET') body.read = body.read === 'true';
        return json(res, 200, { ok: true, ...await handlers.fishAdmin(operation, body, context) });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, e.statusCode ?? 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address();
      resolve({
        server,
        port: actual.port,
        host,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
