import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db.mjs';
import { TaskPlanner } from '../tasks/planner.mjs';

if (workerData?.startupTest) {
  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage('ready');
  Atomics.wait(gate, 0, 0);
  const db = openDatabase(workerData.filename);
  try {
    if (workerData.service === 'tasks') {
      const planner = new TaskPlanner(db, { assigneeIds: [1, 2, 3, 4, 5], timeZone: 'Europe/Moscow' });
      assert.equal(planner.generate(), 0);
    }
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
  } finally {
    db.close();
  }
} else {
  test('inventory and tasks can initialize the same empty SQLite file simultaneously', async () => {
    const temp = mkdtempDisposableSync(join(tmpdir(), 'nursery-startup-'));
    try {
      for (let i = 0; i < 6; i++) {
        const gate = new Int32Array(new SharedArrayBuffer(4));
        const filename = join(temp.path, `plants-${i}.sqlite`);
        const workers = ['inventory', 'tasks'].map(service => new Worker(new URL(import.meta.url), {
          workerData: { startupTest: true, service, filename, gate: gate.buffer },
        }));
        try {
          await Promise.all(workers.map(worker => once(worker, 'message')));
          const exits = Promise.all(workers.map(worker => once(worker, 'exit')));
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
          assert.deepEqual(await exits, [[0], [0]]);
        } finally {
          await Promise.all(workers.map(worker => worker.terminate()));
        }
      }
    } finally {
      temp.remove();
    }
  });
}
