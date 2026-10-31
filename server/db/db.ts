import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function computePayloadHash(payloadJson: string): string {
  return crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
}

function loadSchemaSql(): string {
  const candidates = [
    path.resolve(__dirname, 'schema.sql'),
    path.resolve(process.cwd(), 'server/db/schema.sql'),
    path.resolve(process.cwd(), 'database/schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  throw new Error('Could not locate server/db/schema.sql');
}

export function openDatabase(customDbPath?: string): DatabaseSync {
  const dbPath =
    customDbPath ||
    process.env.SHOWRUNNER_DB_PATH ||
    path.resolve(process.cwd(), 'database/engine.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  const schemaSql = loadSchemaSql();
  db.exec(schemaSql);

  const projCols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
  if (!projCols.some((c) => c.name === 'brand_name')) {
    db.exec(`ALTER TABLE projects ADD COLUMN brand_name TEXT NOT NULL DEFAULT 'FactLock'`);
  }
  if (!projCols.some((c) => c.name === 'locked_topic')) {
    db.exec(`ALTER TABLE projects ADD COLUMN locked_topic TEXT`);
  }
  if (!projCols.some((c) => c.name === 'embedding_model')) {
    db.exec(`ALTER TABLE projects ADD COLUMN embedding_model TEXT`);
  }
  if (!projCols.some((c) => c.name === 'master_prompt_extracted_json')) {
    db.exec(`ALTER TABLE projects ADD COLUMN master_prompt_extracted_json TEXT`);
  }
  if (!projCols.some((c) => c.name === 'dna_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN dna_version INTEGER DEFAULT 0`);
  }
  if (!projCols.some((c) => c.name === 'entry_mode')) {
    db.exec(`ALTER TABLE projects ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'FULL'`);
  }
  if (!projCols.some((c) => c.name === 'transcript_meta_json')) {
    db.exec(`ALTER TABLE projects ADD COLUMN transcript_meta_json TEXT`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS thumbnail_vision_cache (
      hash TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      specs_json TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const keyCols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
  if (!keyCols.some((c) => c.name === 'key_type')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN key_type TEXT NOT NULL DEFAULT 'GEMINI'`);
  }
  if (!keyCols.some((c) => c.name === 'last_checked_at')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN last_checked_at TIMESTAMP`);
  }
  if (!keyCols.some((c) => c.name === 'last_error')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN last_error TEXT`);
  }
  if (!keyCols.some((c) => c.name === 'discovered_models_json')) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN discovered_models_json TEXT`);
  }

  const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
  if (!jobCols.some((c) => c.name === 'phase')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT ''`);
  }

  const repCols = db.prepare(`PRAGMA table_info(repair_attempts)`).all() as Array<{
    name: string;
  }>;
  if (!repCols.some((c) => c.name === 'paragraph_index')) {
    db.exec(`DROP TABLE IF EXISTS repair_attempts`);
    db.exec(`
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
    `);
  }

  // Mark any stale RUNNING jobs as FAILED on server boot (A6)
  db.prepare(
    `UPDATE jobs
     SET status = 'FAILED',
         phase = 'FAILED_ON_BOOT',
         message = 'Marked FAILED on server restart (stale RUNNING job)',
         error_json = COALESCE(error_json, '{"code":"JOB_STALE_ON_BOOT","message":"Job interrupted by server restart"}'),
         updated_at = CURRENT_TIMESTAMP
     WHERE status = 'RUNNING'`
  ).run();

  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)`
  ).run('1.3.0-v3-dna');

  verifyStageIntegrityHashes(db);

  return db;
}

export function verifyStageIntegrityHashes(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT project_id, stage_id, payload_json, payload_hash, status FROM project_stages`
    )
    .all() as Array<{
    project_id: string;
    stage_id: string;
    payload_json: string;
    payload_hash: string;
    status: string;
  }>;

  let invalidatedCount = 0;
  for (const row of rows) {
    const expectedHash = computePayloadHash(row.payload_json);
    if (!row.payload_hash) {
      db.prepare(
        `UPDATE project_stages SET payload_hash = ? WHERE project_id = ? AND stage_id = ?`
      ).run(expectedHash, row.project_id, row.stage_id);
      continue;
    }
    if (row.payload_hash !== expectedHash && row.status !== 'INVALIDATED') {
      db.prepare(
        `UPDATE project_stages SET status = 'INVALIDATED', is_dirty = 1, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND stage_id = ?`
      ).run(row.project_id, row.stage_id);
      invalidatedCount++;
    }
  }
  return invalidatedCount;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error if transaction already closed
    }
    throw err;
  }
}
