import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { bearerToken, missingRoute, readJson, send, unauthorized } from './http.mjs';
import { transaction } from './sqlite.mjs';
import { ApiError, invalid, quantity, string } from './validation.mjs';
import { careValue, consult, fieldLabels, recommendation } from './consultant.mjs';

const hashPassword = promisify(scrypt);
const lifetime = 8 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const stock = `SELECT plant_id, SUM(quantity) AS available
  FROM plant_batches WHERE stage = 'ready' AND archived_at IS NULL AND quantity > 0 GROUP BY plant_id`;
const handoff =
  'Не удалось найти подтверждённый ответ в базе питомника. Передал вопрос и переписку администратору. Ответ появится в этом чате.';
const askConditions =
  'Расскажите, где будет расти растение, сколько там солнца и как часто сможете поливать.';

export function createShop(db, planner) {
  const sessions = new Map();
  const authAttempts = new Map();
  const answerAttempts = new Map();
  const readyPlants = db.prepare(`SELECT p.id, p.name, p.price_kopecks / 100.0 AS price_rub, s.available, c.*
    FROM (${stock}) s JOIN plants p ON p.id = s.plant_id
    LEFT JOIN plant_care c ON c.plant_id = p.id
    WHERE p.archived_at IS NULL ORDER BY p.name, p.id`);
  const knowledge = db.prepare(`SELECT p.id, p.name, c.* FROM plants p
    LEFT JOIN plant_care c ON c.plant_id = p.id WHERE p.archived_at IS NULL ORDER BY p.id`);
  const available = db.prepare(`SELECT COALESCE(SUM(b.quantity), 0) AS quantity FROM plant_batches b
    JOIN plants p ON p.id = b.plant_id WHERE p.id = ? AND p.archived_at IS NULL AND b.archived_at IS NULL AND b.stage = 'ready'`);
  const cartRows =
    db.prepare(`SELECT p.id AS plant_id, p.name, p.price_kopecks / 100.0 AS price_rub, cc.quantity,
    CASE WHEN p.archived_at IS NOT NULL THEN 0 ELSE COALESCE(s.available, 0) END AS available
    FROM customer_cart cc JOIN plants p ON p.id = cc.plant_id
    LEFT JOIN (${stock}) s ON s.plant_id = cc.plant_id WHERE cc.customer_id = ? ORDER BY p.name, p.id`);
  const cartQuantity = db.prepare(
    'SELECT quantity FROM customer_cart WHERE customer_id = ? AND plant_id = ?',
  );
  const addMessage =
    db.prepare(`INSERT INTO customer_messages(customer_id, author, text, sent_at, request_id, plant_ids)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const messages = db.prepare(`SELECT id, author, text, sent_at, plant_ids FROM customer_messages
    WHERE customer_id = ? ORDER BY id`);
  const conversation = db.prepare('SELECT state FROM customer_conversations WHERE customer_id = ?');
  const updateConversation = db.prepare(
    'UPDATE customer_conversations SET state = ?, updated_at = ? WHERE customer_id = ?',
  );
  const seen = db.prepare('SELECT id FROM customer_messages WHERE customer_id = ? AND request_id = ?');
  const lastReferences = db.prepare(`SELECT plant_ids FROM customer_messages
    WHERE customer_id = ? AND plant_ids IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const lastReply = db.prepare(
    "SELECT text FROM customer_messages WHERE customer_id = ? AND author = 'assistant' ORDER BY id DESC LIMIT 1",
  );

  function rateLimit(map, key, limit) {
    const time = Date.now();
    for (const [id, attempt] of map) if (attempt.until <= time) map.delete(id);
    const attempt = map.get(key) ?? { count: 0, until: time + 60_000 };
    if (attempt.count >= limit)
      throw new ApiError(429, 'too_many_attempts', 'Попробуйте ещё раз через минуту.');
    attempt.count++;
    map.set(key, attempt);
  }

  async function login(input, registration) {
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = input.password;
    if (
      !/^[a-z0-9_.-]{3,40}$/.test(username) ||
      typeof password !== 'string' ||
      password.length < 8 ||
      password.length > 256
    ) {
      if (!registration) unauthorized();
      invalid('Логин: 3–40 латинских букв, цифр или символов . _ -. Пароль: 8–256 символов.');
    }
    let user;
    if (registration) {
      const name = string(input.name, 'имя', 100);
      const salt = randomBytes(16).toString('hex');
      const digest = (await hashPassword(password, salt, 32)).toString('hex');
      user = transaction(db, () => {
        const row = db
          .prepare(
            `INSERT INTO customers(username, name, password_hash, created_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING RETURNING id, username, name`,
          )
          .get(username, name, salt + ':' + digest, now());
        if (!row) throw new ApiError(409, 'login_taken', 'Этот логин уже занят.');
        db.prepare(
          "INSERT INTO customer_conversations(customer_id, state, updated_at) VALUES (?, 'assistant', ?)",
        ).run(row.id, now());
        return row;
      });
    } else {
      const row = db
        .prepare('SELECT id, username, name, password_hash FROM customers WHERE username = ?')
        .get(username);
      const [salt, digest] = row?.password_hash.split(':') ?? ['0'.repeat(32), '0'.repeat(64)];
      const actual = await hashPassword(password, salt, 32);
      if (!timingSafeEqual(actual, Buffer.from(digest, 'hex')) || !row) unauthorized();
      user = { id: row.id, username: row.username, name: row.name };
    }
    for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
    const access_token = randomBytes(32).toString('hex');
    sessions.set(access_token, { user, expires: Date.now() + lifetime });
    return { user, access_token, expires_in: lifetime / 1000 };
  }

  function thread(id) {
    return {
      state: conversation.get(id).state,
      items: messages.all(id).map(({ plant_ids, ...message }) => ({
        ...message,
        plant_ids: JSON.parse(plant_ids ?? '[]'),
      })),
    };
  }

  function cart(id) {
    return { items: cartRows.all(id) };
  }

  function setCart(id, plantId, count) {
    if (count === 0) {
      db.prepare('DELETE FROM customer_cart WHERE customer_id = ? AND plant_id = ?').run(id, plantId);
      return;
    }
    if (count > available.get(plantId).quantity) {
      throw new ApiError(409, 'not_available', 'Столько экземпляров сейчас нет в наличии.');
    }
    db.prepare(
      `INSERT INTO customer_cart(customer_id, plant_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT(customer_id, plant_id) DO UPDATE SET quantity = excluded.quantity`,
    ).run(id, plantId, count);
  }

  function answer(id, plan) {
    switch (plan.action) {
      case 'care': {
        const plant = knowledge.all().find((item) => item.id === plan.plant_id);
        if (!plant) return null;
        const values = plan.fields.map((field) => [fieldLabels[field], careValue(plant, field)]);
        if (values.some(([, value]) => !value)) return null;
        return {
          plantIds: [plant.id],
          text: [
            plant.name + ' · из справочника питомника',
            ...values.map(([label, value]) => label + ' — ' + value),
          ].join('\n'),
        };
      }
      case 'recommend': {
        const items = readyPlants
          .all()
          .filter((plant) => recommendation(plant, plan.filters))
          .slice(0, 3);
        if (!items.length) return null;
        const evidence = {
          light: 'light',
          watering: 'watering',
          group: 'category',
          max_height_cm: 'height',
          min_temperature_c: 'hardiness',
        };
        const lines = items.map((plant, index) => {
          const details = Object.keys(plan.filters)
            .map((key) => careValue(plant, evidence[key]))
            .join(' ');
          return index + 1 + '. ' + plant.name + ' · ' + details;
        });
        return {
          plantIds: items.map((plant) => plant.id),
          text: ['В наличии по указанным условиям', ...lines].join('\n'),
        };
      }
      case 'cart': {
        const plant = readyPlants.all().find((item) => item.id === plan.plant_id);
        const existing = cartQuantity.get(id, plan.plant_id)?.quantity || 0;
        if (!plant || existing + plan.quantity > Math.min(2147483647, plant.available)) {
          return { text: 'Добавить в корзину не получилось. Проверьте наличие и количество в каталоге.' };
        }
        setCart(id, plant.id, existing + plan.quantity);
        return {
          text: 'В корзину добавлено ' + plan.quantity + ' шт. · ' + plant.name,
          plantIds: [plant.id],
        };
      }
      case 'cart_clarify':
        return { text: 'Укажите название одного растения и количество. Например, «Добавь 2 туи в корзину».' };
      case 'clarify':
        return { text: askConditions };
      default:
        return null;
    }
  }

  async function message(id, input) {
    const text = string(input.text, 'сообщение', 2000);
    const requestId = 'buyer-' + string(input.request_id, 'идентификатор сообщения', 100);
    if (seen.get(id, requestId)) return thread(id);
    const state = conversation.get(id).state;
    rateLimit(answerAttempts, id, 20);
    const context = JSON.parse(lastReferences.get(id)?.plant_ids ?? '[]');
    // An explicitly requested cart action can still be fulfilled while a person handles the conversation.
    const followUp = lastReply.get(id)?.text === askConditions;
    const plan = await consult(
      text,
      knowledge.all(),
      context,
      state === 'pending' ? null : planner,
      followUp,
    );
    return transaction(db, () => {
      if (seen.get(id, requestId)) return thread(id);
      const current = conversation.get(id).state;
      const posted = now();
      addMessage.run(id, 'customer', text, posted, requestId, null);
      const automated = current !== 'pending' || ['cart', 'cart_clarify'].includes(plan.action);
      if (automated) {
        const reply = answer(id, plan);
        addMessage.run(
          id,
          'assistant',
          reply?.text ?? handoff,
          posted,
          null,
          reply?.plantIds ? JSON.stringify(reply.plantIds) : null,
        );
        updateConversation.run(reply ? current : 'pending', posted, id);
      } else {
        updateConversation.run('pending', posted, id);
      }
      return thread(id);
    });
  }

  async function route(req, res, pathname) {
    const method = req.method;
    const registration = pathname === '/api/shop/register';
    if ((registration || pathname === '/api/shop/login') && method === 'POST') {
      rateLimit(authAttempts, req.socket.remoteAddress, 30);
      return send(res, registration ? 201 : 200, await login(await readJson(req), registration));
    }
    const token = bearerToken(req);
    const session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(token);
      unauthorized();
    }
    const { id } = session.user;
    if (pathname === '/api/shop/session' && method === 'GET') return send(res, 200, session.user);
    if (pathname === '/api/shop/logout' && method === 'POST') {
      sessions.delete(token);
      return send(res, 200, { logged_out: true });
    }
    if (pathname === '/api/shop/catalog' && method === 'GET') {
      const items = readyPlants
        .all()
        .map(({ id, name, price_rub, available, category, scientific_name, light, watering }) => ({
          id,
          name,
          price_rub,
          available,
          category,
          scientific_name,
          light,
          watering,
        }));
      return send(res, 200, { items });
    }
    if (pathname === '/api/shop/cart') {
      if (method === 'GET') return send(res, 200, cart(id));
      if (method === 'PUT') {
        const input = await readJson(req);
        const plant = string(input.plant_id, 'растение');
        const count = quantity(input.quantity);
        const previous = quantity(input.previous_quantity);
        return send(
          res,
          200,
          transaction(db, () => {
            if ((cartQuantity.get(id, plant)?.quantity || 0) !== previous) {
              throw new ApiError(
                409,
                'cart_changed',
                'Количество в корзине изменилось. Проверьте корзину и повторите действие.',
              );
            }
            setCart(id, plant, count);
            return cart(id);
          }),
        );
      }
    }
    if (pathname === '/api/shop/conversation') {
      if (method === 'GET') return send(res, 200, thread(id));
      if (method === 'POST') return send(res, 200, await message(id, await readJson(req)));
    }
    missingRoute();
  }

  async function adminRoute(req, res, pathname) {
    if (pathname === '/api/admin/conversations' && req.method === 'GET') {
      const items = db
        .prepare(
          `SELECT c.customer_id AS id, u.name, u.username, c.state, c.updated_at,
        (SELECT m.text FROM customer_messages m WHERE m.customer_id = c.customer_id AND m.author = 'customer'
          ORDER BY m.id DESC LIMIT 1) AS latest
        FROM customer_conversations c JOIN customers u ON u.id = c.customer_id WHERE c.state != 'assistant'
        ORDER BY c.state = 'pending' DESC, c.updated_at DESC, c.customer_id DESC`,
        )
        .all();
      return send(res, 200, { items });
    }
    const match = /^\/api\/admin\/conversations\/([1-9]\d*)$/.exec(pathname);
    if (!match || !Number.isSafeInteger(Number(match[1]))) missingRoute();
    const id = Number(match[1]);
    const getCustomer = () => {
      const row = conversation.get(id);
      if (!row || row.state === 'assistant') missingRoute();
      return db.prepare('SELECT id, name, username FROM customers WHERE id = ?').get(id);
    };
    if (req.method === 'GET') return send(res, 200, { customer: getCustomer(), ...thread(id) });
    if (req.method === 'POST') {
      const input = await readJson(req);
      const text = string(input.text, 'ответ', 4000);
      const requestId = 'admin-' + string(input.request_id, 'идентификатор ответа', 100);
      return send(
        res,
        200,
        transaction(db, () => {
          const customer = getCustomer();
          if (!seen.get(id, requestId)) {
            const posted = now();
            addMessage.run(id, 'admin', text, posted, requestId, null);
            updateConversation.run('answered', posted, id);
          }
          return { customer, ...thread(id) };
        }),
      );
    }
    missingRoute();
  }

  return { route, adminRoute };
}
