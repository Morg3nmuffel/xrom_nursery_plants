const fields = {
  light: 'Освещение',
  watering: 'Полив',
  soil: 'Почва',
  pruning: 'Обрезка',
  flowering: 'Цветение',
  hardiness: 'Зимостойкость',
  height: 'Высота',
};

const normalize = (text) => text.toLowerCase().replaceAll('ё', 'е');
const tokens = (text) => normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
const plantNames = (plant) => [plant.name, plant.scientific_name ?? '', plant.id].map(normalize);
const subject = (plant) => tokens(plant.name)[0] || '';
const unsupported =
  /кошк|собак|вредител|болезн|подкорм|удобрен|лечи|ядов|безопас|дет[ией]|съед|аллерг|комнат|балкон|квартир|сколько[^?]{0,50}(литр|миллилитр|воды)/;

function mentionedPlants(question, plants) {
  const text = normalize(question);
  const words = tokens(question);
  return plants.filter((plant) => {
    const stem = subject(plant).replace(/[аяь]$/, '');
    return (
      plantNames(plant).some((name) => name && text.includes(name)) ||
      words.some((word) =>
        stem === 'ту' ? /^ту[яиюей]$/.test(word) : stem.length >= 3 && word.startsWith(stem),
      )
    );
  });
}

export function careValue(plant, field) {
  if (field === 'height')
    return plant.min_height_cm == null ? null : plant.min_height_cm + '–' + plant.max_height_cm + ' см';
  if (field === 'hardiness')
    return plant.min_temperature_c == null
      ? null
      : 'До ' + plant.min_temperature_c + ' °C, зона ' + plant.hardiness_zone + '. ' + plant.hardiness_notes;
  return plant[field] || null;
}

const topicPatterns = {
  light: /свет|освещ|солн|полутен|тенев/,
  watering: /полив|поливат|увлаж|часто полить/,
  soil: /почв|субстрат|грунт|земл/,
  pruning: /обрез|стрич|подстри/,
  flowering: /цветет|цветени|зацвет/,
  hardiness: /зим|мороз|холод|температур/,
  height: /высот|высок|выраст|размер/,
};

function localPlan(question, plants, context, followUp) {
  const text = normalize(question);
  const mentioned = mentionedPlants(question, plants);
  const plant =
    mentioned.length === 1
      ? mentioned[0]
      : mentioned.length === 0 && context.length === 1
        ? plants.find((item) => item.id === context[0])
        : undefined;
  const topics = Object.keys(fields).filter((field) => topicPatterns[field].test(text));
  if (
    followUp ||
    /подбер|подбир|посовет|порекоменд|подход|какие растения|что посадить|что выбрать|что растет/.test(text)
  ) {
    const filters = {};
    if (/полутен/.test(text)) filters.light = 'partial';
    else if (tokens(text).some(word => /^(тени|тень|тенист)/.test(word))) filters.light = 'shade';
    else if (/солн/.test(text)) filters.light = 'sun';
    if (/редк|засух|мало полив|нечаст|редко быва/.test(text)) filters.watering = 'rare';
    else if (/регуляр|частый полив|часто поливать/.test(text)) filters.watering = 'regular';
    if (/хвойн/.test(text)) filters.group = 'Хвойные';
    const height = /до\s+(\d+(?:[.,]\d+)?)\s*(см|м)(?![\p{L}])/u.exec(text);
    if (height) filters.max_height_cm = Number(height[1].replace(',', '.')) * (height[2] === 'м' ? 100 : 1);
    const frost = /(?:до\s*)?[-−]\s*(\d+(?:[.,]\d+)?)\s*(?:°\s*с|градус)/u.exec(text);
    if (frost) filters.min_temperature_c = -Number(frost[1].replace(',', '.'));
    if (Object.keys(filters).length) return { action: 'recommend', filters };
    return /подбер|подбир|посовет|порекоменд|посадить|выбрать/.test(text) && !topics.length
      ? { action: 'clarify' }
      : { action: 'handoff' };
  }
  if (plant && (topics.length || /уход|ухажив/.test(text))) {
    return {
      action: 'care',
      plant_id: plant.id,
      fields: topics.length ? topics : ['light', 'watering', 'soil', 'pruning'],
    };
  }
  return { action: 'handoff' };
}

export function explicitAction(question, plants, context) {
  const text = normalize(question);
  if (/^\s*(позов|приглас|свяж|переключ|переда|нужен|хочу).*(админ|человек|консультант|сотрудник)/.test(text))
    return { action: 'handoff' };
  if (
    !/^(?:пожалуйста[, ]+)?(?:добавь(?:те)?|положи(?:те)?|помести(?:те)?|закинь(?:те)?|кинь(?:те)?|перенеси(?:те)?)(?!\p{L})/u.test(
      text,
    )
  )
    return null;
  if (/(?:^|\s)(?:если|когда|только при|но не)(?:\s|$)|\?/.test(text)) return { action: 'cart_clarify' };
  const matches = mentionedPlants(question, plants);
  const ordinal = [/перв[уаоы]/, /втор[уаоы]/, /трет[ьия]/].findIndex((pattern) => pattern.test(text));
  const id =
    matches.length === 1
      ? matches[0].id
      : matches.length === 0
        ? ordinal !== -1
          ? context[ordinal]
          : context.length === 1 && /это|ее|его|этот|эту|растение|в корзин/.test(text)
            ? context[0]
            : undefined
        : undefined;
  if (!id) return { action: 'cart_clarify' };
  const amounts = [...text.matchAll(/(?<![\p{L}\p{N}])\d+(?![\p{L}\p{N}])/gu)].map((match) =>
    Number(match[0]),
  );
  const wordCount = [
    [/одн[ауоы]|один/, 1],
    [/дв[ае]/, 2],
    [/три/, 3],
    [/четыре/, 4],
    [/пять/, 5],
    [/шесть/, 6],
    [/семь/, 7],
    [/восемь/, 8],
    [/девять/, 9],
    [/десять/, 10],
  ].find(([pattern]) =>
    tokens(text).some((word) => new RegExp('^(?:' + pattern.source + ')$').test(word)),
  )?.[1];
  const count = amounts[0] ?? wordCount ?? 1;
  if (
    amounts.length > 1 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 2147483647 ||
    /[-−]\s*\d/.test(text)
  )
    return { action: 'cart_clarify' };
  return { action: 'cart', plant_id: id, quantity: count };
}

function supportedFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  const checks = {
    light: (value) => ['sun', 'partial', 'shade'].includes(value),
    watering: (value) => ['rare', 'regular'].includes(value),
    group: (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 100,
    max_height_cm: (value) => typeof value === 'number' && value > 0 && value <= 10000,
    min_temperature_c: (value) => typeof value === 'number' && value >= -100 && value <= 0,
  };
  const entries = Object.entries(filters);
  return entries.length && entries.every(([key, value]) => Object.hasOwn(checks, key) && checks[key](value))
    ? filters
    : null;
}

export function recommendation(plant, filters) {
  const light = normalize(plant.light || '');
  const watering = normalize(plant.watering || '');
  return Object.entries(filters).every(([key, value]) => {
    switch (key) {
      case 'light':
        if (value === 'sun') return /солн/.test(light);
        if (value === 'partial') return /полутен/.test(light);
        return /(?:^|[^\p{L}])(?:тень|тени|тенист)/u.test(light);
      case 'watering':
        return value === 'rare'
          ? /редк|засухоустойчив/.test(watering)
          : /регуляр|равномерно влаж/.test(watering);
      case 'group':
        return Boolean(plant.category && normalize(plant.category) === normalize(value));
      case 'max_height_cm':
        return plant.max_height_cm != null && plant.max_height_cm <= value;
      case 'min_temperature_c':
        return plant.min_temperature_c != null && plant.min_temperature_c <= value;
      default:
        return false;
    }
  });
}

export function createAiPlanner({ url, key, model } = {}) {
  if (!url || !model) return null;
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
  )
    throw new Error('CONSULTANT_API_URL должен использовать HTTPS или локальный HTTP.');
  return async function plan({ question, plants, context }) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(3500),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You classify Russian questions for a nursery. Return JSON only, no answer text.
Use {"action":"care","plant_id":"...","fields":[...]} only for an unambiguous plant and questions fully covered by database fields:
light, watering, soil, pruning, flowering, hardiness, height. For a follow-up you may use a single context ID.
Use {"action":"recommend","filters":{...}} only when all user constraints are expressible: light sun/partial/shade, watering rare/regular, group exact category, max_height_cm number, min_temperature_c negative number. Do not ignore conditions.
Use {"action":"clarify"} when the user seeks recommendations but hasn't stated any conditions.
Otherwise use {"action":"handoff"}. This includes toxicity, pests, safety, indoor suitability, unsupported details and ambiguous subjects.
Plant IDs and categories must come from the given list. Never give instructions or create cart actions.`,
          },
          { role: 'user', content: JSON.stringify({ question, plants, context }) },
        ],
      }),
    });
    if (!response.ok) return null;
    return JSON.parse((await response.json()).choices[0].message.content);
  };
}

export async function consult(question, plants, context, planner, followUp = false) {
  const explicit = explicitAction(question, plants, context);
  if (explicit) return explicit;
  if (unsupported.test(normalize(question))) return { action: 'handoff' };
  const base = localPlan(question, plants, context, followUp);
  if (!planner) return base;
  let choice;
  try {
    choice = await planner({
      question: followUp ? 'Условия для подбора растения: ' + question : question,
      context,
      plants: plants.map(({ id, name, scientific_name, category }) => ({
        id,
        name,
        scientific_name,
        category,
      })),
    });
  } catch {
    return base;
  }
  if (!choice) return base;
  if (choice.action === 'care') {
    const known = plants.find((plant) => plant.id === choice.plant_id);
    const match = mentionedPlants(question, plants);
    const picked =
      match.length === 1 ? match[0].id : match.length === 0 && context.length === 1 ? context[0] : null;
    if (
      known &&
      known.id === picked &&
      Array.isArray(choice.fields) &&
      choice.fields.length &&
      choice.fields.every((field) => typeof field === 'string' && Object.hasOwn(fields, field))
    ) {
      return { action: 'care', plant_id: known.id, fields: [...new Set(choice.fields)] };
    }
  }
  if (choice.action === 'recommend') {
    const filters = supportedFilters(choice.filters);
    if (
      filters &&
      (base.action !== 'recommend' ||
        Object.entries(base.filters).every(([key, value]) => filters[key] === value))
    )
      return { action: 'recommend', filters };
  }
  if (choice.action === 'clarify') return { action: 'clarify' };
  return { action: 'handoff' };
}

export const fieldLabels = fields;
