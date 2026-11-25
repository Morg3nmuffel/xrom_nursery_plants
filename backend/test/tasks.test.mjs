import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { importCatalog, openDatabase } from '../db.mjs';
import { Inventory } from '../inventory.mjs';
import { recordSale } from '../sales.mjs';
import { createTasksService } from '../tasks/api.mjs';
import { TaskPlanner } from '../tasks/planner.mjs';

const employees = JSON.parse(readFileSync(new URL('../examples/task-employees.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../catalog/plants.json', import.meta.url), 'utf8'));
const assigneeIds = employees.map(employee => employee.id);
const timeZone = 'Europe/Moscow';
const hydrangea = 'hydrangea-paniculata-limelight';
const lavender = 'lavandula-angustifolia';
const beforeMidnight = '2026-11-24T20:59:00.000Z';

test('upgrading the five-assignee table retains finished tasks and accepts additional staff IDs', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  const batch = inventory.create({ plant_id: lavender, location: 'Ряд 1', stage: 'rooting', quantity: 4 });
  db.exec(`CREATE TABLE task_assignments (
    id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES plant_batches(id),
    assignee_id INTEGER NOT NULL CHECK (assignee_id BETWEEN 1 AND 5), due_on TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, completed_on TEXT,
    completed_details_json TEXT, UNIQUE(batch_id, due_on)) STRICT;
    CREATE UNIQUE INDEX task_one_open_per_batch ON task_assignments(batch_id) WHERE completed_at IS NULL;
    CREATE INDEX task_completions_by_day ON task_assignments(completed_on, batch_id)`);
  const snapshot = { title: 'Проверить посевы', instructions: 'Сделано', care: {}, location: 'Ряд 1' };
  db.prepare(`INSERT INTO task_assignments VALUES (7, ?, 1, '2026-11-24', ?, NULL, ?, '2026-11-24', ?)`)
    .run(batch.id, beforeMidnight, beforeMidnight, JSON.stringify(snapshot));
  const planner = new TaskPlanner(db, { assigneeIds: [6], timeZone: 'Europe/Moscow', clock: () => new Date(beforeMidnight) });
  assert.equal(planner.list().items[0].instructions, 'Сделано');
  inventory.create({ plant_id: lavender, location: 'Ряд 2', stage: 'rooting', quantity: 4 });
  assert.equal(planner.generate(), 1);
  assert.equal(planner.list(6).items.length, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the demo board keeps exactly three started and three finished examples through repeated starts', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  new Inventory(db).seedDemo();
  const clock = () => new Date(beforeMidnight);
  const options = { employees, timeZone, clock, seedDemoBoard: true };
  createTasksService(db, options);
  const planner = new TaskPlanner(db, { timeZone, clock });
  const tasks = planner.list().items.filter(task => task.status !== 'todo');
  assert.equal(tasks.filter(task => task.status === 'in_progress').length, 3);
  assert.equal(tasks.filter(task => task.status === 'done').length, 3);
  assert.ok(tasks.every(task => task.started_at && task.assignee_id && task.instructions));
  assert.ok(tasks.every(task => !task.completed_at || task.completed_at === beforeMidnight));
  createTasksService(db, options);
  assert.deepEqual(planner.list().items.filter(task => task.status !== 'todo'), tasks);
});

test('the demo assigns each of five employees one task using stage and imported care', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  inventory.seedDemo();
  inventory.create({ plant_id: lavender, location: 'Пустой стеллаж', stage: 'rooting', quantity: 0 });
  const planner = new TaskPlanner(db, { assigneeIds, timeZone, clock: () => new Date(beforeMidnight) });
  assert.equal(planner.generate(), 5);
  assert.equal(planner.generate(), 0);

  const { date, items } = planner.list();
  assert.equal(date, '2026-11-24');
  assert.deepEqual(items.map(task => task.assignee_id).sort(), assigneeIds);
  assert.deepEqual(items.map(task => task.stage), ['ready', 'ready', 'rooting', 'growing', 'sowing']);
  assert.equal(new Set(items.map(task => task.title)).size, 4);
  assert.ok(items.every(task => task.status === 'todo' && task.due_on === date));
  const original = catalog.plants.find(plant => plant.id === hydrangea);
  assert.deepEqual(items[0].care, { watering: original.watering, light: original.light });
  assert.deepEqual(items[4].care, {});
  assert.match(items[4].instructions, /у ответственного/);
  assert.equal(planner.list(items[0].assignee_id).items[0].id, items[0].id);
});

test('overdue work survives midnight and restart, and completion retains its snapshot', t => {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'nursery-tasks-'));
  t.after(() => directory.remove());
  const filename = join(directory.path, 'inventory.sqlite');
  const db = openDatabase(filename);
  const peer = openDatabase(filename);
  try {
    const inventory = new Inventory(db);
    const batch = inventory.create({ plant_id: lavender, location: 'Теплица 1', stage: 'rooting', quantity: 12 });
    let now = beforeMidnight;
    const options = { assigneeIds, timeZone, clock: () => new Date(now) };
    const planner = new TaskPlanner(db, options);
    const secondPlanner = new TaskPlanner(peer, options);
    assert.equal(planner.generate(), 1);
    assert.equal(secondPlanner.generate(), 0);
    const [task] = planner.list().items;
    assert.equal(planner.changeStatus(task.id, task.assignee_id, 'start').started_at, beforeMidnight);

    now = '2026-11-24T21:01:00.000Z';
    assert.equal(secondPlanner.generate(), 0);
    assert.equal(secondPlanner.list().date, '2026-11-25');
    assert.equal(secondPlanner.list().items[0].due_on, '2026-11-24');
    const updated = inventory.update(batch.id, { version: batch.version, stage: 'ready', location: 'Площадка В' });
    const active = secondPlanner.list().items[0];
    assert.equal(active.status, 'in_progress');
    assert.equal(active.stage, 'ready');
    assert.equal(active.location, 'Площадка В');

    const completed = secondPlanner.changeStatus(task.id, task.assignee_id, 'complete');
    assert.equal(completed.status, 'done');
    assert.equal(completed.completed_at, now);
    assert.deepEqual(planner.changeStatus(task.id, task.assignee_id, 'complete'), completed);
    assert.equal(planner.generate(), 0);
    inventory.update(batch.id, { version: updated.version, location: 'Теплица 2' });

    const reopened = openDatabase(filename);
    try {
      const restarted = new TaskPlanner(reopened, options);
      assert.deepEqual(restarted.list().items, [completed]);
      assert.equal(restarted.generate(), 0);
      now = '2026-11-25T21:01:00.000Z';
      assert.equal(restarted.generate(), 1);
      const [next] = restarted.list().items;
      assert.notEqual(next.id, task.id);
      assert.notEqual(next.assignee_id, task.assignee_id);
      assert.equal(next.location, 'Теплица 2');
      assert.equal(next.status, 'todo');
      assert.equal(reopened.prepare('SELECT count(*) AS count FROM task_assignments').get().count, 2);
      assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    peer.close();
    db.close();
  }
});

test('catalog refresh updates open instructions, and a sold-out batch cannot be completed', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const inventory = new Inventory(db);
  const batch = inventory.create({ plant_id: hydrangea, location: 'Площадка Б', stage: 'ready', quantity: 3 });
  const planner = new TaskPlanner(db, { assigneeIds, timeZone });
  planner.generate();
  const [task] = planner.list().items;
  db.prepare('UPDATE plant_care SET watering = ? WHERE plant_id = ?').run('Учебная рекомендация.', hydrangea);
  assert.equal(planner.list().items[0].care.watering, 'Учебная рекомендация.');
  importCatalog(db);
  assert.equal(planner.list().items[0].care.watering, task.care.watering);
  recordSale(db, { register_id: 'test', receipt_id: 'sold-out', status: 'paid', items: [{ plant_id: hydrangea, quantity: 3 }] });
  assert.deepEqual(planner.list().items, []);
  assert.throws(() => planner.changeStatus(task.id, task.assignee_id, 'complete'), { code: 'batch_empty' });
  inventory.update(batch.id, { version: inventory.detail(batch.id).version, quantity: 1 });
  assert.equal(planner.generate(), 0);
  assert.equal(planner.list().items[0].id, task.id);
  assert.equal(planner.list().items[0].quantity, 1);
});

test('the task API authenticates employees, enforces ownership, and assigns newly added stock automatically', async t => {
  const db = openDatabase(':memory:');
  const inventory = new Inventory(db);
  inventory.seedDemo();
  const server = createTasksService(db, { employees, intervalMs: 10, clock: () => new Date(beforeMidnight) });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tasksPath = '/api/tasks';

  async function call(path, { method = 'GET', json, token } = {}) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}${path}`, { method, headers, body: json && JSON.stringify(json) });
    return { status: response.status, data: await response.json() };
  }

  const root = await call('/');
  assert.equal(root.status, 404);
  assert.equal(root.data.error.code, 'not_found');
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call(tasksPath)).status, 401);
  assert.equal((await call(`${tasksPath}/login`, { method: 'POST', json: { username: 'anna', password: 'wrong' } })).status, 401);

  const [owner, colleague] = await Promise.all(employees.slice(0, 2).map(async ({ username, password }) => {
    const reply = await call(`${tasksPath}/login`, { method: 'POST', json: { username, password } });
    assert.equal(reply.status, 200);
    return reply.data.access_token;
  }));
  const personal = (await call(tasksPath, { token: owner })).data;
  assert.equal(personal.items.length, 1);
  assert.equal(personal.employee.name, 'Анна');
  const [{ id, assignee_id }] = personal.items;
  assert.equal(assignee_id, personal.employee.id);
  assert.equal((await call(`${tasksPath}?scope=team`, { token: colleague })).data.items.length, 5);
  assert.equal((await call(`${tasksPath}/${id}/complete`, { method: 'POST', token: colleague })).status, 403);
  const action = verb => call(`${tasksPath}/${id}/${verb}`, { method: 'POST', token: owner });
  const started = await action('start');
  assert.equal(started.data.status, 'in_progress');
  assert.deepEqual(await action('start'), started);
  const [closed, retried] = await Promise.all([action('complete'), action('complete')]);
  assert.equal(closed.status, 200);
  assert.deepEqual(closed, retried);
  assert.equal(closed.data.status, 'done');
  assert.equal((await action('start')).status, 409);
  assert.equal((await call(tasksPath, { token: owner })).data.items[0].completed_at, beforeMidnight);

  const added = inventory.create({ plant_id: lavender, location: 'Стеллаж 8', stage: 'rooting', quantity: 4 });
  let generated;
  const deadline = Date.now() + 1000;
  while (!generated && Date.now() < deadline) {
    const team = (await call(`${tasksPath}?scope=team`, { token: owner })).data.items;
    generated = team.find(task => task.batch_id === added.id);
    if (!generated) await wait(10);
  }
  assert.equal(generated?.location, 'Стеллаж 8');
  assert.equal((await call(`${tasksPath}/logout`, { method: 'POST', token: owner })).status, 200);
  assert.equal((await call(tasksPath, { token: owner })).status, 401);
});
