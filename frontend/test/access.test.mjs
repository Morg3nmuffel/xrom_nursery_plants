import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../../backend/db.mjs';
import { Inventory } from '../../backend/inventory.mjs';
import { createService } from '../../backend/api.mjs';
import { createTasksService } from '../../backend/tasks/api.mjs';
import { createMaterialsService } from '../../backend/consumables/api.mjs';
import { openMaterials } from '../../backend/consumables/db.mjs';
import { Stock } from '../../backend/consumables/stock.mjs';
import { createWebServer } from '../server.mjs';

test('admin web session protects all three APIs, handles a planting and revokes access on logout', async () => {
  const db = openDatabase(':memory:'),
    stock = openMaterials(':memory:');
  const employees = JSON.parse(
    readFileSync(new URL('../../backend/examples/task-employees.json', import.meta.url)),
  );
  const config = {
    adminUser: 'admin',
    adminPassword: 'test-admin-password',
    posToken: 'test-pos',
    syncToken: 'test-sync',
  };
  const servers = [];
  async function listen(server) {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  try {
    new Inventory(db).seedDemo();
    new Stock(stock).seedDemo();
    const plants = await listen(createService(db, config));
    const tasks = await listen(createTasksService(db, { ...config, employees, intervalMs: 15 }));
    const store = await listen(
      createMaterialsService(stock, { ...config, plantUrl: plants, intervalMs: 15 }),
    );
    const app = await listen(createWebServer({ urls: { plants, tasks, store } }));
    const auth = { username: 'admin', password: config.adminPassword };
    let cookie;
    const call = (path, { method = 'GET', body, origin = app } = {}) =>
      fetch(app + path, {
        method,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Nursery-Request': '1',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    for (const path of ['/ui.js', '/api/plants/inventory', '/api/tasks/tasks', '/api/store/materials'])
      assert.equal((await call(path)).status, 401);
    assert.match(await (await call('/')).text(), /login\.js/);
    assert.equal((await call('/api/login', { method: 'POST', body: employees[0] })).status, 401);
    const logged = await call('/api/login', { method: 'POST', body: auth });
    assert.equal(logged.status, 200);
    assert.deepEqual(await logged.json(), { username: 'admin' });
    const header = logged.headers.get('set-cookie');
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Strict/i);
    cookie = header.split(';')[0];
    assert.match(await (await call('/')).text(), /ui\.js/);
    assert.equal(
      (await call('/api/store/usage', { method: 'POST', body: {}, origin: 'https://unrelated.invalid' }))
        .status,
      403,
    );
    assert.equal((await call('/api/tasks/1/complete', { method: 'POST', body: {} })).status, 404);
    const sample = {
      planting_id: 'panel-test',
      plant_id: 'lavandula-angustifolia',
      quantity: 4,
      location: 'Стеллаж 1',
    };
    const registered = await call('/api/plants/plantings', { method: 'POST', body: sample });
    assert.equal(registered.status, 201);
    const batch = (await registered.json()).batch_id;
    assert.equal((await call('/api/plants/plantings', { method: 'POST', body: sample })).status, 200);
    let jobs, assigned;
    for (let i = 0; i < 100; i++) {
      jobs = (await (await call('/api/store/plantings')).json()).items;
      assigned = (await (await call('/api/tasks/tasks')).json()).items.filter((t) => t.batch_id === batch);
      if (assigned.length && jobs[0]?.status === 'applied') break;
      await delay(15);
    }
    assert.equal(assigned.length, 1);
    assert.equal(jobs[0].status, 'applied');
    const inv = await (await call('/api/plants/inventory/' + batch)).json();
    assert.equal(
      (
        await call('/api/plants/inventory/' + batch, {
          method: 'PATCH',
          body: { version: inv.version, stage: 'rooting' },
        })
      ).status,
      200,
    );
    const materials = (await (await call('/api/store/materials')).json()).items;
    assert.deepEqual(
      materials.map((m) => m.quantity),
      [96, 48],
    );
    assert.equal((await call('/api/logout', { method: 'POST' })).status, 200);
    assert.equal((await call('/api/store/materials')).status, 401);
  } finally {
    for (const server of servers.reverse()) await new Promise((r) => server.close(r));
    stock.close();
    db.close();
  }
});
