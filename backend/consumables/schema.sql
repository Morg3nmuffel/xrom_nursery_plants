CREATE TABLE materials (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    unit          TEXT NOT NULL,
    decimals      INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 3),
    stock_milli   INTEGER NOT NULL DEFAULT 0 CHECK (stock_milli BETWEEN 0 AND 9000000000000)
) STRICT;
INSERT INTO materials(id, name, unit, decimals) VALUES
    ('pot', 'Горшок', 'шт', 0), ('soil', 'Грунт', 'л', 3);

CREATE VIEW material_inventory AS
SELECT id, name, unit, decimals, stock_milli / 1000.0 AS quantity FROM materials;

CREATE TABLE operations (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('purchase', 'usage', 'planting')),
    reference    TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    recorded_at  TEXT NOT NULL,
    UNIQUE(kind, reference)
) STRICT;
CREATE TABLE movements (
    operation_id INTEGER NOT NULL REFERENCES operations(id),
    material_id  TEXT NOT NULL REFERENCES materials(id),
    delta_milli  INTEGER NOT NULL CHECK (delta_milli <> 0),
    after_milli  INTEGER NOT NULL CHECK (after_milli >= 0),
    PRIMARY KEY(operation_id, material_id)
) STRICT;
CREATE INDEX material_history ON movements(material_id, operation_id);
CREATE VIEW material_history_view AS
SELECT o.id AS operation_no, o.kind, o.reference AS operation_id, o.recorded_at,
       m.material_id, c.name, c.unit, m.delta_milli / 1000.0 AS delta, m.after_milli / 1000.0 AS balance_after
FROM operations o JOIN movements m ON m.operation_id = o.id JOIN materials c ON c.id = m.material_id;

-- Empty plant_id denotes the default recipe. Versions remain available to pending plantings.
CREATE TABLE recipes (
    id         INTEGER PRIMARY KEY,
    plant_id   TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX recipe_versions ON recipes(plant_id, created_at, id);
CREATE TABLE recipe_items (
    recipe_id      INTEGER NOT NULL REFERENCES recipes(id),
    material_id    TEXT NOT NULL REFERENCES materials(id),
    per_plant_milli INTEGER NOT NULL CHECK (per_plant_milli > 0),
    PRIMARY KEY(recipe_id, material_id)
) STRICT;

CREATE TABLE planting_jobs (
    seq         INTEGER PRIMARY KEY,
    planting_id TEXT NOT NULL UNIQUE,
    plant_id    TEXT NOT NULL,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    recorded_at TEXT NOT NULL,
    recipe_id   INTEGER REFERENCES recipes(id),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
    problem     TEXT CHECK (problem IS NULL OR json_valid(problem)),
    operation_no INTEGER UNIQUE REFERENCES operations(id),
    CHECK ((status = 'applied') = (operation_no IS NOT NULL))
) STRICT;
CREATE INDEX pending_jobs ON planting_jobs(seq) WHERE status = 'pending';
CREATE TABLE seed_runs(name TEXT PRIMARY KEY) STRICT;
