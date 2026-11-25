CREATE TABLE IF NOT EXISTS task_assignments (
    id                     INTEGER PRIMARY KEY,
    batch_id               INTEGER REFERENCES plant_batches(id),
    assignee_id            INTEGER CHECK (assignee_id > 0),
    title                  TEXT,
    instructions           TEXT NOT NULL DEFAULT '',
    removed_on             TEXT,
    due_on                 TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    started_at             TEXT,
    completed_at           TEXT,
    completed_on           TEXT,
    completed_details_json TEXT CHECK (json_valid(completed_details_json)),
    CHECK ((completed_at IS NULL) = (completed_on IS NULL)),
    CHECK ((completed_at IS NULL) = (completed_details_json IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS task_one_open_per_batch
ON task_assignments(batch_id) WHERE title IS NULL AND completed_at IS NULL AND removed_on IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS task_auto_per_day ON task_assignments(batch_id, due_on) WHERE title IS NULL;

CREATE INDEX IF NOT EXISTS task_completions_by_day
ON task_assignments(completed_on, batch_id) WHERE completed_on IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_recent_completions_by_assignee
ON task_assignments(assignee_id, completed_at DESC, id DESC)
WHERE completed_at IS NOT NULL AND removed_on IS NULL;

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT,
    removed_at TEXT,
    CHECK (removed_at IS NOT NULL OR password_hash IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS employee_login ON employees(username) WHERE removed_at IS NULL;
