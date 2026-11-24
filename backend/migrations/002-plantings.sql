CREATE TABLE plantings (
    planting_id  TEXT PRIMARY KEY CHECK (length(trim(planting_id)) BETWEEN 1 AND 160),
    batch_id     INTEGER NOT NULL UNIQUE REFERENCES plant_batches(id),
    planted_at   TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json))
) STRICT;
