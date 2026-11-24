import { homedir } from 'node:os';
import { join } from 'node:path';
import { openMaterials } from './db.mjs';
import { createMaterialsService } from './api.mjs';
import { Stock } from './stock.mjs';

async function main() {
  const command = process.argv[2] ?? 'serve';
  if (!['serve', 'seed-demo'].includes(command)) throw new Error('Команды: serve | seed-demo');
  const dataHome = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const filename = process.env.MATERIALS_DB || join(dataHome, 'XromGroup', 'consumables.sqlite');
  const db = openMaterials(filename);
  try {
    if (command === 'seed-demo') {
      console.log(new Stock(db).seedDemo() ? 'Учебная закупка и норма зарегистрированы.' : 'Учебные данные уже загружены.');
      return;
    }
    const host = process.env.MATERIALS_HOST || '127.0.0.1';
    const port = Number(process.env.MATERIALS_PORT || 8789);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Недопустимый MATERIALS_PORT.');
    const server = createMaterialsService(db, {
      adminUser: process.env.ADMIN_USERNAME, adminPassword: process.env.ADMIN_PASSWORD,
      syncToken: process.env.MATERIAL_SYNC_TOKEN, plantUrl: process.env.PLANT_SERVICE_URL,
      intervalMs: Number(process.env.MATERIALS_POLL_MS || 2000),
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('close', resolve);
      const stop = () => server.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server.listen(port, host, () => console.log(`Склад расходников: http://${host}:${port} | SQLite: ${filename}`));
    });
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
