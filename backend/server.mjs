import { homedir } from 'node:os';
import { join } from 'node:path';
import { createService } from './api.mjs';
import { importCatalog, openDatabase } from './db.mjs';
import { Inventory } from './inventory.mjs';

async function main() {
  const [command = 'serve', file] = process.argv.slice(2);
  if (!['serve', 'seed-demo', 'import-catalog'].includes(command)) {
    throw new Error('Команды: serve | seed-demo | import-catalog [файл.json]');
  }
  const dataHome = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const filename = process.env.INVENTORY_DB || join(dataHome, 'XromGroup', 'inventory.sqlite');
  const db = openDatabase(filename);
  try {
    if (command === 'seed-demo') {
      console.log('Добавлено учебных партий:', new Inventory(db).seedDemo());
      return;
    }
    if (command === 'import-catalog') {
      console.log('Импортировано карточек ухода:', importCatalog(db, file));
      return;
    }
    const host = process.env.INVENTORY_HOST || '127.0.0.1';
    const port = Number(process.env.INVENTORY_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Недопустимый INVENTORY_PORT.');
    const server = createService(db, {
      adminUser: process.env.ADMIN_USERNAME,
      adminPassword: process.env.ADMIN_PASSWORD,
      posToken: process.env.POS_TOKEN,
      syncToken: process.env.MATERIAL_SYNC_TOKEN,
      growthIntervalMs: Number(process.env.GROWTH_INTERVAL_MS || 30_000),
    });
    await new Promise((resolve, reject) => {
      server.once('close', resolve);
      server.once('error', reject);
      const stop = () => server.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server.listen(port, host, () => console.log(`Учёт растений: http://${host}:${port} | SQLite: ${filename}`));
    });
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
