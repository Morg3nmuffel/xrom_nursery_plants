import { adminAccess, bearerToken, jsonServer, missingRoute, readJson, send } from '../http.mjs';
import { Stock } from './stock.mjs';
import { PlantingQueue } from './plantings.mjs';
import { plantingSync } from './sync.mjs';

export function createMaterialsService(db, { adminUser, adminPassword, syncToken,
  plantUrl = 'http://127.0.0.1:8787', intervalMs = 2000 }) {
  if (!syncToken || syncToken === adminPassword) throw new Error('Задайте отдельный MATERIAL_SYNC_TOKEN для связи с сервисом растений.');
  const admin = adminAccess({ adminUser, adminPassword });
  const stock = new Stock(db);
  const queue = new PlantingQueue(stock);
  const sync = plantingSync(queue, { plantUrl, syncToken, intervalMs });
  const server = jsonServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (pathname === '/health' && method === 'GET') {
      db.prepare('SELECT 1').get();
      return send(res, 200, { status: 'ok' });
    }
    if (pathname === '/api/admin/login' && method === 'POST') return send(res, 200, admin.login(await readJson(req)));
    if (!pathname.startsWith('/api/admin/')) missingRoute();
    const token = bearerToken(req);
    admin.require(token);
    if (pathname === '/api/admin/logout' && method === 'POST') return send(res, 200, admin.logout(token));
    if (pathname === '/api/admin/materials') {
      if (method === 'GET') return send(res, 200, { items: stock.materials() });
      if (method === 'POST') return send(res, 201, stock.addMaterial(await readJson(req)));
    }
    if (method === 'POST' && ['/api/admin/purchases', '/api/admin/usage'].includes(pathname)) {
      const kind = pathname === '/api/admin/purchases' ? 'purchase' : 'usage';
      const result = stock.post(kind, await readJson(req));
      return send(res, result.replayed ? 200 : 201, result);
    }
    if (pathname === '/api/admin/recipes') {
      if (method === 'GET') return send(res, 200, { items: stock.recipes() });
      if (method === 'PUT') return send(res, 200, stock.setRecipe(await readJson(req)));
    }
    if (pathname === '/api/admin/movements' && method === 'GET') {
      return send(res, 200, { items: stock.history(searchParams.get('material_id')) });
    }
    if (pathname === '/api/admin/plantings' && method === 'GET') {
      return send(res, 200, { items: queue.jobs(searchParams.get('status')) });
    }
    if (pathname === '/api/admin/sync' && method === 'GET') return send(res, 200, sync.status());
    missingRoute();
  });
  server.once('listening', () => sync.start());
  server.once('close', () => sync.stop());
  return server;
}
