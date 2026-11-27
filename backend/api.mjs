import { Inventory } from './inventory.mjs';
import { createShop } from './shop.mjs';
import { recordSale } from './sales.mjs';
import { ApiError, invalid } from './validation.mjs';
import { photoPath, photoRequestLimit } from './catalog/photos.mjs';
import { adminAccess, bearerToken, jsonServer, missingRoute, readJson, sameSecret, send, unauthorized } from './http.mjs';

export function createService(db, { adminUser = 'admin', adminPassword, posToken, syncToken, consultant, growthIntervalMs = 30_000 }) {
  if (!adminUser || !adminPassword || !posToken || adminPassword === posToken) {
    throw new Error('Задайте разные ADMIN_PASSWORD и POS_TOKEN, а также непустой логин администратора.');
  }
  if (!Number.isInteger(growthIntervalMs) || growthIntervalMs <= 0 || growthIntervalMs > 2147483647) {
    throw new Error('GROWTH_INTERVAL_MS должен быть положительным целым числом до 2147483647.');
  }
  const inventory = new Inventory(db);
  const admin = adminAccess({ adminUser, adminPassword });
  const shop = createShop(db, consultant);
  if (syncToken && [posToken, adminPassword].includes(syncToken)) throw new Error('Для обмена со складом задайте отдельный MATERIAL_SYNC_TOKEN.');

  async function route(req, res) {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (pathname === '/health' && method === 'GET') {
      db.prepare('SELECT 1').get();
      return send(res, 200, { status: 'ok' });
    }
    const photo = photoPath.exec(pathname);
    if (photo && method === 'GET') {
      const file = inventory.catalogPhoto(photo[1]);
      if (!file) throw new ApiError(404, 'photo_not_found', 'Фото растения не найдено.');
      res.writeHead(200, {
        'Content-Type': file.content_type,
        'Content-Length': file.bytes.byteLength,
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(file.bytes);
    }
    if (pathname === '/api/admin/login' && method === 'POST') {
      return send(res, 200, admin.login(await readJson(req)));
    }
    if (pathname.startsWith('/api/shop/')) return shop.route(req, res, pathname);

    const bearer = bearerToken(req);
    if (pathname === '/api/internal/plantings' && method === 'GET') {
      if (!syncToken || !sameSecret(bearer, syncToken)) unauthorized();
      const after = Number(searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) invalid('Недопустимый курсор after.');
      const items = db.prepare('SELECT * FROM planting_feed WHERE seq > ? ORDER BY seq LIMIT 100').all(after);
      return send(res, 200, { items });
    }
    if (pathname === '/api/pos/sales' && method === 'POST') {
      if (!sameSecret(bearer, posToken)) unauthorized();
      const result = recordSale(db, await readJson(req));
      return send(res, result.replayed ? 200 : 201, result);
    }
    if (!pathname.startsWith('/api/admin/')) missingRoute();
    admin.require(bearer);
    if (pathname === '/api/admin/conversations' || pathname.startsWith('/api/admin/conversations/')) {
      return shop.adminRoute(req, res, pathname);
    }
    if (pathname === '/api/admin/logout' && method === 'POST') {
      return send(res, 200, admin.logout(bearer));
    }
    if (pathname === '/api/admin/plants' && method === 'GET') {
      return send(res, 200, { items: inventory.catalog() });
    }
    if (pathname === '/api/admin/plants' && method === 'POST') {
      return send(res, 201, inventory.addPlant(await readJson(req, photoRequestLimit)));
    }
    if (pathname === '/api/admin/plants/price' && method === 'PATCH') {
      return send(res, 200, inventory.setPrice(searchParams.get('id'), await readJson(req)));
    }
    if (pathname === '/api/admin/plants' && method === 'DELETE') {
      return send(res, 200, inventory.removePlant(searchParams.get('id')));
    }
    if (pathname === '/api/admin/plantings' && method === 'POST') {
      const planting = inventory.plant(await readJson(req));
      return send(res, planting.replayed ? 200 : 201, planting);
    }
    if (pathname === '/api/admin/inventory') {
      if (method === 'GET') return send(res, 200, inventory.list(searchParams.get('stage')));
      if (method === 'POST') return send(res, 201, inventory.create(await readJson(req)));
    }
    const batch = /^\/api\/admin\/inventory\/([1-9]\d*)(\/history)?$/.exec(pathname);
    if (batch) {
      const id = Number(batch[1]);
      if (!Number.isSafeInteger(id)) invalid('Некорректный идентификатор партии.');
      if (batch[2] && method === 'GET') return send(res, 200, { items: inventory.history(id) });
      if (!batch[2] && method === 'GET') return send(res, 200, inventory.detail(id));
      if (!batch[2] && method === 'PATCH') return send(res, 200, inventory.update(id, await readJson(req)));
      if (!batch[2] && method === 'DELETE') return send(res, 200, inventory.removeBatch(id));
    }
    missingRoute();
  }

  inventory.applyDueGrowth();
  const server = jsonServer(route);
  let timer;
  server.once('listening', () => {
    timer = setInterval(() => {
      try {
        inventory.applyDueGrowth();
      } catch (error) {
        console.error('Ошибка фоновой обработки роста:', error.message);
      }
    }, growthIntervalMs);
    timer.unref();
  });
  server.once('close', () => clearInterval(timer));
  return server;
}
