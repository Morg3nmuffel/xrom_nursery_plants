import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sendJson } from '../backend/http.mjs';
import { ApiError } from '../backend/validation.mjs';

const files = new Map([
  ['/login.js', ['login.js', 'text/javascript']],
  ['/ui.js', ['ui.js', 'text/javascript']],
  ['/employee.js', ['employee.js', 'text/javascript']],
  ['/customer.js', ['customer.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/greenhouse.jpg', ['greenhouse.jpg', 'image/jpeg']],
]);
const routes = [
  ['plants', 'GET', /^\/(inventory|plants|inventory\/[1-9]\d*(\/history)?)$/],
  ['plants', 'POST', /^\/(plantings|plants)$/],
  ['plants', 'DELETE', /^\/(plants|inventory\/[1-9]\d*)$/],
  ['plants', 'PATCH', /^\/inventory\/[1-9]\d*$/],
  ['tasks', 'GET', /^\/(tasks|employees)$/],
  ['tasks', 'POST', /^\/(tasks|employees)$/],
  ['tasks', 'DELETE', /^\/(tasks|employees)\/[1-9]\d*$/],
  ['store', 'GET', /^\/(materials|movements|recipes|plantings|sync)$/],
  ['store', 'POST', /^\/(materials|purchases|usage)$/],
  ['plants', 'PATCH', /^\/plants\/price$/],
  ['plants', 'GET', /^\/conversations(?:\/[1-9]\d*)?$/],
  ['plants', 'POST', /^\/conversations\/[1-9]\d*$/],
  ['store', 'DELETE', /^\/recipes\/[1-9]\d*$/],
  ['store', 'PUT', /^\/recipes$/],
  ['store', 'DELETE', /^\/materials$/],
];
const shopRoutes = new Map([
  ['/api/shop/session', ['GET']],
  ['/api/shop/catalog', ['GET']],
  ['/api/shop/cart', ['GET', 'PUT']],
  ['/api/shop/conversation', ['GET', 'POST']],
]);
const loginRoles = new Map([
  ['/api/login', 'admin'],
  ['/api/employee/login', 'employee'],
  ['/api/shop/login', 'customer'],
  ['/api/shop/register', 'customer'],
]);
const bundles = { admin: 'ui', employee: 'employee', customer: 'customer' };
const sessionName = 'nursery_admin';
const sessionMs = 8 * 60 * 60 * 1000;

export function createWebServer({ urls, secureCookie = false }) {
  const sessions = new Map();
  const attempts = new Map();
  const cookie = (value, age) =>
    sessionName +
    '=' +
    value +
    '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' +
    age +
    (secureCookie ? '; Secure' : '');

  async function upstream(service, path, method, token, body) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await fetch(new URL(path, urls[service]), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(path === '/api/shop/conversation' && method === 'POST' ? 13_000 : 6000),
        redirect: 'error',
      });
      return { status: response.status, data: await response.json() };
    } catch {
      throw new ApiError(
        503,
        'service_unavailable',
        'Нет связи с сервисом «' +
          { plants: 'Учёт растений', tasks: 'Задачи', store: 'Склад' }[service] +
          '».',
      );
    }
  }
  function revoke({ role, tokens }) {
    const path = { employee: '/api/tasks/logout', admin: '/api/admin/logout', customer: '/api/shop/logout' }[
      role
    ];
    return Promise.allSettled(
      Object.entries(tokens).map(([service, token]) => upstream(service, path, 'POST', token)),
    );
  }
  async function authenticate(role, credentials, registration) {
    const path = {
      employee: '/api/tasks/login',
      admin: '/api/admin/login',
      customer: registration ? '/api/shop/register' : '/api/shop/login',
    }[role];
    const services = { employee: ['tasks'], customer: ['plants'], admin: ['plants', 'tasks', 'store'] }[role];
    const tokens = {};
    try {
      for (const service of services) {
        const result = await upstream(service, path, 'POST', null, credentials);
        if (result.status === 401)
          throw new ApiError(401, 'invalid_credentials', 'Проверьте логин и пароль.');
        if (role === 'customer' && result.status >= 400 && result.status < 500) {
          throw new ApiError(result.status, result.data.error.code, result.data.error.message);
        }
        if (result.status !== (registration ? 201 : 200) || !result.data.access_token)
          throw new ApiError(503, 'login_unavailable', 'Вход временно недоступен.');
        tokens[service] = result.data.access_token;
      }
      return tokens;
    } catch (error) {
      await revoke({ role, tokens });
      throw error;
    }
  }
  function prune(map, now) {
    for (const [key, item] of map) if (item.expires <= now) map.delete(key);
  }

  async function route(req, res) {
    const { pathname, search } = new URL(req.url, 'http://localhost');
    const method = req.method;
    const sid = /(?:^|;\s*)nursery_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const now = Date.now();
    let session = sessions.get(sid);
    if (session && session.expires <= now) {
      sessions.delete(sid);
      session = null;
    }
    if (!['GET', 'HEAD'].includes(method)) {
      const origin = req.headers.origin;
      if (
        req.headers['x-nursery-request'] !== '1' ||
        (origin && origin !== (secureCookie ? 'https://' : 'http://') + req.headers.host)
      ) {
        throw new ApiError(403, 'origin_denied', 'Недопустимый источник запроса.');
      }
    }
    const loginRole = loginRoles.get(pathname);
    if (loginRole && method === 'POST') {
      prune(attempts, now);
      prune(sessions, now);
      const { username, password, name } = await readJson(req);
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw new ApiError(400, 'credentials_required', 'Введите логин и пароль.');
      }
      const ip = req.socket.remoteAddress;
      const attempt = attempts.get(ip) || { count: 0, expires: now + 60_000 };
      if (attempt.count >= 12) throw new ApiError(429, 'too_many_attempts', 'Повторите вход через минуту.');
      attempt.count++;
      attempts.set(ip, attempt);
      const registration = pathname === '/api/shop/register';
      const tokens = await authenticate(loginRole, { username, password, name }, registration);
      attempts.delete(ip);
      if (session) {
        sessions.delete(sid);
        await revoke(session);
      }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { username, role: loginRole, tokens, expires: now + sessionMs });
      res.setHeader('Set-Cookie', cookie(id, sessionMs / 1000));
      return sendJson(res, registration ? 201 : 200, { username });
    }
    if (pathname.startsWith('/api/') || ['/ui.js', '/employee.js', '/customer.js'].includes(pathname)) {
      if (!session) throw new ApiError(401, 'unauthorized', 'Войдите в питомник.');
      if (pathname === '/api/logout' && method === 'POST') {
        sessions.delete(sid);
        res.setHeader('Set-Cookie', cookie('', 0));
        await revoke(session);
        return sendJson(res, 200, { logged_out: true });
      }
      const employeeRoute = pathname.startsWith('/api/employee/') || pathname === '/employee.js';
      const shopRoute = pathname.startsWith('/api/shop/') || pathname === '/customer.js';
      const requiredRole = employeeRoute ? 'employee' : shopRoute ? 'customer' : 'admin';
      if (session.role !== requiredRole)
        throw new ApiError(403, 'forbidden', 'Этот раздел недоступен для вашей учётной записи.');

      async function forward(service, path, body) {
        const result = await upstream(service, path, method, session.tokens[service], body);
        if (result.status === 401) {
          sessions.delete(sid);
          res.setHeader('Set-Cookie', cookie('', 0));
          await revoke(session);
        }
        return sendJson(res, result.status, result.data);
      }
      if (employeeRoute) {
        if (pathname === '/api/employee/tasks' && method === 'GET') return forward('tasks', '/api/tasks');
        const taskAction = /^\/api\/employee(\/tasks\/[1-9]\d*\/(start|complete))$/.exec(pathname);
        if (taskAction && method === 'POST') return forward('tasks', '/api' + taskAction[1]);
      } else if (shopRoute) {
        if (shopRoutes.get(pathname)?.includes(method)) {
          const body = method === 'GET' ? undefined : await readJson(req);
          return forward('plants', pathname, body);
        }
      } else {
        if (pathname === '/api/session' && method === 'GET')
          return sendJson(res, 200, { username: session.username });
        const parts = /^\/api\/(plants|tasks|store)(\/.*)$/.exec(pathname);
        if (
          parts &&
          routes.some(
            ([service, verb, pattern]) => service === parts[1] && verb === method && pattern.test(parts[2]),
          )
        ) {
          const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req);
          return forward(parts[1], '/api/admin' + parts[2] + search, body);
        }
      }
    }
    if (method === 'GET' && pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Питомник · Панель управления</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script defer src="/' +
          (session ? bundles[session.role] : 'login') +
          '.js"></script></body></html>',
      );
    }
    const asset = files.get(pathname);
    if (method === 'GET' && asset) {
      const data = await readFile(new URL('./public/' + asset[0], import.meta.url));
      res.setHeader('Content-Type', asset[1]);
      return res.end(data);
    }
    throw new ApiError(404, 'not_found', 'Маршрут не найден.');
  }
  return createServer({ requestTimeout: 30_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      await route(req, res);
    } catch (error) {
      if (req.destroyed && !req.complete) return;
      req.resume();
      if (error instanceof ApiError)
        return sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      console.error(error.message);
      sendJson(res, 500, { error: { code: 'internal_error', message: 'Ошибка веб-приложения.' } });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WEB_PORT || 8790);
  const host = process.env.WEB_HOST || '127.0.0.1';
  const app = createWebServer({
    urls: {
      plants: process.env.WEB_PLANTS_URL || 'http://127.0.0.1:8787',
      tasks: process.env.WEB_TASKS_URL || 'http://127.0.0.1:8788',
      store: process.env.WEB_STORE_URL || 'http://127.0.0.1:8789',
    },
    secureCookie: process.env.WEB_SECURE_COOKIE === '1',
  });
  app.listen(port, host, () => {
    const url = 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + app.address().port + '/';
    console.log('Панель питомника: ' + url);
    if (process.platform === 'darwin' && process.argv.includes('--open')) spawn('open', [url]).unref();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
}
