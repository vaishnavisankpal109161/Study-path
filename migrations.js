/**
 * StudyPath • Database Migrations & Data Preservation Module
 * Supports both PostgreSQL (hosted: Neon / Supabase / Vercel Postgres)
 * and SQLite (local: data/studypath.db).
 */

const fs = require('fs');
const path = require('path');

// Load environment variables if present
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    lines.forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        let value = (match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[match[1]] = value;
      }
    });
  }
}
loadEnv();

const PG_CONNECTION_STRING = process.env.POSTGRES_URL || process.env.DATABASE_URL;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    name VARCHAR(255) NOT NULL,
    major VARCHAR(255),
    reset_token VARCHAR(255),
    reset_token_expires BIGINT,
    created_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));
  CREATE INDEX IF NOT EXISTS idx_users_reset ON users(reset_token);

  CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(128) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS assignments (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    due_date VARCHAR(64) NOT NULL,
    priority VARCHAR(32) NOT NULL,
    duration VARCHAR(64),
    estimated_minutes INTEGER DEFAULT 90,
    notes TEXT,
    links TEXT DEFAULT '[]',
    completed INTEGER NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_date);

  CREATE TABLE IF NOT EXISTS subtasks (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assignment_id VARCHAR(64) NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    due_date VARCHAR(64),
    completed INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_subtasks_user ON subtasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_subtasks_assignment ON subtasks(assignment_id);

  CREATE TABLE IF NOT EXISTS study_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject VARCHAR(255) NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time VARCHAR(32) NOT NULL,
    duration_minutes INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    created_at VARCHAR(64) NOT NULL,
    updated_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_study_sessions_user ON study_sessions(user_id);

  CREATE TABLE IF NOT EXISTS reminders (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assignment_id VARCHAR(64) NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    remind_at VARCHAR(64) NOT NULL,
    offset_minutes INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at VARCHAR(64) NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_assignment ON reminders(assignment_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_time ON reminders(remind_at);
`;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    name TEXT NOT NULL,
    major TEXT,
    reset_token TEXT,
    reset_token_expires INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_reset ON users(reset_token);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    due_date TEXT NOT NULL,
    priority TEXT NOT NULL,
    duration TEXT,
    estimated_minutes INTEGER DEFAULT 90,
    notes TEXT,
    links TEXT DEFAULT '[]',
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_date);

  CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    title TEXT NOT NULL,
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_subtasks_user ON subtasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_subtasks_assignment ON subtasks(assignment_id);

  CREATE TABLE IF NOT EXISTS study_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_study_sessions_user ON study_sessions(user_id);

  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    offset_minutes INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_assignment ON reminders(assignment_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_time ON reminders(remind_at);
`;

/**
 * Run migrations on PostgreSQL hosted database
 */
async function runPostgresMigrations(connectionString) {
  const { Pool } = require('pg');
  const isLocalPg = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = new Pool({
    connectionString,
    ssl: isLocalPg ? false : { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    console.log('🔄 Connected to PostgreSQL. Applying schema migrations...');
    await client.query(PG_SCHEMA);

    // Check if users table has data
    const userCountRes = await client.query('SELECT COUNT(*) AS count FROM users');
    const userCount = parseInt(userCountRes.rows[0].count, 10);
    console.log(`📊 PostgreSQL users table currently has ${userCount} records.`);

    // If database is empty, seed from seed_data.json to preserve user accounts and assignments
    const seedPath = path.join(__dirname, 'data', 'seed_data.json');
    if (userCount === 0 && fs.existsSync(seedPath)) {
      console.log('🌱 Empty database detected. Restoring preserved user accounts & assignment data...');
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

      // Users
      for (const u of seed.users || []) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, salt, name, major, reset_token, reset_token_expires, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [u.id, u.email, u.password_hash, u.salt, u.name, u.major, u.reset_token, u.reset_token_expires, u.created_at]
        );
      }

      // Sessions
      for (const s of seed.sessions || []) {
        await client.query(
          `INSERT INTO sessions (token, user_id, expires_at, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (token) DO NOTHING`,
          [s.token, s.user_id, s.expires_at, s.created_at]
        );
      }

      // Assignments
      for (const a of seed.assignments || []) {
        await client.query(
          `INSERT INTO assignments (id, user_id, title, subject, due_date, priority, duration, estimated_minutes, notes, links, completed, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.user_id, a.title, a.subject, a.due_date, a.priority, a.duration, a.estimated_minutes || 90, a.notes, a.links, a.completed, a.created_at, a.updated_at]
        );
      }

      // Subtasks
      for (const st of seed.subtasks || []) {
        await client.query(
          `INSERT INTO subtasks (id, user_id, assignment_id, title, due_date, completed, order_index, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [st.id, st.user_id, st.assignment_id, st.title, st.due_date, st.completed, st.order_index, st.created_at, st.updated_at]
        );
      }

      // Study Sessions
      for (const ss of seed.study_sessions || []) {
        await client.query(
          `INSERT INTO study_sessions (id, user_id, subject, day_of_week, start_time, duration_minutes, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [ss.id, ss.user_id, ss.subject, ss.day_of_week, ss.start_time, ss.duration_minutes, ss.notes, ss.created_at, ss.updated_at]
        );
      }

      // Reminders
      for (const r of seed.reminders || []) {
        await client.query(
          `INSERT INTO reminders (id, user_id, assignment_id, remind_at, offset_minutes, title, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [r.id, r.user_id, r.assignment_id, r.remind_at, r.offset_minutes, r.title, r.status, r.created_at]
        );
      }

      console.log('✅ Successfully preserved and restored all user data to PostgreSQL.');
    }

    console.log('✅ PostgreSQL migrations completed successfully.');
    return { success: true, engine: 'postgres' };
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Run migrations on SQLite local database
 */
function runSqliteMigrations() {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'studypath.db');
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SQLITE_SCHEMA);

  console.log('✅ Local SQLite migrations applied successfully.');
  return { success: true, engine: 'sqlite' };
}

/**
 * Main migration entry point
 */
async function migrate() {
  if (PG_CONNECTION_STRING) {
    console.log('🚀 Running migrations on hosted PostgreSQL database...');
    return await runPostgresMigrations(PG_CONNECTION_STRING);
  } else {
    console.log('💻 No POSTGRES_URL or DATABASE_URL provided. Running migrations on local SQLite database...');
    return runSqliteMigrations();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
}

module.exports = {
  migrate,
  runPostgresMigrations,
  runSqliteMigrations,
  PG_SCHEMA,
  SQLITE_SCHEMA
};
