import { readFileSync } from 'node:fs';
import { transaction } from '../db.mjs';
import { ApiError, invalid, string } from '../validation.mjs';

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
  SELECT t.*, e.name AS assignee_name, i.plant_id, i.name AS plant_name, i.location, i.stage, i.stage_label, i.quantity,
         c.watering, c.light, c.soil, c.pruning
  FROM task_assignments t
  LEFT JOIN inventory i ON i.id = t.batch_id
  LEFT JOIN employees e ON e.id = t.assignee_id
  LEFT JOIN plant_care c ON c.plant_id = i.plant_id`;

function taskDetails(row) {
  const { title, instructions, care: fields } = Object.hasOwn(stageRules, row.stage) ? stageRules[row.stage] : defaultRule;
  const care = Object.fromEntries(fields.filter(field => row[field]?.trim()).map(field => [field, row[field]]));
  let directions = instructions;
  if (care.watering) directions += ' При необходимости полейте по рекомендации из карточки ухода.';
  if (!Object.keys(care).length) directions += ' Уточните условия ухода у ответственного.';
  return {
    title: row.title ?? title, instructions: row.title ? row.instructions : directions, care,
    plant_id: row.plant_id, plant_name: row.plant_name, location: row.location,
    stage: row.stage, stage_label: row.stage_label, quantity: row.quantity,
  };
}

function formatTask(row) {
  const details = row.completed_at ? JSON.parse(row.completed_details_json) : taskDetails(row);
  return {
    id: row.id, batch_id: row.batch_id, assignee_id: row.assignee_id,
    assignee_name: row.assignee_name ?? (row.assignee_id == null ? 'Без исполнителя' : 'Сотрудник №' + row.assignee_id),
    due_on: row.due_on,
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
    transaction(db, () => {
      const columns = db.prepare('PRAGMA table_info(task_assignments)').all();
      const legacy = columns.length && !columns.some(column => column.name === 'removed_on');
      if (legacy) db.exec(`ALTER TABLE task_assignments RENAME TO task_assignments_legacy;
        DROP INDEX IF EXISTS task_one_open_per_batch; DROP INDEX IF EXISTS task_completions_by_day`);
      db.exec(schema);
      if (legacy) db.exec(`INSERT INTO task_assignments(id, batch_id, assignee_id, due_on, created_at,
        started_at, completed_at, completed_on, completed_details_json)
        SELECT id, batch_id, assignee_id, due_on, created_at, started_at, completed_at, completed_on, completed_details_json
        FROM task_assignments_legacy; DROP TABLE task_assignments_legacy`);
    });
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
        SELECT b.id FROM inventory b
        WHERE b.quantity > 0
          AND NOT EXISTS (SELECT 1 FROM task_assignments t WHERE t.batch_id = b.id AND t.title IS NULL
            AND ((t.completed_at IS NULL AND t.removed_on IS NULL) OR t.completed_on = ? OR t.due_on = ? OR t.removed_on = ?))
        ORDER BY b.id`).all(today, today, today);
      const unassigned = this.db.prepare(`SELECT t.id FROM task_assignments t LEFT JOIN inventory b ON b.id = t.batch_id
        WHERE t.assignee_id IS NULL AND t.completed_at IS NULL AND t.removed_on IS NULL
        AND (t.batch_id IS NULL OR b.quantity > 0) ORDER BY t.id`).all();
      if (!candidates.length && !unassigned.length) return 0;

      const counts = this.db.prepare(`
        SELECT t.assignee_id, count(*) AS count
        FROM task_assignments t LEFT JOIN inventory b ON b.id = t.batch_id
        WHERE t.removed_on IS NULL AND ((t.completed_at IS NULL AND (b.quantity > 0 OR t.batch_id IS NULL)) OR t.completed_on = ?)
        GROUP BY t.assignee_id`).all(today);
      const assigned = new Map(counts.map(row => [row.assignee_id, row.count]));
      const ids = this.assigneeIds ?? this.db.prepare('SELECT id FROM employees WHERE removed_at IS NULL ORDER BY id').all().map(e => e.id);
      const workerCount = ids.length;
      if (!workerCount) return 0;
      const day = Math.floor(Date.parse(today) / dayMs);
      const offset = ((day % workerCount) + workerCount) % workerCount;
      const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
      const workers = rotated.map(id => ({ id, count: assigned.get(id) ?? 0 }));
      const add = this.db.prepare(`
        INSERT INTO task_assignments(batch_id, assignee_id, due_on, created_at) VALUES (?, ?, ?, ?)`);
      const createdAt = now.toISOString();
      const nextWorker = () => workers.reduce((least, next) => next.count < least.count ? next : least);
      const reassign = this.db.prepare('UPDATE task_assignments SET assignee_id = ? WHERE id = ?');
      for (const task of unassigned) {
        const worker = nextWorker();
        reassign.run(worker.id, task.id);
        worker.count++;
      }
      for (const { id } of candidates) {
        const worker = nextWorker();
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
      WHERE t.removed_on IS NULL AND ((t.completed_at IS NULL AND (i.quantity > 0 OR t.batch_id IS NULL)) OR t.completed_on = ?)
        ${filter}
      ORDER BY t.due_on, t.id`).all(...params);
    return { date: today, items: rows.map(formatTask) };
  }

  add(input) {
    const title = string(input.title, 'title', 200);
    const instructions = input.instructions ? string(input.instructions, 'instructions', 4000) : '';
    const now = this.clock();
    const due = input.due_on ?? this.dateOf(now);
    const date = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due) && new Date(due + 'T00:00:00Z');
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== due) invalid('Проверьте срок задачи.');
    return transaction(this.db, () => {
      if (input.assignee_id != null && (!Number.isSafeInteger(input.assignee_id) ||
          !this.db.prepare('SELECT 1 FROM employees WHERE id = ? AND removed_at IS NULL').get(input.assignee_id))) invalid('Сотрудник не найден.');
      if (input.batch_id != null && (!Number.isSafeInteger(input.batch_id) ||
          !this.db.prepare('SELECT 1 FROM inventory WHERE id = ? AND quantity > 0').get(input.batch_id))) invalid('Выберите доступную партию.');
      const { id } = this.db.prepare(`INSERT INTO task_assignments(batch_id, assignee_id, title, instructions, due_on, created_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(input.batch_id ?? null, input.assignee_id ?? null, title, instructions, due, now.toISOString());
      return formatTask(this.db.prepare(taskRows + ' WHERE t.id = ?').get(id));
    });
  }

  remove(id) {
    const result = this.db.prepare('UPDATE task_assignments SET removed_on = ? WHERE id = ? AND removed_on IS NULL')
      .run(this.dateOf(this.clock()), id);
    if (!result.changes) throw new ApiError(404, 'task_not_found', 'Задача не найдена.');
    return { id };
  }

  changeStatus(id, employeeId, action) {
    return transaction(this.db, () => {
      const read = this.db.prepare(`${taskRows} WHERE t.id = ?`);
      const task = read.get(id);
      if (!task || task.removed_on || (task.batch_id !== null && task.quantity === null && !task.completed_at)) {
        throw new ApiError(404, 'task_not_found', 'Задача не найдена.');
      }
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
