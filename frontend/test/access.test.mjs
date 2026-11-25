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

test('admin web session protects all three APIs, handles a planting and revokes access on logout', async (t) => {
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

    await t.test('one browser can sign into all three roles and log out of just one', async () => {
      const browserCookies = new Map();
      const request = async (path, { method = 'GET', body, overrideCookie } = {}) => {
        const cookie =
          overrideCookie ??
          [...browserCookies.entries()]
            .filter(([scope]) => path.startsWith(scope))
            .map(([, value]) => value)
            .join('; ');
        const response = await fetch(app + path, {
          method,
          headers: {
            Origin: app,
            'Content-Type': 'application/json',
            'X-Nursery-Request': '1',
            Cookie: cookie,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const assigned = response.headers.get('set-cookie');
        if (assigned) {
          const scope = /; Path=([^;]+)/.exec(assigned)[1];
          assert.equal(scope, '/' + path.split('/')[1] + '/');
          if (assigned.includes('Max-Age=0')) browserCookies.delete(scope);
          else browserCookies.set(scope, assigned.split(';')[0]);
        }
        return response;
      };
      assert.match(await (await request('/employee/')).text(), /Сотрудник/);
      const registration = { username: 'tab-buyer', password: 'test-buyer-password', name: 'Покупатель' };
      assert.equal(
        (await request('/customer/api/shop/register', { method: 'POST', body: registration })).status,
        201,
      );
      assert.equal((await request('/admin/api/login', { method: 'POST', body: auth })).status, 200);
      const { username, password } = employees[0];
      assert.equal(
        (await request('/employee/api/employee/login', { method: 'POST', body: { username, password } }))
          .status,
        200,
      );

      for (const [scope, bundle, dataPath] of [
        ['/admin/', 'ui.js', 'api/session'],
        ['/employee/', 'employee.js', 'api/employee/tasks'],
        ['/customer/', 'customer.js', 'api/shop/cart'],
      ]) {
        assert.match(await (await request(scope)).text(), new RegExp(scope + bundle.replace('.', '\\.')));
        assert.equal((await request(scope + dataPath)).status, 200);
      }
      assert.equal((await request('/customer/api/login', { method: 'POST', body: auth })).status, 403);
      assert.equal(
        (await request('/admin/api/session', { overrideCookie: browserCookies.get('/customer/') })).status,
        401,
      );
      assert.equal((await request('/admin/api/logout', { method: 'POST' })).status, 200);
      assert.match(await (await request('/admin/')).text(), /login\.js/);
      assert.equal((await request('/employee/api/employee/tasks')).status, 200);
      assert.equal((await request('/customer/api/shop/cart')).status, 200);
    });
  } finally {
    for (const server of servers.reverse()) await new Promise((r) => server.close(r));
    stock.close();
    db.close();
  }
});
