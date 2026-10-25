/**
 * StudyPath • Dedicated SQLite to Hosted PostgreSQL Migration Script
 * Connects to local SQLite (data/studypath.db) and copies all records
 * into the hosted PostgreSQL database, preserving user credentials,
 * assignments, subtasks, study sessions, and reminders.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load environment variables
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

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function migrateData() {
  if (!connectionString) {
    console.error('❌ Error: POSTGRES_URL or DATABASE_URL environment variable is required to migrate to hosted database.');
    console.error('Usage: POSTGRES_URL=postgres://user:pass@host:5432/dbname node migrate_sqlite_to_hosted.js');
    process.exit(1);
  }

  const { DatabaseSync } = require('node:sqlite');
  const sqlitePath = path.join(__dirname, 'data', 'studypath.db');
  if (!fs.existsSync(sqlitePath)) {
    console.error('❌ Error: Local SQLite file not found at:', sqlitePath);
    process.exit(1);
  }

  const sqlite = new DatabaseSync(sqlitePath);
  const isLocalPg = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = new Pool({
    connectionString,
    ssl: isLocalPg ? false : { rejectUnauthorized: false }
  });

  const client = await pool.connect();

  try {
    console.log('🔄 Connected to hosted PostgreSQL database. Ensuring schema...');
    const { PG_SCHEMA } = require('./migrations');
    await client.query(PG_SCHEMA);

    console.log('📦 Reading records from local SQLite database...');
    const users = sqlite.prepare('SELECT * FROM users').all();
    const sessions = sqlite.prepare('SELECT * FROM sessions').all();
    const assignments = sqlite.prepare('SELECT * FROM assignments').all();
    const subtasks = sqlite.prepare('SELECT * FROM subtasks').all();
    const studySessions = sqlite.prepare('SELECT * FROM study_sessions').all();
    const reminders = sqlite.prepare('SELECT * FROM reminders').all();

    console.log(`Found: ${users.length} users, ${sessions.length} sessions, ${assignments.length} assignments, ${subtasks.length} subtasks, ${studySessions.length} study sessions, ${reminders.length} reminders.`);

    console.log('🚀 Transferring records to PostgreSQL...');
    await client.query('BEGIN');

    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, salt, name, major, reset_token, reset_token_expires, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           salt = EXCLUDED.salt,
           name = EXCLUDED.name,
           major = EXCLUDED.major`,
        [u.id, u.email, u.password_hash, u.salt, u.name, u.major, u.reset_token, u.reset_token_expires, u.created_at]
      );
    }

    for (const s of sessions) {
      await client.query(
        `INSERT INTO sessions (token, user_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE SET
           expires_at = EXCLUDED.expires_at`,
        [s.token, s.user_id, s.expires_at, s.created_at]
      );
    }

    for (const a of assignments) {
      await client.query(
        `INSERT INTO assignments (id, user_id, title, subject, due_date, priority, duration, estimated_minutes, notes, links, completed, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           subject = EXCLUDED.subject,
           due_date = EXCLUDED.due_date,
           priority = EXCLUDED.priority,
           duration = EXCLUDED.duration,
           estimated_minutes = EXCLUDED.estimated_minutes,
           notes = EXCLUDED.notes,
           links = EXCLUDED.links,
           completed = EXCLUDED.completed,
           updated_at = EXCLUDED.updated_at`,
        [a.id, a.user_id, a.title, a.subject, a.due_date, a.priority, a.duration, a.estimated_minutes || 90, a.notes, a.links, a.completed, a.created_at, a.updated_at]
      );
    }

    for (const st of subtasks) {
      await client.query(
        `INSERT INTO subtasks (id, user_id, assignment_id, title, due_date, completed, order_index, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           due_date = EXCLUDED.due_date,
           completed = EXCLUDED.completed,
           order_index = EXCLUDED.order_index,
           updated_at = EXCLUDED.updated_at`,
        [st.id, st.user_id, st.assignment_id, st.title, st.due_date, st.completed, st.order_index, st.created_at, st.updated_at]
      );
    }

    for (const ss of studySessions) {
      await client.query(
        `INSERT INTO study_sessions (id, user_id, subject, day_of_week, start_time, duration_minutes, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           subject = EXCLUDED.subject,
           day_of_week = EXCLUDED.day_of_week,
           start_time = EXCLUDED.start_time,
           duration_minutes = EXCLUDED.duration_minutes,
           notes = EXCLUDED.notes,
           updated_at = EXCLUDED.updated_at`,
        [ss.id, ss.user_id, ss.subject, ss.day_of_week, ss.start_time, ss.duration_minutes, ss.notes, ss.created_at, ss.updated_at]
      );
    }

    for (const r of reminders) {
      await client.query(
        `INSERT INTO reminders (id, user_id, assignment_id, remind_at, offset_minutes, title, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           remind_at = EXCLUDED.remind_at,
           offset_minutes = EXCLUDED.offset_minutes,
           title = EXCLUDED.title,
           status = EXCLUDED.status`,
        [r.id, r.user_id, r.assignment_id, r.remind_at, r.offset_minutes, r.title, r.status, r.created_at]
      );
    }

    await client.query('COMMIT');
    console.log('🎉 Migration finished successfully! All data preserved and transferred to hosted database.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrateData();
}

module.exports = migrateData;
