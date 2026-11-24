import { readFileSync } from 'node:fs';
import { transaction } from '../db.mjs';
import { ApiError } from '../validation.mjs';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const dayMs = 86_400_000;
const defaultRule = {
  title: 'Осмотреть партию',
  instructions: 'Проверьте состояние растений, влажность субстрата и освещение.',
  care: ['watering', 'light'],
};

const stageRules = {
  sowing: {
    title: 'Проверить посевы',
    instructions: 'Осмотрите посевы и проверьте влажность субстрата.',
    care: ['watering', 'soil'],
  },
  rooting: {
    title: 'Проверить укоренение',
    instructions: 'Осмотрите саженцы, проверьте влажность и дренаж субстрата.',
    care: ['watering', 'soil', 'light'],
  },
  growing: {
    title: 'Осмотреть растения на доращивании',
    instructions: 'Проверьте состояние побегов, влажность субстрата и освещение.',
    care: ['watering', 'light', 'pruning'],
  },
  ready: {
    title: 'Проверить товарную партию',
    instructions: 'Осмотрите товарный вид растений и проверьте влажность субстрата.',
    care: ['watering', 'light'],
  },
};

const taskRows = `
  SELECT t.*, i.plant_id, i.name AS plant_name, i.location, i.stage, i.stage_label, i.quantity,
         c.watering, c.light, c.soil, c.pruning
  FROM task_assignments t
  JOIN inventory i ON i.id = t.batch_id
  LEFT JOIN plant_care c ON c.plant_id = i.plant_id`;

function taskDetails(row) {
  const { title, instructions, care: fields } = Object.hasOwn(stageRules, row.stage) ? stageRules[row.stage] : defaultRule;
  const care = Object.fromEntries(fields.filter(field => row[field]?.trim()).map(field => [field, row[field]]));
  let directions = instructions;
  if (care.watering) directions += ' При необходимости полейте по рекомендации из карточки ухода.';
  if (!Object.keys(care).length) directions += ' Уточните условия ухода у ответственного.';
  return {
    title, instructions: directions, care,
    plant_id: row.plant_id, plant_name: row.plant_name, location: row.location,
    stage: row.stage, stage_label: row.stage_label, quantity: row.quantity,
  };
}

function formatTask(row) {
  const details = row.completed_at ? JSON.parse(row.completed_details_json) : taskDetails(row);
  return {
    id: row.id, batch_id: row.batch_id, assignee_id: row.assignee_id, due_on: row.due_on,
    created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at,
    status: row.completed_at ? 'done' : row.started_at ? 'in_progress' : 'todo',
    ...details,
  };
}

export class TaskPlanner {
  constructor(db, { assigneeIds, timeZone, clock = () => new Date() }) {
    this.db = db;
    this.assigneeIds = assigneeIds;
    this.clock = clock;
    this.calendar = new Intl.DateTimeFormat('ru-RU', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    transaction(db, () => db.exec(schema));
  }

  dateOf(now) {
    const parts = Object.fromEntries(this.calendar.formatToParts(now).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  generate() {
    return transaction(this.db, () => {
      const now = this.clock();
      const today = this.dateOf(now);
      const candidates = this.db.prepare(`
        SELECT b.id FROM plant_batches b
        WHERE b.quantity > 0
          AND NOT EXISTS (SELECT 1 FROM task_assignments t WHERE t.batch_id = b.id AND t.completed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM task_assignments t WHERE t.batch_id = b.id AND t.completed_on = ?)
          AND NOT EXISTS (SELECT 1 FROM task_assignments t WHERE t.batch_id = b.id AND t.due_on = ?)
        ORDER BY b.id`).all(today, today);
      if (!candidates.length) return 0;

      const counts = this.db.prepare(`
        SELECT t.assignee_id, count(*) AS count
        FROM task_assignments t JOIN plant_batches b ON b.id = t.batch_id
        WHERE (t.completed_at IS NULL AND b.quantity > 0) OR t.completed_on = ?
        GROUP BY t.assignee_id`).all(today);
      const assigned = new Map(counts.map(row => [row.assignee_id, row.count]));
      const workerCount = this.assigneeIds.length;
      const day = Math.floor(Date.parse(today) / dayMs);
      const offset = ((day % workerCount) + workerCount) % workerCount;
      const rotated = [...this.assigneeIds.slice(offset), ...this.assigneeIds.slice(0, offset)];
      const workers = rotated.map(id => ({ id, count: assigned.get(id) ?? 0 }));
      const add = this.db.prepare(`
        INSERT INTO task_assignments(batch_id, assignee_id, due_on, created_at) VALUES (?, ?, ?, ?)`);
      const createdAt = now.toISOString();
      for (const { id } of candidates) {
        const worker = workers.reduce((least, next) => next.count < least.count ? next : least);
        add.run(id, worker.id, today, createdAt);
        worker.count++;
      }
      return candidates.length;
    });
  }

  list(assigneeId = null) {
    const today = this.dateOf(this.clock());
    const filter = assigneeId === null ? '' : 'AND t.assignee_id = ?';
    const params = assigneeId === null ? [today] : [today, assigneeId];
    const rows = this.db.prepare(`${taskRows}
      WHERE ((t.completed_at IS NULL AND i.quantity > 0) OR t.completed_on = ?)
        ${filter}
      ORDER BY t.due_on, t.id`).all(...params);
    return { date: today, items: rows.map(formatTask) };
  }

  changeStatus(id, employeeId, action) {
    return transaction(this.db, () => {
      const read = this.db.prepare(`${taskRows} WHERE t.id = ?`);
      const task = read.get(id);
      if (!task) throw new ApiError(404, 'task_not_found', 'Задача не найдена.');
      if (task.assignee_id !== employeeId) {
        throw new ApiError(403, 'not_assignee', 'Задача назначена другому сотруднику.');
      }
      if (task.completed_at) {
        if (action === 'complete') return formatTask(task);
        throw new ApiError(409, 'task_done', 'Задача уже выполнена.');
      }
      if (task.quantity === 0) {
        throw new ApiError(409, 'batch_empty', 'Растений из этой партии сейчас нет в наличии.');
      }

      const now = this.clock();
      if (action === 'start') {
        if (task.started_at) return formatTask(task);
        this.db.prepare('UPDATE task_assignments SET started_at = ? WHERE id = ?').run(now.toISOString(), id);
      } else {
        this.db.prepare(`UPDATE task_assignments
          SET completed_at = ?, completed_on = ?, completed_details_json = ? WHERE id = ?`)
          .run(now.toISOString(), this.dateOf(now), JSON.stringify(taskDetails(task)), id);
      }
      return formatTask(read.get(id));
    });
  }
}
