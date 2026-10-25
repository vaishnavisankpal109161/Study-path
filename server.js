/**
 * StudyPath • Complete Secure Web Application Backend Server
 * Includes Authentication API, Protected REST Endpoints, Database Integration,
 * Port Conflict Fallback, and Static File Serving.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const db = require('./db');
const auth = require('./auth');

// Load simple environment variables
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

const INITIAL_PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'studypath_session';
const SESSION_EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS, 10) || 72;
const ROOT_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.webmanifest': 'application/manifest+json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * Cookie Parser Helper
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * JSON Body Reader Helper
 */
function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === 'string') {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.resolve({});
    }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) { // 1MB limit
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * JSON Response Sender Helper
 */
function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

/**
 * Authentication Middleware: Resolves user from session cookie or Bearer header
 */
async function authenticateRequest(req) {
  const cookies = req.cookies || parseCookies(req.headers?.cookie);
  let token = cookies[SESSION_COOKIE_NAME];

  if (!token && req.headers?.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) return null;
  return await db.getSessionUser(token);
}

/**
 * Router & Request Handler
 */
async function handleRequest(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = urlObj.pathname;

  // Resolve Vercel serverless rewrites
  if (pathname === '/api/index.js' || pathname === '/api' || pathname === '/api/') {
    const routeParam = urlObj.searchParams.get('__route');
    if (routeParam) {
      pathname = routeParam.startsWith('/') ? routeParam : '/api/' + routeParam;
    } else if (req.headers['x-matched-path']) {
      pathname = req.headers['x-matched-path'];
    } else if (req.headers['x-forwarded-uri']) {
      pathname = req.headers['x-forwarded-uri'].split('?')[0];
    }
  }

  const method = req.method.toUpperCase();

  // --------------------------------------------------------------------------
  // API ROUTES
  // --------------------------------------------------------------------------

  if (pathname.startsWith('/api/')) {
    try {
      // 1. AUTH: Sign Up
      if (pathname === '/api/auth/signup' && method === 'POST') {
        const body = await readJsonBody(req);
        const { name, email, password, major } = body;

        if (!name || !name.trim()) {
          return sendJson(res, 400, { error: 'Full name is required.' });
        }
        const normalizedEmail = (email || '').trim().toLowerCase();
        if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
          return sendJson(res, 400, { error: 'A valid email address is required.' });
        }
        if (!password || password.length < 8) {
          return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
        }

        // Check duplicate
        const existing = await db.getUserByEmail(normalizedEmail);
        if (existing) {
          return sendJson(res, 409, { error: 'An account with this email already exists. Please log in.' });
        }

        const salt = auth.generateSalt();
        const passwordHash = auth.hashPassword(password, salt);
        const userId = 'user_' + crypto.randomBytes(8).toString('hex');

        const user = await db.createUser({
          id: userId,
          email: normalizedEmail,
          passwordHash,
          salt,
          name: name.trim(),
          major: major ? major.trim() : null
        });

        // Create Session & Set Secure HTTP-only Cookie
        const sessionToken = auth.generateSessionToken();
        const { expiresAt } = await db.createSession(sessionToken, user.id, SESSION_EXPIRY_HOURS);
        const cookieMaxAge = SESSION_EXPIRY_HOURS * 3600;

        let cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cookieMaxAge}`;
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
          cookieHeader += '; Secure';
        }
        return sendJson(res, 201, { user, sessionToken }, { 'Set-Cookie': cookieHeader });
      }

      // 2. AUTH: Log In
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const { email, password, rememberMe } = body;

        if (!email || !password) {
          return sendJson(res, 400, { error: 'Please provide both email and password.' });
        }

        const normalizedEmail = (email || '').trim().toLowerCase();
        const userRecord = await db.getUserByEmail(normalizedEmail);
        if (!userRecord || !auth.verifyPassword(password, userRecord.salt, userRecord.password_hash)) {
          return sendJson(res, 401, { error: 'Invalid email or password.' });
        }

        const isPersistent = rememberMe !== false; // defaults to true unless explicitly unchecked
        const sessionHours = isPersistent ? SESSION_EXPIRY_HOURS : Math.min(SESSION_EXPIRY_HOURS, 24);
        const sessionToken = auth.generateSessionToken();
        const { expiresAt } = await db.createSession(sessionToken, userRecord.id, sessionHours);

        let cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`;
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
          cookieHeader += '; Secure';
        }
        if (isPersistent) {
          const cookieMaxAge = sessionHours * 3600;
          cookieHeader += `; Max-Age=${cookieMaxAge}`;
        }

        const user = {
          id: userRecord.id,
          email: userRecord.email,
          name: userRecord.name,
          major: userRecord.major,
          createdAt: userRecord.created_at
        };

        return sendJson(res, 200, { user, sessionToken, rememberMe: isPersistent }, { 'Set-Cookie': cookieHeader });
      }

      // 3. AUTH: Check Current Session (Me)
      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = await authenticateRequest(req);
        if (!user) {
          return sendJson(res, 401, { error: 'Not authenticated' });
        }
        return sendJson(res, 200, { user });
      }

      // 4. AUTH: Log Out
      if (pathname === '/api/auth/logout' && method === 'POST') {
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[SESSION_COOKIE_NAME];
        if (token) {
          await db.deleteSession(token);
        }
        let clearCookie = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
          clearCookie += '; Secure';
        }
        return sendJson(res, 200, { success: true }, { 'Set-Cookie': clearCookie });
      }

      // 5. AUTH: Forgot Password (Request Token)
      if (pathname === '/api/auth/forgot-password' && method === 'POST') {
        const body = await readJsonBody(req);
        const { email } = body;

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          return sendJson(res, 400, { error: 'Please provide a valid email address.' });
        }

        const user = await db.getUserByEmail(email);
        if (!user) {
          // Prevent account enumeration by showing consistent message
          return sendJson(res, 200, { 
            success: true, 
            message: 'If an account exists with this email, password reset instructions have been generated.' 
          });
        }

        const resetToken = auth.generateResetToken();
        const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
        await db.setPasswordResetToken(email, resetToken, expiresAt);

        console.log(`\n🔑 [Password Reset Token for ${user.email}]: ${resetToken}\n`);

        return sendJson(res, 200, {
          success: true,
          message: 'Password reset token generated (valid for 1 hour).',
          resetToken: resetToken // Provided directly in prototype for ease of reset
        });
      }

      // 6. AUTH: Reset Password (Confirm Token)
      if (pathname === '/api/auth/reset-password' && method === 'POST') {
        const body = await readJsonBody(req);
        const { token, newPassword } = body;

        if (!token) {
          return sendJson(res, 400, { error: 'Reset token is required.' });
        }
        if (!newPassword || newPassword.length < 8) {
          return sendJson(res, 400, { error: 'New password must be at least 8 characters.' });
        }

        const user = await db.getUserByResetToken(token);
        if (!user) {
          return sendJson(res, 400, { error: 'Invalid or expired password reset token.' });
        }

        const newSalt = auth.generateSalt();
        const newHash = auth.hashPassword(newPassword, newSalt);
        await db.updatePasswordWithToken(token, newHash, newSalt);

        return sendJson(res, 200, { 
          success: true, 
          message: 'Password updated successfully! Please log in with your new password.' 
        });
      }

      // ----------------------------------------------------------------------
      // PROTECTED ASSIGNMENT ENDPOINTS (ENFORCE USER ISOLATION)
      // ----------------------------------------------------------------------

      const user = await authenticateRequest(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Unauthorized: Please log in to access your planner.' });
      }

      // Link Validation Helper
      function validateLinks(links) {
        if (!links) return { valid: true, sanitized: [] };
        if (!Array.isArray(links)) return { valid: false, error: 'Links must be an array of link objects.' };
        const sanitized = [];
        for (const item of links) {
          if (!item || typeof item !== 'object') continue;
          const url = (item.url || '').trim();
          if (!url) continue;
          if (!/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(url)) {
            return { valid: false, error: `Invalid link URL "${url}". Links must begin with http:// or https://` };
          }
          sanitized.push({
            title: (item.title || url).trim().slice(0, 100),
            url: url.slice(0, 500)
          });
        }
        return { valid: true, sanitized };
      }

      // GET /api/assignments
      if (pathname === '/api/assignments' && method === 'GET') {
        const assignments = await db.getAssignmentsForUser(user.id);
        return sendJson(res, 200, { assignments });
      }

      // POST /api/assignments
      if (pathname === '/api/assignments' && method === 'POST') {
        const body = await readJsonBody(req);
        const { title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, subtasks, completed } = body;

        if (!title || !title.trim()) {
          return sendJson(res, 400, { error: 'Assignment title is required.' });
        }
        if (!subject || !subject.trim()) {
          return sendJson(res, 400, { error: 'Course or subject is required.' });
        }
        if (!dueDate) {
          return sendJson(res, 400, { error: 'Due date is required.' });
        }

        const linkCheck = validateLinks(links);
        if (!linkCheck.valid) {
          return sendJson(res, 400, { error: linkCheck.error });
        }

        const id = body.id || 'task_' + crypto.randomBytes(8).toString('hex');
        const created = await db.createAssignment({
          id,
          userId: user.id,
          title,
          subject,
          dueDate,
          priority: priority || 'medium',
          duration: duration || null,
          estimatedMinutes: estimatedMinutes != null ? estimatedMinutes : null,
          notes: notes || '',
          links: linkCheck.sanitized,
          subtasks: Array.isArray(subtasks) ? subtasks : [],
          completed: Boolean(completed)
        });

        return sendJson(res, 201, { assignment: created });
      }

      // PUT /api/assignments/:id
      const putMatch = pathname.match(/^\/api\/assignments\/([\w-]+)$/);
      if (putMatch && method === 'PUT') {
        const id = putMatch[1];
        const body = await readJsonBody(req);
        const { title, subject, dueDate, priority, duration, estimatedMinutes, notes, links, subtasks } = body;

        if (!title || !title.trim()) {
          return sendJson(res, 400, { error: 'Assignment title is required.' });
        }
        if (!subject || !subject.trim()) {
          return sendJson(res, 400, { error: 'Course or subject is required.' });
        }
        if (!dueDate) {
          return sendJson(res, 400, { error: 'Due date is required.' });
        }

        const linkCheck = validateLinks(links);
        if (!linkCheck.valid) {
          return sendJson(res, 400, { error: linkCheck.error });
        }

        const updated = await db.updateAssignment({
          id,
          userId: user.id,
          title,
          subject,
          dueDate,
          priority,
          duration,
          estimatedMinutes,
          notes,
          links: linkCheck.sanitized,
          subtasks: Array.isArray(subtasks) ? subtasks : undefined
        });

        if (!updated) {
          return sendJson(res, 404, { error: 'Assignment not found or unauthorized.' });
        }
        return sendJson(res, 200, { assignment: updated });
      }

      // PATCH /api/assignments/:id/complete
      const completeMatch = pathname.match(/^\/api\/assignments\/([\w-]+)\/complete$/);
      if (completeMatch && method === 'PATCH') {
        const id = completeMatch[1];
        const body = await readJsonBody(req);
        const updated = await db.toggleAssignmentCompleted(id, user.id, Boolean(body.completed));

        if (!updated) {
          return sendJson(res, 404, { error: 'Assignment not found or unauthorized.' });
        }
        return sendJson(res, 200, { assignment: updated });
      }

      // DELETE /api/assignments/:id
      const deleteMatch = pathname.match(/^\/api\/assignments\/([\w-]+)$/);
      if (deleteMatch && method === 'DELETE') {
        const id = deleteMatch[1];
        const deleted = await db.deleteAssignment(id, user.id);
        if (!deleted) {
          return sendJson(res, 404, { error: 'Assignment not found or unauthorized.' });
        }
        return sendJson(res, 200, { success: true, deleted });
      }

      // POST /api/assignments/clear-completed
      if (pathname === '/api/assignments/clear-completed' && method === 'POST') {
        const all = await db.getAssignmentsForUser(user.id);
        const completedList = all.filter(a => a.completed);
        for (const item of completedList) {
          await db.deleteAssignment(item.id, user.id);
        }
        return sendJson(res, 200, { success: true, count: completedList.length, cleared: completedList });
      }

      // POST /api/assignments/batch-restore (Used for real backend Undo/Redo)
      if (pathname === '/api/assignments/batch-restore' && method === 'POST') {
        const body = await readJsonBody(req);
        const items = body.items || [];
        const restored = [];

        for (const item of items) {
          const resItem = await db.createAssignment({
            id: item.id,
            userId: user.id,
            title: item.title,
            subject: item.subject,
            dueDate: item.dueDate,
            priority: item.priority,
            duration: item.duration,
            estimatedMinutes: item.estimatedMinutes,
            notes: item.notes,
            links: item.links,
            subtasks: item.subtasks,
            completed: Boolean(item.completed)
          });
          restored.push(resItem);
        }

        return sendJson(res, 200, { success: true, restored });
      }

      // ----------------------------------------------------------------------
      // SUBTASKS ENDPOINTS
      // ----------------------------------------------------------------------

      // POST /api/assignments/:id/subtasks
      const postSubtaskMatch = pathname.match(/^\/api\/assignments\/([\w-]+)\/subtasks$/);
      if (postSubtaskMatch && method === 'POST') {
        const assignmentId = postSubtaskMatch[1];
        const assignment = await db.getAssignmentById(assignmentId, user.id);
        if (!assignment) {
          return sendJson(res, 404, { error: 'Assignment not found or unauthorized.' });
        }

        const body = await readJsonBody(req);
        const { title, dueDate } = body;
        if (!title || !title.trim()) {
          return sendJson(res, 400, { error: 'Subtask title is required.' });
        }

        const subtaskId = 'sub_' + crypto.randomBytes(6).toString('hex');
        const created = await db.createSubtask({
          id: subtaskId,
          userId: user.id,
          assignmentId,
          title: title.trim(),
          dueDate: dueDate || null,
          completed: false,
          orderIndex: (assignment.subtasks || []).length
        });

        return sendJson(res, 201, { subtask: created });
      }

      // PATCH /api/subtasks/:id/complete
      const completeSubtaskMatch = pathname.match(/^\/api\/subtasks\/([\w-]+)\/complete$/);
      if (completeSubtaskMatch && method === 'PATCH') {
        const id = completeSubtaskMatch[1];
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch (e) {
          body = {};
        }
        const updated = await db.toggleSubtaskCompleted(id, user.id, body && body.completed !== undefined ? Boolean(body.completed) : undefined);
        if (!updated) {
          return sendJson(res, 404, { error: 'Subtask not found or unauthorized.' });
        }
        return sendJson(res, 200, { subtask: updated });
      }

      // DELETE /api/subtasks/:id
      const deleteSubtaskMatch = pathname.match(/^\/api\/subtasks\/([\w-]+)$/);
      if (deleteSubtaskMatch && method === 'DELETE') {
        const id = deleteSubtaskMatch[1];
        const deleted = await db.deleteSubtask(id, user.id);
        if (!deleted) {
          return sendJson(res, 404, { error: 'Subtask not found or unauthorized.' });
        }
        return sendJson(res, 200, { success: true, deleted });
      }

      // ----------------------------------------------------------------------
      // RECURRING STUDY SESSIONS ENDPOINTS
      // ----------------------------------------------------------------------

      // GET /api/study-sessions
      if (pathname === '/api/study-sessions' && method === 'GET') {
        const sessions = await db.getStudySessionsForUser(user.id);
        return sendJson(res, 200, { sessions });
      }

      // POST /api/study-sessions
      if (pathname === '/api/study-sessions' && method === 'POST') {
        const body = await readJsonBody(req);
        const { subject, dayOfWeek, startTime, durationMinutes, notes } = body;

        if (!subject || !subject.trim()) {
          return sendJson(res, 400, { error: 'Subject is required for study sessions.' });
        }
        const day = parseInt(dayOfWeek, 10);
        if (isNaN(day) || day < 0 || day > 6) {
          return sendJson(res, 400, { error: 'Day of week must be between 0 (Sunday) and 6 (Saturday).' });
        }
        if (!startTime || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(startTime.trim())) {
          return sendJson(res, 400, { error: 'Start time must be in HH:MM 24-hour format.' });
        }
        const dur = parseInt(durationMinutes, 10);
        if (isNaN(dur) || dur <= 0 || dur > 720) {
          return sendJson(res, 400, { error: 'Duration must be between 5 and 720 minutes.' });
        }

        const id = 'sess_' + crypto.randomBytes(6).toString('hex');
        const created = await db.createStudySession({
          id,
          userId: user.id,
          subject: subject.trim(),
          dayOfWeek: day,
          startTime: startTime.trim(),
          durationMinutes: dur,
          notes: notes || ''
        });

        return sendJson(res, 201, { session: created });
      }

      // PUT /api/study-sessions/:id
      const putSessionMatch = pathname.match(/^\/api\/study-sessions\/([\w-]+)$/);
      if (putSessionMatch && method === 'PUT') {
        const id = putSessionMatch[1];
        const body = await readJsonBody(req);
        const { subject, dayOfWeek, startTime, durationMinutes, notes } = body;

        if (!subject || !subject.trim()) {
          return sendJson(res, 400, { error: 'Subject is required for study sessions.' });
        }
        const day = parseInt(dayOfWeek, 10);
        if (isNaN(day) || day < 0 || day > 6) {
          return sendJson(res, 400, { error: 'Day of week must be between 0 (Sunday) and 6 (Saturday).' });
        }
        if (!startTime || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(startTime.trim())) {
          return sendJson(res, 400, { error: 'Start time must be in HH:MM 24-hour format.' });
        }
        const dur = parseInt(durationMinutes, 10);
        if (isNaN(dur) || dur <= 0 || dur > 720) {
          return sendJson(res, 400, { error: 'Duration must be between 5 and 720 minutes.' });
        }

        const updated = await db.updateStudySession({
          id,
          userId: user.id,
          subject: subject.trim(),
          dayOfWeek: day,
          startTime: startTime.trim(),
          durationMinutes: dur,
          notes: notes || ''
        });

        if (!updated) {
          return sendJson(res, 404, { error: 'Study session not found or unauthorized.' });
        }
        return sendJson(res, 200, { session: updated });
      }

      // DELETE /api/study-sessions/:id
      const deleteSessionMatch = pathname.match(/^\/api\/study-sessions\/([\w-]+)$/);
      if (deleteSessionMatch && method === 'DELETE') {
        const id = deleteSessionMatch[1];
        const deleted = await db.deleteStudySession(id, user.id);
        if (!deleted) {
          return sendJson(res, 404, { error: 'Study session not found or unauthorized.' });
        }
        return sendJson(res, 200, { success: true, deleted });
      }

      // ----------------------------------------------------------------------
      // REMINDERS ENDPOINTS
      // ----------------------------------------------------------------------

      // GET /api/reminders
      if (pathname === '/api/reminders' && method === 'GET') {
        const reminders = await db.getRemindersForUser(user.id);
        return sendJson(res, 200, { reminders });
      }

      // GET /api/reminders/due (Returns due reminders and marks them delivered)
      if (pathname === '/api/reminders/due' && method === 'GET') {
        const nowIso = new Date().toISOString();
        const due = await db.getDueReminders(user.id, nowIso);
        return sendJson(res, 200, { due });
      }

      // POST /api/reminders
      if (pathname === '/api/reminders' && method === 'POST') {
        const body = await readJsonBody(req);
        const { assignmentId, remindAt, offsetMinutes, title } = body;

        if (!assignmentId) {
          return sendJson(res, 400, { error: 'Assignment ID is required.' });
        }
        const assignment = await db.getAssignmentById(assignmentId, user.id);
        if (!assignment) {
          return sendJson(res, 404, { error: 'Assignment not found or unauthorized.' });
        }

        let targetRemindAt = remindAt;
        if (!targetRemindAt) {
          const dueTime = new Date(assignment.dueDate).getTime();
          const offsetMs = (parseInt(offsetMinutes, 10) || 60) * 60 * 1000;
          targetRemindAt = new Date(dueTime - offsetMs).toISOString();
        }

        const reminderId = 'rem_' + crypto.randomBytes(6).toString('hex');
        const created = await db.createReminder({
          id: reminderId,
          userId: user.id,
          assignmentId,
          remindAt: targetRemindAt,
          offsetMinutes: parseInt(offsetMinutes, 10) || 60,
          title: (title || `Reminder: ${assignment.title}`).trim()
        });

        return sendJson(res, 201, { reminder: created });
      }

      // POST /api/reminders/:id/dismiss
      const dismissReminderMatch = pathname.match(/^\/api\/reminders\/([\w-]+)\/dismiss$/);
      if (dismissReminderMatch && method === 'POST') {
        const id = dismissReminderMatch[1];
        const dismissed = await db.dismissReminder(id, user.id);
        if (!dismissed) {
          return sendJson(res, 404, { error: 'Reminder not found or unauthorized.' });
        }
        return sendJson(res, 200, { reminder: dismissed });
      }

      // DELETE /api/reminders/:id
      const deleteReminderMatch = pathname.match(/^\/api\/reminders\/([\w-]+)$/);
      if (deleteReminderMatch && method === 'DELETE') {
        const id = deleteReminderMatch[1];
        const deleted = await db.deleteReminder(id, user.id);
        if (!deleted) {
          return sendJson(res, 404, { error: 'Reminder not found or unauthorized.' });
        }
        return sendJson(res, 200, { success: true, deleted });
      }

      // ----------------------------------------------------------------------
      // PROGRESS INSIGHTS & WORKLOAD VIEW ENDPOINT
      // ----------------------------------------------------------------------

      // GET /api/insights
      if (pathname === '/api/insights' && method === 'GET') {
        const assignments = await db.getAssignmentsForUser(user.id);
        const studySessions = await db.getStudySessionsForUser(user.id);

        const now = Date.now();
        const totalAssignments = assignments.length;
        const completedList = assignments.filter(a => a.completed);
        const pendingList = assignments.filter(a => !a.completed);

        const completedCount = completedList.length;
        const pendingCount = pendingList.length;
        const completionRate = totalAssignments > 0 ? Math.round((completedCount / totalAssignments) * 100) : 0;

        // Overdue vs Upcoming separation
        const overdueList = pendingList.filter(a => new Date(a.dueDate).getTime() <= now);
        const upcomingList = pendingList.filter(a => new Date(a.dueDate).getTime() > now);

        // Workload hours
        const totalPendingWorkloadMinutes = pendingList.reduce((sum, a) => sum + (a.estimatedMinutes || 90), 0);
        const overdueWorkloadMinutes = overdueList.reduce((sum, a) => sum + (a.estimatedMinutes || 90), 0);

        // Current calendar week bounds (Monday 00:00 to Sunday 23:59:59 local)
        const nowDate = new Date();
        const currentDayOfWeek = nowDate.getDay(); // 0 is Sunday
        const mondayOffset = currentDayOfWeek === 0 ? -6 : 1 - currentDayOfWeek;
        const weekStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + mondayOffset, 0, 0, 0);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

        // Assignments due this week
        const assignmentsDueThisWeek = pendingList.filter(a => {
          const dueMs = new Date(a.dueDate).getTime();
          return dueMs >= weekStart.getTime() && dueMs <= weekEnd.getTime();
        });
        const assignmentsWeekMinutes = assignmentsDueThisWeek.reduce((sum, a) => sum + (a.estimatedMinutes || 90), 0);

        // Weekly recurring study session hours
        const studySessionsWeekMinutes = studySessions.reduce((sum, s) => sum + (s.durationMinutes || 60), 0);
        const totalWeekWorkloadMinutes = assignmentsWeekMinutes + studySessionsWeekMinutes;

        // Daily workload distribution for the 7 days of the current week
        const dailyWorkload = [];
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        for (let i = 0; i < 7; i++) {
          const dayStart = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
          const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
          const dayIndex = (i + 1) % 7; // Sunday is 0, Mon is 1, etc.

          // Assignments due on this calendar day
          const dayAssignments = pendingList.filter(a => {
            const dueMs = new Date(a.dueDate).getTime();
            return dueMs >= dayStart.getTime() && dueMs <= dayEnd.getTime();
          });
          const assignmentMinutes = dayAssignments.reduce((sum, a) => sum + (a.estimatedMinutes || 90), 0);

          // Study sessions scheduled on this day of week
          const daySessions = studySessions.filter(s => s.dayOfWeek === dayIndex);
          const sessionMinutes = daySessions.reduce((sum, s) => sum + (s.durationMinutes || 60), 0);

          dailyWorkload.push({
            dayName: dayNames[i],
            date: dayStart.toISOString().slice(0, 10),
            dayIndex,
            assignmentMinutes,
            sessionMinutes,
            totalMinutes: assignmentMinutes + sessionMinutes,
            assignmentCount: dayAssignments.length,
            sessionCount: daySessions.length
          });
        }

        // Subject workload breakdown
        const subjectMap = {};
        assignments.forEach(a => {
          if (!subjectMap[a.subject]) {
            subjectMap[a.subject] = { subject: a.subject, totalMinutes: 0, pendingMinutes: 0, count: 0, completedCount: 0 };
          }
          subjectMap[a.subject].count++;
          if (a.completed) {
            subjectMap[a.subject].completedCount++;
          } else {
            const m = a.estimatedMinutes || 90;
            subjectMap[a.subject].totalMinutes += m;
            subjectMap[a.subject].pendingMinutes += m;
          }
        });
        studySessions.forEach(s => {
          if (!subjectMap[s.subject]) {
            subjectMap[s.subject] = { subject: s.subject, totalMinutes: 0, pendingMinutes: 0, count: 0, completedCount: 0 };
          }
          // Weekly recurring session load
          subjectMap[s.subject].totalMinutes += s.durationMinutes || 60;
        });

        // Subtask aggregation
        let totalSubtasks = 0;
        let completedSubtasks = 0;
        assignments.forEach(a => {
          if (Array.isArray(a.subtasks)) {
            totalSubtasks += a.subtasks.length;
            completedSubtasks += a.subtasks.filter(st => st.completed).length;
          }
        });

        return sendJson(res, 200, {
          totalAssignments,
          completedCount,
          pendingCount,
          overdueCount: overdueList.length,
          completionRate,
          summary: {
            totalCount: totalAssignments,
            completedCount,
            pendingCount,
            completionRate
          },
          workload: {
            thisWeekHours: (totalWeekWorkloadMinutes / 60).toFixed(1),
            thisWeekTotalHours: (totalWeekWorkloadMinutes / 60).toFixed(1),
            thisWeekTotalMinutes: totalWeekWorkloadMinutes,
            overdueHours: (overdueWorkloadMinutes / 60).toFixed(1),
            overdueCount: overdueList.length,
            overdueMinutes: overdueWorkloadMinutes,
            totalPendingHours: (totalPendingWorkloadMinutes / 60).toFixed(1),
            totalPendingMinutes: totalPendingWorkloadMinutes,
            dailyWorkload,
            dailyDistribution: dailyWorkload.map(d => ({
              dayName: d.dayName.slice(0, 3),
              totalHours: parseFloat((d.totalMinutes / 60).toFixed(1)),
              assignmentHours: parseFloat((d.assignmentMinutes / 60).toFixed(1)),
              sessionHours: parseFloat((d.sessionMinutes / 60).toFixed(1))
            })),
            subjectBreakdown: Object.values(subjectMap).map(s => ({
              subject: s.subject,
              count: s.count,
              totalHours: parseFloat((s.totalMinutes / 60).toFixed(1))
            })),
            overdueExplanation: 'Overdue work is tracked separately as a backlog demand pool so your weekly schedule reflects achievable upcoming commitments while highlighting overdue assignments that require immediate focus.'
          },
          subjects: Object.values(subjectMap),
          subtasks: {
            total: totalSubtasks,
            totalCount: totalSubtasks,
            completed: completedSubtasks,
            completedCount: completedSubtasks,
            completionRate: totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0,
            rate: totalSubtasks > 0 ? Math.round((completedSubtasks / totalSubtasks) * 100) : 0,
            steps: assignments.flatMap(a => (a.subtasks || []).map(st => ({
              ...st,
              assignmentTitle: a.title,
              assignmentSubject: a.subject
            })))
          }
        });
      }

      return sendJson(res, 404, { error: `Endpoint not found: ${method} ${pathname}` });

    } catch (apiErr) {
      console.error('API Error:', apiErr);
      return sendJson(res, 500, { error: apiErr.message || 'Internal Server Error' });
    }
  }

  // --------------------------------------------------------------------------
  // STATIC FILE SERVING
  // --------------------------------------------------------------------------

  let safePath = path.normalize(decodeURI(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  let filePath = path.join(ROOT_DIR, 'public', safePath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ROOT_DIR, safePath);
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      let indexPath = path.join(ROOT_DIR, 'public', 'index.html');
      if (!fs.existsSync(indexPath)) {
        indexPath = path.join(ROOT_DIR, 'index.html');
      }
      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    let contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (path.basename(filePath) === 'manifest.json') {
      contentType = 'application/manifest+json; charset=UTF-8';
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
        return;
      }

      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      };
      if (path.basename(filePath) === 'sw.js') {
        headers['Service-Worker-Allowed'] = '/';
      }

      res.writeHead(200, headers);
      res.end(content);
    });
  });
}

function startServer(port) {
  const server = http.createServer(handleRequest);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  ⚠️ Port ${port} is already in use. Automatically falling back to port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  ✨ StudyPath full-stack app running at: \x1b[36m${url}\x1b[0m`);
    console.log(`  📁 Root directory: ${ROOT_DIR}`);
    console.log(`  🔒 Database: ${path.join(ROOT_DIR, 'data', 'studypath.db')}\n`);
    console.log(`  Press Ctrl + C to stop the server.\n`);

    if (process.platform === 'win32' && !process.env.VERCEL && !process.env.CI) {
      exec(`start "" "${url}"`);
    }
  });
}

module.exports = handleRequest;

if (require.main === module) {
  startServer(INITIAL_PORT);
}
