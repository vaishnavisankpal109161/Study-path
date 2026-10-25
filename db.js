/**
 * StudyPath • Relational Database Module (node:sqlite)
 * Enforces schema migrations, foreign keys, and strict per-user data isolation.
 */

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.warn('node:sqlite module not available in this Node runtime:', e.message);
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
const path = require('path');
const fs = require('fs');

let DATA_DIR = path.join(__dirname, 'data');
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
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

let db;
try {
  const DB_PATH = path.join(DATA_DIR, 'studypath.db');
  db = new DatabaseSync(DB_PATH);
} catch (diskErr) {
  console.warn('Fallback to in-memory SQLite database:', diskErr.message);
  db = new DatabaseSync(':memory:');
}

// Enable foreign keys and appropriate journal mode
try {
  db.exec('PRAGMA foreign_keys = ON;');
  if (isServerless) {
    db.exec('PRAGMA journal_mode = MEMORY;');
  } else {
    db.exec('PRAGMA journal_mode = WAL;');
  }
} catch (pragmaErr) {
  console.warn('Pragma setup error:', pragmaErr.message);
}

/**
 * Helpers for time estimate parsing and formatting
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
  
  // Regex check for "X hr", "X hrs", "X mins", "X h Y m"
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

/**
 * Initialize database schema and perform migrations
 */
function initSchema() {
  db.exec(`
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
      notes TEXT,
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
  `);

  // Run migrations for existing databases
  const assignmentCols = db.prepare('PRAGMA table_info(assignments)').all().map(c => c.name);
  if (!assignmentCols.includes('estimated_minutes')) {
    db.exec('ALTER TABLE assignments ADD COLUMN estimated_minutes INTEGER DEFAULT 90;');
  }
  if (!assignmentCols.includes('links')) {
    db.exec("ALTER TABLE assignments ADD COLUMN links TEXT DEFAULT '[]';");
  }
}

initSchema();

// ============================================================================
// USER QUERIES
// ============================================================================

function createUser({ id, email, passwordHash, salt, name, major }) {
  const stmt = db.prepare(`
    INSERT INTO users (id, email, password_hash, salt, name, major, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, email.toLowerCase().trim(), passwordHash, salt, name.trim(), major ? major.trim() : null, new Date().toISOString());
  return getUserById(id);
}

function getUserByEmail(email) {
  if (!email) return null;
  const stmt = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
  return stmt.get(email.toLowerCase().trim()) || null;
}

function getUserById(id) {
  if (!id) return null;
  const stmt = db.prepare('SELECT id, email, name, major, created_at FROM users WHERE id = ?');
  return stmt.get(id) || null;
}

function setPasswordResetToken(email, token, expiresAt) {
  const stmt = db.prepare(`
    UPDATE users 
    SET reset_token = ?, reset_token_expires = ?
    WHERE email = ? COLLATE NOCASE
  `);
  const result = stmt.run(token, expiresAt, email.toLowerCase().trim());
  return result.changes > 0;
}

function getUserByResetToken(token) {
  if (!token) return null;
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT * FROM users 
    WHERE reset_token = ? AND reset_token_expires > ?
  `);
  return stmt.get(token, now) || null;
}

function updatePasswordWithToken(token, newHash, newSalt) {
  const user = getUserByResetToken(token);
  if (!user) return false;

  const stmt = db.prepare(`
    UPDATE users 
    SET password_hash = ?, salt = ?, reset_token = NULL, reset_token_expires = NULL
    WHERE id = ?
  `);
  stmt.run(newHash, newSalt, user.id);

  // Invalidate any existing sessions for this user on password reset
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return true;
}

// ============================================================================
// SESSION QUERIES
// ============================================================================

function createSession(token, userId, expiryHours = 72) {
  const expiresAt = Date.now() + expiryHours * 60 * 60 * 1000;
  const stmt = db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(token, userId, expiresAt, new Date().toISOString());
  return { token, expiresAt };
}

function getSessionUser(token) {
  if (!token) return null;
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT u.id, u.email, u.name, u.major, u.created_at, s.expires_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `);
  return stmt.get(token, now) || null;
}

function deleteSession(token) {
  if (!token) return;
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
  stmt.run(token);
}

function cleanExpiredSessions() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

setInterval(cleanExpiredSessions, 60 * 60 * 1000).unref();

// ============================================================================
// SUBTASK QUERIES (STRICT USER ISOLATION)
// ============================================================================

function getSubtasksForAssignment(assignmentId, userId) {
  const stmt = db.prepare(`
    SELECT id, user_id AS userId, assignment_id AS assignmentId, title, 
           due_date AS dueDate, completed, order_index AS orderIndex,
           created_at AS createdAt, updated_at AS updatedAt
    FROM subtasks
    WHERE assignment_id = ? AND user_id = ?
    ORDER BY order_index ASC, created_at ASC
  `);
  return stmt.all(assignmentId, userId).map(r => ({
    ...r,
    completed: Boolean(r.completed)
  }));
}

function createSubtask({ id, userId, assignmentId, title, dueDate = null, completed = false, orderIndex = 0 }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO subtasks (id, user_id, assignment_id, title, due_date, completed, order_index, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, userId, assignmentId, title.trim(), dueDate || null, completed ? 1 : 0, orderIndex, now, now);
  const getStmt = db.prepare(`
    SELECT id, user_id AS userId, assignment_id AS assignmentId, title, 
           due_date AS dueDate, completed, order_index AS orderIndex,
           created_at AS createdAt, updated_at AS updatedAt
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `);
  const row = getStmt.get(id, userId);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

function updateSubtask({ id, userId, title, dueDate, completed }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE subtasks
    SET title = ?, due_date = ?, completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(title.trim(), dueDate || null, completed ? 1 : 0, now, id, userId);
  const getStmt = db.prepare(`
    SELECT id, user_id AS userId, assignment_id AS assignmentId, title, 
           due_date AS dueDate, completed, order_index AS orderIndex,
           created_at AS createdAt, updated_at AS updatedAt
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `);
  const row = getStmt.get(id, userId);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

function toggleSubtaskCompleted(id, userId, completed) {
  const getStmt = db.prepare(`
    SELECT id, user_id AS userId, assignment_id AS assignmentId, title, 
           due_date AS dueDate, completed, order_index AS orderIndex,
           created_at AS createdAt, updated_at AS updatedAt
    FROM subtasks
    WHERE id = ? AND user_id = ?
  `);
  const existing = getStmt.get(id, userId);
  if (!existing) return null;

  const newStatus = (completed !== undefined && completed !== null)
    ? (Boolean(completed) ? 1 : 0)
    : (existing.completed ? 0 : 1);

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE subtasks
    SET completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(newStatus, now, id, userId);

  const row = getStmt.get(id, userId);
  return row ? { ...row, completed: Boolean(row.completed) } : null;
}

function deleteSubtask(id, userId) {
  const getStmt = db.prepare('SELECT * FROM subtasks WHERE id = ? AND user_id = ?');
  const existing = getStmt.get(id, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM subtasks WHERE id = ? AND user_id = ?').run(id, userId);
  return existing;
}

// ============================================================================
// ASSIGNMENT QUERIES (STRICT USER ISOLATION)
// ============================================================================

function mapAssignmentRow(row, userId) {
  if (!row) return null;
  let parsedLinks = [];
  try {
    if (row.links) parsedLinks = JSON.parse(row.links);
  } catch (e) {
    parsedLinks = [];
  }
  if (!Array.isArray(parsedLinks)) parsedLinks = [];

  const estimatedMinutes = row.estimated_minutes != null 
    ? row.estimated_minutes 
    : parseEstimatedMinutes(row.duration);

  const subtasks = getSubtasksForAssignment(row.id, userId);

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    subject: row.subject,
    dueDate: row.due_date,
    priority: row.priority,
    duration: row.duration || formatEstimatedMinutes(estimatedMinutes),
    estimatedMinutes,
    notes: row.notes || '',
    links: parsedLinks,
    subtasks,
    completed: Boolean(row.completed),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getAssignmentsForUser(userId) {
  const stmt = db.prepare(`
    SELECT id, user_id, title, subject, due_date, priority, duration, 
           estimated_minutes, notes, links, completed, created_at, updated_at
    FROM assignments
    WHERE user_id = ?
    ORDER BY due_date ASC
  `);
  const rows = stmt.all(userId);
  return rows.map(r => mapAssignmentRow(r, userId));
}

function getAssignmentById(id, userId) {
  const stmt = db.prepare(`
    SELECT id, user_id, title, subject, due_date, priority, duration, 
           estimated_minutes, notes, links, completed, created_at, updated_at
    FROM assignments
    WHERE id = ? AND user_id = ?
  `);
  const row = stmt.get(id, userId);
  return mapAssignmentRow(row, userId);
}

function createAssignment({ id, userId, title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, completed = false, subtasks = [] }) {
  const now = new Date().toISOString();
  const mins = estimatedMinutes != null ? parseEstimatedMinutes(estimatedMinutes) : parseEstimatedMinutes(duration);
  const formattedDuration = duration || formatEstimatedMinutes(mins);
  const linksJson = typeof links === 'string' ? links : JSON.stringify(links || []);

  const stmt = db.prepare(`
    INSERT INTO assignments (id, user_id, title, subject, due_date, priority, duration, estimated_minutes, notes, links, completed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, userId, title.trim(), subject.trim(), dueDate, priority, formattedDuration, mins, notes ? notes.trim() : '', linksJson, completed ? 1 : 0, now, now);

  if (Array.isArray(subtasks) && subtasks.length > 0) {
    const crypto = require('crypto');
    subtasks.forEach((st, idx) => {
      if (st.title && st.title.trim()) {
        const subtaskId = st.id || 'sub_' + crypto.randomBytes(6).toString('hex');
        createSubtask({
          id: subtaskId,
          userId,
          assignmentId: id,
          title: st.title.trim(),
          dueDate: st.dueDate || null,
          completed: Boolean(st.completed),
          orderIndex: idx
        });
      }
    });
  }

  return getAssignmentById(id, userId);
}

function updateAssignment({ id, userId, title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, subtasks }) {
  const now = new Date().toISOString();
  const mins = estimatedMinutes != null ? parseEstimatedMinutes(estimatedMinutes) : parseEstimatedMinutes(duration);
  const formattedDuration = duration || formatEstimatedMinutes(mins);
  const linksJson = typeof links === 'string' ? links : JSON.stringify(links || []);

  const stmt = db.prepare(`
    UPDATE assignments
    SET title = ?, subject = ?, due_date = ?, priority = ?, duration = ?, 
        estimated_minutes = ?, notes = ?, links = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(title.trim(), subject.trim(), dueDate, priority, formattedDuration, mins, notes ? notes.trim() : '', linksJson, now, id, userId);

  // If subtasks array is passed, sync them
  if (Array.isArray(subtasks)) {
    const crypto = require('crypto');
    // Delete existing and re-insert or sync
    db.prepare('DELETE FROM subtasks WHERE assignment_id = ? AND user_id = ?').run(id, userId);
    subtasks.forEach((st, idx) => {
      if (st.title && st.title.trim()) {
        const subtaskId = st.id || 'sub_' + crypto.randomBytes(6).toString('hex');
        createSubtask({
          id: subtaskId,
          userId,
          assignmentId: id,
          title: st.title.trim(),
          dueDate: st.dueDate || null,
          completed: Boolean(st.completed),
          orderIndex: idx
        });
      }
    });
  }

  return getAssignmentById(id, userId);
}

function toggleAssignmentCompleted(id, userId, completed) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE assignments
    SET completed = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(completed ? 1 : 0, now, id, userId);
  return getAssignmentById(id, userId);
}

function deleteAssignment(id, userId) {
  const existing = getAssignmentById(id, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM assignments WHERE id = ? AND user_id = ?').run(id, userId);
  return existing;
}

// ============================================================================
// STUDY SESSIONS QUERIES (STRICT USER ISOLATION)
// ============================================================================

function getStudySessionsForUser(userId) {
  const stmt = db.prepare(`
    SELECT id, user_id AS userId, subject, day_of_week AS dayOfWeek, 
           start_time AS startTime, duration_minutes AS durationMinutes,
           notes, created_at AS createdAt, updated_at AS updatedAt
    FROM study_sessions
    WHERE user_id = ?
    ORDER BY day_of_week ASC, start_time ASC
  `);
  return stmt.all(userId);
}

function getStudySessionById(id, userId) {
  const stmt = db.prepare(`
    SELECT id, user_id AS userId, subject, day_of_week AS dayOfWeek, 
           start_time AS startTime, duration_minutes AS durationMinutes,
           notes, created_at AS createdAt, updated_at AS updatedAt
    FROM study_sessions
    WHERE id = ? AND user_id = ?
  `);
  return stmt.get(id, userId) || null;
}

function createStudySession({ id, userId, subject, dayOfWeek, startTime, durationMinutes, notes }) {
  const now = new Date().toISOString();
  const day = parseInt(dayOfWeek, 10);
  const dur = parseInt(durationMinutes, 10) || 60;
  const stmt = db.prepare(`
    INSERT INTO study_sessions (id, user_id, subject, day_of_week, start_time, duration_minutes, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, userId, subject.trim(), isNaN(day) ? 1 : day, startTime.trim(), dur, notes ? notes.trim() : '', now, now);
  return getStudySessionById(id, userId);
}

function updateStudySession({ id, userId, subject, dayOfWeek, startTime, durationMinutes, notes }) {
  const now = new Date().toISOString();
  const day = parseInt(dayOfWeek, 10);
  const dur = parseInt(durationMinutes, 10) || 60;
  const stmt = db.prepare(`
    UPDATE study_sessions
    SET subject = ?, day_of_week = ?, start_time = ?, duration_minutes = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(subject.trim(), isNaN(day) ? 1 : day, startTime.trim(), dur, notes ? notes.trim() : '', now, id, userId);
  return getStudySessionById(id, userId);
}

function deleteStudySession(id, userId) {
  const existing = getStudySessionById(id, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM study_sessions WHERE id = ? AND user_id = ?').run(id, userId);
  return existing;
}

// ============================================================================
// REMINDER QUERIES (STRICT USER ISOLATION)
// ============================================================================

function getRemindersForUser(userId) {
  const stmt = db.prepare(`
    SELECT r.id, r.user_id AS userId, r.assignment_id AS assignmentId,
           r.remind_at AS remindAt, r.offset_minutes AS offsetMinutes,
           r.title, r.status, r.created_at AS createdAt,
           a.title AS assignmentTitle, a.due_date AS assignmentDueDate, a.subject AS assignmentSubject
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.user_id = ?
    ORDER BY r.remind_at ASC
  `);
  return stmt.all(userId);
}

function getReminderById(id, userId) {
  const stmt = db.prepare(`
    SELECT r.id, r.user_id AS userId, r.assignment_id AS assignmentId,
           r.remind_at AS remindAt, r.offset_minutes AS offsetMinutes,
           r.title, r.status, r.created_at AS createdAt,
           a.title AS assignmentTitle, a.due_date AS assignmentDueDate, a.subject AS assignmentSubject
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.id = ? AND r.user_id = ?
  `);
  return stmt.get(id, userId) || null;
}

function createReminder({ id, userId, assignmentId, remindAt, offsetMinutes, title }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO reminders (id, user_id, assignment_id, remind_at, offset_minutes, title, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(id, userId, assignmentId, remindAt, parseInt(offsetMinutes, 10) || 60, title.trim(), now);
  return getReminderById(id, userId);
}

function deleteReminder(id, userId) {
  const existing = getReminderById(id, userId);
  if (!existing) return null;
  db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(id, userId);
  return existing;
}

function dismissReminder(id, userId) {
  const stmt = db.prepare(`
    UPDATE reminders
    SET status = 'dismissed'
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(id, userId);
  return getReminderById(id, userId);
}

function getDueReminders(userId, nowIso = new Date().toISOString()) {
  const stmt = db.prepare(`
    SELECT r.id, r.user_id AS userId, r.assignment_id AS assignmentId,
           r.remind_at AS remindAt, r.offset_minutes AS offsetMinutes,
           r.title, r.status, r.created_at AS createdAt,
           a.title AS assignmentTitle, a.due_date AS assignmentDueDate, a.subject AS assignmentSubject
    FROM reminders r
    LEFT JOIN assignments a ON r.assignment_id = a.id
    WHERE r.user_id = ? AND r.status = 'pending' AND r.remind_at <= ?
    ORDER BY r.remind_at ASC
  `);
  const due = stmt.all(userId, nowIso);
  if (due.length > 0) {
    const updateStmt = db.prepare("UPDATE reminders SET status = 'delivered' WHERE id = ? AND user_id = ?");
    due.forEach(item => updateStmt.run(item.id, userId));
  }
  return due;
}

module.exports = {
  db,
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
