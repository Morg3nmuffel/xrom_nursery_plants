import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { enableWal, transaction } from '../sqlite.mjs';

// Separate application id prevents opening the plant database as a materials ledger.
const applicationId = 0x58524d43;

export function openMaterials(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    transaction(db, () => {
      const { application_id: id } = db.prepare('PRAGMA application_id').get();
      const { user_version: version } = db.prepare('PRAGMA user_version').get();
      if (id === applicationId && version === 3) return;
      if (id !== applicationId || ![1, 2].includes(version)) {
        if (id || version || db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table'").get()) {
          throw new Error('MATERIALS_DB должен указывать на отдельную базу расходников.');
        }
        db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      }
      if (version < 2) db.exec(readFileSync(new URL('./002-archive.sql', import.meta.url), 'utf8'));
      db.exec(`ALTER TABLE recipes ADD COLUMN retired_at TEXT;
        DROP VIEW current_recipes;
        CREATE VIEW current_recipes AS SELECT * FROM valid_recipes WHERE retired_at IS NULL
          AND id IN (SELECT MAX(id) FROM recipes GROUP BY plant_id);
        PRAGMA application_id = ${applicationId}; PRAGMA user_version = 3`);
    });
    enableWal(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
