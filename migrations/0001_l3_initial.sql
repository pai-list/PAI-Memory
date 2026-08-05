-- L3 Fact Graph migration v1
CREATE TABLE IF NOT EXISTS l3_facts (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL,
  content TEXT NOT NULL,
  serial INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  embedding BLOB,
  mat256 BLOB,
  int8_data BLOB,
  int8_mean BLOB,
  int8_scale BLOB,
  metadata_json TEXT NOT NULL,
  layer TEXT NOT NULL,
  tier TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  accessCount INTEGER NOT NULL DEFAULT 0,
  lastAccessedAt INTEGER NOT NULL,
  importanceScore REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  novelty TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_l3_factKey ON l3_facts(fact_key);
CREATE INDEX IF NOT EXISTS idx_l3_createdAt ON l3_facts(createdAt);
CREATE INDEX IF NOT EXISTS idx_l3_pinned ON l3_facts(pinned);
CREATE INDEX IF NOT EXISTS idx_l3_lastAccessed ON l3_facts(lastAccessedAt);
CREATE INDEX IF NOT EXISTS idx_l3_validTo ON l3_facts(valid_to);