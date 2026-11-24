CREATE TABLE plants (
    id   TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160 AND id = trim(id)),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0)
) STRICT;

-- У двух растений из примера на фото пока нет карточки ухода.
CREATE TABLE plant_care (
    plant_id          TEXT PRIMARY KEY REFERENCES plants(id),
    scientific_name   TEXT NOT NULL,
    category          TEXT NOT NULL,
    light             TEXT NOT NULL,
    watering          TEXT NOT NULL,
    soil              TEXT NOT NULL,
    hardiness_zone    TEXT NOT NULL,
    min_temperature_c REAL NOT NULL,
    hardiness_notes   TEXT NOT NULL,
    pruning           TEXT NOT NULL,
    flowering         TEXT NOT NULL,
    min_height_cm     REAL NOT NULL,
    max_height_cm     REAL NOT NULL CHECK (max_height_cm >= min_height_cm)
) STRICT;

CREATE TABLE stages (
    code     TEXT PRIMARY KEY,
    label    TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE
) STRICT;
INSERT INTO stages VALUES
    ('sowing',  'Посев', 0),
    ('rooting', 'Укоренение', 1),
    ('growing', 'Доращивание', 2),
    ('ready',   'Готово к продаже', 3);

CREATE TABLE plant_batches (
    id         INTEGER PRIMARY KEY,
    plant_id   TEXT NOT NULL REFERENCES plants(id),
    location   TEXT NOT NULL CHECK (length(trim(location)) BETWEEN 1 AND 160),
    stage      TEXT NOT NULL REFERENCES stages(code),
    quantity   INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 2147483647),
    version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX batches_for_sale ON plant_batches(plant_id, stage, id) WHERE quantity > 0;

CREATE VIEW inventory AS
SELECT b.id, b.plant_id, p.name, b.location, b.stage, s.label AS stage_label,
       b.quantity, b.version, b.updated_at
FROM plant_batches AS b
JOIN plants AS p ON p.id = b.plant_id
JOIN stages AS s ON s.code = b.stage;

CREATE TABLE growth_plan (
    batch_id INTEGER NOT NULL REFERENCES plant_batches(id),
    stage    TEXT NOT NULL REFERENCES stages(code),
    due_at   TEXT NOT NULL,
    PRIMARY KEY (batch_id, stage)
) STRICT;
CREATE INDEX growth_due ON growth_plan(due_at, batch_id);

CREATE TABLE paid_receipts (
    id          INTEGER PRIMARY KEY,
    register_id TEXT NOT NULL,
    receipt_id  TEXT NOT NULL,
    items_json  TEXT NOT NULL CHECK (json_valid(items_json)),
    applied_at  TEXT NOT NULL,
    UNIQUE (register_id, receipt_id)
) STRICT;

CREATE TABLE batch_events (
    id              INTEGER PRIMARY KEY,
    batch_id        INTEGER NOT NULL REFERENCES plant_batches(id),
    kind            TEXT NOT NULL CHECK (kind IN ('intake', 'edit', 'growth', 'sale')),
    recorded_at     TEXT NOT NULL,
    due_at          TEXT,
    sale_id         INTEGER REFERENCES paid_receipts(id),
    location_before TEXT,
    location_after  TEXT NOT NULL,
    stage_before    TEXT REFERENCES stages(code),
    stage_after     TEXT NOT NULL REFERENCES stages(code),
    quantity_before INTEGER,
    quantity_after  INTEGER NOT NULL,
    CHECK ((kind = 'sale') = (sale_id IS NOT NULL))
) STRICT;
CREATE INDEX batch_history ON batch_events(batch_id, id);
CREATE INDEX receipt_movements ON batch_events(sale_id) WHERE sale_id IS NOT NULL;

CREATE TABLE seed_runs (name TEXT PRIMARY KEY) STRICT;
