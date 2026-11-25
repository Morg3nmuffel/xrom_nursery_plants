import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { enableWal, transaction } from './sqlite.mjs';

export { transaction };

const schemaFile = new URL('./schema.sql', import.meta.url);
const plantingsMigration = new URL('./migrations/002-plantings.sql', import.meta.url);
const catalogFile = new URL('./catalog/plants.json', import.meta.url);

export function inventoryDatabasePath() {
  const dataHome = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return process.env.INVENTORY_DB || join(dataHome, 'XromGroup', 'inventory.sqlite');
}

function writeCatalog(db, file) {
  const catalog = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (catalog.entity !== 'nursery_plants' || catalog.schema_version !== '1.0' ||
      !Array.isArray(catalog.plants) || catalog.plants.length === 0) {
    throw new Error('Ожидался справочник nursery_plants версии 1.0 с массивом plants.');
  }
  return writePlants(db, catalog.plants);
}

export function writePlants(db, plants) {
  const plant = db.prepare(`
    INSERT INTO plants(id, name) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
  const care = db.prepare(`
    INSERT INTO plant_care (plant_id, scientific_name, category, light, watering,
      soil, hardiness_zone, min_temperature_c, hardiness_notes, pruning, flowering,
      min_height_cm, max_height_cm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plant_id) DO UPDATE SET
      scientific_name = excluded.scientific_name, category = excluded.category,
      light = excluded.light, watering = excluded.watering, soil = excluded.soil,
      hardiness_zone = excluded.hardiness_zone, min_temperature_c = excluded.min_temperature_c,
      hardiness_notes = excluded.hardiness_notes, pruning = excluded.pruning,
      flowering = excluded.flowering, min_height_cm = excluded.min_height_cm,
      max_height_cm = excluded.max_height_cm`);
  const seen = new Set();
  for (const p of plants) {
    if (typeof p.id !== 'string' || !p.id || p.id !== p.id.trim() || p.id.length > 160 || seen.has(p.id)) {
      throw new Error('Нужен уникальный id растения длиной 1–160 символов без крайних пробелов.');
    }
    seen.add(p.id);
    plant.run(p.id, p.name);
    care.run(p.id, p.scientific_name, p.category, p.light, p.watering, p.soil,
      p.hardiness.zone, p.hardiness.min_temperature_c, p.hardiness.notes,
      p.pruning, p.flowering, p.height.min_cm, p.height.max_cm);
  }
  return seen.size;
}

export function importCatalog(db, file = catalogFile) {
  return transaction(db, () => writeCatalog(db, file));
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    enableWal(db);
    transaction(db, () => {
      if (db.prepare('PRAGMA application_id').get().application_id !== 0) {
        throw new Error('INVENTORY_DB должен указывать на базу растений.');
      }
      const { user_version: version } = db.prepare('PRAGMA user_version').get();
      if (version === 5) return;
      if (version < 0 || version > 5) throw new Error('Неизвестная версия схемы базы учёта.');
      if (version === 0) {
        db.exec(readFileSync(schemaFile, 'utf8'));
        writeCatalog(db, catalogFile);
      }
      if (version < 2) db.exec(readFileSync(plantingsMigration, 'utf8'));
      if (version < 3) db.exec(readFileSync(new URL('./migrations/003-planting-feed.sql', import.meta.url), 'utf8'));
      if (version < 4) db.exec(readFileSync(new URL('./migrations/004-admin.sql', import.meta.url), 'utf8'));
      db.exec('ALTER TABLE plants ADD COLUMN price_kopecks INTEGER CHECK (price_kopecks BETWEEN 0 AND 999999999999); PRAGMA user_version = 5');
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
