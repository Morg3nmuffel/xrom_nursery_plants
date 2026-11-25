ALTER TABLE plants ADD COLUMN archived_at TEXT;
ALTER TABLE plant_batches ADD COLUMN archived_at TEXT;
DROP VIEW inventory;
CREATE VIEW inventory AS
SELECT b.id, b.plant_id, p.name, b.location, b.stage, s.label AS stage_label,
       b.quantity, b.version, b.updated_at
FROM plant_batches b JOIN plants p ON p.id = b.plant_id JOIN stages s ON s.code = b.stage
WHERE b.archived_at IS NULL;
