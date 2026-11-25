import { transaction } from '../sqlite.mjs';
import { ApiError, invalid, object, string } from '../validation.mjs';

export const maxMilli = 9_000_000_000_000;

function milliUnits(value, decimals, id) {
  const parts = typeof value === 'number' && /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(value));
  if (!parts || (parts[2]?.length ?? 0) > decimals) invalid(`Проверьте количество и точность для ${id}.`);
  const amount = Number(parts[1]) * 1000 + Number((parts[2] ?? '').padEnd(3, '0'));
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > maxMilli) invalid('Количество вне допустимого диапазона.');
  return amount;
}

export class Stock {
  constructor(db) {
    this.db = db;
  }

  materials() {
    return this.db.prepare('SELECT * FROM material_inventory ORDER BY id').all();
  }

  addMaterial(input) {
    const id = string(input.id, 'id');
    const name = string(input.name, 'name');
    const unit = string(input.unit, 'unit', 32);
    const decimals = input.decimals === undefined ? 0 : input.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) invalid('decimals должно быть целым от 0 до 3.');
    return transaction(this.db, () => {
      const result = this.db.prepare(`INSERT INTO materials(id, name, unit, decimals) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`).run(id, name, unit, decimals);
      if (!result.changes) throw new ApiError(409, 'material_exists', 'Артикул расходника уже зарегистрирован.');
      return this.db.prepare('SELECT * FROM material_inventory WHERE id = ?').get(id);
    });
  }

  removeMaterial(id) {
    const result = this.db.prepare('UPDATE materials SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(new Date().toISOString(), id);
    if (!result.changes) throw new ApiError(404, 'unknown_material', 'Расходник отсутствует на складе.');
    return { id };
  }

  normalizeItems(items, includeArchived = false) {
    if (!Array.isArray(items) || !items.length) invalid('Нужен непустой массив items.');
    const amounts = new Map();
    const lookup = this.db.prepare('SELECT decimals FROM materials WHERE id = ? AND (archived_at IS NULL OR ?)');
    for (const item of items) {
      object(item, 'items[]');
      const id = string(item.material_id, 'material_id');
      const material = lookup.get(id, Number(includeArchived));
      if (!material) throw new ApiError(422, 'unknown_material', 'Неизвестный расходник.', { material_id: id });
      if (amounts.has(id)) invalid('Объедините строки одного расходника в одну позицию.');
      amounts.set(id, milliUnits(item.quantity, material.decimals, id));
    }
    return [...amounts.keys()].sort().map(material_id => ({ material_id, milli: amounts.get(material_id) }));
  }

  history(materialId) {
    if (materialId == null) return this.db.prepare('SELECT * FROM material_history_view ORDER BY operation_no DESC, material_id').all();
    return this.db.prepare('SELECT * FROM material_history_view WHERE material_id = ? ORDER BY operation_no DESC').all(materialId);
  }

  post(kind, input) {
    if (!['purchase', 'usage'].includes(kind)) invalid('Неизвестная складская операция.');
    const reference = string(input.operation_id, 'operation_id');
    return transaction(this.db, () => this.move(kind, reference, this.normalizeItems(input.items, true)));
  }

  // Called with the write lock held. Check all balances before recording any lines.
  move(kind, reference, lines) {
    const signature = JSON.stringify(lines);
    const previous = this.db.prepare('SELECT id, request_json FROM operations WHERE kind = ? AND reference = ?').get(kind, reference);
    const movements = this.db.prepare('SELECT * FROM material_history_view WHERE operation_no = ? ORDER BY material_id');
    if (previous) {
      if (previous.request_json !== signature) throw new ApiError(409, 'operation_conflict', 'У этого номера операции другой состав.');
      return { operation_no: previous.id, replayed: true, movements: movements.all(previous.id) };
    }
    const lookup = this.db.prepare('SELECT stock_milli, unit FROM materials WHERE id = ? AND archived_at IS NULL');
    const changes = lines.map(({ material_id, milli }) => {
      const material = lookup.get(material_id);
      if (!material) throw new ApiError(422, 'unknown_material', 'Расходник удалён со склада.', { material_id });
      const delta = kind === 'purchase' ? milli : -milli;
      const after = material.stock_milli + delta;
      if (after < 0) {
        throw new ApiError(409, 'insufficient_material', 'Недостаточно материала для списания.',
          { material_id, unit: material.unit, required: milli / 1000, available: material.stock_milli / 1000 });
      }
      if (after > maxMilli) invalid('Закупка превышает максимальный остаток.');
      return { material_id, delta, after };
    });
    const { id } = this.db.prepare(`INSERT INTO operations(kind, reference, request_json, recorded_at)
      VALUES (?, ?, ?, ?) RETURNING id`).get(kind, reference, signature, new Date().toISOString());
    const update = this.db.prepare('UPDATE materials SET stock_milli = ? WHERE id = ?');
    const insert = this.db.prepare('INSERT INTO movements(operation_id, material_id, delta_milli, after_milli) VALUES (?, ?, ?, ?)');
    for (const row of changes) {
      update.run(row.after, row.material_id);
      insert.run(id, row.material_id, row.delta, row.after);
    }
    return { operation_no: id, replayed: false, movements: movements.all(id) };
  }

  recipeItems(id) {
    return this.db.prepare(`SELECT material_id, per_plant_milli AS milli FROM recipe_items
      WHERE recipe_id = ? ORDER BY material_id`).all(id);
  }

  recipes() {
    return this.db.prepare('SELECT id, plant_id FROM current_recipes ORDER BY plant_id').all().map(row => ({
      id: row.id, plant_id: row.plant_id || null, items: this.recipeItems(row.id).map(line => ({
        material_id: line.material_id, quantity: line.milli / 1000,
      })),
    }));
  }

  removeRecipe(id) {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT plant_id FROM current_recipes WHERE id = ?').get(id);
      if (!row) throw new ApiError(404, 'recipe_not_found', 'Норма уже удалена или заменена.');
      this.db.prepare('UPDATE recipes SET retired_at = ? WHERE plant_id = ? AND retired_at IS NULL')
        .run(new Date().toISOString(), row.plant_id);
      return { id };
    });
  }

  setRecipe(input) {
    const scope = input.plant_id == null ? '' : string(input.plant_id, 'plant_id');
    return transaction(this.db, () => this.writeRecipe(scope, this.normalizeItems(input.items)));
  }

  writeRecipe(scope, lines) {
    const current = this.db.prepare('SELECT id FROM recipes WHERE plant_id = ? AND retired_at IS NULL ORDER BY id DESC LIMIT 1').get(scope);
    if (current) {
      const prior = new Map(this.recipeItems(current.id).map(line => [line.material_id, line.milli]));
      if (prior.size === lines.length && lines.every(line => prior.get(line.material_id) === line.milli)) return current;
    }
    const row = this.db.prepare('INSERT INTO recipes(plant_id, created_at) VALUES (?, ?) RETURNING id')
      .get(scope, new Date().toISOString());
    const insert = this.db.prepare('INSERT INTO recipe_items(recipe_id, material_id, per_plant_milli) VALUES (?, ?, ?)');
    for (const line of lines) insert.run(row.id, line.material_id, line.milli);
    return row;
  }

  seedDemo() {
    return transaction(this.db, () => {
      if (!this.db.prepare("INSERT OR IGNORE INTO seed_runs VALUES ('demo-v1')").run().changes) return false;
      this.writeRecipe('', this.normalizeItems([{ material_id: 'pot', quantity: 1 }, { material_id: 'soil', quantity: 0.5 }]));
      this.move('purchase', 'demo-opening', this.normalizeItems([{ material_id: 'pot', quantity: 100 }, { material_id: 'soil', quantity: 50 }]));
      return true;
    });
  }
}
