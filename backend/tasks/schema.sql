CREATE TABLE IF NOT EXISTS task_assignments (
    id                     INTEGER PRIMARY KEY,
    batch_id               INTEGER NOT NULL REFERENCES plant_batches(id),
    assignee_id            INTEGER NOT NULL CHECK (assignee_id BETWEEN 1 AND 5),
    due_on                 TEXT NOT NULL,
    created_at             TEXT NOT NULL,
    started_at             TEXT,
    completed_at           TEXT,
    completed_on           TEXT,
    completed_details_json TEXT CHECK (json_valid(completed_details_json)),
    UNIQUE (batch_id, due_on),
    CHECK ((completed_at IS NULL) = (completed_on IS NULL)),
    CHECK ((completed_at IS NULL) = (completed_details_json IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS task_one_open_per_batch
ON task_assignments(batch_id) WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS task_completions_by_day
ON task_assignments(completed_on, batch_id) WHERE completed_on IS NOT NULL;
