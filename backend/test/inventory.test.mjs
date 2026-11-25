import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createService } from '../api.mjs';
import { importCatalog, openDatabase } from '../db.mjs';
import { Inventory } from '../inventory.mjs';
import { recordSale } from '../sales.mjs';

const catalog = JSON.parse(readFileSync(new URL('../catalog/plants.json', import.meta.url)));
const sample = JSON.parse(readFileSync(new URL('../examples/paid-receipt.json', import.meta.url)));
const hydrangea = 'hydrangea-paniculata-limelight';
const lavender = 'lavandula-angustifolia';
const thuja = 'thuja-occidentalis-smaragd';
const posToken = 'unit-test-pos-key';
const adminPassword = 'unit-test-admin-password';
const inventoryPath = '/api/admin/inventory';
const salePath = '/api/pos/sales';
const plantingPath = '/api/admin/plantings';
const sowing = JSON.parse(readFileSync(new URL('../examples/planting.json', import.meta.url)));

async function startApi(db, interval = 30_000) {
  const server = createService(db, { posToken, adminPassword, growthIntervalMs: interval });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  return {
    request,
    async login() {
      const res = await request('POST', '/api/admin/login', null, { username: 'admin', password: adminPassword });
      assert.equal(res.status, 200);
      return res.data.access_token;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function fixture(t, interval) {
  const db = openDatabase(':memory:');
  const inventory = new Inventory(db);
  inventory.seedDemo();
  const api = await startApi(db, interval);
  t.after(async () => { await api.close(); db.close(); });
  return { db, inventory, ...api };
}

function receipt(id, items) {
  return { register_id: 'test-pos', receipt_id: id, status: 'paid', items };
}

test('planting adds a separate growing cohort once, visible in inventory and history', async t => {
  const { request, login, inventory } = await fixture(t);
  const admin = await login();
  const post = body => request('POST', plantingPath, admin, body);
  assert.equal((await request('POST', plantingPath, null, sowing)).status, 401);
  assert.equal((await request('POST', plantingPath, posToken, sowing)).status, 401);
  const replies = await Promise.all([post(sowing), post(sowing)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 201]);
  const planting = replies.find(r => r.status === 201).data;
  assert.deepEqual(replies.find(r => r.status === 200).data, { ...planting, replayed: true });
  const path = inventoryPath + '/' + planting.batch_id;
  const detail = (await request('GET', path, admin)).data;
  assert.equal(detail.planted_at, planting.planted_at);
  assert.equal(detail.stage, 'sowing');
  const lavenderLots = inventory.list().items.filter(b => b.plant_id === lavender);
  assert.deepEqual(lavenderLots.map(b => b.quantity), [300, 40]);
  const events = (await request('GET', path + '/history', admin)).data.items;
  assert.deepEqual(events.map(e => [e.kind, e.planting_id, e.planted_at, e.quantity_after]),
    [['planting', sowing.planting_id, planting.planted_at, 40]]);
  const buyOne = receipt('from-planting', [{ plant_id: lavender, quantity: 1 }]);
  assert.equal((await request('POST', salePath, posToken, buyOne)).status, 409);
  assert.equal((await request('PATCH', path, admin, { version: 1, stage: 'ready' })).status, 200);
  assert.equal((await request('POST', salePath, posToken, buyOne)).status, 201);
  assert.deepEqual((await post(sowing)).data, { ...planting, replayed: true });
  assert.equal(inventory.detail(planting.batch_id).quantity, 39);
  const conflict = await post({ ...sowing, quantity: 50 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'planting_conflict');
  const next = await post({ ...sowing, planting_id: 'planting-next' });
  assert.equal(next.status, 201);
  assert.notEqual(next.data.batch_id, planting.batch_id);
});

test('planting a new variety creates its catalog row, validates input and follows its own growth plan', async t => {
  const { request, login, inventory, db } = await fixture(t);
  const admin = await login();
  const post = body => request('POST', plantingPath, admin, body);
  const newPlant = { ...sowing, plant_id: 'new-cultivar', plant_name: 'Новый сорт', stage: 'rooting',
    planted_at: '2020-03-01T08:00:00Z', growth_plan: [{ stage: 'growing', due_at: '2099-04-01T08:00:00Z' }] };
  for (const change of [
    { quantity: 0 }, { quantity: -1 }, { quantity: 0.5 }, { location: ' ' }, { planting_id: '' },
    { stage: 'ready' }, { planted_at: '2020-02-31T08:00:00Z' }, { planted_at: '9999-12-01T00:00:00Z' },
    { growth_plan: [{ stage: 'growing', due_at: newPlant.planted_at }] },
  ]) assert.equal((await post({ ...newPlant, ...change })).status, 400);
  assert.equal((await post({ ...sowing, plant_id: 'unlisted' })).status, 422);
  assert.equal((await post({ ...sowing, plant_name: 'Чужой сорт' })).status, 409);
  assert.equal(inventory.catalog().length, 14);
  assert.equal(inventory.list().count, 5);
  assert.equal(db.prepare('SELECT count(*) AS n FROM plantings').get().n, 0);
  const result = await post(newPlant);
  assert.equal(result.status, 201);
  const catalogItem = inventory.catalog().find(p => p.id === newPlant.plant_id);
  assert.deepEqual(catalogItem, { id: newPlant.plant_id, name: newPlant.plant_name, price_rub: null, care: null });
  assert.equal(result.data.planted_at, '2020-03-01T08:00:00.000Z');
  const batch = inventory.detail(result.data.batch_id);
  assert.equal(batch.stage, 'rooting');
  assert.deepEqual(batch.growth_plan, [{ stage: 'growing', due_at: '2099-04-01T08:00:00.000Z' }]);
  assert.equal(inventory.applyDueGrowth('2099-04-01T08:00:00.000Z'), 1);
  assert.equal(inventory.detail(batch.id).stage, 'growing');
  assert.deepEqual(inventory.history(batch.id).map(e => e.kind), ['planting', 'growth']);
});

test('a v1 database upgrades in place with its stock and receipts; planting retries survive restart', () => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'xrom-planting-upgrade-'));
  const filename = join(temp.path, 'nursery.sqlite');
  let db = new DatabaseSync(filename);
  try {
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec('PRAGMA user_version = 1');
    importCatalog(db);
    db.prepare(`INSERT INTO plant_batches(plant_id, location, stage, quantity, updated_at)
      VALUES (?, 'Теплица 2', 'ready', 7, '2020-01-01T00:00:00.000Z')`).run(hydrangea);
    const paid = receipt('legacy', [{ plant_id: hydrangea, quantity: 2 }]);
    const original = recordSale(db, paid);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    let inventory = new Inventory(db);
    assert.equal(inventory.detail(1).quantity, 5);
    assert.equal(inventory.detail(1).planted_at, null);
    assert.deepEqual(inventory.history(1).map(e => e.kind), ['sale']);
    assert.deepEqual(recordSale(db, paid), { ...original, replayed: true });
    const planted = inventory.plant(sowing);
    db.close();
    db = openDatabase(filename);
    inventory = new Inventory(db);
    assert.deepEqual(inventory.plant(sowing), { ...planted, replayed: true });
    assert.equal(inventory.list().count, 2);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    temp.remove();
  }
});

test('all care fields survive SQL import; only the five pictured plant batches are seeded', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  assert.equal(inventory.list().count, 0);
  const imported = inventory.catalog();
  assert.equal(imported.length, 12);
  for (const original of catalog.plants) {
    const { id, name, care } = imported.find(p => p.id === original.id);
    assert.deepEqual({ id, name, ...care }, original);
  }
  assert.equal(inventory.seedDemo(), 5);
  assert.equal(inventory.seedDemo(), 0);
  assert.deepEqual(inventory.list().items.map(b => [b.plant_id, b.location, b.stage, b.quantity]), [
    [hydrangea, 'Теплица 2, ряд 4', 'ready', 120], [thuja, 'Площадка Б', 'ready', 64],
    [lavender, 'Теплица 1', 'rooting', 300], ['clematis-nelly-moser', 'Теплица 2, ряд 1', 'growing', 70],
    ['petunia-ampelnaya', 'Теплица 3', 'sowing', 800],
  ]);
  assert.deepEqual(inventory.catalog().filter(p => p.care === null).map(p => p.id),
    ['clematis-nelly-moser', 'petunia-ampelnaya']);
});

test('demo shop seeds nine priced products once and preserves existing stock and prices', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  inventory.seedDemo();
  inventory.setPrice(hydrangea, { price_rub: 1990 });
  assert.deepEqual(inventory.seedDemoShop(), { batches: 7, prices: 8 });
  const ready = inventory.list('ready').items;
  assert.equal(new Set(ready.map((batch) => batch.plant_id)).size, 9);
  const catalog = new Map(inventory.catalog().map((plant) => [plant.id, plant]));
  assert.ok(ready.every(({ plant_id }) => catalog.get(plant_id).price_rub > 0));
  assert.equal(catalog.get(hydrangea).price_rub, 1990);
  assert.deepEqual(ready.filter((batch) => batch.plant_id === hydrangea).map((batch) => batch.quantity), [120]);
  assert.equal(inventory.list('rooting').items.find((batch) => batch.plant_id === lavender).quantity, 300);
  assert.deepEqual(inventory.seedDemoShop(), { batches: 0, prices: 0 });
  assert.deepEqual(inventory.list('ready').items, ready);
});

test('admin login, editing, stage filters, history, logout and POS permissions', async t => {
  const { request, login } = await fixture(t);
  assert.equal((await request('GET', inventoryPath)).status, 401);
  assert.equal((await request('GET', inventoryPath, posToken)).status, 401);
  assert.equal((await request('POST', '/api/admin/login', null, { username: 'admin', password: 'wrong' })).status, 401);
  const token = await login();
  assert.equal((await request('POST', salePath, token, sample)).status, 401);
  assert.equal((await request('POST', salePath, null, sample)).status, 401);
  assert.equal((await request('GET', '/api/admin/plants', token)).data.items.length, 14);
  assert.equal((await request('GET', inventoryPath + '?stage=ready', token)).data.count, 2);
  assert.equal((await request('GET', inventoryPath + '?stage=bad', token)).status, 400);
  const created = await request('POST', inventoryPath, token,
    { plant_id: lavender, location: 'Стеллаж 1', stage: 'rooting', quantity: 8 });
  assert.equal(created.status, 201);
  const path = inventoryPath + '/' + created.data.id;
  const observation = { version: 1, location: 'Стеллаж 2', stage: 'growing', quantity: 7 };
  const edit = await request('PATCH', path, token, observation);
  assert.equal(edit.status, 200);
  assert.equal(edit.data.stage_label, 'Доращивание');
  assert.equal(edit.data.location, 'Стеллаж 2');
  assert.equal(edit.data.quantity, 7);
  assert.equal(edit.data.version, 2);
  assert.equal((await request('PATCH', path, token, observation)).status, 409);
  assert.equal((await request('PATCH', path, token, { version: 2, quantity: -1 })).status, 400);
  assert.equal((await request('GET', path, token)).data.version, 2);
  const history = (await request('GET', path + '/history', token)).data.items;
  assert.deepEqual(history.map(e => [e.kind, e.quantity_before, e.quantity_after]),
    [['intake', null, 8], ['edit', 8, 7]]);
  assert.equal((await request('POST', '/api/admin/logout', token)).status, 200);
  assert.equal((await request('GET', inventoryPath, token)).status, 401);
});

test('paid receipt returns the original deductions on retry and rejects a changed receipt', async t => {
  const { request, inventory } = await fixture(t);
  const first = await request('POST', salePath, posToken, sample);
  assert.equal(first.status, 201);
  assert.deepEqual(first.data.movements.map(m => [m.sold, m.remaining_after_sale]), [[2, 118], [1, 63]]);
  const secondRegister = await request('POST', salePath, posToken, { ...sample, register_id: 'another-pos' });
  assert.equal(secondRegister.status, 201);
  const splitItems = [sample.items[1], { plant_id: hydrangea, quantity: 1 }, { plant_id: hydrangea, quantity: 1 }];
  const replay = await request('POST', salePath, posToken, { ...sample, items: splitItems });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, { ...first.data, replayed: true });
  const collision = await request('POST', salePath, posToken, { ...sample, items: [sample.items[0]] });
  assert.equal(collision.status, 409);
  assert.equal(collision.data.error.code, 'receipt_conflict');
  inventory.seedDemo();
  assert.deepEqual(inventory.list('ready').items.map(b => b.quantity), [116, 62]);
});

test('invalid or unfulfillable lines roll back the whole receipt and its history', async t => {
  const { request, db, inventory } = await fixture(t);
  const post = body => request('POST', salePath, posToken, body);
  const failed = await post(receipt('bad', [sample.items[0], { plant_id: lavender, quantity: 1 }]));
  assert.equal(failed.status, 409);
  assert.equal(failed.data.error.available, 0);
  assert.equal((await post(receipt('bad', [sample.items[0], { plant_id: 'unknown', quantity: 1 }]))).status, 422);
  assert.equal((await post({ ...sample, status: 'pending' })).status, 422);
  for (const n of [0, -1, 1.5, '2', null]) {
    assert.equal((await post(receipt('bad', [{ plant_id: thuja, quantity: n }]))).status, 400);
  }
  assert.equal((await post(receipt('bad', []))).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paid_receipts').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM batch_events WHERE kind = 'sale'").get().n, 0);
  assert.deepEqual(inventory.list('ready').items.map(b => [b.quantity, b.version]), [[120, 1], [64, 1]]);
  assert.equal((await post({ ...sample, receipt_id: 'bad' })).status, 201);
});

test('sales allocate across ready batches in intake order and protect an open admin edit', async t => {
  const { request, login, inventory } = await fixture(t);
  const token = await login();
  const first = inventory.list('ready').items[0];
  const young = inventory.create({ plant_id: hydrangea, location: 'А', stage: 'rooting', quantity: 100 });
  const next = inventory.create({ plant_id: hydrangea, location: 'Б', stage: 'ready', quantity: 3 });
  const sale = await request('POST', salePath, posToken, receipt('many', [{ plant_id: hydrangea, quantity: 122 }]));
  assert.equal(sale.status, 201);
  assert.deepEqual(sale.data.movements.map(m => [m.batch_id, m.sold, m.remaining_after_sale]),
    [[first.id, 120, 0], [next.id, 2, 1]]);
  assert.equal(inventory.detail(young.id).quantity, 100);
  const stale = await request('PATCH', inventoryPath + '/' + first.id, token, { version: first.version, quantity: 119 });
  assert.equal(stale.data.error.code, 'stale_version');
  assert.equal(inventory.detail(first.id).quantity, 0);
});

test('parallel retries debit once and two sales cannot buy the same last plant', async t => {
  const { request, inventory } = await fixture(t);
  const plant_id = 'acer-ginnala';
  const batch = inventory.create({ plant_id, location: 'А', stage: 'ready', quantity: 2 });
  const sell = id => request('POST', salePath, posToken, receipt(id, [{ plant_id, quantity: 1 }]));
  const retries = await Promise.all([sell('one'), sell('one'), sell('one')]);
  assert.deepEqual(retries.map(r => r.status).sort(), [200, 200, 201]);
  const last = await Promise.all([sell('two'), sell('three')]);
  assert.deepEqual(last.map(r => r.status).sort(), [201, 409]);
  assert.equal(inventory.detail(batch.id).quantity, 0);
  assert.equal(inventory.history(batch.id).filter(e => e.kind === 'sale').length, 2);
});

test('invalid replacement keeps the old growth plan; an observation supersedes elapsed stages', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  const plan = [
    { stage: 'rooting', due_at: '2030-02-01T08:00:00.000Z' },
    { stage: 'growing', due_at: '2030-03-01T08:00:00.000Z' },
    { stage: 'ready', due_at: '2030-04-01T08:00:00.000Z' },
  ];
  const batch = inventory.create({ plant_id: lavender, location: 'А', stage: 'sowing', quantity: 3, growth_plan: plan });
  for (const invalidPlan of [
    [plan[1], plan[0]], [plan[0], { ...plan[1], due_at: plan[0].due_at }],
    [{ stage: 'rooting', due_at: '2030-02-30T08:00:00Z' }], null,
  ]) {
    assert.throws(() => inventory.update(batch.id, { version: 1, growth_plan: invalidPlan }), { code: 'invalid_request' });
    assert.deepEqual(inventory.detail(batch.id), batch);
  }
  const observed = inventory.update(batch.id, { version: 1, stage: 'growing' });
  assert.deepEqual(observed.growth_plan.map(p => ({ ...p })), [plan[2]]);
  assert.equal(inventory.applyDueGrowth('2030-03-02T00:00:00.000Z'), 0);
  assert.equal(inventory.applyDueGrowth('2030-04-01T08:00:00.000Z'), 1);
  assert.equal(inventory.applyDueGrowth('2030-04-01T08:01:00.000Z'), 0);
  assert.equal(inventory.detail(batch.id).quantity, 3);
});

test('the running worker advances scheduled stock, which can then be sold at the till', async t => {
  const { request, login } = await fixture(t, 20);
  const admin = await login();
  const batch = await request('POST', inventoryPath, admin, {
    plant_id: lavender, location: 'Стеллаж', stage: 'growing', quantity: 4,
    growth_plan: [{ stage: 'ready', due_at: '2001-01-01T00:00:00Z' }],
  });
  assert.equal(batch.status, 201);
  const path = inventoryPath + '/' + batch.data.id;
  const deadline = Date.now() + 4000;
  let row;
  do {
    row = (await request('GET', path, admin)).data;
    if (row.stage === 'ready') break;
    await delay(15);
  } while (Date.now() < deadline);
  assert.equal(row.stage, 'ready');
  assert.equal(row.version, 2);
  const sale = await request('POST', salePath, posToken, receipt('grown', [{ plant_id: lavender, quantity: 1 }]));
  assert.equal(sale.status, 201);
  assert.equal(sale.data.movements[0].remaining_after_sale, 3);
  const events = (await request('GET', path + '/history', admin)).data.items;
  assert.deepEqual(events.map(e => e.kind), ['intake', 'growth', 'sale']);
});

test('file-backed restart catches up once, preserves a paid receipt and keeps a catalog refresh atomic', async () => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'xrom-inventory-'));
  const filename = join(temp.path, 'inventory.sqlite');
  let db = openDatabase(filename);
  let api;
  try {
    let inventory = new Inventory(db);
    inventory.seedDemo();
    recordSale(db, sample);
    const batch = inventory.create({
      plant_id: lavender, location: 'А', stage: 'rooting', quantity: 4,
      growth_plan: [{ stage: 'growing', due_at: '2001-01-01T00:00:00Z' }, { stage: 'ready', due_at: '2001-02-01T00:00:00Z' }],
    });
    db.close();
    db = openDatabase(filename);
    api = await startApi(db);
    inventory = new Inventory(db);
    assert.equal(inventory.detail(batch.id).stage, 'ready');
    assert.equal(inventory.applyDueGrowth(), 0);
    assert.deepEqual(inventory.history(batch.id).map(e => e.stage_after), ['rooting', 'growing', 'ready']);
    assert.equal((await api.request('POST', salePath, posToken, sample)).status, 200);
    assert.equal(inventory.list('ready').items[0].quantity, 118);

    const updated = structuredClone(catalog);
    updated.plants[0].watering = 'Обновлённое описание из справочника.';
    const file = join(temp.path, 'updated.json');
    writeFileSync(file, JSON.stringify(updated));
    assert.equal(importCatalog(db, file), 12);
    const description = () => inventory.catalog().find(p => p.id === updated.plants[0].id).care.watering;
    assert.equal(description(), updated.plants[0].watering);
    updated.plants[0].watering = 'Изменение в ошибочном импорте';
    updated.plants.push(updated.plants[0]);
    writeFileSync(file, JSON.stringify(updated));
    assert.throws(() => importCatalog(db, file));
    assert.equal(description(), 'Обновлённое описание из справочника.');
    assert.equal(inventory.detail(batch.id).quantity, 4);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    if (api) await api.close();
    db.close();
    temp.remove();
  }
});
