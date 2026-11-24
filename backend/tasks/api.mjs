import { randomBytes } from 'node:crypto';
import { adminAccess, bearerToken, jsonServer, missingRoute, readJson, sameSecret, sendJson } from '../http.mjs';
import { ApiError, invalid } from '../validation.mjs';
import { TaskPlanner } from './planner.mjs';

const sessionLifetimeMs = 8 * 60 * 60 * 1000;

function verifyEmployees(employees) {
  if (!Array.isArray(employees) || employees.length !== 5) {
    throw new Error('В списке сотрудников должно быть ровно пять записей.');
  }
  const ids = new Set();
  const usernames = new Set();
  for (const employee of employees) {
    const { id, name, username, password } = employee ?? {};
    if (!Number.isInteger(id) || id < 1 || id > 5 || ids.has(id) || usernames.has(username) ||
        typeof name !== 'string' || !name.trim() || name.length > 120 ||
        typeof username !== 'string' || !username.trim() || username !== username.trim() || username.length > 120 ||
        typeof password !== 'string' || !password.trim() || password.length > 1024) {
      throw new Error('Для каждого сотрудника укажите уникальные id от 1 до 5 и username, а также name и password.');
    }
    ids.add(id);
    usernames.add(username);
  }
}

export function createTasksService(db, {
  employees, adminUser, adminPassword, timeZone = 'Europe/Moscow', intervalMs = 30_000, clock,
}) {
  verifyEmployees(employees);
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2147483647) {
    throw new Error('TASKS_INTERVAL_MS должен быть положительным целым числом до 2147483647.');
  }
  const employeeByLogin = new Map(employees.map(employee => [employee.username, employee]));
  const employeeNames = new Map(employees.map(({ id, name }) => [id, name.trim()]));
  const assigneeIds = [...employeeNames.keys()].sort((a, b) => a - b);
  const planner = new TaskPlanner(db, { assigneeIds, timeZone, clock });
  const sessions = new Map();
  const admin = adminPassword ? adminAccess({ adminUser, adminPassword }) : null;

  function getSession(token) {
    const session = sessions.get(token);
    if (session && session.expires > Date.now()) return session;
    sessions.delete(token);
    throw new ApiError(401, 'unauthorized', 'Требуется авторизация сотрудника.');
  }

  function withAssigneeName(task) {
    return { ...task, assignee_name: employeeNames.get(task.assignee_id) };
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
        return sendJson(res, 200, { date, time_zone: timeZone, items: items.map(withAssigneeName),
          employees: [...employeeNames].map(([id, name]) => ({ id, name })) });
      }
      missingRoute();
    }
    if (pathname === '/health' && method === 'GET') {
      db.prepare('SELECT 1 FROM task_assignments LIMIT 1').get();
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname === '/api/tasks/login' && method === 'POST') {
      const { username, password } = await readJson(req);
      const employee = employeeByLogin.get(username);
      if (!employee || !sameSecret(password, employee.password)) {
        throw new ApiError(401, 'invalid_credentials', 'Неверный логин или пароль.');
      }
      const now = Date.now();
      for (const [token, session] of sessions) {
        if (session.expires <= now) sessions.delete(token);
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { id: employee.id, expires: now + sessionLifetimeMs });
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
        date, time_zone: timeZone, employee: { id, name: employeeNames.get(id) }, items: items.map(withAssigneeName),
      });
    }
    const task = /^\/api\/tasks\/([1-9]\d*)\/(start|complete)$/.exec(pathname);
    if (task && method === 'POST') {
      const { id } = getSession(token);
      const taskId = Number(task[1]);
      if (!Number.isSafeInteger(taskId)) invalid('Некорректный идентификатор задачи.');
      return sendJson(res, 200, withAssigneeName(planner.changeStatus(taskId, id, task[2])));
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
