/**
 * StudyPath • Universal Database Layer
 * Supports both persistent hosted PostgreSQL (Neon / Supabase / Vercel Postgres)
 * and zero-config local SQLite (data/studypath.db).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let isPostgres = Boolean(PG_URL);
let pgPool = null;
let sqliteDb = null;

// Initialize Database Connections
if (isPostgres) {
  try {
    const { Pool } = require('pg');
    const isLocalPg = PG_URL.includes('localhost') || PG_URL.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: PG_URL,
      ssl: isLocalPg ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000
    });
    console.log('⚡ StudyPath Database: Connected to hosted PostgreSQL.');
  } catch (err) {
    console.warn('⚠️ Failed to initialize PostgreSQL pool, falling back to SQLite:', err.message);
    isPostgres = false;
  }
}

if (!isPostgres) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    console.warn('node:sqlite module not available, using memory stub:', e.message);
    DatabaseSync = class InMemDatabase {
      constructor() { this.data = {}; }
      exec() {}
      prepare() {
        return {
          run: () => ({ changes: 1, lastInsertRowid: 1 }),
          get: () => null,
          all: () => []
        };
      }
    };
  }

  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  let DATA_DIR = path.join(__dirname, 'data');
  if (isServerless) {
    DATA_DIR = path.join('/tmp', 'studypath-data');
  }

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (e) {
    DATA_DIR = path.join('/tmp', 'studypath-data');
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  try {
    const DB_PATH = path.join(DATA_DIR, 'studypath.db');
    sqliteDb = new DatabaseSync(DB_PATH);
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec(isServerless ? 'PRAGMA journal_mode = MEMORY;' : 'PRAGMA journal_mode = WAL;');
    console.log(`📁 StudyPath Database: Local SQLite active at ${DB_PATH}`);
  } catch (diskErr) {
    console.warn('⚠️ SQLite disk error, fallback to memory database:', diskErr.message);
    sqliteDb = new DatabaseSync(':memory:');
  }
}

// Automatically ensure schema on initialization
let schemaInitialized = false;
async function ensureSchema() {
  if (schemaInitialized) return;
  try {
    const { PG_SCHEMA, SQLITE_SCHEMA } = require('./migrations');
    if (isPostgres && pgPool) {
      await pgPool.query(PG_SCHEMA);
      // Auto-restore seed data if empty
      const userRes = await pgPool.query('SELECT COUNT(*) AS count FROM users');
      const count = parseInt(userRes.rows[0].count, 10);
      if (count === 0) {
        const seedPath = path.join(__dirname, 'data', 'seed_data.json');
        if (fs.existsSync(seedPath)) {
          const { runPostgresMigrations } = require('./migrations');
          await runPostgresMigrations(PG_URL);
        }
      }
    } else if (sqliteDb) {
      sqliteDb.exec(SQLITE_SCHEMA);
    }
    schemaInitialized = true;
  } catch (err) {
    console.warn('⚠️ Notice during schema verification:', err.message);
  }
}
ensureSchema().catch(() => {});

// Helper: Convert '?' placeholders to PostgreSQL '$1, $2, ...'
function toPgSql(sql) {
  let count = 1;
  return sql.replace(/\?/g, () => `$${count++}`);
}

// Helper: Normalize PostgreSQL and SQLite row keys
function normalizeRow(row) {
  if (!row) return null;
  const out = {};
  for (const [key, val] of Object.entries(row)) {
    const k = key.toLowerCase();
    if (k === 'userid') out.userId = val;
    else if (k === 'assignmentid') out.assignmentId = val;
    else if (k === 'duedate') out.dueDate = val;
    else if (k === 'orderindex') out.orderIndex = val;
    else if (k === 'dayofweek') out.dayOfWeek = val;
    else if (k === 'starttime') out.startTime = val;
    else if (k === 'durationminutes') out.durationMinutes = val;
    else if (k === 'remindat') out.remindAt = val;
    else if (k === 'offsetminutes') out.offsetMinutes = val;
    else if (k === 'assignmenttitle') out.assignmentTitle = val;
    else if (k === 'assignmentduedate') out.assignmentDueDate = val;
    else if (k === 'assignmentsubject') out.assignmentSubject = val;
    else if (k === 'createdat') out.createdAt = val;
    else if (k === 'updatedat') out.updatedAt = val;
    else if (k === 'estimatedminutes' || k === 'estimated_minutes') out.estimatedMinutes = val != null ? parseInt(val, 10) : 90;
    else out[key] = val;
  }
  return out;
}

// Unified query abstraction
async function queryOne(sql, params = []) {
  await ensureSchema();
  if (isPostgres && pgPool) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows.length > 0 ? normalizeRow(res.rows[0]) : null;
  } else {
    const stmt = sqliteDb.prepare(sql);
    const row = stmt.get(...params);
    return row ? normalizeRow(row) : null;
  }
}

async function queryAll(sql, params = []) {
  await ensureSchema();
  if (isPostgres && pgPool) {
    const res = await pgPool.query(toPgSql(sql), params);
    return res.rows.map(normalizeRow);
  } else {
    const stmt = sqliteDb.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map(normalizeRow);
  }
}

async function execute(sql, params = []) {
  await ensureSchema();
  if (isPostgres && pgPool) {
    const res = await pgPool.query(toPgSql(sql), params);
    return { changes: res.rowCount };
  } else {
    const stmt = sqliteDb.prepare(sql);
    return stmt.run(...params);
  }
}

/**
 * Time estimate helpers
 */
function parseEstimatedMinutes(durationStr, fallback = 90) {
  if (typeof durationStr === 'number' && !isNaN(durationStr) && durationStr > 0) {
    return Math.round(durationStr);
  }
  if (!durationStr || typeof durationStr !== 'string') return fallback;
  const s = durationStr.trim().toLowerCase();
  if (s.includes('30 min')) return 30;
  if (s === '1 hr' || s === '1 hour' || s.startsWith('1h')) return 60;
  if (s.includes('1.5 hr')) return 90;
  if (s.includes('2 hr')) return 120;
  if (s.includes('3+ hr') || s.includes('3 hr')) return 180;
  
  const hrMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:hr|hour|h)/);
  const minMatch = s.match(/(\d+)\s*(?:min|m)/);
  let total = 0;
  if (hrMatch) total += parseFloat(hrMatch[1]) * 60;
  if (minMatch) total += parseInt(minMatch[1], 10);
  return total > 0 ? Math.round(total) : fallback;
}

function formatEstimatedMinutes(minutes) {
  const m = parseInt(minutes, 10) || 90;
  if (m < 60) return `${m} mins`;
  const hrs = m / 60;
  if (hrs === 1) return '1 hr';
  if (Number.isInteger(hrs)) return `${hrs} hrs`;
  return `${hrs.toFixed(1)} hrs`;
}

// ============================================================================
// USER QUERIES
// ============================================================================

async function createUser({ id, email, passwordHash, salt, name, major }) {
  await execute(`
    INSERT INTO users (id, email, password_hash, salt, name, major, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, email.toLowerCase().trim(), passwordHash, salt, name.trim(), major ? major.trim() : null, new Date().toISOString()]);
  return await getUserById(id);
}

async function getUserByEmail(email) {
  if (!email) return null;
  return await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email.toLowerCase().trim()]);
}

async function getUserById(id) {
  if (!id) return null;
  return await queryOne('SELECT id, email, name, major, created_at FROM users WHERE id = ?', [id]);
}

async function setPasswordResetToken(email, token, expiresAt) {
  const result = await execute(`
    UPDATE users 
    SET reset_token = ?, reset_token_expires = ?
    WHERE LOWER(email) = LOWER(?)
  `, [token, expiresAt, email.toLowerCase().trim()]);
  return result.changes > 0;
}

async function getUserByResetToken(token) {
  if (!token) return null;
  const now = Date.now();
  return await queryOne(`
    SELECT * FROM users 
    WHERE reset_token = ? AND reset_token_expires > ?
  `, [token, now]);
}

async function updatePasswordWithToken(token, newHash, newSalt) {
  const user = await getUserByResetToken(token);
  if (!user) return false;

  await execute(`
    UPDATE users 
    SET password_hash = ?, salt = ?, reset_token = NULL, reset_token_expires = NULL
    WHERE id = ?
  `, [newHash, newSalt, user.id]);

  await execute('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  return true;
}

// ============================================================================
// SESSION QUERIES
// ============================================================================

async function createSession(token, userId, expiryHours = 72) {
  const expiresAt = Date.now() + expiryHours * 60 * 60 * 1000;
  await execute(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `, [token, userId, expiresAt, new Date().toISOString()]);
  return { token, expiresAt };
}

async function getSessionUser(token) {
  if (!token) return null;
  const now = Date.now();
  return await queryOne(`
    SELECT u.id, u.email, u.name, u.major, u.created_at, s.expires_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `, [token, now]);
}

async function deleteSession(token) {
  if (!token) return;
  await execute('DELETE FROM sessions WHERE token = ?', [token]);
}

async function cleanExpiredSessions() {
  const now = Date.now();
  await execute('DELETE FROM sessions WHERE expires_at <= ?', [now]);
}
setInterval(cleanExpiredSessions, 60 * 60 * 1000).unref();

// ============================================================================
// SUBTASK QUERIES
// ============================================================================

async function getSubtasksForAssignment(assignmentId, userId) {
  const rows = await queryAll(`
    SELECT id, user_id AS "userId", assignment_id AS "assignmentId", title, 
           due_date AS "dueDate", completed, order_index AS "orderIndex",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM subtasks
    WHERE assignment_id = ? AND user_id = ?
    ORDER BY order_index ASC, created_at ASC
  `, [assignmentId, userId]);
  return rows.map(r => ({
    ...r,
    completed: Boolean(r.completed)
  }));
}

async function createSubtask({ id, userId, assignmentId, title, dueDate = null, completed = false, orderIndex = 0 }) {
  const now = new Date().toISOString();
  await execute(`
    INSERT INTO subtasks (id, user_id, assignment_id, title, due_date, completed, order_index, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, userId, assignmentId, title.trim(), dueDate || null, completed ? 1 : 0, orderIndex, now, now]);

  const row = await queryOne(`
    SELECT id, user_id AS "userId", assignment_id AS "assignmentId", title, 
           due_date AS "dueDate", completed, order_index AS "orderIndex",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

async function updateSubtask({ id, userId, title, dueDate, completed }) {
  const now = new Date().toISOString();
  await execute(`
    UPDATE subtasks
    SET title = ?, due_date = ?, completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [title.trim(), dueDate || null, completed ? 1 : 0, now, id, userId]);

  const row = await queryOne(`
    SELECT id, user_id AS "userId", assignment_id AS "assignmentId", title, 
           due_date AS "dueDate", completed, order_index AS "orderIndex",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

async function toggleSubtaskCompleted(id, userId, completed) {
  const existing = await queryOne(`
    SELECT id, user_id AS "userId", assignment_id AS "assignmentId", title, 
           due_date AS "dueDate", completed, order_index AS "orderIndex",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  if (!existing) return null;

  const newStatus = (completed !== undefined && completed !== null)
    ? (Boolean(completed) ? 1 : 0)
    : (existing.completed ? 0 : 1);

  const now = new Date().toISOString();
  await execute(`
    UPDATE subtasks
    SET completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [newStatus, now, id, userId]);

  const row = await queryOne(`
    SELECT id, user_id AS "userId", assignment_id AS "assignmentId", title, 
           due_date AS "dueDate", completed, order_index AS "orderIndex",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

async function deleteSubtask(id, userId) {
  const existing = await queryOne('SELECT * FROM subtasks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!existing) return null;
  await execute('DELETE FROM subtasks WHERE id = ? AND user_id = ?', [id, userId]);
  return existing;
}

// ============================================================================
// ASSIGNMENT QUERIES
// ============================================================================

async function mapAssignmentRow(row, userId) {
  if (!row) return null;
  let parsedLinks = [];
  try {
    if (row.links) parsedLinks = typeof row.links === 'string' ? JSON.parse(row.links) : row.links;
  } catch (e) {
    parsedLinks = [];
  }
  if (!Array.isArray(parsedLinks)) parsedLinks = [];

  const estimatedMinutes = row.estimated_minutes != null 
    ? row.estimated_minutes 
    : (row.estimatedMinutes != null ? row.estimatedMinutes : parseEstimatedMinutes(row.duration));

  const subtasks = await getSubtasksForAssignment(row.id, userId);

  return {
    id: row.id,
    userId: row.user_id || row.userId,
    title: row.title,
    subject: row.subject,
    dueDate: row.due_date || row.dueDate,
    priority: row.priority,
    duration: row.duration || formatEstimatedMinutes(estimatedMinutes),
    estimatedMinutes,
    notes: row.notes || '',
    links: parsedLinks,
    subtasks,
    completed: Boolean(row.completed),
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt
  };
}

async function getAssignmentsForUser(userId) {
  const rows = await queryAll(`
    SELECT id, user_id, title, subject, due_date, priority, duration, 
           estimated_minutes, notes, links, completed, created_at, updated_at
    FROM assignments
    WHERE user_id = ?
    ORDER BY due_date ASC
  `, [userId]);
  
  const results = [];
  for (const r of rows) {
    results.push(await mapAssignmentRow(r, userId));
  }
  return results;
}

async function getAssignmentById(id, userId) {
  const row = await queryOne(`
    SELECT id, user_id, title, subject, due_date, priority, duration, 
           estimated_minutes, notes, links, completed, created_at, updated_at
    FROM assignments
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return await mapAssignmentRow(row, userId);
}

async function createAssignment({ id, userId, title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, completed = false, subtasks = [] }) {
  const now = new Date().toISOString();
  const mins = estimatedMinutes != null ? parseEstimatedMinutes(estimatedMinutes) : parseEstimatedMinutes(duration);
  const formattedDuration = duration || formatEstimatedMinutes(mins);
  const linksJson = typeof links === 'string' ? links : JSON.stringify(links || []);

  await execute(`
    INSERT INTO assignments (id, user_id, title, subject, due_date, priority, duration, estimated_minutes, notes, links, completed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, userId, title.trim(), subject.trim(), dueDate, priority, formattedDuration, mins, notes ? notes.trim() : '', linksJson, completed ? 1 : 0, now, now]);

  if (Array.isArray(subtasks) && subtasks.length > 0) {
    for (let idx = 0; idx < subtasks.length; idx++) {
      const st = subtasks[idx];
      if (st.title && st.title.trim()) {
        const subtaskId = st.id || 'sub_' + crypto.randomBytes(6).toString('hex');
        await createSubtask({
          id: subtaskId,
          userId,
          assignmentId: id,
          title: st.title.trim(),
          dueDate: st.dueDate || null,
          completed: Boolean(st.completed),
          orderIndex: idx
        });
      }
    }
  }

  return await getAssignmentById(id, userId);
}

async function updateAssignment({ id, userId, title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, subtasks }) {
  const now = new Date().toISOString();
  const mins = estimatedMinutes != null ? parseEstimatedMinutes(estimatedMinutes) : parseEstimatedMinutes(duration);
  const formattedDuration = duration || formatEstimatedMinutes(mins);
  const linksJson = typeof links === 'string' ? links : JSON.stringify(links || []);

  await execute(`
    UPDATE assignments
    SET title = ?, subject = ?, due_date = ?, priority = ?, duration = ?, 
        estimated_minutes = ?, notes = ?, links = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [title.trim(), subject.trim(), dueDate, priority, formattedDuration, mins, notes ? notes.trim() : '', linksJson, now, id, userId]);

  if (Array.isArray(subtasks)) {
    await execute('DELETE FROM subtasks WHERE assignment_id = ? AND user_id = ?', [id, userId]);
    for (let idx = 0; idx < subtasks.length; idx++) {
      const st = subtasks[idx];
      if (st.title && st.title.trim()) {
        const subtaskId = st.id || 'sub_' + crypto.randomBytes(6).toString('hex');
        await createSubtask({
          id: subtaskId,
          userId,
          assignmentId: id,
          title: st.title.trim(),
          dueDate: st.dueDate || null,
          completed: Boolean(st.completed),
          orderIndex: idx
        });
      }
    }
  }

  return await getAssignmentById(id, userId);
}

async function toggleAssignmentCompleted(id, userId, completed) {
  const now = new Date().toISOString();
  await execute(`
    UPDATE assignments
    SET completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [completed ? 1 : 0, now, id, userId]);
  return await getAssignmentById(id, userId);
}

async function deleteAssignment(id, userId) {
  const existing = await getAssignmentById(id, userId);
  if (!existing) return null;
  await execute('DELETE FROM assignments WHERE id = ? AND user_id = ?', [id, userId]);
  return existing;
}

// ============================================================================
// STUDY SESSIONS QUERIES
// ============================================================================

async function getStudySessionsForUser(userId) {
  return await queryAll(`
    SELECT id, user_id AS "userId", subject, day_of_week AS "dayOfWeek", 
           start_time AS "startTime", duration_minutes AS "durationMinutes",
           notes, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM study_sessions
    WHERE user_id = ?
    ORDER BY day_of_week ASC, start_time ASC
  `, [userId]);
}

async function getStudySessionById(id, userId) {
  return await queryOne(`
    SELECT id, user_id AS "userId", subject, day_of_week AS "dayOfWeek", 
           start_time AS "startTime", duration_minutes AS "durationMinutes",
           notes, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM study_sessions
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
}

async function createStudySession({ id, userId, subject, dayOfWeek, startTime, durationMinutes, notes }) {
  const now = new Date().toISOString();
  const day = parseInt(dayOfWeek, 10);
  const dur = parseInt(durationMinutes, 10) || 60;
  await execute(`
    INSERT INTO study_sessions (id, user_id, subject, day_of_week, start_time, duration_minutes, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, userId, subject.trim(), isNaN(day) ? 1 : day, startTime.trim(), dur, notes ? notes.trim() : '', now, now]);
  return await getStudySessionById(id, userId);
}

async function updateStudySession({ id, userId, subject, dayOfWeek, startTime, durationMinutes, notes }) {
  const now = new Date().toISOString();
  const day = parseInt(dayOfWeek, 10);
  const dur = parseInt(durationMinutes, 10) || 60;
  await execute(`
    UPDATE study_sessions
    SET subject = ?, day_of_week = ?, start_time = ?, duration_minutes = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `, [subject.trim(), isNaN(day) ? 1 : day, startTime.trim(), dur, notes ? notes.trim() : '', now, id, userId]);
  return await getStudySessionById(id, userId);
}

async function deleteStudySession(id, userId) {
  const existing = await getStudySessionById(id, userId);
  if (!existing) return null;
  await execute('DELETE FROM study_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  return existing;
}

// ============================================================================
// REMINDER QUERIES
// ============================================================================

async function getRemindersForUser(userId) {
  return await queryAll(`
    SELECT r.id, r.user_id AS "userId", r.assignment_id AS "assignmentId",
           r.remind_at AS "remindAt", r.offset_minutes AS "offsetMinutes",
           r.title, r.status, r.created_at AS "createdAt",
           a.title AS "assignmentTitle", a.due_date AS "assignmentDueDate", a.subject AS "assignmentSubject"
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.user_id = ?
    ORDER BY r.remind_at ASC
  `, [userId]);
}

async function getReminderById(id, userId) {
  return await queryOne(`
    SELECT r.id, r.user_id AS "userId", r.assignment_id AS "assignmentId",
           r.remind_at AS "remindAt", r.offset_minutes AS "offsetMinutes",
           r.title, r.status, r.created_at AS "createdAt",
           a.title AS "assignmentTitle", a.due_date AS "assignmentDueDate", a.subject AS "assignmentSubject"
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.id = ? AND r.user_id = ?
  `, [id, userId]);
}

async function createReminder({ id, userId, assignmentId, remindAt, offsetMinutes, title }) {
  const now = new Date().toISOString();
  await execute(`
    INSERT INTO reminders (id, user_id, assignment_id, remind_at, offset_minutes, title, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `, [id, userId, assignmentId, remindAt, parseInt(offsetMinutes, 10) || 60, title.trim(), now]);
  return await getReminderById(id, userId);
}

async function deleteReminder(id, userId) {
  const existing = await getReminderById(id, userId);
  if (!existing) return null;
  await execute('DELETE FROM reminders WHERE id = ? AND user_id = ?', [id, userId]);
  return existing;
}

async function dismissReminder(id, userId) {
  await execute(`
    UPDATE reminders
    SET status = 'dismissed'
    WHERE id = ? AND user_id = ?
  `, [id, userId]);
  return await getReminderById(id, userId);
}

async function getDueReminders(userId, nowIso = new Date().toISOString()) {
  const due = await queryAll(`
    SELECT r.id, r.user_id AS "userId", r.assignment_id AS "assignmentId",
           r.remind_at AS "remindAt", r.offset_minutes AS "offsetMinutes",
           r.title, r.status, r.created_at AS "createdAt",
           a.title AS "assignmentTitle", a.due_date AS "assignmentDueDate", a.subject AS "assignmentSubject"
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.user_id = ? AND r.status = 'pending' AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `, [userId, nowIso]);

  if (due.length > 0) {
    for (const item of due) {
      await execute("UPDATE reminders SET status = 'delivered' WHERE id = ? AND user_id = ?", [item.id, userId]);
    }
  }
  return due;
}

module.exports = {
  isPostgres,
  createUser,
  getUserByEmail,
  getUserById,
  setPasswordResetToken,
  getUserByResetToken,
  updatePasswordWithToken,
  createSession,
  getSessionUser,
  deleteSession,
  parseEstimatedMinutes,
  formatEstimatedMinutes,
  getAssignmentsForUser,
  getAssignmentById,
  createAssignment,
  updateAssignment,
  toggleAssignmentCompleted,
  deleteAssignment,
  getSubtasksForAssignment,
  createSubtask,
  updateSubtask,
  toggleSubtaskCompleted,
  deleteSubtask,
  getStudySessionsForUser,
  getStudySessionById,
  createStudySession,
  updateStudySession,
  deleteStudySession,
  getRemindersForUser,
  getReminderById,
  createReminder,
  deleteReminder,
  dismissReminder,
  getDueReminders
};
