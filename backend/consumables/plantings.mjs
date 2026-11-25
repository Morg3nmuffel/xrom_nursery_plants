import { transaction } from '../sqlite.mjs';
import { ApiError, invalid, object, quantity, string, utcDate } from '../validation.mjs';
import { maxMilli } from './stock.mjs';

export class PlantingQueue {
  constructor(stock) {
    this.stock = stock;
    this.db = stock.db;
  }

  cursor() {
    return this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM planting_jobs').get().seq;
  }

  accept(items) {
    if (!Array.isArray(items) || items.length > 100) invalid('Некорректная страница событий посадки.');
    return transaction(this.db, () => {
      const insert = this.db.prepare(`INSERT INTO planting_jobs(seq, planting_id, plant_id, quantity, recorded_at)
        VALUES (?, ?, ?, ?, ?)`);
      let cursor = this.cursor();
      for (const item of items) {
        object(item, 'посадка');
        if (!Number.isSafeInteger(item.seq) || item.seq < 1) invalid('Некорректный номер события.');
        const id = string(item.planting_id, 'planting_id');
        const plant = string(item.plant_id, 'plant_id');
        const count = quantity(item.quantity, 1);
        const at = utcDate(item.recorded_at, 'recorded_at');
        if (item.seq <= cursor) {
          const old = this.db.prepare('SELECT * FROM planting_jobs WHERE seq = ?').get(item.seq);
          if (old?.planting_id !== id || old.plant_id !== plant || old.quantity !== count || old.recorded_at !== at) {
            throw new Error('Номер события не совпадает с сохранённой посадкой.');
          }
          continue;
        }
        if (item.seq !== cursor + 1) throw new Error('Пропущено событие посадки.');
        insert.run(item.seq, id, plant, count, at);
        cursor = item.seq;
      }
    });
  }

  jobs(status) {
    if (status != null && !['pending', 'applied'].includes(status)) invalid('Неизвестное состояние посадки.');
    return this.db.prepare('SELECT * FROM planting_jobs WHERE (? IS NULL OR status = ?) ORDER BY seq DESC')
      .all(status ?? null, status ?? null).map(job => ({ ...job, problem: JSON.parse(job.problem) }));
  }

  selectRecipe(job) {
    if (job.recipe_id !== null) return job.recipe_id;
    const atRegistration = this.db.prepare(`SELECT id FROM recipes WHERE plant_id IN ('', ?) AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
      ORDER BY (plant_id = ?) DESC, created_at DESC, id DESC LIMIT 1`).get(job.plant_id, job.recorded_at, job.recorded_at, job.plant_id);
    if (atRegistration) return atRegistration.id;
    // A planting received before initial configuration can use the first applicable recipe.
    return this.db.prepare(`SELECT id FROM recipes WHERE plant_id IN ('', ?)
      AND created_at > ? AND (retired_at IS NULL OR retired_at > ?) ORDER BY created_at, id LIMIT 1`).get(job.plant_id, job.recorded_at, job.recorded_at)?.id ?? null;
  }

  settle(seq) {
    return transaction(this.db, () => {
      const job = this.db.prepare("SELECT * FROM planting_jobs WHERE seq = ? AND status = 'pending'").get(seq);
      if (!job) return;
      let recipe = this.selectRecipe(job);
      if (recipe !== null && !this.db.prepare('SELECT 1 FROM valid_recipes WHERE id = ?').get(recipe)) {
        recipe = this.db.prepare(`SELECT id FROM current_recipes WHERE plant_id IN ('', ?)
          ORDER BY (plant_id = ?) DESC LIMIT 1`).get(job.plant_id, job.plant_id)?.id ?? null;
      }
      const waitFor = problem => {
        const json = JSON.stringify(problem);
        if (recipe !== job.recipe_id || json !== job.problem) {
          this.db.prepare('UPDATE planting_jobs SET recipe_id = ?, problem = ? WHERE seq = ?').run(recipe, json, seq);
        }
      };
      if (recipe === null) return waitFor({ code: 'missing_recipe' });
      const lines = this.stock.recipeItems(recipe);
      for (const line of lines) {
        if (line.milli > Math.floor(maxMilli / job.quantity)) {
          return waitFor({ code: 'quantity_limit', material_id: line.material_id, per_plant: line.milli / 1000 });
        }
        line.milli *= job.quantity;
      }
      let movement;
      try {
        movement = this.stock.move('planting', job.planting_id, lines);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'insufficient_material') throw error;
        return waitFor({ code: error.code, ...error.details });
      }
      this.db.prepare(`UPDATE planting_jobs SET status = 'applied', recipe_id = ?, problem = NULL,
        operation_no = ? WHERE seq = ?`).run(recipe, movement.operation_no, seq);
    });
  }

  settlePending() {
    const jobs = this.db.prepare("SELECT seq FROM planting_jobs WHERE status = 'pending' ORDER BY seq").all();
    for (const job of jobs) this.settle(job.seq);
  }
}
