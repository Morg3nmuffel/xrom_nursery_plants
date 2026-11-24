import { readFileSync } from 'node:fs';
import { transaction } from './db.mjs';
import { ApiError, invalid, object, quantity, string, utcDate } from './validation.mjs';

function recordEvent(db, before, after, { kind, at, dueAt = null, saleId = null }) {
  db.prepare(`
    INSERT INTO batch_events
      (batch_id, kind, recorded_at, due_at, sale_id, location_before, location_after,
       stage_before, stage_after, quantity_before, quantity_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(after.id, kind, at, dueAt, saleId, before?.location ?? null, after.location,
      before?.stage ?? null, after.stage, before?.quantity ?? null, after.quantity);
}

// Caller owns the write transaction that supplied 'before'.
export function reviseBatch(db, before, changes, event) {
  const { location, stage, quantity } = { ...before, ...changes };
  const after = db.prepare(`
    UPDATE plant_batches SET location = ?, stage = ?, quantity = ?, version = version + 1,
      updated_at = ? WHERE id = ? RETURNING *`).get(location, stage, quantity, event.at, before.id);
  recordEvent(db, before, after, event);
  return after;
}

export class Inventory {
  constructor(db) {
    this.db = db;
    const stages = db.prepare('SELECT code, position FROM stages ORDER BY position').all();
    this.stagePositions = new Map(stages.map(({ code, position }) => [code, position]));
  }

  checkStage(stage) {
    if (!this.stagePositions.has(stage)) invalid('Неизвестная стадия растения.');
    return stage;
  }

  catalog() {
    const rows = this.db.prepare(`
      SELECT p.id, p.name, c.* FROM plants p LEFT JOIN plant_care c ON c.plant_id = p.id
      ORDER BY p.id`).all();
    return rows.map(p => ({
      id: p.id, name: p.name,
      care: p.plant_id === null ? null : {
        scientific_name: p.scientific_name, category: p.category, light: p.light,
        watering: p.watering, soil: p.soil, pruning: p.pruning, flowering: p.flowering,
        hardiness: { zone: p.hardiness_zone, min_temperature_c: p.min_temperature_c, notes: p.hardiness_notes },
        height: { min_cm: p.min_height_cm, max_cm: p.max_height_cm },
      },
    }));
  }

  list(stage) {
    const items = stage === null || stage === undefined
      ? this.db.prepare('SELECT * FROM inventory ORDER BY id').all()
      : this.db.prepare('SELECT * FROM inventory WHERE stage = ? ORDER BY id').all(this.checkStage(stage));
    return { count: items.length, items };
  }

  detail(id) {
    const row = this.db.prepare(`
      SELECT i.*, p.planting_id, p.planted_at,
                  (SELECT json_group_array(json_object('stage', g.stage, 'due_at', g.due_at) ORDER BY g.due_at)
                   FROM growth_plan g WHERE g.batch_id = i.id) AS plan_json
      FROM inventory i LEFT JOIN plantings p ON p.batch_id = i.id WHERE i.id = ?`).get(id);
    if (!row) throw new ApiError(404, 'batch_not_found', 'Партия не найдена.');
    const { plan_json, ...batch } = row;
    return { ...batch, growth_plan: JSON.parse(plan_json) };
  }

  history(id) {
    this.detail(id);
    return this.db.prepare(`
      SELECT e.id, CASE WHEN p.planting_id IS NULL THEN e.kind ELSE 'planting' END AS kind,
             e.recorded_at, e.due_at, e.location_before, e.location_after, e.stage_before, e.stage_after,
             e.quantity_before, e.quantity_after, r.register_id, r.receipt_id, p.planting_id, p.planted_at
      FROM batch_events e LEFT JOIN paid_receipts r ON r.id = e.sale_id
      LEFT JOIN plantings p ON p.batch_id = e.batch_id AND e.kind = 'intake'
      WHERE e.batch_id = ? ORDER BY e.id`).all(id);
  }

  normalizePlan(currentStage, plan = [], earliest = '') {
    if (!Array.isArray(plan)) invalid('Поле growth_plan должно быть массивом переходов.');
    let previousPosition = this.stagePositions.get(currentStage);
    let previousDate = earliest;
    return plan.map(entry => {
      object(entry, 'growth_plan[]');
      const position = this.stagePositions.get(this.checkStage(entry.stage));
      const dueAt = utcDate(entry.due_at);
      if (position <= previousPosition || dueAt <= previousDate) {
        invalid('Переходы в плане должны идти вперёд по стадии и по времени.');
      }
      previousPosition = position;
      previousDate = dueAt;
      return { stage: entry.stage, due_at: dueAt };
    });
  }

  replacePlan(id, steps) {
    this.db.prepare('DELETE FROM growth_plan WHERE batch_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO growth_plan(batch_id, stage, due_at) VALUES (?, ?, ?)');
    for (const step of steps) insert.run(id, step.stage, step.due_at);
  }

  // Also used inside the single transaction that imports the example from the photo.
  insertBatch(input, plan = this.normalizePlan(input.stage, input.growth_plan)) {
    const plantId = string(input.plant_id, 'plant_id');
    if (!this.db.prepare('SELECT 1 FROM plants WHERE id = ?').get(plantId)) {
      throw new ApiError(422, 'unknown_plant', 'Растение отсутствует в справочнике.', { plant_id: plantId });
    }
    const at = new Date().toISOString();
    const after = this.db.prepare(`
      INSERT INTO plant_batches(plant_id, location, stage, quantity, updated_at)
      VALUES (?, ?, ?, ?, ?) RETURNING *`)
      .get(plantId, string(input.location, 'location'), this.checkStage(input.stage), quantity(input.quantity), at);
    if (plan.length) this.replacePlan(after.id, plan);
    recordEvent(this.db, null, after, { kind: 'intake', at });
    return this.detail(after.id);
  }

  create(input) {
    return transaction(this.db, () => this.insertBatch(object(input, 'партия')));
  }

  plant(input) {
    object(input, 'посадка');
    const plantingId = string(input.planting_id, 'planting_id');
    const name = Object.hasOwn(input, 'plant_name') ? string(input.plant_name, 'plant_name') : null;
    const requestedAt = Object.hasOwn(input, 'planted_at') ? utcDate(input.planted_at, 'planted_at') : null;
    const stage = this.checkStage(input.stage === undefined ? 'sowing' : input.stage);
    if (stage === 'ready') invalid('Для посадки выберите посев, укоренение или доращивание.');
    const batch = { plant_id: string(input.plant_id, 'plant_id'), location: string(input.location, 'location'),
      stage, quantity: quantity(input.quantity, 1) };
    const plan = this.normalizePlan(stage, input.growth_plan, requestedAt ?? '');
    const contents = JSON.stringify({ ...batch, plant_name: name, planted_at: requestedAt, growth_plan: plan });

    return transaction(this.db, () => {
      const previous = this.db.prepare('SELECT * FROM plantings WHERE planting_id = ?').get(plantingId);
      if (previous) {
        if (previous.request_json !== contents) {
          throw new ApiError(409, 'planting_conflict', 'Этот номер посадки уже использован для других данных.');
        }
        return { planting_id: plantingId, batch_id: previous.batch_id, planted_at: previous.planted_at,
          ...batch, replayed: true };
      }
      const now = new Date().toISOString();
      const plantedAt = requestedAt ?? now;
      if (plantedAt > now) invalid('Дата фактической посадки не может быть в будущем.');
      if (plan.length && plan[0].due_at <= plantedAt) invalid('Первый переход должен быть позже посадки.');
      if (name !== null) {
        this.db.prepare('INSERT INTO plants(id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(batch.plant_id, name);
        const plant = this.db.prepare('SELECT name FROM plants WHERE id = ?').get(batch.plant_id);
        if (plant.name !== name) {
          throw new ApiError(409, 'plant_name_conflict', 'В справочнике этому артикулу уже соответствует другое название.');
        }
      }
      const { id } = this.insertBatch(batch, plan);
      this.db.prepare('INSERT INTO plantings(planting_id, batch_id, planted_at, request_json) VALUES (?, ?, ?, ?)')
        .run(plantingId, id, plantedAt, contents);
      return { planting_id: plantingId, batch_id: id, planted_at: plantedAt, ...batch, replayed: false };
    });
  }

  update(id, input) {
    object(input, 'партия');
    if (!Number.isSafeInteger(input.version) || input.version < 1) invalid('Укажите текущую целую version партии.');
    const fields = Object.keys(input).filter(key => key !== 'version');
    const editable = ['location', 'quantity', 'stage', 'growth_plan'];
    if (!fields.length || fields.some(key => !editable.includes(key))) {
      invalid('Для изменения доступны location, quantity, stage и growth_plan.');
    }
    return transaction(this.db, () => {
      const before = this.detail(id);
      if (input.version !== before.version) {
        throw new ApiError(409, 'stale_version', 'Партия изменилась. Обновите данные перед правкой.',
          { current_version: before.version });
      }
      const changes = {};
      if (Object.hasOwn(input, 'quantity')) changes.quantity = quantity(input.quantity);
      if (Object.hasOwn(input, 'location')) changes.location = string(input.location, 'location');
      if (Object.hasOwn(input, 'stage')) changes.stage = this.checkStage(input.stage);
      const stage = changes.stage ?? before.stage;
      if (Object.hasOwn(input, 'growth_plan')) {
        this.replacePlan(id, this.normalizePlan(stage, input.growth_plan, before.planted_at ?? ''));
      } else if (stage !== before.stage) {
        this.db.prepare(`DELETE FROM growth_plan WHERE batch_id = ? AND stage IN
          (SELECT code FROM stages WHERE position <= ?)`).run(id, this.stagePositions.get(stage));
      }
      reviseBatch(this.db, before, changes, { kind: 'edit', at: new Date().toISOString() });
      return this.detail(id);
    });
  }

  applyDueGrowth(now = new Date().toISOString()) {
    return transaction(this.db, () => {
      const due = this.db.prepare(`
        SELECT batch_id, stage, due_at FROM growth_plan WHERE due_at <= ? ORDER BY due_at, batch_id`).all(now);
      const remove = this.db.prepare('DELETE FROM growth_plan WHERE batch_id = ? AND stage = ?');
      for (const step of due) {
        const before = this.detail(step.batch_id);
        reviseBatch(this.db, before, { stage: step.stage }, { kind: 'growth', at: now, dueAt: step.due_at });
        remove.run(before.id, step.stage);
      }
      return due.length;
    });
  }

  seedDemo() {
    const batches = JSON.parse(readFileSync(new URL('./examples/photo-batches.json', import.meta.url), 'utf8'));
    return transaction(this.db, () => {
      const marker = this.db.prepare("INSERT OR IGNORE INTO seed_runs(name) VALUES ('photo-v1')").run();
      if (!marker.changes) return 0;
      const addPlant = this.db.prepare('INSERT INTO plants(id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING');
      for (const batch of batches) {
        if (batch.name) addPlant.run(batch.plant_id, batch.name);
        this.insertBatch(batch);
      }
      return batches.length;
    });
  }
}
