export { consultantFromEnvironment, createAiPlanner } from './consultant-model.mjs';

const fields = {
  light: 'Освещение',
  watering: 'Полив',
  soil: 'Почва',
  pruning: 'Обрезка',
  flowering: 'Цветение',
  hardiness: 'Зимостойкость',
  height: 'Высота',
  availability: 'Наличие',
  price: 'Цена',
};

export const clarificationPrompts = {
  conditions: 'Расскажите, где будет расти растение, сколько там солнца и как часто сможете поливать.',
  plant: 'Уточните название растения или номер из последнего списка.',
  light: 'Сколько прямого солнца получает это место и в какое время дня?',
  watering: 'Как часто сможете поливать растение?',
  size: 'Какой максимальной высоты должно быть растение?',
  cart: 'Укажите название одного растения или номер из списка и количество.',
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

function referenceIndex(text) {
  return [/перв[уаоы]/, /втор[уаоы]/, /трет[ьия]/].findIndex((pattern) => pattern.test(text));
}

function cartRequest(text) {
  const instruction =
    /(?:^|[\s,])(?:добав(?:ь|ьте|им|ить)|полож(?:и|ите|ить|им)|помест(?:и|ите|ить)|закин(?:ь|ьте)|кин(?:ь|ьте)|перенеси(?:те)?|возьму|возьмем|беру|хочу купить|хочу взять)(?!\p{L})/u;
  return (
    instruction.test(text) &&
    !/(?:^|[\s,])(?:не\s+(?:добав|полож|помещ|хочу|буду)\p{L}*|если|когда|допустим|например|только при|но не|как\s+(?:добав|полож)\p{L}*|можно ли)(?!\p{L})/u.test(
      text,
    )
  );
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
  availability: /в налич|в продаже|остал(?:ось|ись)|распродан/,
  price: /стоимост|цен[ауые]|сколько стоит|сколько стоят/,
};

function localPlan(question, plants, context, followUp) {
  const text = normalize(question);
  if (
    /^(?:привет(?:ствую)?|здравствуйте|доброе утро|добрый день|добрый вечер|спасибо(?: большое)?)[!.\s]*$/.test(
      text,
    )
  )
    return { action: 'greeting' };
  const mentioned = mentionedPlants(question, plants);
  const index = referenceIndex(text);
  const plant =
    mentioned.length === 1
      ? mentioned[0]
      : mentioned.length === 0 && (index !== -1 || context.length === 1)
        ? plants.find((item) => item.id === context[index === -1 ? 0 : index])
        : undefined;
  const topics = Object.keys(fields).filter((field) => topicPatterns[field].test(text));
  if (
    followUp ||
    /подбер|подбир|посовет|порекоменд|подход|какие растения|что посадить|что выбрать|что растет/.test(text)
  ) {
    const filters = {};
    if (/полутен/.test(text)) filters.light = 'partial';
    else if (tokens(text).some((word) => /^(тени|тень|тенист)/.test(word))) filters.light = 'shade';
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
  if (!cartRequest(text) || /(?:только при|но не)|\?/.test(text)) return { action: 'cart_clarify' };
  const matches = mentionedPlants(question, plants);
  const ordinal = referenceIndex(text);
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
  const count = requestedQuantity(text) ?? 1;
  if (!validQuantity(count)) return { action: 'cart_clarify' };
  return { action: 'cart', plant_id: id, quantity: count };
}

const validQuantity = (count) => Number.isSafeInteger(count) && count >= 1 && count <= 2147483647;
function requestedQuantity(text) {
  const amounts = [...text.matchAll(/(?<![\p{L}\p{N}])\d+(?![\p{L}\p{N}]|-(?:й|я|ая|ое|ый|ой))/gu)];
  if (amounts.length > 1 || /[-−]\s*\d|\d[.,]\d|нескольк|сколько-нибудь/.test(text)) return NaN;
  if (amounts.length) return Number(amounts[0][0]);
  const amountWords = new Map(
    Object.entries({
      один: 1,
      одна: 1,
      одну: 1,
      одно: 1,
      два: 2,
      две: 2,
      пару: 2,
      пара: 2,
      три: 3,
      четыре: 4,
      пять: 5,
      шесть: 6,
      семь: 7,
      восемь: 8,
      девять: 9,
      десять: 10,
      одиннадцать: 11,
      двенадцать: 12,
      тринадцать: 13,
      четырнадцать: 14,
      пятнадцать: 15,
      шестнадцать: 16,
      семнадцать: 17,
      восемнадцать: 18,
      девятнадцать: 19,
      двадцать: 20,
    }),
  );
  const counts = tokens(text).flatMap((word) => (amountWords.has(word) ? [amountWords.get(word)] : []));
  if (counts.length > 1) return NaN;
  return counts[0];
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
  const entries = Object.entries(filters).filter(([, value]) => value !== null);
  return entries.length && entries.every(([key, value]) => Object.hasOwn(checks, key) && checks[key](value))
    ? Object.fromEntries(entries)
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

function selectedPlants(choice, question, plants, context) {
  const ids = choice.plant_ids ?? (choice.plant_id ? [choice.plant_id] : []);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 3 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !plants.some((plant) => plant.id === id))
  )
    return null;
  const named = mentionedPlants(question, plants).map((plant) => plant.id);
  if (named.length)
    return ids.every((id) => named.includes(id)) && named.every((id) => ids.includes(id)) ? ids : null;
  const index = referenceIndex(normalize(question));
  if (index !== -1 && context.length) return ids.length === 1 && ids[0] === context[index] ? ids : null;
  return ids;
}

export async function consult(
  question,
  plants,
  context,
  planner,
  followUp = false,
  history = [],
  stock = [],
) {
  const explicit = explicitAction(question, plants, context);
  if (explicit && (explicit.action !== 'cart_clarify' || !cartRequest(normalize(question)))) return explicit;
  if (unsupported.test(normalize(question))) return { action: 'handoff' };
  const base = explicit ?? localPlan(question, plants, context, followUp);
  if (!planner) return base;
  const focused = new Set([...context, ...mentionedPlants(question, plants).map((plant) => plant.id)]);
  const ready = new Map(stock.map((plant) => [plant.id, plant]));
  let choice;
  try {
    choice = await planner({
      question,
      context,
      history,
      awaiting_conditions: followUp,
      plants: plants.map((plant) => {
        const current = ready.get(plant.id);
        const facts = focused.has(plant.id)
          ? Object.fromEntries(
              Object.keys(fields).flatMap((field) => {
                if (field === 'availability') return [[field, current?.available ?? 0]];
                if (field === 'price') return [[field, current?.price_rub ?? null]];
                const value = careValue(plant, field);
                return value ? [[field, value.slice(0, 650)]] : [];
              }),
            )
          : undefined;
        return {
          id: plant.id,
          name: plant.name,
          scientific_name: plant.scientific_name,
          category: plant.category,
          in_stock: Boolean(current),
          facts,
        };
      }),
    });
  } catch {
    return base;
  }
  if (!choice) return base;
  if (choice.action === 'care') {
    const ids = selectedPlants(choice, question, plants, context);
    const requested = choice.fields;
    if (
      ids &&
      Array.isArray(requested) &&
      requested.length &&
      requested.every((field) => typeof field === 'string' && Object.hasOwn(fields, field)) &&
      (base.action !== 'care' || base.fields.every((field) => requested.includes(field)))
    ) {
      return { action: 'care', plant_ids: ids, fields: [...new Set(requested)] };
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
  if (choice.action === 'cart') {
    const text = normalize(question);
    if (!cartRequest(text)) return base;
    const ids = selectedPlants(choice, question, plants, context);
    const quantity = requestedQuantity(text);
    const known = mentionedPlants(question, plants);
    if (
      ids?.length === 1 &&
      (known.length === 1 || context.includes(ids[0])) &&
      validQuantity(choice.quantity) &&
      choice.quantity === (quantity ?? 1)
    )
      return { action: 'cart', plant_id: ids[0], quantity: choice.quantity };
    return { action: 'cart_clarify' };
  }
  if (choice.action === 'clarify') {
    const clarification = Object.hasOwn(clarificationPrompts, choice.clarification)
      ? choice.clarification
      : 'conditions';
    return { action: 'clarify', clarification };
  }
  if (choice.action === 'greeting' && base.action === 'greeting') return base;
  return { action: 'handoff' };
}

export const fieldLabels = fields;
