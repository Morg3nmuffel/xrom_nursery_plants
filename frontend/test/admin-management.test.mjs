import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../backend/db.mjs';
import { createService } from '../../backend/api.mjs';
import { createTasksService } from '../../backend/tasks/api.mjs';
import { createMaterialsService } from '../../backend/consumables/api.mjs';
import { openMaterials } from '../../backend/consumables/db.mjs';
import { Stock } from '../../backend/consumables/stock.mjs';
import { recordSale } from '../../backend/sales.mjs';
import { TaskPlanner } from '../../backend/tasks/planner.mjs';
import { createWebServer } from '../server.mjs';

const roster = JSON.parse(readFileSync(new URL('../../backend/examples/task-employees.json', import.meta.url)));
const config = { adminUser: 'admin', adminPassword: 'test-admin', posToken: 'test-pos-key', syncToken: 'test-feed' };

async function boot(dir, clock) {
  const db = openDatabase(join(dir, 'plants.sqlite'));
  const store = openMaterials(join(dir, 'materials.sqlite'));
  const servers = [];
  async function listen(server) {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const plants = await listen(createService(db, config));
  const tasks = await listen(createTasksService(db, { ...config, employees: roster, intervalMs: 100000, clock }));
  const warehouse = await listen(createMaterialsService(store, { ...config, plantUrl: plants, intervalMs: 100000 }));
  const web = await listen(createWebServer({ urls: { plants, tasks, store: warehouse } }));
  let cookie = '';
  async function call(path, method = 'GET', body, status = 200) {
    const res = await fetch(web + '/api/' + path, { method, headers: {
      Origin: web, Cookie: cookie, 'Content-Type': 'application/json', 'X-Nursery-Request': '1',
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.status, status, path + ': ' + JSON.stringify(data.error));
    if (path === 'login') cookie = res.headers.get('set-cookie').split(';')[0];
    return data;
  }
  await call('tasks/employees', 'POST', {}, 401);
  await call('login', 'POST', { username: 'admin', password: config.adminPassword });
  return { call, db, store, tasks, web, async close() {
    for (const server of servers.reverse()) await new Promise(resolve => server.close(resolve));
    db.close(); store.close();
  } };
}

test('a plant photo is validated, survives restart and is shared with the shop until archival', async () => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'nursery-catalog-photo-'));
  let app = await boot(dir.path);
  try {
    const imageBytes = readFileSync(new URL('../public/plants/hydrangea-paniculata-limelight.webp', import.meta.url));
    const reference = (await app.call('plants/plants')).items.find(p => p.care);
    const card = { id: 'test/photo', name: 'Растение с фото', price_rub: 200, care: reference.care };
    const photo = 'data:image/webp;base64,' + imageBytes.toString('base64');
    const unauthorized = await fetch(app.web + '/api/plants/plants', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nursery-Request': '1' },
      body: JSON.stringify({ ...card, photo }),
    });
    assert.equal(unauthorized.status, 401);
    await app.call('plants/plants', 'POST', { ...card, photo: photo.replace('image/webp', 'image/png') }, 400);
    await app.call('plants/plants', 'POST', { ...card, photo: 'data:image/webp;base64,' + 'A'.repeat(7_000_000) }, 413);
    assert.ok(!(await app.call('plants/plants')).items.some(p => p.id === card.id));

    const { image } = await app.call('plants/plants', 'POST', { ...card, photo }, 201);
    assert.match(image, /^\/plant-photos\/[a-f0-9]{32}$/);
    const batch = await app.call('plants/plantings', 'POST',
      { planting_id: 'photo-planting', plant_id: card.id, location: 'Ряд 1', quantity: 2 }, 201);
    await app.call('plants/inventory/' + batch.batch_id, 'PATCH', { version: 1, stage: 'ready' });

    await app.close();
    app = await boot(dir.path);
    const saved = (await app.call('plants/plants')).items.find(p => p.id === card.id);
    assert.deepEqual(saved, { ...card, image });
    const response = await fetch(app.web + image);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes);

    const signup = await fetch(app.web + '/customer/api/shop/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nursery-Request': '1' },
      body: JSON.stringify({ username: 'photo-shopper', password: 'test-customer-password', name: 'Покупатель' }),
    });
    assert.equal(signup.status, 201);
    const shop = await fetch(app.web + '/customer/api/shop/catalog', {
      headers: { Cookie: signup.headers.get('set-cookie').split(';')[0] },
    });
    assert.equal(shop.status, 200);
    assert.equal((await shop.json()).items.find(p => p.id === card.id).image, image);

    await app.call('plants/plants?id=' + encodeURIComponent(card.id), 'DELETE');
    assert.equal((await fetch(app.web + image)).status, 404);
    const restored = await app.call('plants/plants', 'POST', card, 201);
    assert.deepEqual(restored, card);
  } finally {
    await app.close();
    dir.remove();
  }
});

test('admin creates and deletes through the web gateway; database restarts preserve both decisions', async () => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'nursery-admin-'));
  let app = await boot(dir.path);
  try {
    const login = { username: 'worker-six', password: 'test-worker-password' };
    const worker = await app.call('tasks/employees', 'POST', { name: 'Садовник', ...login }, 201);
    assert.equal(worker.id, 6);
    const reference = (await app.call('plants/plants')).items.find(p => p.care);
    const card = { id: 'test/сорт', name: 'Сорт для проверки', price_rub: 42.15, care: reference.care };
    await app.call('plants/plants', 'POST', card, 201);
    const batch = await app.call('plants/plantings', 'POST',
      { planting_id: 'new-planting', plant_id: card.id, location: 'Ряд 3', quantity: 8 }, 201);
    await app.call('plants/inventory/' + batch.batch_id, 'PATCH', { version: 1, stage: 'ready' });
    const receipt = { register_id: 'A', receipt_id: '1', status: 'paid', items: [{ plant_id: card.id, quantity: 1 }] };
    const sale = recordSale(app.db, receipt);
    const task = await app.call('tasks/tasks', 'POST', { title: 'Проверить метки', instructions: 'Записать результат',
      assignee_id: worker.id, batch_id: batch.batch_id }, 201);
    const m = await app.call('store/materials', 'POST', { id: 'm/1', name: 'Метка', unit: 'шт' }, 201);
    const purchase = { operation_id: 'invoice', items: [{ material_id: m.id, quantity: 3 }] };
    await app.call('store/purchases', 'POST', purchase, 201);
    await app.call('store/recipes', 'PUT', { items: purchase.items });
    await app.call('plants/plants/price?id=' + encodeURIComponent(card.id), 'PATCH', { price_rub: -1 }, 400);
    card.price_rub = 0;
    await app.call('plants/plants/price?id=' + encodeURIComponent(card.id), 'PATCH', { price_rub: card.price_rub });
    const [rule] = (await app.call('store/recipes')).items;
    await app.call('store/recipes/' + rule.id, 'DELETE');
    await app.close(); app = await boot(dir.path);
    assert.equal((await app.call('store/recipes')).items.length, 0);
    assert.deepEqual((await app.call('plants/plants')).items.find(p => p.id === card.id), card);
    assert.equal((await app.call('tasks/tasks')).items.find(t => t.id === task.id).assignee_name, worker.name);
    assert.equal((await app.call('store/materials')).items.find(row => row.id === m.id).quantity, 3);
    const loginResponse = await fetch(app.tasks + '/api/tasks/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login),
    });
    assert.equal(loginResponse.status, 200);
    const token = (await loginResponse.json()).access_token;
    const employee = { headers: { Authorization: 'Bearer ' + token } };
    assert.equal((await fetch(app.tasks + '/api/admin/tasks/' + task.id, { ...employee, method: 'DELETE' })).status, 401);
    await app.call('tasks/employees/' + worker.id, 'DELETE');
    assert.equal((await fetch(app.tasks + '/api/tasks', employee)).status, 401);
    await app.call('tasks/tasks/' + task.id, 'DELETE');
    const auto = (await app.call('tasks/tasks')).items.find(t => t.batch_id === batch.batch_id);
    await app.call('tasks/tasks/' + auto.id, 'DELETE');
    new TaskPlanner(app.db, { timeZone: 'Europe/Moscow' }).generate();
    assert.equal((await app.call('tasks/tasks')).items.length, 0);
    await app.call('plants/plants?id=' + encodeURIComponent(card.id), 'DELETE');
    assert.equal((await app.call('plants/inventory/' + batch.batch_id)).quantity, 7);
    await app.call('plants/inventory/' + batch.batch_id, 'DELETE');
    await app.call('store/materials?id=' + encodeURIComponent(m.id), 'DELETE');
    await app.close(); app = await boot(dir.path);
    assert.ok(!(await app.call('tasks/employees')).items.some(e => e.id === worker.id));
    assert.equal((await app.call('tasks/tasks')).items.length, 0);
    assert.ok(!(await app.call('plants/plants')).items.some(p => p.id === card.id));
    assert.equal((await app.call('plants/inventory')).count, 0);
    await app.call('plants/inventory/' + batch.batch_id, 'GET', undefined, 404);
    assert.deepEqual(recordSale(app.db, receipt), { ...sale, replayed: true });
    assert.throws(() => recordSale(app.db, { ...receipt, receipt_id: '2' }), { code: 'insufficient_stock' });
    assert.ok(!(await app.call('store/materials')).items.some(row => row.id === m.id));
    assert.equal((await app.call('store/recipes')).items.length, 0);
    assert.equal((await app.call('store/movements')).items[0].name, m.name);
    assert.equal(new Stock(app.store).post('purchase', purchase).replayed, true);
    await app.call('store/purchases', 'POST', { ...purchase, operation_id: 'another' }, 422);
    assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(app.store.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await app.close();
    dir.remove();
  }
});

test('a staff account created by an admin gets only its own tasks and ten recent completions after restart', async () => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'nursery-employee-'));
  let now = Date.parse('2026-11-21T10:00:00Z');
  const clock = () => new Date(now);
  let app = await boot(dir.path, clock);
  let cookie;
  async function employeeRequest(path, { method = 'GET', body } = {}) {
    return fetch(app.web + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: app.web, 'Content-Type': 'application/json', 'X-Nursery-Request': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const credentials = { username: 'new-worker', password: 'test-worker-password' };
  async function login() {
    const response = await employeeRequest('/api/employee/login', { method: 'POST', body: credentials });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { username: credentials.username });
    const header = response.headers.get('set-cookie');
    assert.match(header, /HttpOnly/);
    cookie = header.split(';')[0];
  }
  async function board(path = '/api/employee/tasks') {
    const response = await employeeRequest(path);
    assert.equal(response.status, 200);
    return response.json();
  }
  const act = (task, action) => employeeRequest('/api/employee/tasks/' + task.id + '/' + action, {
    method: 'POST',
  });
  try {
    assert.equal((await employeeRequest('/employee.js')).status, 401);
    assert.equal((await employeeRequest('/api/employee/tasks')).status, 401);
    await app.call('employee/tasks', 'GET', undefined, 403);
    const worker = await app.call('tasks/employees', 'POST', { name: 'Садовник', ...credentials }, 201);
    const tasks = [];
    for (let i = 0; i < 14; i++) {
      tasks.push(await app.call('tasks/tasks', 'POST',
        { title: 'Задание ' + i, assignee_id: worker.id }, 201));
    }
    const other = await app.call('tasks/tasks', 'POST', { title: 'Задача коллеги', assignee_id: 1 }, 201);
    await login();
    assert.match(await (await employeeRequest('/')).text(), /employee\.js/);
    assert.equal((await employeeRequest('/employee.js')).status, 200);
    for (const path of ['/ui.js', '/api/plants/inventory', '/api/tasks/tasks', '/api/store/materials'])
      assert.equal((await employeeRequest(path)).status, 403);
    const own = await board('/api/employee/tasks?scope=team');
    assert.equal(own.employee.id, worker.id);
    assert.deepEqual(own.items.map(task => task.id), tasks.map(task => task.id));
    assert.equal((await act(other, 'start')).status, 403);
    const premature = await act(tasks[0], 'complete');
    assert.equal(premature.status, 409);
    assert.equal((await premature.json()).error.code, 'task_not_started');

    const completed = tasks.slice(0, 12).reverse();
    for (const task of completed) {
      now += 6 * 60 * 60 * 1000;
      const started = await act(task, 'start');
      assert.equal(started.status, 200);
      assert.equal((await started.json()).status, 'in_progress');
      const finished = await act(task, 'complete');
      assert.equal(finished.status, 200);
      assert.equal((await finished.json()).status, 'done');
    }
    await act(tasks[12], 'start');
    assert.equal((await employeeRequest('/api/logout', { method: 'POST' })).status, 200);
    assert.equal((await employeeRequest('/api/employee/tasks')).status, 401);
    assert.equal(app.db.prepare('SELECT count(*) AS total FROM task_assignments WHERE completed_at IS NOT NULL').get().total, 12);
    await app.close();
    app = await boot(dir.path, clock);
    await login();
    const { items } = await board();
    assert.deepEqual(items.filter(task => task.status === 'done').map(task => task.id),
      completed.slice(-10).reverse().map(task => task.id));
    assert.equal(items.find(task => task.id === tasks[12].id).status, 'in_progress');
    assert.equal(items.find(task => task.id === tasks[13].id).status, 'todo');
    await app.call('tasks/employees/' + worker.id, 'DELETE');
    assert.equal((await employeeRequest('/api/employee/tasks')).status, 401);
  } finally {
    await app.close();
    dir.remove();
  }
});
