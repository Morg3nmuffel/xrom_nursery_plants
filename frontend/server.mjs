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
  ['/style.css', ['style.css', 'text/css']],
  ['/greenhouse.jpg', ['greenhouse.jpg', 'image/jpeg']],
]);
const routes = [
  ['plants', 'GET', /^\/(inventory|plants|inventory\/[1-9]\d*(\/history)?)$/],
  ['plants', 'POST', /^\/plantings$/],
  ['plants', 'PATCH', /^\/inventory\/[1-9]\d*$/],
  ['tasks', 'GET', /^\/tasks$/],
  ['store', 'GET', /^\/(materials|movements|recipes|plantings|sync)$/],
  ['store', 'POST', /^\/(materials|purchases|usage)$/],
  ['store', 'PUT', /^\/recipes$/],
];
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
      const response = await fetch(new URL('/api/admin' + path, urls[service]), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
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
  function revoke(tokens) {
    return Promise.allSettled(
      Object.entries(tokens).map(([service, token]) => upstream(service, '/logout', 'POST', token)),
    );
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
    if (pathname === '/api/login' && method === 'POST') {
      prune(attempts, now);
      prune(sessions, now);
      const ip = req.socket.remoteAddress;
      const attempt = attempts.get(ip) || { count: 0, expires: now + 60_000 };
      if (attempt.count >= 12) throw new ApiError(429, 'too_many_attempts', 'Повторите вход через минуту.');
      const { username, password } = await readJson(req);
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        throw new ApiError(400, 'credentials_required', 'Введите логин и пароль.');
      }
      attempt.count++;
      attempts.set(ip, attempt);
      const tokens = {};
      try {
        for (const service of ['plants', 'tasks', 'store']) {
          const result = await upstream(service, '/login', 'POST', null, { username, password });
          if (result.status === 401)
            throw new ApiError(
              401,
              'invalid_credentials',
              'Вход доступен администратору. Проверьте логин и пароль.',
            );
          if (result.status !== 200 || !result.data.access_token)
            throw new ApiError(503, 'login_unavailable', 'Проверьте конфигурацию входа трёх сервисов.');
          tokens[service] = result.data.access_token;
        }
      } catch (error) {
        await revoke(tokens);
        throw error;
      }
      attempts.delete(ip);
      if (session) {
        sessions.delete(sid);
        await revoke(session.tokens);
      }
      const id = randomBytes(32).toString('hex');
      sessions.set(id, { username, tokens, expires: now + sessionMs });
      res.setHeader('Set-Cookie', cookie(id, sessionMs / 1000));
      return sendJson(res, 200, { username });
    }
    if (pathname.startsWith('/api/') || pathname === '/ui.js') {
      if (!session) throw new ApiError(401, 'unauthorized', 'Войдите под учётной записью администратора.');
      if (pathname === '/api/session' && method === 'GET')
        return sendJson(res, 200, { username: session.username });
      if (pathname === '/api/logout' && method === 'POST') {
        sessions.delete(sid);
        res.setHeader('Set-Cookie', cookie('', 0));
        await revoke(session.tokens);
        return sendJson(res, 200, { logged_out: true });
      }
      const parts = /^\/api\/(plants|tasks|store)(\/.*)$/.exec(pathname);
      if (
        parts &&
        routes.some(
          ([service, verb, pattern]) => service === parts[1] && verb === method && pattern.test(parts[2]),
        )
      ) {
        const body = method === 'GET' ? undefined : await readJson(req);
        const result = await upstream(parts[1], parts[2] + search, method, session.tokens[parts[1]], body);
        if (result.status === 401) {
          sessions.delete(sid);
          res.setHeader('Set-Cookie', cookie('', 0));
          await revoke(session.tokens);
        }
        return sendJson(res, result.status, result.data);
      }
    }
    if (method === 'GET' && pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Питомник · Панель управления</title><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script defer src="/' +
          (session ? 'ui' : 'login') +
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
