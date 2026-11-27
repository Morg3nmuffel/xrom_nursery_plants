import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createService } from '../../backend/api.mjs';
import { createMaterialsService } from '../../backend/consumables/api.mjs';
import { openMaterials } from '../../backend/consumables/db.mjs';
import { consult, consultantFromEnvironment, createAiPlanner } from '../../backend/consultant.mjs';
import { openDatabase } from '../../backend/db.mjs';
import { Inventory } from '../../backend/inventory.mjs';
import { createTasksService } from '../../backend/tasks/api.mjs';
import { createWebServer } from '../server.mjs';

const config = { adminPassword: 'test-admin', posToken: 'test-pos', syncToken: 'test-sync' };
const hydrangea = 'hydrangea-paniculata-limelight';
const thuja = 'thuja-occidentalis-smaragd';
const lavender = 'lavandula-angustifolia';

function browser(url) {
  let cookie = '';
  return async (path, { method = 'GET', body, status = 200, json = true } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-Nursery-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const header = response.headers.get('set-cookie');
    if (header) cookie = header.split(';')[0];
    const value = json ? await response.json() : await response.text();
    assert.equal(response.status, status, path + ' ' + JSON.stringify(value.error ?? ''));
    return value;
  };
}

async function listen(server) {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return 'http://127.0.0.1:' + server.address().port;
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function boot(folder, planner) {
  const db = openDatabase(join(folder, 'plants.sqlite'));
  const materials = openMaterials(join(folder, 'materials.sqlite'));
  const inventory = new Inventory(db);
  inventory.seedDemo();
  const plants = createService(db, { ...config, consultant: planner });
  const tasks = createTasksService(db, config);
  const plantUrl = await listen(plants);
  const store = createMaterialsService(materials, { ...config, plantUrl, intervalMs: 100_000 });
  const web = createWebServer({
    urls: { plants: plantUrl, tasks: await listen(tasks), store: await listen(store) },
  });
  return {
    url: await listen(web),
    db,
    inventory,
    async stop() {
      await close(web);
      await close(store);
      await close(tasks);
      await close(plants);
      materials.close();
      db.close();
    },
  };
}

test('registered buyers see ready stock and keep cart and full human handoff through a database restart', async () => {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'nursery-customer-'));
  const providerQuestions = [];
  const providerThinking = [];
  const provider = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const { messages, thinking } = JSON.parse(input);
    const { question } = JSON.parse(messages[1].content);
    providerQuestions.push(question);
    providerThinking.push(thinking);
    let decision;
    if (question.includes('поливать')) {
      decision = {
        action: 'care',
        plant_id: hydrangea,
        fields: ['watering'],
        text: 'Выдуманный ответ от модели',
      };
    } else if (question.includes('полутени')) {
      decision = { action: 'recommend', filters: { light: 'partial' } };
    } else {
      decision = { action: 'handoff', text: 'Выдуманный ответ от модели' };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
  });
  const ai = createAiPlanner({
    url: (await listen(provider)) + '/v1/chat/completions',
    model: 'deepseek-flash',
  });
  let app = await boot(directory.path, ai);
  const credentials = { username: 'buyer.one', password: 'test-customer-password' };
  const message = (client, text, id) =>
    client('/api/shop/conversation', {
      method: 'POST',
      body: { text, request_id: id },
    });
  try {
    let buyer = browser(app.url);
    const second = browser(app.url);
    let admin = browser(app.url);
    await buyer('/api/shop/catalog', { status: 401 });
    assert.match(await buyer('/', { json: false }), /login\.js/);
    await buyer('/api/shop/register', {
      method: 'POST',
      status: 201,
      body: { ...credentials, name: 'Полина' },
    });
    await second('/api/shop/register', {
      method: 'POST',
      status: 409,
      body: { ...credentials, name: 'Дубль' },
    });
    await second('/api/shop/register', {
      method: 'POST',
      status: 201,
      body: { ...credentials, username: 'buyer.two', name: 'Второй покупатель' },
    });
    await admin('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: config.adminPassword },
    });
    assert.match(await buyer('/', { json: false }), /customer\.js/);
    assert.match(await buyer('/customer.js', { json: false }), /./);
    await buyer('/api/plants/conversations', { status: 403 });
    await buyer('/api/employee/tasks', { status: 403 });
    await admin('/api/shop/cart', { status: 403 });

    const { items } = await buyer('/api/shop/catalog');
    assert.deepEqual(items.map((plant) => plant.id).sort(), [hydrangea, thuja]);
    const reference = (await admin('/api/plants/plants')).items;
    assert.equal(new Set(reference.map(plant => plant.image)).size, reference.length);
    for (const plant of reference) {
      assert.match(plant.image, /^\/plants\/[a-z0-9-]+\.webp$/);
      const response = await fetch(new URL(plant.image, app.url));
      assert.equal(response.status, 200, plant.id);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
    }
    for (const plant of items) {
      assert.equal(plant.image, reference.find(row => row.id === plant.id).image);
    }
    const update = (plant_id, quantity, previous_quantity, status) =>
      buyer('/api/shop/cart', {
        method: 'PUT',
        body: { plant_id, quantity, previous_quantity },
        status,
      });
    await update(lavender, 1, 0, 409);
    await update(thuja, 1, 0, 200);
    assert.equal((await update(thuja, 2, 0, 409)).error.code, 'cart_changed');
    assert.equal((await second('/api/shop/cart')).items.length, 0);

    const care = await message(buyer, 'Как поливать гортензию?', 'care');
    const source = app.db
      .prepare('SELECT watering FROM plant_care WHERE plant_id = ?')
      .get(hydrangea).watering;
    assert.ok(care.items.at(-1).text.includes(source));
    assert.ok(!care.items.at(-1).text.includes('Выдуманный'));
    const choice = await message(buyer, 'Подберите растение для полутени.', 'pick');
    assert.deepEqual(choice.items.at(-1).plant_ids, [hydrangea, thuja]);
    assert.equal((await admin('/api/plants/conversations')).items.length, 0);
    await message(buyer, 'Добавь 2 экземпляра первой позиции', 'cart');
    await message(buyer, 'Добавь 2 экземпляра первой позиции', 'cart');
    const cart = await buyer('/api/shop/cart');
    assert.deepEqual(Object.fromEntries(cart.items.map((row) => [row.plant_id, row.quantity])), {
      [hydrangea]: 2,
      [thuja]: 1,
    });
    assert.equal(providerQuestions.length, 2);
    assert.deepEqual(providerThinking, [{ type: 'disabled' }, { type: 'disabled' }]);

    const ask = 'Можно ли выращивать гортензию рядом с аквариумом?';
    const escalated = await message(buyer, ask, 'unknown');
    assert.equal(escalated.state, 'pending');
    assert.match(escalated.items.at(-1).text, /Передал вопрос/);
    const [conversation] = (await admin('/api/plants/conversations')).items;
    assert.equal(conversation.latest, ask);
    const path = '/api/plants/conversations/' + conversation.id;
    assert.deepEqual((await admin(path)).items, escalated.items);
    await second(path, { status: 403 });
    assert.equal((await second('/api/shop/conversation')).items.length, 0);

    const waiting = await message(buyer, 'Рядом есть окно.', 'clarification-for-admin');
    assert.equal(waiting.state, 'pending');
    assert.equal(waiting.items.at(-1).author, 'customer');
    assert.equal(providerQuestions.length, 3);

    const response = { text: 'Уточните, сколько света в этом месте.', request_id: 'answer-one' };
    await admin(path, { method: 'POST', body: response });
    await admin(path, { method: 'POST', body: response });
    const answered = await buyer('/api/shop/conversation');
    assert.equal(answered.state, 'answered');
    assert.equal(answered.items.filter((item) => item.author === 'admin').length, 1);
    const continued = await message(buyer, 'Как поливать гортензию?', 'follow-up');
    assert.equal(continued.state, 'answered');
    assert.deepEqual(continued.items.slice(0, answered.items.length), answered.items);
    assert.equal(continued.items.at(-1).author, 'assistant');
    assert.ok(continued.items.at(-1).text.includes(source));
    assert.equal(providerQuestions.length, 4);

    const transferredAgain = await message(buyer, 'Продаёте ли вы аквариумы?', 'second-unknown');
    assert.equal(transferredAgain.state, 'pending');
    assert.equal((await admin('/api/plants/conversations')).items[0].id, conversation.id);
    assert.deepEqual((await admin(path)).items, transferredAgain.items);
    assert.equal(providerQuestions.length, 5);

    const ready = app.inventory.list('ready').items.find((batch) => batch.plant_id === thuja);
    app.inventory.update(ready.id, { version: ready.version, stage: 'growing' });
    assert.equal(
      (await buyer('/api/shop/catalog')).items.some((item) => item.id === thuja),
      false,
    );
    const failedAdd = await message(buyer, 'Добавь ещё 1 тую в корзину', 'cart-not-available');
    assert.match(failedAdd.items.at(-1).text, /Добавить в корзину не получилось/);
    assert.equal((await buyer('/api/shop/cart')).items.find((row) => row.plant_id === thuja).available, 0);
    await app.stop();
    app = await boot(directory.path, ai);
    buyer = browser(app.url);
    admin = browser(app.url);
    await buyer('/api/shop/login', {
      method: 'POST',
      body: { ...credentials, password: 'wrong-pass' },
      status: 401,
    });
    await buyer('/api/shop/login', { method: 'POST', body: credentials });
    assert.deepEqual((await buyer('/api/shop/conversation')).items, failedAdd.items);
    assert.equal((await buyer('/api/shop/cart')).items.find((row) => row.plant_id === hydrangea).quantity, 2);
    await buyer('/api/logout', { method: 'POST' });
    await buyer('/api/shop/cart', { status: 401 });
    assert.deepEqual(app.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await app.stop();
    await close(provider);
    directory.remove();
  }
});

test('without a model the consultant can ask for conditions and rejects ungrounded or conditional cart requests', async () => {
  const plants = [{ id: thuja, name: 'Туя западная', light: 'Солнце или лёгкая полутень.' }];
  assert.deepEqual(await consult('Подберите мне растение', plants, []), { action: 'clarify' });
  assert.deepEqual(await consult('У меня полутень', plants, [], null, true), {
    action: 'recommend',
    filters: { light: 'partial' },
  });
  assert.deepEqual(
    await consult('Как поливать тую?', plants, [], async () => ({
      action: 'care',
      plant_id: lavender,
      fields: ['watering'],
    })),
    { action: 'handoff' },
  );
  assert.deepEqual(await consult('Добавь тую, только если она безопасна для кошек', plants, []), {
    action: 'cart_clarify',
  });
  assert.deepEqual(await consult('Туя безопасна для кошек?', plants, []), { action: 'handoff' });
});

test('a copied care profile identifies the documented plant and checks sale availability separately', async () => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'nursery-profile-'));
  let modelCalls = 0;
  const app = await boot(dir.path, async () => {
    modelCalls++;
    return null;
  });
  const buyer = browser(app.url);
  const juniper = 'juniperus-sabina';
  const copied = `Полив
Редкий умеренный полив; после укоренения засухоустойчив.
Освещение
Солнце; допускает легкую полутень.
Почва
Сухая или умеренно влажная, песчаная, щелочная или нейтральная, хорошо дренированная почва.
Обрезка
Санитарная обрезка ранней весной; сильную стрижку проводить постепенно.
Цветение
Декоративного цветения нет; образует шишкоягоды.
Зимостойкость
Зона 3-7 · до -40 °C. Высокая зимостойкость; важно избегать застоя воды зимой.
Высота
80–150 см
мне нужен такой цветок что подскажете`;
  const ask = (text, request_id) =>
    buyer('/api/shop/conversation', {
      method: 'POST',
      body: { text, request_id },
    });
  try {
    await buyer('/api/shop/register', {
      method: 'POST',
      status: 201,
      body: { username: 'profile-buyer', name: 'Покупатель', password: 'test-profile-password' },
    });
    const before = await ask(copied, 'profile');
    assert.equal(before.state, 'assistant');
    assert.deepEqual(before.items.at(-1).plant_ids, [juniper]);
    assert.match(before.items.at(-1).text, /Описание совпадает с карточкой «Можжевельник казацкий»/);
    assert.match(before.items.at(-1).text, /Сейчас нет готовых к продаже экземпляров/);
    assert.match(before.items.at(-1).text, /до -40 °C/i);
    assert.equal(modelCalls, 0);

    const nearby = await ask('Подберите для полутени, редкий полив и морозы до -40 градусов.', 'filter');
    assert.equal(nearby.state, 'assistant');
    assert.match(nearby.items.at(-1).text, /По справочнику подходят/);
    assert.ok(nearby.items.at(-1).plant_ids.includes(juniper));

    app.inventory.create({ plant_id: juniper, stage: 'ready', location: 'Теплица', quantity: 5 });
    const after = await ask(copied, 'stock-update');
    assert.match(after.items.at(-1).text, /5 шт. готово к продаже/);
  } finally {
    await app.stop();
    dir.remove();
  }
});

test('the consultant keeps known comparison facts, escalates gaps and reads only the current buyer cart', async () => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'nursery-comparison-'));
  const modelInputs = [];
  const app = await boot(dir.path, async (input) => {
    modelInputs.push(input);
    return { action: 'greeting' };
  });
  const buyer = browser(app.url);
  const other = browser(app.url);
  const admin = browser(app.url);
  const juniper = 'juniperus-sabina';
  const ask = (client, text, request_id) =>
    client('/api/shop/conversation', {
      method: 'POST',
      body: { text, request_id },
    });
  try {
    for (const [client, username] of [
      [buyer, 'compare-buyer'],
      [other, 'other-buyer'],
    ]) {
      await client('/api/shop/register', {
        method: 'POST',
        status: 201,
        body: { username, name: 'Покупатель', password: 'test-comparison-password' },
      });
    }
    const stock = await ask(buyer, 'Что сейчас\nв наличии?', 'catalog');
    assert.match(stock.items.at(-1).text, /Туя западная.*64 шт. в наличии/);
    assert.ok(!stock.items.at(-1).plant_ids.includes(juniper));
    await buyer('/api/shop/cart', {
      method: 'PUT',
      body: { plant_id: thuja, quantity: 3, previous_quantity: 0 },
    });
    const ownCart = await ask(buyer, 'Покажи, что в моей корзине', 'cart');
    assert.match(ownCart.items.at(-1).text, /В вашей корзине[\s\S]*Туя западная.*3 шт./);
    const otherCart = await ask(other, 'Что в корзине?', 'cart');
    assert.equal(otherCart.items.at(-1).text, 'В вашей корзине пока ничего нет.');

    const knownLight = app.db.prepare('SELECT light FROM plant_care WHERE plant_id = ?').get(thuja).light;
    await buyer('/api/shop/cart', {
      method: 'PUT',
      body: { plant_id: hydrangea, quantity: 1, previous_quantity: 0 },
    });
    const cartComparison = await ask(buyer, 'Сравни растения в моей корзине по освещению', 'cart-comparison');
    assert.match(cartComparison.items.at(-1).text, /Гортензия/);
    assert.ok(cartComparison.items.at(-1).text.includes(knownLight));
    await ask(buyer, 'Спасибо', 'model-history');
    assert.equal(modelInputs.length, 1);
    assert.ok(!modelInputs[0].history.some((item) => item.text.startsWith('В вашей корзине')));

    app.db.prepare('DELETE FROM plant_care WHERE plant_id = ?').run(juniper);
    const partial = await ask(buyer, 'Сравни тую и можжевельник по освещению', 'partial');
    assert.equal(partial.state, 'pending');
    const reply = partial.items.at(-1).text;
    assert.ok(reply.includes(knownLight));
    assert.match(reply, /Можжевельник казацкий[\s\S]*Освещение — недостаточно информации/);
    assert.match(reply, /Передал вопрос и переписку администратору/);
    await admin('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: config.adminPassword },
    });
    const [ticket] = (await admin('/api/plants/conversations')).items;
    assert.equal(ticket.latest, 'Сравни тую и можжевельник по освещению');
    assert.equal((await admin('/api/plants/conversations/' + ticket.id)).items.at(-1).text, reply);

    const unknown = await ask(other, 'Сравни тую и незабудку по освещению', 'unknown-plant');
    assert.equal(unknown.state, 'pending');
    assert.ok(unknown.items.at(-1).text.includes(knownLight));
    assert.match(unknown.items.at(-1).text, /«незабудку» — недостаточно информации/);
    await admin('/api/plants/conversations/' + ticket.id, {
      method: 'POST',
      body: { text: 'Уточню данные.', request_id: 'reset-waiting-test' },
    });
    const mixed = await ask(buyer, 'Сравни тую и гортензию по освещению и безопасности для кошек', 'mixed');
    assert.equal(mixed.state, 'pending');
    assert.ok(mixed.items.at(-1).text.includes(knownLight));
    assert.match(mixed.items.at(-1).text, /По остальным условиям запроса недостаточно/);
  } finally {
    await app.stop();
    dir.remove();
  }
});

test('Responses API interprets recent chat and cart requests, while the server validates stock and facts', async () => {
  const directory = mkdtempDisposableSync(join(tmpdir(), 'nursery-responses-'));
  const envFile = join(directory.path, '.env');
  const requests = [];
  const decisions = [
    { action: 'clarify', clarification: 'light' },
    { action: 'recommend', filters: { light: 'partial', group: null } },
    { action: 'care', plant_ids: [hydrangea, thuja], fields: ['availability'], text: '1000 шт.' },
    { action: 'cart', plant_ids: [thuja], quantity: 2 },
    { action: 'cart', plant_ids: [thuja], quantity: 12 },
  ];
  const provider = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const request = JSON.parse(input);
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      ...request,
      input: JSON.parse(request.input),
    });
    const decision = decisions[requests.length - 1];
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
      }),
    );
  });
  const endpoint = (await listen(provider)) + '/v1/responses';
  const app = await boot(directory.path, consultantFromEnvironment(envFile, {}));
  const buyer = browser(app.url);
  const ask = (text, request_id) =>
    buyer('/api/shop/conversation', { method: 'POST', body: { text, request_id } });
  const configure = (key) =>
    writeFileSync(
      envFile,
      [
        'OPENAI_API_KEY=unused-for-other-providers',
        'CONSULTANT_API_KEY=' + key,
        'CONSULTANT_API_URL=' + endpoint,
        'CONSULTANT_MODEL=gpt-5.4-mini',
      ].join('\n'),
    );
  try {
    assert.equal(createAiPlanner({ model: 'gpt-5.4-mini' }), null);
    await buyer('/api/shop/register', {
      method: 'POST',
      status: 201,
      body: { username: 'response.buyer', name: 'Покупатель', password: 'test-response-password' },
    });
    const greetings = await ask('Здравствуйте', 'before-key');
    assert.match(greetings.items.at(-1).text, /Могу помочь/);
    assert.equal(requests.length, 0);

    configure('test-provider-key');
    const clarification = await ask('Хочу что-нибудь посадить у забора', 'site');
    assert.match(clarification.items.at(-1).text, /Сколько прямого солнца/);
    const result = await ask('Прямые лучи только до десяти утра', 'lighting');
    assert.deepEqual(result.items.at(-1).plant_ids, [hydrangea, thuja]);
    assert.ok(requests[1].input.history.some((item) => item.text === 'Хочу что-нибудь посадить у забора'));
    assert.equal(requests[1].input.awaiting_conditions, true);
    assert.equal(requests[0].path, '/v1/responses');
    assert.equal(requests[0].store, false);
    assert.equal(requests[0].text.format.strict, true);
    assert.equal(requests[0].auth, 'Bearer test-provider-key');
    assert.ok(!JSON.stringify(requests[0].input).includes('test-response-password'));

    const comparison = await ask('Есть в продаже гортензия и туя?', 'comparison');
    assert.match(comparison.items.at(-1).text, /120 шт./);
    assert.match(comparison.items.at(-1).text, /64 шт./);
    assert.doesNotMatch(comparison.items.at(-1).text, /1000 шт./);

    configure('rotated-provider-key');
    const added = await ask('Я возьму пару экземпляров второй из списка', 'model-cart');
    assert.match(added.items.at(-1).text, /В корзину добавлено 2 шт./);
    assert.equal(requests[3].auth, 'Bearer rotated-provider-key');
    await ask('Я возьму ещё тую', 'unjustified-quantity');
    assert.equal((await buyer('/api/shop/cart')).items[0].quantity, 2);
  } finally {
    await app.stop();
    await close(provider);
    directory.remove();
  }
});
