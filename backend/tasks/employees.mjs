import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { transaction } from '../sqlite.mjs';
import { ApiError, invalid, string } from '../validation.mjs';

function credentials(input) {
  const name = string(input.name, 'name', 120);
  const username = string(input.username, 'username', 120);
  const password = input.password;
  if (typeof password !== 'string' || !password.trim() || password.length > 1024) invalid('Введите пароль до 1024 символов.');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return [name, username, salt + ':' + hash];
}

export class Employees {
  constructor(db, initial) {
    this.db = db;
    transaction(db, () => {
      if (!db.prepare("INSERT OR IGNORE INTO seed_runs VALUES ('employees-v1')").run().changes) return;
      const rows = typeof initial === 'function' ? initial() : (initial ?? []);
      if (!Array.isArray(rows)) invalid('Ожидался список сотрудников.');
      const insert = db.prepare('INSERT INTO employees(id, name, username, password_hash) VALUES (?, ?, ?, ?)');
      for (const row of rows) {
        if (!Number.isSafeInteger(row.id) || row.id < 1) invalid('Некорректный номер сотрудника.');
        insert.run(row.id, ...credentials(row));
      }
      // Reserve legacy assignee IDs even when only part of the original roster is available.
      db.exec(`INSERT INTO employees(id, name, username, removed_at)
        SELECT DISTINCT assignee_id, 'Сотрудник №' || assignee_id, '', CURRENT_TIMESTAMP
        FROM task_assignments WHERE assignee_id IS NOT NULL AND assignee_id NOT IN (SELECT id FROM employees);
        UPDATE task_assignments SET assignee_id = NULL, started_at = NULL WHERE completed_at IS NULL
        AND assignee_id IN (SELECT id FROM employees WHERE removed_at IS NOT NULL)`);
    });
  }

  list() {
    return this.db.prepare('SELECT id, name, username FROM employees WHERE removed_at IS NULL ORDER BY id').all();
  }

  add(input) {
    const values = credentials(input);
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM employees WHERE username = ? AND removed_at IS NULL').get(values[1])) {
        throw new ApiError(409, 'login_taken', 'Этот логин уже занят.');
      }
      return this.db.prepare('INSERT INTO employees(name, username, password_hash) VALUES (?, ?, ?) RETURNING id, name, username').get(...values);
    });
  }

  remove(id) {
    return transaction(this.db, () => {
      const result = this.db.prepare('UPDATE employees SET removed_at = ?, password_hash = NULL WHERE id = ? AND removed_at IS NULL')
        .run(new Date().toISOString(), id);
      if (!result.changes) throw new ApiError(404, 'employee_not_found', 'Сотрудник не найден.');
      this.db.prepare(`UPDATE task_assignments SET assignee_id = NULL, started_at = NULL
        WHERE assignee_id = ? AND completed_at IS NULL AND removed_on IS NULL`).run(id);
      return { id };
    });
  }

  authenticate(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) return null;
    const row = this.db.prepare('SELECT id, password_hash FROM employees WHERE username = ? AND removed_at IS NULL').get(username);
    if (!row) return null;
    const [salt, hash] = row.password_hash.split(':');
    return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(hash, 'hex')) ? row.id : null;
  }
}
