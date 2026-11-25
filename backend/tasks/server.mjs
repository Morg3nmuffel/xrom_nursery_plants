import { readFileSync } from 'node:fs';
import { inventoryDatabasePath, openDatabase } from '../db.mjs';
import { createTasksService } from './api.mjs';

async function main() {
  const employeesFile = process.argv[2] || process.env.TASKS_EMPLOYEES_FILE;
  const employees = () => employeesFile ? JSON.parse(readFileSync(employeesFile, 'utf8').replace(/^\uFEFF/, '')) : [];
  const host = process.env.TASKS_HOST || '127.0.0.1';
  const port = Number(process.env.TASKS_PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Недопустимый TASKS_PORT.');

  const filename = inventoryDatabasePath();
  const db = openDatabase(filename);
  try {
    const server = createTasksService(db, {
      employees,
      adminUser: process.env.ADMIN_USERNAME,
      adminPassword: process.env.ADMIN_PASSWORD,
      timeZone: process.env.TASKS_TIME_ZONE || 'Europe/Moscow',
      intervalMs: Number(process.env.TASKS_INTERVAL_MS || 30_000),
    });
    const stop = () => server.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await new Promise((resolve, reject) => {
      server.once('close', resolve);
      server.once('error', reject);
      server.listen(port, host, () => console.log(`Задачи питомника: http://${host}:${port} | SQLite: ${filename}`));
    });
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
