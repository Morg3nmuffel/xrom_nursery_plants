import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiError, invalid, object } from './validation.mjs';

const bodyLimit = 64 * 1024;
const sessionLifetime = 8 * 60 * 60 * 1000;

export async function readJson(req) {
  const mediaType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'json_required', 'Передайте данные как application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) throw new ApiError(413, 'body_too_large', 'Превышен размер запроса 64 КиБ.');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    invalid('Некорректный JSON.');
  }
  return object(value, 'тело запроса');
}

export function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function sameSecret(value, expected) {
  if (typeof value !== 'string') return false;
  const digest = text => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(value), digest(expected));
}

export function unauthorized() {
  throw new ApiError(401, 'unauthorized', 'Требуется авторизация.');
}

export function missingRoute() {
  throw new ApiError(404, 'not_found', 'Маршрут не найден.');
}

export function bearerToken(req) {
  return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
}

export function adminAccess({ adminUser = 'admin', adminPassword }) {
  if (!adminUser || !adminPassword) throw new Error('Задайте пароль и логин администратора.');
  const sessions = new Map();
  return {
    login({ username, password }) {
      if (!sameSecret(username, adminUser) || !sameSecret(password, adminPassword)) unauthorized();
      const now = Date.now();
      for (const [token, expires] of sessions) {
        if (expires <= now) sessions.delete(token);
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + sessionLifetime);
      return { access_token: token, token_type: 'Bearer', expires_in: sessionLifetime / 1000 };
    },
    require(token) {
      if ((sessions.get(token) ?? 0) <= Date.now()) {
        sessions.delete(token);
        unauthorized();
      }
    },
    logout(token) {
      sessions.delete(token);
      return { logged_out: true };
    },
  };
}

export function jsonServer(route) {
  return createServer({ requestTimeout: 30_000 }, async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      if (req.destroyed && !req.complete) return;
      req.resume();
      if (error instanceof ApiError) {
        return send(res, error.status, { error: { code: error.code, message: error.message, ...error.details } });
      }
      if ((error.errcode & 0xff) === 5) {
        return send(res, 503, { error: { code: 'database_busy', message: 'База занята. Повторите запрос.' } });
      }
      console.error(error);
      send(res, 500, { error: { code: 'internal_error', message: 'Внутренняя ошибка сервиса.' } });
    }
  });
}
