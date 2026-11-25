CREATE TABLE customers (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE customer_cart (
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    plant_id    TEXT NOT NULL REFERENCES plants(id),
    quantity    INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 2147483647),
    PRIMARY KEY (customer_id, plant_id)
) STRICT;

CREATE TABLE customer_conversations (
    customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
    state        TEXT NOT NULL CHECK (state IN ('assistant', 'pending', 'answered')),
    updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE customer_messages (
    id           INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customer_conversations(customer_id),
    author       TEXT NOT NULL CHECK (author IN ('customer', 'assistant', 'admin')),
    text         TEXT NOT NULL,
    sent_at      TEXT NOT NULL,
    request_id   TEXT,
    plant_ids    TEXT CHECK (json_valid(plant_ids)),
    UNIQUE (customer_id, request_id)
) STRICT;

CREATE INDEX customer_messages_by_thread ON customer_messages(customer_id, id);
