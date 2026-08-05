-- L2 Episodic Chain migration v1
CREATE TABLE IF NOT EXISTS l2_entries (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  embedding BLOB,
  metadata_json TEXT NOT NULL,
  layer TEXT NOT NULL,
  tier TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  accessCount INTEGER NOT NULL DEFAULT 0,
  lastAccessedAt INTEGER NOT NULL,
  importanceScore REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_l2_createdAt ON l2_entries(createdAt);
CREATE INDEX IF NOT EXISTS idx_l2_pinned ON l2_entries(pinned);
CREATE INDEX IF NOT EXISTS idx_l2_lastAccessed ON l2_entries(lastAccessedAt);