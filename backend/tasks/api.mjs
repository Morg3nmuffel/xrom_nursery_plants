import { randomBytes } from 'node:crypto';
import { adminAccess, bearerToken, jsonServer, missingRoute, readJson, sendJson } from '../http.mjs';
import { ApiError, invalid } from '../validation.mjs';
import { TaskPlanner } from './planner.mjs';
import { Employees } from './employees.mjs';

const sessionLifetimeMs = 8 * 60 * 60 * 1000;

export function createTasksService(db, {
  employees, adminUser, adminPassword, timeZone = 'Europe/Moscow', intervalMs = 30_000, clock,
  seedDemoBoard = false,
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
    throw new Error('TASKS_INTERVAL_MS должен быть положительным целым числом до 2147483647.');
  }
  const planner = new TaskPlanner(db, { timeZone, clock });
  const roster = new Employees(db, employees);
  if (seedDemoBoard) planner.seedDemoBoard();
  const sessions = new Map();
  const admin = adminPassword ? adminAccess({ adminUser, adminPassword }) : null;

  function getSession(token) {
    const session = sessions.get(token);
    if (session && session.expires > Date.now() &&
        db.prepare('SELECT 1 FROM employees WHERE id = ? AND removed_at IS NULL').get(session.id)) return session;
    sessions.delete(token);
    throw new ApiError(401, 'unauthorized', 'Требуется авторизация сотрудника.');
  }

  async function route(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (admin && pathname.startsWith('/api/admin/')) {
      if (pathname === '/api/admin/login' && method === 'POST') {
        return sendJson(res, 200, admin.login(await readJson(req)));
      }
      const token = bearerToken(req);
      admin.require(token);
      if (pathname === '/api/admin/logout' && method === 'POST') return sendJson(res, 200, admin.logout(token));
      if (pathname === '/api/admin/tasks' && method === 'GET') {
        const { date, items } = planner.list();
        return sendJson(res, 200, { date, time_zone: timeZone, items, employees: roster.list() });
      }
      if (pathname === '/api/admin/employees' && method === 'GET') return sendJson(res, 200, { items: roster.list() });
      if (pathname === '/api/admin/employees' && method === 'POST') return sendJson(res, 201, roster.add(await readJson(req)));
      if (pathname === '/api/admin/tasks' && method === 'POST') return sendJson(res, 201, planner.add(await readJson(req)));
      const target = /^\/api\/admin\/(employees|tasks)\/([1-9]\d*)$/.exec(pathname);
      if (target && method === 'DELETE') {
        const id = Number(target[2]);
        if (!Number.isSafeInteger(id)) invalid('Некорректный идентификатор.');
        return sendJson(res, 200, target[1] === 'employees' ? roster.remove(id) : planner.remove(id));
      }
      missingRoute();
    }
    if (pathname === '/health' && method === 'GET') {
      db.prepare('SELECT 1 FROM task_assignments LIMIT 1').get();
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname === '/api/tasks/login' && method === 'POST') {
      const { username, password } = await readJson(req);
      const employeeId = roster.authenticate(username, password);
      if (employeeId === null) {
        throw new ApiError(401, 'invalid_credentials', 'Неверный логин или пароль.');
      }
      const now = Date.now();
      for (const [token, session] of sessions) {
        if (session.expires <= now) sessions.delete(token);
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { id: employeeId, expires: now + sessionLifetimeMs });
      return sendJson(res, 200, { access_token: token, token_type: 'Bearer', expires_in: sessionLifetimeMs / 1000 });
    }

    const token = bearerToken(req);
    if (pathname === '/api/tasks/logout' && method === 'POST') {
      getSession(token);
      sessions.delete(token);
      return sendJson(res, 200, { logged_out: true });
    }
    if (pathname === '/api/tasks' && method === 'GET') {
      const { id } = getSession(token);
      const scope = searchParams.get('scope') ?? 'mine';
      if (scope !== 'mine' && scope !== 'team') invalid('Допустимые значения scope: mine и team.');
      const { date, items } = planner.list(scope === 'mine' ? id : null);
      return sendJson(res, 200, {
        date, time_zone: timeZone, employee: { id, name: db.prepare('SELECT name FROM employees WHERE id = ?').get(id).name }, items,
      });
    }
    const task = /^\/api\/tasks\/([1-9]\d*)\/(start|complete)$/.exec(pathname);
    if (task && method === 'POST') {
      const { id } = getSession(token);
      const taskId = Number(task[1]);
      if (!Number.isSafeInteger(taskId)) invalid('Некорректный идентификатор задачи.');
      return sendJson(res, 200, planner.changeStatus(taskId, id, task[2]));
    }
    missingRoute();
  }

  planner.generate();
  const server = jsonServer(route);
  let timer;
  server.once('listening', () => {
    timer = setInterval(() => {
      try {
        planner.generate();
      } catch (error) {
        console.error('Ошибка автоматического назначения задач:', error.message);
      }
    }, intervalMs);
    timer.unref();
  });
  server.once('close', () => clearInterval(timer));
  return server;
}
