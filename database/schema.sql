-- ShowRunner OS v1.3.0 Production Schema (SQLite WAL)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  brand_name TEXT NOT NULL DEFAULT 'FactLock',
  locked_topic TEXT,
  target_duration REAL NOT NULL DEFAULT 11,
  target_words INTEGER NOT NULL DEFAULT 2062,
  configured_wpm REAL NOT NULL DEFAULT 187.41,
  actual_wpm REAL,
  active_state TEXT NOT NULL DEFAULT 'S0',
  generation_mode TEXT NOT NULL DEFAULT 'MODE_2_VIDEO',
  video_provider TEXT NOT NULL DEFAULT 'VEO_3_1',
  default_clip_duration REAL NOT NULL DEFAULT 8.0,
  reasoning_model TEXT,
  fast_model TEXT,
  embedding_model TEXT,
  smart_tiering INTEGER NOT NULL DEFAULT 1,
  master_prompt TEXT,
  master_prompt_extracted_json TEXT,
  dna_version INTEGER DEFAULT 0,
  entry_mode TEXT NOT NULL DEFAULT 'FULL',
  transcript_meta_json TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,
  encrypted_key TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  project_label TEXT NOT NULL,
  key_type TEXT NOT NULL DEFAULT 'GEMINI',
  status TEXT NOT NULL DEFAULT 'VALID',
  cooldown_until TIMESTAMP,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMP,
  last_checked_at TIMESTAMP,
  last_error TEXT,
  discovered_models_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_dna (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  dna_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_videos (
  project_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  transcript_json TEXT,
  analysis_json TEXT,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, video_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_stages (
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  is_dirty INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, stage_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blacklist_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  topic_title TEXT NOT NULL,
  banned_anchor TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phonetic_glossary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  english_term TEXT NOT NULL,
  hinglish_spelling TEXT,
  devanagari_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  stage_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS script_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  script_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  passed_checks INTEGER NOT NULL,
  audit_json TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS repair_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL DEFAULT 'S3',
  paragraph_index INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  failure_code TEXT NOT NULL DEFAULT 'C03',
  original_text TEXT NOT NULL DEFAULT '',
  repaired_text TEXT NOT NULL DEFAULT '',
  succeeded INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  result_json TEXT,
  error_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thumbnail_vision_cache (
  hash TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  specs_json TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
