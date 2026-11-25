ALTER TABLE materials ADD COLUMN archived_at TEXT;
DROP VIEW material_inventory;
CREATE VIEW material_inventory AS SELECT id, name, unit, decimals, stock_milli / 1000.0 AS quantity
FROM materials WHERE archived_at IS NULL;
CREATE VIEW valid_recipes AS
SELECT r.* FROM recipes r WHERE NOT EXISTS (
  SELECT 1 FROM recipe_items i JOIN materials m ON m.id = i.material_id
  WHERE i.recipe_id = r.id AND m.archived_at IS NOT NULL
);
CREATE VIEW current_recipes AS
SELECT * FROM valid_recipes WHERE id IN (SELECT MAX(id) FROM recipes GROUP BY plant_id);
