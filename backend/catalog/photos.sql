CREATE TABLE IF NOT EXISTS catalog_photos (
    plant_id     TEXT PRIMARY KEY REFERENCES plants(id),
    public_id    TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes        BLOB NOT NULL CHECK (length(bytes) BETWEEN 1 AND 5242880)
) STRICT;
