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

async function boot(dir) {
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
  const tasks = await listen(createTasksService(db, { ...config, employees: roster, intervalMs: 100000 }));
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
  return { call, db, store, tasks, async close() {
    for (const server of servers.reverse()) await new Promise(resolve => server.close(resolve));
    db.close(); store.close();
  } };
}

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
