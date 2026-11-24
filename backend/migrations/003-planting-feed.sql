CREATE TABLE planting_feed (
    seq         INTEGER PRIMARY KEY,
    planting_id TEXT NOT NULL UNIQUE REFERENCES plantings(planting_id),
    plant_id    TEXT NOT NULL,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    recorded_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER publish_planting AFTER INSERT ON plantings
BEGIN
    INSERT INTO planting_feed(planting_id, plant_id, quantity, recorded_at)
    SELECT NEW.planting_id, plant_id, quantity, updated_at FROM plant_batches WHERE id = NEW.batch_id;
END;
