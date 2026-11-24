import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createService } from '../api.mjs';
import { importCatalog, openDatabase } from '../db.mjs';
import { Inventory } from '../inventory.mjs';
import { createMaterialsService } from '../consumables/api.mjs';
import { openMaterials } from '../consumables/db.mjs';
import { PlantingQueue } from '../consumables/plantings.mjs';
import { Stock } from '../consumables/stock.mjs';

const items = (pot, soil) => [{ material_id: 'pot', quantity: pot }, { material_id: 'soil', quantity: soil }];
const balance = stock => stock.materials().map(m => m.quantity);
const at = () => new Date().toISOString();
const event = (seq, plant_id, quantity) => ({ seq, planting_id: 'planting-' + seq, plant_id, quantity, recorded_at: at() });
const sample = JSON.parse(readFileSync(new URL('../examples/planting.json', import.meta.url)));

test('material catalog, fractional purchases, manual usage, immutable replay and whole-document rollback', t => {
  const db = openMaterials(':memory:');
  t.after(() => db.close());
  const stock = new Stock(db);
  assert.deepEqual(balance(stock), [0, 0]);
  const incoming = { operation_id: 'invoice-1', items: items(10, 2.125) };
  const first = stock.post('purchase', incoming);
  stock.post('usage', { operation_id: 'work-1', items: items(1, 0.001) });
  assert.deepEqual(balance(stock), [9, 2.124]);
  assert.deepEqual(stock.post('purchase', { ...incoming, items: [...incoming.items].reverse() }), { ...first, replayed: true });
  assert.throws(() => stock.post('purchase', { ...incoming, items: items(1, 2) }), { code: 'operation_conflict' });
  assert.throws(() => stock.post('usage', { operation_id: 'over', items: items(2, 3) }), { code: 'insufficient_material' });
  assert.deepEqual(balance(stock), [9, 2.124]);
  assert.equal(stock.history().length, 4);
  stock.addMaterial({ id: 'fertilizer', name: 'Удобрение', unit: 'кг', decimals: 3 });
  stock.post('purchase', { operation_id: 'extra', items: [{ material_id: 'fertilizer', quantity: 0.125 }] });
  assert.equal(stock.history('fertilizer')[0].balance_after, 0.125);
  for (const bad of [items(0.5, 1), items(1, 0.1234), items(0, 1), items(1, -1),
    [{ material_id: 'missing', quantity: 1 }], [incoming.items[0], incoming.items[0]]]) {
    assert.throws(() => stock.post('usage', { operation_id: 'invalid', items: bad }));
  }
});

test('shortage keeps every line pending, another planting can settle, purchase retries the original recipe', t => {
  const db = openMaterials(':memory:');
  t.after(() => db.close());
  const stock = new Stock(db);
  const queue = new PlantingQueue(stock);
  stock.setRecipe({ items: items(2, 0.5) });
  stock.setRecipe({ plant_id: 'B', items: [{ material_id: 'pot', quantity: 1 }] });
  stock.post('purchase', { operation_id: 'initial', items: items(100, 1) });
  const events = [event(1, 'A', 3), event(2, 'B', 2)];
  queue.accept(events);
  queue.settlePending();
  assert.deepEqual(balance(stock), [98, 1]);
  assert.deepEqual(queue.jobs('pending')[0].problem,
    { code: 'insufficient_material', material_id: 'soil', unit: 'л', required: 1.5, available: 1 });
  stock.setRecipe({ items: items(1, 0.1) });
  stock.post('purchase', { operation_id: 'top-up', items: [{ material_id: 'soil', quantity: 0.5 }] });
  queue.settlePending();
  queue.accept(events);
  queue.settlePending();
  assert.deepEqual(balance(stock), [92, 0]);
  assert.equal(queue.jobs('applied').length, 2);
  assert.equal(stock.history().filter(row => row.kind === 'planting').length, 3);
});

test('missing recipe, restart and second consumer preserve cursor, assigned recipe and exact-once stock', () => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'xrom-stock-'));
  const filename = join(temp.path, 'stock.sqlite');
  let db = openMaterials(filename);
  try {
    let stock = new Stock(db);
    let queue = new PlantingQueue(stock);
    const row = event(1, 'A', 2);
    queue.accept([row]);
    queue.settlePending();
    assert.equal(queue.jobs()[0].problem.code, 'missing_recipe');
    db.close();
    db = openMaterials(filename);
    stock = new Stock(db);
    queue = new PlantingQueue(stock);
    assert.equal(queue.cursor(), 1);
    assert.throws(() => queue.accept([event(3, 'B', 2)]));
    assert.equal(queue.cursor(), 1);
    stock.seedDemo();
    const secondDb = openMaterials(filename);
    try {
      const second = new PlantingQueue(new Stock(secondDb));
      second.accept([row]);
      second.settlePending();
      queue.settlePending();
      assert.deepEqual(balance(stock), [98, 49]);
      assert.equal(stock.seedDemo(), false);
    } finally { secondDb.close(); }
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => openDatabase(filename), /базу растений/);
  } finally { db.close(); temp.remove(); }
});

test('v2 plant database starts publishing only new plantings in the original transaction', () => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'xrom-feed-'));
  const filename = join(temp.path, 'plants.sqlite');
  let db = new DatabaseSync(filename);
  try {
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec(readFileSync(new URL('../migrations/002-plantings.sql', import.meta.url), 'utf8'));
    db.exec('PRAGMA user_version = 2');
    importCatalog(db);
    new Inventory(db).plant(sample);
    db.close();
    db = openDatabase(filename);
    assert.throws(() => openMaterials(filename), /базу расходников/);
    const inventory = new Inventory(db);
    assert.equal(inventory.plant(sample).replayed, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM planting_feed').get().n, 0);
    assert.throws(() => inventory.plant({ ...sample, planting_id: 'new', plant_id: 'unknown' }));
    const planted = inventory.plant({ ...sample, planting_id: 'new' });
    inventory.update(planted.batch_id, { version: 1, quantity: 1 });
    assert.deepEqual(db.prepare('SELECT seq, planting_id, quantity FROM planting_feed').all().map(r => ({ ...r })),
      [{ seq: 1, planting_id: 'new', quantity: 40 }]);
  } finally { db.close(); temp.remove(); }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function call(base, path, method = 'GET', token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: res.status, data: await res.json() };
}

test('two HTTP services catch up after warehouse downtime, debit once and expose admin purchases and usage', async () => {
  const plantDb = openDatabase(':memory:');
  const stockDb = openMaterials(':memory:');
  const config = { adminPassword: 'test-password', syncToken: 'test-feed-token', posToken: 'test-pos-key' };
  const plants = createService(plantDb, config);
  let warehouse;
  try {
    const plantUrl = await listen(plants);
    const credentials = { username: 'admin', password: config.adminPassword };
    const login = async url => (await call(url, '/api/admin/login', 'POST', null, credentials)).data.access_token;
    const grower = await login(plantUrl);
    assert.equal((await call(plantUrl, '/api/internal/plantings', 'GET', grower)).status, 401);
    assert.equal((await call(plantUrl, '/api/internal/plantings', 'GET', config.posToken)).status, 401);
    assert.equal((await call(plantUrl, '/api/admin/plantings', 'POST', grower, sample)).status, 201);
    assert.equal((await call(plantUrl, '/api/admin/plantings', 'POST', grower, sample)).status, 200);
    new Stock(stockDb).seedDemo();
    warehouse = createMaterialsService(stockDb, { ...config, plantUrl, intervalMs: 15 });
    const base = await listen(warehouse);
    const admin = await login(base);
    const stock = () => call(base, '/api/admin/materials', 'GET', admin);
    assert.equal((await call(base, '/api/admin/materials')).status, 401);
    assert.equal((await call(base, '/api/admin/usage', 'POST', config.syncToken, {})).status, 401);
    const deadline = Date.now() + 4000;
    while (!(await call(base, '/api/admin/plantings?status=applied', 'GET', admin)).data.items.length && Date.now() < deadline) await delay(15);
    assert.deepEqual((await stock()).data.items.map(r => r.quantity), [60, 30]);
    const order = { operation_id: 'invoice-2', items: items(20, 10) };
    const buys = await Promise.all([1, 2].map(() => call(base, '/api/admin/purchases', 'POST', admin, order)));
    assert.deepEqual(buys.map(r => r.status).sort(), [200, 201]);
    assert.equal((await call(base, '/api/admin/usage', 'POST', admin, { operation_id: 'work', items: items(1, 0.25) })).status, 201);
    assert.deepEqual((await stock()).data.items.map(r => r.quantity), [79, 39.75]);
    assert.equal((await call(base, '/api/admin/sync', 'GET', admin)).data.cursor, 1);
    assert.equal((await call(base, '/api/admin/movements?material_id=soil', 'GET', admin)).data.items.length, 4);
    assert.equal((await call(base, '/api/admin/materials', 'POST', admin, { id: 'label', name: 'Этикетка', unit: 'шт' })).status, 201);
    assert.equal((await call(base, '/api/admin/recipes', 'PUT', admin, { plant_id: 'A', items: items(1, 0.125) })).status, 200);
    assert.equal((await call(base, '/api/admin/recipes', 'GET', admin)).data.items.length, 2);
  } finally {
    if (warehouse?.listening) await new Promise(resolve => warehouse.close(resolve));
    if (plants.listening) await new Promise(resolve => plants.close(resolve));
    stockDb.close();
    plantDb.close();
  }
});
