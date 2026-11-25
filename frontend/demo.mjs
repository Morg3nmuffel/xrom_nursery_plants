import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseEnv } from 'node:util';
import { createWebServer } from './server.mjs';

const base = fileURLToPath(new URL('../backend/', import.meta.url));
const data = fileURLToPath(new URL('./demo-data/', import.meta.url));
const ports = { plants: 18787, tasks: 18788, store: 18789 };
const urls = Object.fromEntries(Object.entries(ports).map(([k, p]) => [k, 'http://127.0.0.1:' + p]));
const children = new Set();
let web,
  stopping = false;
function stop() {
  stopping = true;
  web?.close();
  for (const child of children) child.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
async function password() {
  if (process.env.NURSERY_DEMO_PASSWORD) return process.env.NURSERY_DEMO_PASSWORD;
  try {
    const local = parseEnv(await readFile(new URL('./.env.local-admin', import.meta.url), 'utf8'));
    if (local.NURSERY_DEMO_PASSWORD?.trim()) return local.NURSERY_DEMO_PASSWORD;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return 'demo-admin';
}
async function main() {
  const env = {
    ...process.env,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: await password(),
    INVENTORY_DB: join(data, 'inventory.sqlite'),
    MATERIALS_DB: join(data, 'materials.sqlite'),
    TASKS_EMPLOYEES_FILE: join(base, 'examples/task-employees.json'),
    TASKS_DEMO_BOARD: '1',
    POS_TOKEN: randomBytes(32).toString('hex'),
    MATERIAL_SYNC_TOKEN: randomBytes(32).toString('hex'),
    INVENTORY_PORT: String(ports.plants),
    TASKS_PORT: String(ports.tasks),
    MATERIALS_PORT: String(ports.store),
    INVENTORY_HOST: '127.0.0.1',
    TASKS_HOST: '127.0.0.1',
    MATERIALS_HOST: '127.0.0.1',
    PLANT_SERVICE_URL: urls.plants,
  };
  delete env.NURSERY_DEMO_PASSWORD;
  for (const args of [
    ['server.mjs', 'seed-demo'],
    ['server.mjs', 'seed-demo-shop'],
    ['consumables/server.mjs', 'seed-demo'],
  ]) {
    const result = spawnSync(process.execPath, args, { cwd: base, env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Не удалось подготовить учебные данные.');
  }
  for (const entry of ['server.mjs', 'tasks/server.mjs', 'consumables/server.mjs']) {
    const proc = spawn(process.execPath, [entry], { cwd: base, env, stdio: ['ignore', 'pipe', 'inherit'] });
    children.add(proc);
    await new Promise((resolve, reject) => {
      let log = '';
      proc.stdout.on('data', (chunk) => {
        if (log === null) return;
        log += chunk;
        if (log.includes(' | SQLite:')) {
          log = null;
          resolve();
        }
      });
      proc.once('error', reject);
      proc.once('exit', (code) => {
        children.delete(proc);
        if (!stopping) {
          process.exitCode = 1;
          stop();
          reject(new Error(entry + ' завершился с кодом ' + code));
        }
      });
    });
    if (stopping) return;
  }
  web = createWebServer({ urls });
  const listening = once(web, 'listening');
  web.listen(8790, '127.0.0.1');
  await listening;
  console.log('Питомник открыт на http://127.0.0.1:8790/ · Логин admin · Остановка Ctrl+C');
  if (process.argv.includes('--open') && process.platform === 'darwin')
    spawn('open', ['http://127.0.0.1:8790/']).unref();
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  stop();
});
