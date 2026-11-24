const retrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function enableWal(db) {
  // Simultaneous journal-mode changes can return SQLITE_BUSY immediately, even with busy_timeout set.
  const timeoutMs = db.prepare('PRAGMA busy_timeout').get().timeout;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error) {
      const remainingMs = deadline - performance.now();
      if ((error.errcode & 0xff) !== 5 || remainingMs <= 0) throw error;
      Atomics.wait(retrySignal, 0, 0, Math.min(25, remainingMs));
    }
  }
}

// Every read-modify-write operation takes the SQLite write lock before reading stock.
export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
