/**
 * StudyPath • Complete Secure Client-Side Engine
 * 
 * Features:
 *   - Protected Planner: Unauthenticated users gated behind Login / Sign Up.
 *   - Real Backend Synchronization: Connects to Node/SQLite REST API.
 *   - Priority Queue: Urgency heuristic ranking for Next-Up Spotlight.
 *   - Action Stack (LIFO): Undo & Redo stack synchronized with backend persistence.
 *   - Immediate Due Alerts & Audio Chime: Overdue/due-soon checks on load, browser autoplay compliant.
 *   - Multi-Token Search & Dynamic Sorting across titles, subjects, notes, subtasks, links.
 *   - Accurate Live Countdown: Floor minutes, 30-second interval, visibility/focus refresh.
 *   - Recurring Study Sessions: Weekly calendar integration, CRUD, and subject scheduling.
 *   - Workload & Progress Insights: 7-day visual distribution, overdue backlog policy, milestones.
 *   - Real Reminders Engine: Web Notifications API + Web Audio Synthesizer Chime.
 *   - Subtasks & Milestones: Step breakdown, progress bars, inline toggles.
 *   - Reference Links: Validated http/https resources with safe external opening.
 */

'use strict';

// ============================================================================
// 1. DATA STRUCTURES IMPLEMENTATION
// ============================================================================

/**
 * ActionStack: LIFO stack for undo/redo state management
 */
class ActionStack {
  constructor(maxSize = 40) {
    this.stack = [];
    this.maxSize = maxSize;
  }

  push(action) {
    if (this.stack.length >= this.maxSize) {
      this.stack.shift();
    }
    this.stack.push(action);
  }

  pop() {
    return this.stack.pop();
  }

  peek() {
    return this.stack[this.stack.length - 1] || null;
  }

  clear() {
    this.stack = [];
  }

  get size() {
    return this.stack.length;
  }

  isEmpty() {
    return this.stack.length === 0;
  }
}

/**
 * AssignmentPriorityQueue: Urgency heuristic calculator for the Next-Up Spotlight
 */
class AssignmentPriorityQueue {
  static calculateUrgencyScore(assignment) {
    if (assignment.completed) return -999999;

    const now = Date.now();
    const dueTime = new Date(assignment.dueDate).getTime();
    const diffHours = (dueTime - now) / (1000 * 60 * 60);

    const priorityWeights = { high: 300, medium: 200, low: 100 };
    const weight = priorityWeights[assignment.priority] || 150;

    let urgencyScore = weight;

    if (diffHours <= 0) {
      urgencyScore += 1000 + Math.min(Math.abs(diffHours) * 10, 500);
    } else if (diffHours <= 12) {
      urgencyScore += 700 + (12 - diffHours) * 20;
    } else if (diffHours <= 24) {
      urgencyScore += 500 + (24 - diffHours) * 10;
    } else if (diffHours <= 48) {
      urgencyScore += 300 + (48 - diffHours) * 5;
    } else {
      urgencyScore += Math.max(0, 100 - (diffHours / 24) * 5);
    }

    return urgencyScore;
  }

  static rankQueue(assignmentsList) {
    return [...assignmentsList].sort((a, b) => {
      if (a.completed !== b.completed) {
        return a.completed ? 1 : -1;
      }
      return AssignmentPriorityQueue.calculateUrgencyScore(b) - 
             AssignmentPriorityQueue.calculateUrgencyScore(a);
    });
  }

  static peekNext(assignmentsList) {
    const pending = assignmentsList.filter(item => !item.completed);
    if (pending.length === 0) return null;
    return AssignmentPriorityQueue.rankQueue(pending)[0];
  }
}

// ============================================================================
// 2. APPLICATION STATE
// ============================================================================

let currentUser = null;
let assignments = [];
let studySessions = [];
let reminders = [];

const undoStack = new ActionStack();
const redoStack = new ActionStack();

let currentFilterStatus = 'all';
let currentFilterPriority = 'all';
let currentFilterSubject = 'all';
let currentSort = 'queue-smart';
let currentSearchQuery = '';

let currentView = 'queue'; // 'queue' | 'calendar' | 'workload' | 'sessions' | 'reminders'
let calendarDate = new Date();
let calendarViewMode = 'week'; // 'week' | 'day'

// Sound & Due Alerts state (loaded safely in client-side code after DOM mounts)
let soundChimeAudioCtx = null;
let isSoundEnabled = true;
const alertedAssignmentIds = new Set();
const dismissedAlertIds = new Set();
const expandedSubtasksAssignmentIds = new Set();

function loadStoredPreferences() {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('studypath_sound_enabled');
      if (stored !== null) {
        isSoundEnabled = stored !== 'false';
      }
    } catch (e) {}
  }
}

// ============================================================================
// 3. API SERVICE LAYER
// ============================================================================

async function apiRequest(endpoint, options = {}) {
  const config = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(endpoint, config);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data.error || `Request failed with status ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

// ============================================================================
// 4. AUTHENTICATION & SESSION MANAGEMENT
// ============================================================================

let redirectAfterLogin = null;

async function checkAuthSession() {
  const bootLoader = document.getElementById('session-boot-loader');

  // Check if user directly navigated to a protected route (e.g. #calendar, #workload)
  const initialHash = (typeof window !== 'undefined' && window.location?.hash)
    ? window.location.hash.replace(/^#\/?/, '').toLowerCase()
    : '';
  const validViews = ['queue', 'calendar', 'workload', 'sessions', 'reminders'];
  if (validViews.includes(initialHash)) {
    redirectAfterLogin = initialHash;
    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem('studypath_redirect_after_login', initialHash);
      } catch (e) {}
    }
  }

  try {
    const data = await apiRequest('/api/auth/me');
    if (data.user) {
      currentUser = data.user;
      let savedRedirect = null;
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        try {
          savedRedirect = sessionStorage.getItem('studypath_redirect_after_login');
          sessionStorage.removeItem('studypath_redirect_after_login');
        } catch (e) {}
      }
      const target = redirectAfterLogin || savedRedirect || (validViews.includes(initialHash) ? initialHash : 'queue');
      redirectAfterLogin = null;
      showAppView(target);
      await loadAllUserData();
    } else {
      showAuthView();
    }
  } catch (err) {
    showAuthView();
  } finally {
    if (bootLoader) {
      bootLoader.classList.add('is-hidden');
    }
  }
}

function showAuthView() {
  currentUser = null;
  assignments = [];
  studySessions = [];
  reminders = [];
  undoStack.clear();
  redoStack.clear();
  updateStackButtons();

  const authView = document.getElementById('auth-view');
  const appView = document.getElementById('app-view');
  if (authView) {
    authView.hidden = false;
    authView.style.display = 'flex';
  }
  if (appView) {
    appView.hidden = true;
    appView.style.display = 'none';
  }

  // Scroll page directly to top
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;

  document.getElementById('login-email')?.focus();
}

function showAppView(targetRoute = null) {
  const authView = document.getElementById('auth-view');
  const appView = document.getElementById('app-view');
  if (authView) {
    authView.hidden = true;
    authView.style.display = 'none';
  }
  if (appView) {
    appView.hidden = false;
    appView.style.display = 'block';
  }

  const nameEl = document.getElementById('welcome-user-name');
  const headerName = document.getElementById('user-display-name');
  const initialsEl = document.getElementById('user-initials');
  const majorBadge = document.getElementById('header-user-major');

  if (currentUser) {
    if (nameEl) nameEl.textContent = currentUser.name.split(' ')[0];
    if (headerName) headerName.textContent = currentUser.name;
    if (initialsEl) {
      const parts = currentUser.name.trim().split(' ');
      const initials = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
      initialsEl.textContent = initials.toUpperCase();
    }
    if (majorBadge) {
      majorBadge.textContent = currentUser.major || 'Active Student';
    }
  }

  updateSoundUI();

  // Scroll page to top immediately so user lands cleanly at top of planner
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;

  // Restore originally requested route if valid, or default to queue
  const validViews = ['queue', 'calendar', 'workload', 'sessions', 'reminders'];
  let routeToOpen = targetRoute;
  if (!routeToOpen) {
    const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
    if (validViews.includes(hash)) {
      routeToOpen = hash;
    }
  }
  if (routeToOpen && validViews.includes(routeToOpen)) {
    switchView(routeToOpen);
    window.location.hash = `#${routeToOpen}`;
  } else {
    switchView('queue');
    if (window.location.hash === '#login' || window.location.hash === '#auth') {
      window.location.hash = '#queue';
    }
  }

  // Ensure scroll remains at top after view render
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
}

async function handleLogout() {
  try {
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.warn('Logout network error', e);
  } finally {
    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem('studypath_redirect_after_login');
      } catch (e) {}
    }
    redirectAfterLogin = null;
    showAuthView();
    showToast('Signed out successfully.');
    announceToScreenReader('You have been signed out.');
  }
}

// ============================================================================
// 5. BACKEND DATA OPERATIONS (ASSIGNMENTS, SESSIONS, REMINDERS)
// ============================================================================

async function loadAssignmentsFromBackend() {
  try {
    const data = await apiRequest('/api/assignments');
    assignments = data.assignments || [];
    refreshUI();
    checkImmediateDueAlerts();
  } catch (err) {
    console.error('Failed to load assignments', err);
    if (err.status === 401) {
      showAuthView();
    } else {
      showToast('Could not sync with database: ' + err.message);
    }
  }
}

async function loadStudySessionsFromBackend() {
  try {
    const data = await apiRequest('/api/study-sessions');
    studySessions = data.sessions || [];
    if (currentView === 'sessions') renderStudySessionsView();
    if (currentView === 'calendar') renderCalendarView();
  } catch (err) {
    console.error('Failed to load study sessions', err);
  }
}

async function loadRemindersFromBackend() {
  try {
    const data = await apiRequest('/api/reminders');
    reminders = data.reminders || [];
    updateRemindersBadge();
    if (currentView === 'reminders') renderRemindersView();
  } catch (err) {
    console.error('Failed to load reminders', err);
  }
}

async function loadAllUserData() {
  await Promise.all([
    loadAssignmentsFromBackend(),
    loadStudySessionsFromBackend(),
    loadRemindersFromBackend()
  ]);
  checkNotificationPermission();
  checkDueReminders();
}

function updateRemindersBadge() {
  const badge = document.getElementById('reminders-count-badge');
  if (!badge) return;
  const activeCount = reminders.filter(r => !r.dismissed).length;
  if (activeCount > 0) {
    badge.textContent = activeCount;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ============================================================================
// 6. STACK-POWERED UNDO / REDO (SYNCS BACKEND)
// ============================================================================

function executeAction(action) {
  undoStack.push(action);
  redoStack.clear();
  updateStackButtons();
}

async function performUndo() {
  if (undoStack.isEmpty()) return;
  const action = undoStack.pop();

  try {
    switch (action.type) {
      case 'ADD':
        {
          await apiRequest(`/api/assignments/${action.item.id}`, { method: 'DELETE' });
          const idx = assignments.findIndex(item => item.id === action.item.id);
          if (idx !== -1) {
            assignments.splice(idx, 1);
            redoStack.push({ type: 'ADD', item: action.item });
            showToast(`Undid adding "${action.item.title}"`);
          }
        }
        break;

      case 'DELETE':
        {
          const res = await apiRequest('/api/assignments', {
            method: 'POST',
            body: action.item
          });
          assignments.splice(action.index, 0, res.assignment);
          redoStack.push({ type: 'DELETE', item: action.item, index: action.index });
          showToast(`Restored "${action.item.title}"`);
        }
        break;

      case 'EDIT':
        {
          const res = await apiRequest(`/api/assignments/${action.id}`, {
            method: 'PUT',
            body: action.previousState
          });
          const idx = assignments.findIndex(item => item.id === action.id);
          if (idx !== -1) {
            const currentSnapshot = { ...assignments[idx] };
            assignments[idx] = res.assignment;
            redoStack.push({ type: 'EDIT', id: action.id, previousState: currentSnapshot });
            showToast(`Undid changes to "${res.assignment.title}"`);
          }
        }
        break;

      case 'TOGGLE_COMPLETE':
        {
          const res = await apiRequest(`/api/assignments/${action.id}/complete`, {
            method: 'PATCH',
            body: { completed: action.previousCompleted }
          });
          const target = assignments.find(item => item.id === action.id);
          if (target) {
            target.completed = res.assignment.completed;
            redoStack.push({
              type: 'TOGGLE_COMPLETE',
              id: action.id,
              previousCompleted: !action.previousCompleted
            });
            showToast(action.previousCompleted ? `Marked "${target.title}" completed` : `Reopened "${target.title}"`);
          }
        }
        break;

      case 'CLEAR_COMPLETED':
        {
          for (const itemWrapper of action.items) {
            await apiRequest('/api/assignments', {
              method: 'POST',
              body: itemWrapper.data
            });
          }
          await loadAssignmentsFromBackend();
          redoStack.push({ type: 'CLEAR_COMPLETED', items: action.items });
          showToast(`Restored ${action.items.length} cleared assignment(s)`);
        }
        break;
    }
  } catch (err) {
    showToast('Undo failed: ' + err.message);
    await loadAssignmentsFromBackend();
  }

  updateStackButtons();
  refreshUI();
}

async function performRedo() {
  if (redoStack.isEmpty()) return;
  const action = redoStack.pop();

  try {
    switch (action.type) {
      case 'ADD':
        {
          const res = await apiRequest('/api/assignments', {
            method: 'POST',
            body: action.item
          });
          assignments.unshift(res.assignment);
          undoStack.push({ type: 'ADD', item: action.item });
          showToast(`Re-added "${action.item.title}"`);
        }
        break;

      case 'DELETE':
        {
          await apiRequest(`/api/assignments/${action.item.id}`, { method: 'DELETE' });
          const targetIdx = assignments.findIndex(item => item.id === action.item.id);
          if (targetIdx !== -1) {
            assignments.splice(targetIdx, 1);
            undoStack.push({ type: 'DELETE', item: action.item, index: targetIdx });
            showToast(`Deleted "${action.item.title}"`);
          }
        }
        break;

      case 'EDIT':
        {
          const res = await apiRequest(`/api/assignments/${action.id}`, {
            method: 'PUT',
            body: action.previousState
          });
          const idx = assignments.findIndex(item => item.id === action.id);
          if (idx !== -1) {
            const currentSnapshot = { ...assignments[idx] };
            assignments[idx] = res.assignment;
            undoStack.push({ type: 'EDIT', id: action.id, previousState: currentSnapshot });
            showToast(`Re-applied edits to "${res.assignment.title}"`);
          }
        }
        break;

      case 'TOGGLE_COMPLETE':
        {
          const res = await apiRequest(`/api/assignments/${action.id}/complete`, {
            method: 'PATCH',
            body: { completed: action.previousCompleted }
          });
          const target = assignments.find(item => item.id === action.id);
          if (target) {
            target.completed = res.assignment.completed;
            undoStack.push({
              type: 'TOGGLE_COMPLETE',
              id: action.id,
              previousCompleted: !action.previousCompleted
            });
            showToast(action.previousCompleted ? `Marked "${target.title}" completed` : `Reopened "${target.title}"`);
          }
        }
        break;

      case 'CLEAR_COMPLETED':
        {
          await apiRequest('/api/assignments/clear-completed', { method: 'POST' });
          assignments = assignments.filter(item => !item.completed);
          undoStack.push({ type: 'CLEAR_COMPLETED', items: action.items });
          showToast('Re-cleared completed assignments');
        }
        break;
    }
  } catch (err) {
    showToast('Redo failed: ' + err.message);
    await loadAssignmentsFromBackend();
  }

  updateStackButtons();
  refreshUI();
}

function updateStackButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  const undoCountPill = document.getElementById('undo-count');
  const redoCountPill = document.getElementById('redo-count');

  if (undoBtn) undoBtn.disabled = undoStack.isEmpty();
  if (redoBtn) redoBtn.disabled = redoStack.isEmpty();

  if (undoCountPill) {
    undoCountPill.textContent = undoStack.size;
    undoCountPill.setAttribute('aria-label', `${undoStack.size} undo actions available`);
  }
  if (redoCountPill) {
    redoCountPill.textContent = redoStack.size;
    redoCountPill.setAttribute('aria-label', `${redoStack.size} redo actions available`);
  }
}

// ============================================================================
// 7. SEARCH & SORT ALGORITHMS
// ============================================================================

function searchAssignments(list, rawQuery) {
  if (!rawQuery || !rawQuery.trim()) return list;

  const tokens = rawQuery.toLowerCase().trim().split(/\s+/);
  return list.filter(item => {
    const subtaskTitles = (item.subtasks || []).map(s => s.title).join(' ');
    const linkTitles = (item.links || []).map(l => (l.title || '') + ' ' + (l.url || '')).join(' ');
    const searchable = `${item.title} ${item.subject} ${item.notes || ''} ${subtaskTitles} ${linkTitles}`.toLowerCase();
    return tokens.every(token => searchable.includes(token));
  });
}

function filterAssignments(list) {
  const now = Date.now();
  const fortyEightHours = 48 * 60 * 60 * 1000;

  return list.filter(item => {
    if (currentFilterStatus === 'pending' && item.completed) return false;
    if (currentFilterStatus === 'completed' && !item.completed) return false;
    
    if (currentFilterStatus === 'overdue') {
      const isOverdue = !item.completed && new Date(item.dueDate).getTime() <= now;
      if (!isOverdue) return false;
    }

    if (currentFilterStatus === 'due-soon') {
      const dueMs = new Date(item.dueDate).getTime();
      const isDueSoon = !item.completed && (dueMs > now) && (dueMs - now <= fortyEightHours);
      if (!isDueSoon) return false;
    }

    if (currentFilterPriority !== 'all' && item.priority !== currentFilterPriority) {
      return false;
    }

    if (currentFilterSubject !== 'all' && item.subject.toLowerCase() !== currentFilterSubject.toLowerCase()) {
      return false;
    }

    return true;
  });
}

function sortAssignments(list, sortType) {
  const copy = [...list];

  switch (sortType) {
    case 'queue-smart':
      return AssignmentPriorityQueue.rankQueue(copy);

    case 'due-asc':
      return copy.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    case 'due-desc':
      return copy.sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));

    case 'priority-desc': {
      const pWeights = { high: 3, medium: 2, low: 1 };
      return copy.sort((a, b) => (pWeights[b.priority] || 0) - (pWeights[a.priority] || 0));
    }

    case 'subject-asc':
      return copy.sort((a, b) => a.subject.localeCompare(b.subject));

    case 'title-asc':
      return copy.sort((a, b) => a.title.localeCompare(b.title));

    default:
      return copy;
  }
}

// ============================================================================
// 8. SPOTLIGHT & QUEUE RENDERING
// ============================================================================

function renderSpotlightCard() {
  const spotlightContainer = document.getElementById('spotlight-card');
  const spotlightContent = document.getElementById('spotlight-content');
  const urgencyTag = document.getElementById('spotlight-urgency-tag');
  if (!spotlightContainer || !spotlightContent) return;

  if (assignments.length === 0) {
    spotlightContent.innerHTML = `
      <div class="spotlight-main spotlight-onboarding">
        <div class="spotlight-tags">
          <span class="subject-pill" style="background:var(--clr-primary-light);color:var(--clr-primary);border-color:rgba(140,83,43,0.25);">Queue Empty</span>
          <span class="priority-pill" style="background:var(--bg-subtle);color:var(--text-muted);border:1px solid var(--border-light);">Ready to Plan</span>
        </div>
        <h2 id="spotlight-heading" class="spotlight-title">Your planner is clear. Add your first assignment!</h2>
        <p class="spotlight-desc">Add coursework, reading, or lab deadlines to activate the intelligent Priority Queue algorithm and see what to focus on next.</p>
      </div>
      <div class="spotlight-actions">
        <button id="btn-spotlight-first" class="btn btn--primary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>Add Your First Assignment</span>
        </button>
      </div>
    `;

    if (urgencyTag) urgencyTag.textContent = 'Queue Status: Awaiting First Task';

    document.getElementById('btn-spotlight-first')?.addEventListener('click', () => openAssignmentModal());
    return;
  }

  const nextTask = AssignmentPriorityQueue.peekNext(assignments);

  if (!nextTask) {
    spotlightContent.innerHTML = `
      <div class="spotlight-main">
        <div class="spotlight-tags">
          <span class="subject-pill" style="background:#D1FAE5;color:#065F46;border-color:rgba(5,150,105,0.2);">Queue Cleared</span>
        </div>
        <h2 id="spotlight-heading" class="spotlight-title">🎉 You're all caught up!</h2>
        <p class="spotlight-desc">All pending assignments are finished. Take a break or plan ahead for upcoming classes.</p>
      </div>
      <div class="spotlight-actions">
        <button id="btn-spotlight-new" class="btn btn--primary">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>Add New Assignment</span>
        </button>
      </div>
    `;

    if (urgencyTag) urgencyTag.textContent = 'Queue Status: 100% Completed';

    document.getElementById('btn-spotlight-new')?.addEventListener('click', () => openAssignmentModal());
    return;
  }

  const dueInfo = formatDueCountdown(nextTask.dueDate);
  const urgencyScore = AssignmentPriorityQueue.calculateUrgencyScore(nextTask);

  spotlightContent.innerHTML = `
    <div class="spotlight-main">
      <div class="spotlight-tags">
        <span class="subject-pill">${escapeHTML(nextTask.subject)}</span>
        <span class="priority-pill priority-pill--${nextTask.priority}">${escapeHTML(nextTask.priority)} Priority</span>
      </div>
      <h2 id="spotlight-heading" class="spotlight-title">${escapeHTML(nextTask.title)}</h2>
      <p class="spotlight-desc">${escapeHTML(nextTask.notes || 'No extra notes provided.')}</p>
    </div>

    <div class="spotlight-meta">
      <div class="meta-item">
        <span class="meta-label">Due Date</span>
        <span class="meta-val ${dueInfo.isOverdue ? 'highlight-time' : ''}">${dueInfo.text}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Est. Time</span>
        <span class="meta-val">${escapeHTML(nextTask.duration || formatMins(nextTask.estimatedMinutes || nextTask.estimated_minutes))}</span>
      </div>
      <div class="spotlight-actions">
        <button id="btn-spotlight-complete" class="btn btn--accent" data-task-id="${nextTask.id}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Mark Done & Advance Queue</span>
        </button>
        <button id="btn-spotlight-edit" class="btn btn--ghost" data-task-id="${nextTask.id}" aria-label="Edit this priority task">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <span>Edit</span>
        </button>
      </div>
    </div>
  `;

  if (urgencyTag) {
    urgencyTag.textContent = `Score: ${Math.round(urgencyScore)} pts • Priority: ${nextTask.priority.toUpperCase()}`;
  }

  document.getElementById('btn-spotlight-complete')?.addEventListener('click', () => toggleComplete(nextTask.id));
  document.getElementById('btn-spotlight-edit')?.addEventListener('click', () => openAssignmentModal(nextTask.id));
}

function renderAssignmentList() {
  const container = document.getElementById('queue-container');
  const emptyState = document.getElementById('empty-state');
  const countBadge = document.getElementById('filtered-count-badge');
  if (!container || !emptyState) return;

  let processed = searchAssignments(assignments, currentSearchQuery);
  processed = filterAssignments(processed);
  processed = sortAssignments(processed, currentSort);

  if (countBadge) {
    countBadge.textContent = `Showing ${processed.length} of ${assignments.length} assignments`;
  }

  if (processed.length === 0) {
    container.innerHTML = '';
    emptyState.hidden = false;

    const emptyTitle = document.getElementById('empty-title');
    const emptyDesc = document.getElementById('empty-desc');
    const emptyResetBtn = document.getElementById('btn-empty-reset');
    const emptyAddBtn = document.getElementById('btn-empty-add');

    if (assignments.length === 0) {
      emptyTitle.textContent = 'Start by adding an assignment';
      emptyDesc.textContent = 'Keep track of upcoming problem sets, papers, and lab reports. StudyPath will automatically rank your work by urgency.';
      if (emptyResetBtn) emptyResetBtn.hidden = true;
      if (emptyAddBtn) {
        emptyAddBtn.hidden = false;
        emptyAddBtn.textContent = 'Add Your First Assignment';
      }
      return;
    }

    if (emptyResetBtn) emptyResetBtn.hidden = false;
    if (emptyAddBtn) {
      emptyAddBtn.hidden = false;
      emptyAddBtn.textContent = 'Add New Assignment';
    }

    if (currentSearchQuery.trim()) {
      emptyTitle.textContent = 'No matching assignments';
      emptyDesc.textContent = `No assignments found matching "${currentSearchQuery}". Try adjusting your keywords.`;
    } else if (currentFilterStatus === 'completed') {
      emptyTitle.textContent = 'No completed assignments';
      emptyDesc.textContent = 'When you finish coursework and check tasks off, they will appear here.';
    } else if (currentFilterStatus === 'overdue') {
      emptyTitle.textContent = 'Zero overdue assignments';
      emptyDesc.textContent = 'All deadlines are current and on schedule.';
    } else {
      emptyTitle.textContent = 'No assignments in this view';
      emptyDesc.textContent = 'Try choosing "All Statuses" or clear your active filters.';
    }
    return;
  }

  emptyState.hidden = true;

  const html = processed.map((item) => {
    const dueInfo = formatDueCountdown(item.dueDate);
    const completedClass = item.completed ? 'is-completed' : '';
    const dueStatusClass = dueInfo.isOverdue ? 'is-overdue' : (dueInfo.isDueSoon ? 'is-due-soon' : '');

    // Subtasks summary & checklist
    const subtasks = item.subtasks || [];
    const totalSteps = subtasks.length;
    const completedSteps = subtasks.filter(s => s.completed).length;
    const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
    const isExpanded = expandedSubtasksAssignmentIds.has(item.id);

    let subtasksHtml = '';
    if (totalSteps > 0) {
      subtasksHtml = `
        <div class="item-subtasks-section">
          <div class="subtask-header-row">
            <button type="button" class="btn-toggle-subtasks" data-action="toggle-expand-subtasks" data-id="${item.id}" aria-expanded="${isExpanded}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="chevron-icon ${isExpanded ? 'is-open' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
              <span>Subtasks: ${completedSteps}/${totalSteps} (${pct}%)</span>
            </button>
            <div class="subtask-mini-track" aria-hidden="true">
              <div class="subtask-mini-fill" style="width: ${pct}%"></div>
            </div>
          </div>
          <div class="subtasks-expandable-list" id="subtasks-list-${item.id}" ${isExpanded ? '' : 'hidden'}>
            ${subtasks.map(step => `
              <div class="subtask-card-step ${step.completed ? 'is-step-done' : ''}">
                <label class="subtask-step-label">
                  <input type="checkbox" class="subtask-step-check" data-action="toggle-step-check" data-assignment-id="${item.id}" data-step-id="${step.id}" ${step.completed ? 'checked' : ''}>
                  <span class="subtask-step-title">${escapeHTML(step.title)}</span>
                </label>
                ${step.dueDate ? `<span class="step-milestone-pill">${escapeHTML(step.dueDate)}</span>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Reference Links
    const links = item.links || [];
    let linksHtml = '';
    if (links.length > 0) {
      linksHtml = `
        <div class="item-links-row" role="list" aria-label="Reference links">
          ${links.map(l => `
            <a href="${escapeHTML(l.url)}" target="_blank" rel="noopener noreferrer" class="item-link-chip" role="listitem" title="Open resource: ${escapeHTML(l.url)}">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
              <span>${escapeHTML(l.title || 'Resource Link')}</span>
            </a>
          `).join('')}
        </div>
      `;
    }

    const durationDisplay = item.duration || formatMins(item.estimatedMinutes || item.estimated_minutes);

    return `
      <article class="assignment-item ${completedClass} priority-${item.priority} tilt-card" data-id="${item.id}" tabindex="0" role="article" aria-label="${escapeHTML(item.title)}, Subject: ${escapeHTML(item.subject)}, ${item.completed ? 'Completed' : 'Pending'}">
        <button 
          class="complete-toggle-btn" 
          data-action="toggle" 
          data-id="${item.id}"
          title="${item.completed ? 'Mark uncompleted' : 'Mark completed'}"
          aria-label="${item.completed ? 'Mark uncompleted' : 'Mark completed'}: ${escapeHTML(item.title)}"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>

        <div class="item-main">
          <div class="item-header">
            <span class="subject-pill">${escapeHTML(item.subject)}</span>
            <span class="priority-pill priority-pill--${item.priority}">${escapeHTML(item.priority)}</span>
            ${item.completed ? '<span class="counter-pill" style="background:#D1FAE5;color:#065F46;font-weight:700;">✓ Done</span>' : ''}
          </div>
          <h3 class="item-title">${escapeHTML(item.title)}</h3>
          ${item.notes ? `<p class="item-notes">${escapeHTML(item.notes)}</p>` : ''}
          ${subtasksHtml}
          ${linksHtml}
        </div>

        <div class="item-meta">
          <span class="item-due ${dueStatusClass}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            ${dueInfo.text}
          </span>
          <span class="item-duration" title="Estimated workload">${escapeHTML(durationDisplay)}</span>
        </div>

        <div class="item-actions">
          <button 
            class="action-icon-btn action-icon-btn--edit" 
            data-action="edit" 
            data-id="${item.id}"
            title="Edit assignment" 
            aria-label="Edit assignment: ${escapeHTML(item.title)}"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
          <button 
            class="action-icon-btn action-icon-btn--delete" 
            data-action="delete" 
            data-id="${item.id}"
            title="Delete assignment" 
            aria-label="Delete assignment: ${escapeHTML(item.title)}"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </article>
    `;
  }).join('');

  container.innerHTML = html;
  attach3DTilt();
}

function updateMetricCounts() {
  const now = Date.now();
  const fortyEightHours = 48 * 60 * 60 * 1000;

  let dueSoon = 0;
  let overdue = 0;
  let active = 0;
  let completed = 0;

  assignments.forEach(item => {
    if (item.completed) {
      completed++;
    } else {
      active++;
      const dueMs = new Date(item.dueDate).getTime();
      if (dueMs <= now) {
        overdue++;
      } else if (dueMs - now <= fortyEightHours) {
        dueSoon++;
      }
    }
  });

  const dueSoonEl = document.getElementById('count-due-soon');
  const overdueEl = document.getElementById('count-overdue');
  const activeEl = document.getElementById('count-active');
  const completedEl = document.getElementById('count-completed');

  if (dueSoonEl) dueSoonEl.textContent = dueSoon;
  if (overdueEl) overdueEl.textContent = overdue;
  if (activeEl) activeEl.textContent = active;
  if (completedEl) completedEl.textContent = completed;

  // Live Compact Progress Indicator on Dashboard
  const totalCount = active + completed;
  const percent = totalCount > 0 ? Math.round((completed / totalCount) * 100) : 0;
  const percentEl = document.getElementById('dashboard-progress-percent');
  const fillEl = document.getElementById('dashboard-progress-fill');
  const barEl = document.getElementById('dashboard-progressbar');
  const subtextEl = document.getElementById('dashboard-progress-subtext');

  if (percentEl) percentEl.textContent = `${percent}%`;
  if (fillEl) fillEl.style.width = `${percent}%`;
  if (barEl) barEl.setAttribute('aria-valuenow', percent);
  if (subtextEl) {
    if (totalCount === 0) {
      subtextEl.textContent = 'No assignments created yet';
    } else if (percent === 100) {
      subtextEl.textContent = `All ${totalCount} assignments completed! 🎉`;
    } else {
      subtextEl.textContent = `${completed} of ${totalCount} completed • ${active} remaining`;
    }
  }
}

function updateSubjectFilterDropdown() {
  const select = document.getElementById('filter-subject');
  if (!select) return;

  const currentVal = select.value;
  const subjects = Array.from(new Set(assignments.map(a => a.subject))).sort();

  let html = `<option value="all">All Subjects (${subjects.length})</option>`;
  subjects.forEach(sub => {
    const isSelected = sub.toLowerCase() === currentVal.toLowerCase() ? 'selected' : '';
    html += `<option value="${escapeHTML(sub)}" ${isSelected}>${escapeHTML(sub)}</option>`;
  });

  select.innerHTML = html;
}

function refreshUI() {
  renderSpotlightCard();
  renderAssignmentList();
  updateMetricCounts();
  updateSubjectFilterDropdown();
  if (currentView === 'calendar') renderCalendarView();
  if (currentView === 'workload') renderWorkloadView();
  if (currentView === 'sessions') renderStudySessionsView();
  if (currentView === 'reminders') renderRemindersView();
}

// ============================================================================
// 8B. VIEW NAVIGATION & TAB MANAGEMENT
// ============================================================================

function switchView(viewName) {
  currentView = viewName;

  // Toggle Tab button states
  document.querySelectorAll('.view-tab-btn').forEach(btn => {
    const target = btn.getAttribute('data-view');
    const isActive = target === viewName;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Toggle View Containers
  const views = ['queue', 'calendar', 'workload', 'sessions', 'reminders'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      if (v === viewName) {
        el.classList.add('active-view');
        el.hidden = false;
      } else {
        el.classList.remove('active-view');
        el.hidden = true;
      }
    }
  });

  // Render view content
  if (viewName === 'calendar') renderCalendarView();
  else if (viewName === 'workload') renderWorkloadView();
  else if (viewName === 'sessions') renderStudySessionsView();
  else if (viewName === 'reminders') renderRemindersView();
  else if (viewName === 'queue') {
    renderSpotlightCard();
    renderAssignmentList();
  }
}

// ============================================================================
// 8C. CALENDAR VIEW ENGINE (ACCESSIBLE DAY & WEEK TIMELINE)
// ============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  // Monday is start of week: Monday=1 ... Sunday=0 -> diff = (day === 0 ? -6 : 1 - day)
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function renderCalendarView() {
  // Use exact DOM IDs matching index.html
  const container = document.getElementById('calendar-body');
  const titleEl = document.getElementById('calendar-title');
  const weekBtn = document.getElementById('btn-view-week');
  const dayBtn = document.getElementById('btn-view-day');

  if (!container || !titleEl) return;

  if (weekBtn) {
    weekBtn.classList.toggle('is-active', calendarViewMode === 'week');
    weekBtn.setAttribute('aria-pressed', calendarViewMode === 'week' ? 'true' : 'false');
  }
  if (dayBtn) {
    dayBtn.classList.toggle('is-active', calendarViewMode === 'day');
    dayBtn.setAttribute('aria-pressed', calendarViewMode === 'day' ? 'true' : 'false');
  }

  const today = new Date();
  const isToday = (d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();

  if (calendarViewMode === 'week') {
    const startOfWeek = getStartOfWeek(calendarDate);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);

    titleEl.textContent = `${MONTH_NAMES[startOfWeek.getMonth()]} ${startOfWeek.getDate()} – ${MONTH_NAMES[endOfWeek.getMonth()]} ${endOfWeek.getDate()}, ${startOfWeek.getFullYear()}`;

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    container.className = 'calendar-body calendar-grid-week';
    container.innerHTML = days.map((dayDate) => {
      const dayNum = dayDate.getDay();
      const dateStr = dayDate.toISOString().slice(0, 10);
      const isTodayCol = isToday(dayDate);

      // 1. Recurring study sessions for this weekday
      const sessionsForDay = studySessions.filter(s => {
        const sDay = Number(s.dayOfWeek !== undefined ? s.dayOfWeek : s.day_of_week);
        return sDay === dayNum;
      });

      // 2. Assignments due on this calendar day
      const assignmentsForDay = assignments.filter(a => {
        try {
          const aDate = new Date(a.dueDate);
          return aDate.getFullYear() === dayDate.getFullYear() &&
                 aDate.getMonth() === dayDate.getMonth() &&
                 aDate.getDate() === dayDate.getDate();
        } catch (e) {
          return false;
        }
      });

      return `
        <div class="calendar-day-col ${isTodayCol ? 'is-today' : ''}" data-date="${dateStr}">
          <div class="cal-day-header">
            <span class="cal-day-name">${DAY_NAMES[dayNum].slice(0, 3)}</span>
            <span class="cal-day-num ${isTodayCol ? 'is-today-circle' : ''}">${dayDate.getDate()}</span>
            ${isTodayCol ? '<span class="today-tag">Today</span>' : ''}
          </div>

          <div class="cal-day-items">
            <!-- Study Sessions (Recurring blocks) -->
            ${sessionsForDay.map(s => {
              const startTime = s.startTime || s.start_time;
              const duration = s.durationMinutes || s.duration_minutes || 60;
              return `
                <div class="cal-event-card cal-event--session" data-action="edit-session" data-session-id="${s.id}" tabindex="0" role="button" aria-label="Study Session: ${escapeHTML(s.subject)}, ${escapeHTML(startTime)} (${duration}m)">
                  <div class="cal-event-time">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <span>${escapeHTML(startTime)} (${duration}m)</span>
                  </div>
                  <div class="cal-event-title">📚 ${escapeHTML(s.subject)}</div>
                </div>
              `;
            }).join('')}

            <!-- Assignments Due -->
            ${assignmentsForDay.map(a => {
              const due = new Date(a.dueDate);
              const timeStr = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              const completedCls = a.completed ? 'is-done' : '';
              return `
                <div class="cal-event-card cal-event--assignment ${completedCls} priority-border--${a.priority}" data-action="edit-assignment" data-id="${a.id}" tabindex="0" role="button" aria-label="Assignment: ${escapeHTML(a.title)}, due ${timeStr}">
                  <div class="cal-event-time">
                    <span class="cal-priority-dot dot--${a.priority}"></span>
                    <span>Due ${timeStr}</span>
                  </div>
                  <div class="cal-event-title">${a.completed ? '✓ ' : ''}${escapeHTML(a.title)}</div>
                  <div class="cal-event-subject">${escapeHTML(a.subject)}</div>
                </div>
              `;
            }).join('')}

            ${sessionsForDay.length === 0 && assignmentsForDay.length === 0 ? '<div class="cal-day-empty">No items scheduled</div>' : ''}
          </div>
        </div>
      `;
    }).join('');

  } else {
    // Single Day View
    const targetDate = new Date(calendarDate);
    const dayNum = targetDate.getDay();
    const isTodayCol = isToday(targetDate);
    titleEl.textContent = `${DAY_NAMES[dayNum]}, ${MONTH_NAMES[targetDate.getMonth()]} ${targetDate.getDate()}, ${targetDate.getFullYear()}`;

    const sessionsForDay = studySessions.filter(s => {
      const sDay = Number(s.dayOfWeek !== undefined ? s.dayOfWeek : s.day_of_week);
      return sDay === dayNum;
    });

    const assignmentsForDay = assignments.filter(a => {
      try {
        const aDate = new Date(a.dueDate);
        return aDate.getFullYear() === targetDate.getFullYear() &&
               aDate.getMonth() === targetDate.getMonth() &&
               aDate.getDate() === targetDate.getDate();
      } catch (e) {
        return false;
      }
    });

    container.className = 'calendar-body calendar-grid-day';
    container.innerHTML = `
      <div class="calendar-day-view-wrap">
        <div class="cal-day-header-banner ${isTodayCol ? 'is-today' : ''}">
          <h2>${DAY_NAMES[dayNum]}, ${MONTH_NAMES[targetDate.getMonth()]} ${targetDate.getDate()}</h2>
          <span class="cal-subtitle">${sessionsForDay.length} recurring study sessions • ${assignmentsForDay.length} assignments due</span>
        </div>

        <div class="cal-day-schedule-feed">
          <div class="schedule-column">
            <h3 class="schedule-column-title">Scheduled Study Blocks</h3>
            ${sessionsForDay.length === 0 ? '<p class="text-muted">No recurring study sessions on this weekday.</p>' : ''}
            ${sessionsForDay.map(s => {
              const startTime = s.startTime || s.start_time;
              const duration = s.durationMinutes || s.duration_minutes || 60;
              return `
                <div class="day-view-item day-view-item--session" data-action="edit-session" data-session-id="${s.id}" tabindex="0" role="button">
                  <div class="d-flex justify-between">
                    <span class="subject-pill">${escapeHTML(s.subject)}</span>
                    <span class="item-duration">${escapeHTML(startTime)} (${duration} mins)</span>
                  </div>
                  ${s.notes ? `<p class="item-notes mt-2">${escapeHTML(s.notes)}</p>` : ''}
                </div>
              `;
            }).join('')}
          </div>

          <div class="schedule-column">
            <h3 class="schedule-column-title">Assignments Due</h3>
            ${assignmentsForDay.length === 0 ? '<p class="text-muted">No assignments due on this date.</p>' : ''}
            ${assignmentsForDay.map(a => {
              const due = new Date(a.dueDate);
              const timeStr = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              return `
                <div class="day-view-item day-view-item--assignment ${a.completed ? 'is-completed' : ''}" data-action="edit-assignment" data-id="${a.id}" tabindex="0" role="button">
                  <div class="d-flex justify-between">
                    <span class="subject-pill">${escapeHTML(a.subject)}</span>
                    <span class="priority-pill priority-pill--${a.priority}">${escapeHTML(a.priority)}</span>
                  </div>
                  <h4 class="item-title mt-1">${escapeHTML(a.title)}</h4>
                  <div class="item-meta mt-1">
                    <span class="item-due">Due at ${timeStr}</span>
                    <span class="item-duration">${escapeHTML(a.duration || formatMins(a.estimatedMinutes || a.estimated_minutes))}</span>
                  </div>
                  ${a.notes ? `<p class="item-notes mt-2">${escapeHTML(a.notes)}</p>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// 8D. WORKLOAD & PROGRESS INSIGHTS ENGINE
// ============================================================================

async function renderWorkloadView() {
  try {
    const data = await apiRequest('/api/insights');

    // 1. Fill KPI Cards matching index.html IDs
    const weekHoursEl = document.getElementById('insights-week-hours');
    const weekBreakdownEl = document.getElementById('insights-week-breakdown');
    const overdueHoursEl = document.getElementById('insights-overdue-hours');
    const overdueCountEl = document.getElementById('insights-overdue-count');
    const policyOverdueHrsEl = document.getElementById('policy-overdue-hrs');
    const completionRateEl = document.getElementById('insights-completion-rate');
    const completionSubtextEl = document.getElementById('insights-completion-subtext');
    const subtasksRateEl = document.getElementById('insights-subtasks-rate');
    const subtasksSubtextEl = document.getElementById('insights-subtasks-subtext');

    const weekHrs = data.workload ? (data.workload.thisWeekHours || data.workload.thisWeekTotalHours || '0.0') : '0.0';
    if (weekHoursEl) weekHoursEl.textContent = weekHrs;
    if (weekBreakdownEl) {
      const aHrs = data.workload?.thisWeekAssignmentsMinutes ? (data.workload.thisWeekAssignmentsMinutes / 60).toFixed(1) : '0';
      const sHrs = data.workload?.thisWeekStudySessionsMinutes ? (data.workload.thisWeekStudySessionsMinutes / 60).toFixed(1) : '0';
      weekBreakdownEl.textContent = `${aHrs}h assignments • ${sHrs}h study blocks`;
    }

    const ovHrs = data.workload ? (data.workload.overdueHours || '0.0') : '0.0';
    const ovCount = data.workload ? (data.workload.overdueCount || 0) : 0;
    if (overdueHoursEl) overdueHoursEl.textContent = ovHrs;
    if (overdueCountEl) overdueCountEl.textContent = `${ovCount} overdue assignment${ovCount === 1 ? '' : 's'} awaiting completion`;
    if (policyOverdueHrsEl) policyOverdueHrsEl.textContent = `${ovHrs} hrs`;

    const compRate = data.summary ? (data.summary.completionRate || 0) : (data.completionRate || 0);
    const compCount = data.summary ? (data.summary.completedCount || 0) : (data.completedCount || 0);
    const totCount = data.summary ? (data.summary.totalCount || 0) : (data.totalAssignments || 0);
    if (completionRateEl) completionRateEl.textContent = `${compRate}%`;
    if (completionSubtextEl) completionSubtextEl.textContent = `${compCount} completed of ${totCount} total`;

    const subRate = data.subtasks ? (data.subtasks.completionRate || data.subtasks.rate || 0) : 0;
    const subComp = data.subtasks ? (data.subtasks.completedCount || data.subtasks.completed || 0) : 0;
    const subTot = data.subtasks ? (data.subtasks.totalCount || data.subtasks.total || 0) : 0;
    if (subtasksRateEl) subtasksRateEl.textContent = `${subRate}%`;
    if (subtasksSubtextEl) subtasksSubtextEl.textContent = `${subComp} completed of ${subTot} total steps`;

    // 2. Render 7-Day Workload Bar Chart
    const chartContainer = document.getElementById('workload-barchart-container');
    if (chartContainer) {
      const daily = (data.workload && (data.workload.dailyDistribution || data.workload.dailyWorkload)) || [];
      const hasWorkload = daily.some(d => (d.totalHours > 0 || d.totalMinutes > 0));

      if (!hasWorkload) {
        chartContainer.innerHTML = `
          <div class="barchart-empty-state">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="text-muted"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>
            <span>No workload scheduled for this week.</span>
            <span class="text-xs text-muted">Add assignments or recurring study blocks to view your daily distribution.</span>
          </div>
        `;
      } else {
        const maxHours = Math.max(6, ...daily.map(d => d.totalHours || ((d.totalMinutes || 0) / 60)));
        chartContainer.innerHTML = `
          <div class="workload-bars-wrap">
            ${daily.map(day => {
              const tHrs = day.totalHours !== undefined ? day.totalHours : parseFloat(((day.totalMinutes || 0) / 60).toFixed(1));
              const aHrs = day.assignmentHours !== undefined ? day.assignmentHours : parseFloat(((day.assignmentMinutes || 0) / 60).toFixed(1));
              const sHrs = day.sessionHours !== undefined ? day.sessionHours : parseFloat(((day.sessionMinutes || 0) / 60).toFixed(1));
              const heightPct = Math.min(100, Math.round((tHrs / maxHours) * 100));
              const dayName = (day.dayName || '').slice(0, 3);
              return `
                <div class="workload-bar-col">
                  <div class="bar-val-label">${tHrs}h</div>
                  <div class="bar-track">
                    <div class="bar-fill" style="height: ${heightPct}%;" title="${day.dayName}: ${aHrs}h assignments, ${sHrs}h study blocks">
                      <div class="bar-fill-session" style="height: ${tHrs > 0 ? (sHrs / tHrs) * 100 : 0}%;"></div>
                    </div>
                  </div>
                  <span class="bar-day-name">${dayName}</span>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
    }

    // 3. Render Course Workload Breakdown
    const courseBreakdownContainer = document.getElementById('subject-breakdown-list');
    if (courseBreakdownContainer) {
      const subjects = (data.workload && data.workload.subjectBreakdown) || data.subjects || [];
      if (subjects.length === 0) {
        courseBreakdownContainer.innerHTML = '<p class="text-muted p-3">No coursework data available.</p>';
      } else {
        courseBreakdownContainer.innerHTML = subjects.map(s => {
          const totHrs = s.totalHours !== undefined ? s.totalHours : parseFloat(((s.totalMinutes || 0) / 60).toFixed(1));
          return `
            <div class="course-stat-row">
              <div class="course-stat-info">
                <span class="subject-pill">${escapeHTML(s.subject)}</span>
                <span class="course-task-count">${s.count} task${s.count === 1 ? '' : 's'}</span>
              </div>
              <div class="course-stat-bar-wrap">
                <div class="course-stat-bar-fill" style="width: ${Math.min(100, totHrs * 12)}%"></div>
              </div>
              <span class="course-hours-val">${totHrs} hrs</span>
            </div>
          `;
        }).join('');
      }
    }

    // 4. Render Milestone Steps List
    const milestonesContainer = document.getElementById('milestones-tracker-list');
    if (milestonesContainer) {
      const steps = (data.subtasks && data.subtasks.steps) || [];
      if (steps.length === 0) {
        milestonesContainer.innerHTML = '<p class="text-muted p-3">No milestone subtasks created yet. Add steps in the assignment editor.</p>';
      } else {
        milestonesContainer.innerHTML = steps.map(st => `
          <div class="milestone-insight-row ${st.completed ? 'is-done' : ''}">
            <input type="checkbox" class="subtask-step-check" data-action="toggle-step-check" data-assignment-id="${st.assignment_id || st.assignmentId}" data-step-id="${st.id}" ${st.completed ? 'checked' : ''} aria-label="Toggle milestone: ${escapeHTML(st.title)}">
            <div class="milestone-insight-main">
              <span class="milestone-title">${escapeHTML(st.title)}</span>
              <span class="milestone-parent">Coursework: <strong>${escapeHTML(st.assignmentTitle || 'Assignment')}</strong></span>
            </div>
            ${st.due_date || st.dueDate ? `<span class="step-milestone-pill">${escapeHTML(st.due_date || st.dueDate)}</span>` : '<span class="text-muted text-xs">No target date</span>'}
          </div>
        `).join('');
      }
    }

  } catch (err) {
    console.error('Failed to load workload insights:', err);
  }
}

// ============================================================================
// 8E. STUDY SESSIONS MANAGEMENT VIEW
// ============================================================================

function renderStudySessionsView() {
  const container = document.getElementById('sessions-container');
  if (!container) return;

  if (studySessions.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card">
        <h3>No Recurring Study Blocks Scheduled</h3>
        <p>Schedule dedicated weekly focus blocks for problem sets, reading, or lab preparation. They appear automatically on your calendar.</p>
        <button type="button" class="btn btn--primary mt-3" data-action="new-session">+ Schedule Your First Study Block</button>
      </div>
    `;
    return;
  }

  // Sort by day of week (Monday=1 ... Sunday=0) then by start time
  const sorted = [...studySessions].sort((a, b) => {
    const da = Number(a.dayOfWeek !== undefined ? a.dayOfWeek : a.day_of_week);
    const db = Number(b.dayOfWeek !== undefined ? b.dayOfWeek : b.day_of_week);
    const ma = da === 0 ? 7 : da;
    const mb = db === 0 ? 7 : db;
    if (ma !== mb) return ma - mb;
    const sa = a.startTime || a.start_time || '';
    const sb = b.startTime || b.start_time || '';
    return sa.localeCompare(sb);
  });

  container.innerHTML = `
    <div class="study-sessions-grid">
      ${sorted.map(s => {
        const dayIdx = Number(s.dayOfWeek !== undefined ? s.dayOfWeek : s.day_of_week);
        const dayName = DAY_NAMES[dayIdx] || 'Monday';
        const startTime = s.startTime || s.start_time;
        const duration = s.durationMinutes || s.duration_minutes || 60;
        return `
          <div class="study-session-card tilt-card" data-session-id="${s.id}">
            <div class="session-card-header">
              <span class="subject-pill">${escapeHTML(s.subject)}</span>
              <span class="day-pill">${dayName}s</span>
            </div>
            <div class="session-card-time">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 16 16 14"></polyline></svg>
              <span>${escapeHTML(startTime)} • ${duration} minutes</span>
            </div>
            ${s.notes ? `<p class="session-card-notes">${escapeHTML(s.notes)}</p>` : ''}
            <div class="session-card-actions">
              <button type="button" class="btn btn--subtle btn--xs" data-action="edit-session" data-session-id="${s.id}">Edit</button>
              <button type="button" class="btn btn--ghost btn--xs text-rose" data-action="delete-session" data-session-id="${s.id}">Delete</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  attach3DTilt();
}

// ============================================================================
// 8F. REMINDERS & NOTIFICATION ENGINE
// ============================================================================

function checkNotificationPermission() {
  const indicator = document.getElementById('perm-status-indicator');
  const title = document.getElementById('perm-status-title');
  const desc = document.getElementById('perm-status-desc');
  const btn = document.getElementById('btn-enable-notifications');

  if (!indicator || !title || !desc) return;

  if (!('Notification' in window)) {
    indicator.className = 'perm-indicator perm--denied';
    title.textContent = 'Browser Notifications Unsupported';
    desc.textContent = 'This browser does not support the Web Notifications API. In-app audio chimes and alerts remain fully active.';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Notifications Unsupported';
    }
    return;
  }

  if (Notification.permission === 'granted') {
    indicator.className = 'perm-indicator perm--granted';
    title.textContent = 'Desktop Notifications Active';
    desc.textContent = 'Real desktop alerts and audio chimes are actively delivered at your chosen deadline reminder times.';
    if (btn) {
      btn.disabled = false;
      btn.className = 'btn btn--secondary btn--sm';
      btn.innerHTML = '<span>Notifications Enabled ✓</span>';
    }
  } else if (Notification.permission === 'denied') {
    indicator.className = 'perm-indicator perm--denied';
    title.textContent = 'Browser Notifications Blocked';
    desc.textContent = 'Desktop notification permission was denied in browser settings. In-app audio chimes and banners remain active while StudyPath is open.';
    if (btn) {
      btn.disabled = true;
      btn.className = 'btn btn--subtle btn--sm';
      btn.innerHTML = '<span>Blocked in Browser Settings</span>';
    }
  } else {
    indicator.className = 'perm-indicator perm--default';
    title.textContent = 'Permission Required for Desktop Alerts';
    desc.textContent = 'Click below to grant permission and receive desktop popups when your deadlines are approaching.';
    if (btn) {
      btn.disabled = false;
      btn.className = 'btn btn--primary btn--sm';
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
        <span>Enable Browser Notifications</span>
      `;
    }
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Web Notifications are not supported in this browser.');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    checkNotificationPermission();
    if (permission === 'granted') {
      showToast('Notifications enabled! You will receive real audio & desktop deadline alerts.');
      await playNotificationChime(true);
      sendDesktopNotification('StudyPath Notifications Ready', 'You will receive real alerts at your chosen reminder times.');
    } else {
      showToast('Notification permission was not granted. In-app alerts remain active.');
    }
  } catch (err) {
    console.error('Notification permission error', err);
  }
}

// Sound Autoplay & Chime Engine
function updateSoundUI() {
  const headerBtn = document.getElementById('btn-sound-toggle');
  const label = document.getElementById('sound-toggle-label');
  const bannerSoundBtn = document.getElementById('btn-enable-sound-banner');
  const bannerSoundText = document.getElementById('banner-sound-text');

  const isSuspended = soundChimeAudioCtx && soundChimeAudioCtx.state === 'suspended';

  if (!isSoundEnabled) {
    if (label) label.textContent = 'Sound: Muted';
    if (headerBtn) {
      headerBtn.classList.add('is-muted');
      headerBtn.classList.remove('is-active');
      headerBtn.setAttribute('title', 'Audio chime is muted. Click to enable.');
    }
    if (bannerSoundText) bannerSoundText.textContent = 'Enable Audio Chime';
    if (bannerSoundBtn) bannerSoundBtn.hidden = false;
  } else if (isSuspended) {
    if (label) label.textContent = 'Sound: Click to Enable';
    if (headerBtn) {
      headerBtn.classList.remove('is-muted');
      headerBtn.classList.remove('is-active');
      headerBtn.setAttribute('title', 'Browser requires a click to enable sound. Click here.');
    }
    if (bannerSoundText) bannerSoundText.textContent = 'Click to Enable Audio Chime';
    if (bannerSoundBtn) bannerSoundBtn.hidden = false;
  } else {
    if (label) label.textContent = 'Sound: Active ✓';
    if (headerBtn) {
      headerBtn.classList.remove('is-muted');
      headerBtn.classList.add('is-active');
      headerBtn.setAttribute('title', 'Audio chime is enabled and active.');
    }
    if (bannerSoundText) bannerSoundText.textContent = 'Sound Active ✓';
    if (bannerSoundBtn) bannerSoundBtn.hidden = true;
  }
}

async function playNotificationChime(userInitiated = false) {
  if (!isSoundEnabled && !userInitiated) return false;

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;

    if (!soundChimeAudioCtx) {
      soundChimeAudioCtx = new AudioCtx();
    }

    if (userInitiated) {
      isSoundEnabled = true;
      if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        try {
          localStorage.setItem('studypath_sound_enabled', 'true');
        } catch (e) {}
      }
      if (soundChimeAudioCtx.state === 'suspended') {
        await soundChimeAudioCtx.resume();
      }
    }

    if (soundChimeAudioCtx.state !== 'running') {
      updateSoundUI();
      return false;
    }

    const now = soundChimeAudioCtx.currentTime;

    // First bell tone: 587.33 Hz (D5)
    const osc1 = soundChimeAudioCtx.createOscillator();
    const gain1 = soundChimeAudioCtx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(soundChimeAudioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Second bell tone: 880 Hz (A5)
    const osc2 = soundChimeAudioCtx.createOscillator();
    const gain2 = soundChimeAudioCtx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.12);
    gain2.gain.setValueAtTime(0.25, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc2.connect(gain2);
    gain2.connect(soundChimeAudioCtx.destination);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.55);

    updateSoundUI();
    return true;
  } catch (e) {
    console.warn('Audio chime warning:', e);
    return false;
  }
}

function sendDesktopNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%238C532B"><circle cx="12" cy="12" r="10"/></svg>'
      });
    } catch (e) {
      console.warn('Notification error:', e);
    }
  }
}

// Immediate Due Alerts Banner Engine
function checkImmediateDueAlerts() {
  const banner = document.getElementById('due-alerts-banner');
  const subtitle = document.getElementById('due-alerts-subtitle');
  const list = document.getElementById('due-alerts-list');
  if (!banner || !list) return;

  const now = Date.now();
  const fortyEightHours = 48 * 60 * 60 * 1000;

  // Filter pending assignments that are overdue, due now, or due soon
  const urgentItems = assignments.filter(a => {
    if (a.completed) return false;
    if (dismissedAlertIds.has(a.id)) return false;
    const dueMs = new Date(a.dueDate).getTime();
    const isOverdue = dueMs <= now;
    const isDueSoon = dueMs > now && dueMs - now <= fortyEightHours;
    return isOverdue || isDueSoon;
  });

  if (urgentItems.length === 0) {
    banner.hidden = true;
    return;
  }

  // Sort: Overdue first, then closest due date
  urgentItems.sort((a, b) => {
    const da = new Date(a.dueDate).getTime();
    const db = new Date(b.dueDate).getTime();
    return da - db;
  });

  banner.hidden = false;
  const overdueCount = urgentItems.filter(a => new Date(a.dueDate).getTime() <= now).length;
  const soonCount = urgentItems.length - overdueCount;

  let subText = '';
  if (overdueCount > 0 && soonCount > 0) {
    subText = `You have ${overdueCount} overdue assignment${overdueCount === 1 ? '' : 's'} and ${soonCount} assignment${soonCount === 1 ? '' : 's'} due within 48 hours.`;
  } else if (overdueCount > 0) {
    subText = `You have ${overdueCount} overdue assignment${overdueCount === 1 ? '' : 's'} requiring immediate attention.`;
  } else {
    subText = `You have ${soonCount} assignment${soonCount === 1 ? '' : 's'} due within 48 hours.`;
  }
  if (subtitle) subtitle.textContent = subText;

  // Check if any items are new to this session for playing sound chime ONCE
  let hasNewAlert = false;
  urgentItems.forEach(item => {
    if (!alertedAssignmentIds.has(item.id)) {
      hasNewAlert = true;
      alertedAssignmentIds.add(item.id);
    }
  });

  if (hasNewAlert && isSoundEnabled) {
    playNotificationChime(false);
  }
  updateSoundUI();

  // Render Alert Items
  list.innerHTML = urgentItems.map(item => {
    const dueInfo = formatDueCountdown(item.dueDate);
    const isOverdue = dueInfo.isOverdue;
    const pillClass = isOverdue ? 'due-alert-pill--overdue' : 'due-alert-pill--soon';
    const pillText = isOverdue ? 'Overdue' : 'Due Soon';

    return `
      <div class="due-alert-item ${isOverdue ? 'is-overdue' : 'is-due-soon'}" role="listitem">
        <div class="due-alert-main">
          <span class="due-alert-pill ${pillClass}">${pillText}</span>
          <div class="due-alert-info">
            <span class="due-alert-title">${escapeHTML(item.title)}</span>
            <span class="due-alert-meta">${escapeHTML(item.subject)} • ${dueInfo.text}</span>
          </div>
        </div>
        <div class="due-alert-actions">
          <button type="button" class="btn btn--primary btn--xs" data-action="open-alert-task" data-id="${item.id}">
            Open Task
          </button>
          <button type="button" class="btn btn--subtle btn--xs" data-action="dismiss-alert-item" data-id="${item.id}" title="Dismiss for current session">
            Dismiss
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function checkDueReminders() {
  if (!currentUser) return;
  try {
    const res = await apiRequest('/api/reminders/due');
    if (res.due && res.due.length > 0) {
      for (const r of res.due) {
        await playNotificationChime(false);
        sendDesktopNotification(`StudyPath Reminder: ${r.title}`, `${r.subject} is due soon!`);
        showToast(`⏰ Deadline Alert: "${r.title}" (${r.subject}) is due soon!`);
        await apiRequest(`/api/reminders/${r.id}/dismiss`, { method: 'POST' });
      }
      await loadRemindersFromBackend();
    }
  } catch (e) {
    // Silent catch during periodic polling
  }
}

function renderRemindersView() {
  checkNotificationPermission();
  const container = document.getElementById('reminders-table-container');
  if (!container) return;

  if (reminders.length === 0) {
    container.innerHTML = `
      <div class="empty-state-card">
        <h3>No Reminders Currently Scheduled</h3>
        <p>Set a deadline reminder when creating or editing an assignment (e.g., 30 minutes, 1 hour, or 1 day before due).</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <table class="reminders-table">
      <thead>
        <tr>
          <th>Assignment</th>
          <th>Subject</th>
          <th>Reminder Scheduled At</th>
          <th>Status</th>
          <th class="text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        ${reminders.map(r => {
          const remDate = new Date(r.remind_at || r.remindAt);
          const dateStr = remDate.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          const isFired = Boolean(r.dismissed);
          return `
            <tr>
              <td><strong>${escapeHTML(r.title || 'Assignment')}</strong></td>
              <td><span class="subject-pill">${escapeHTML(r.subject || 'Coursework')}</span></td>
              <td>${dateStr}</td>
              <td>
                ${isFired 
                  ? '<span class="status-pill status--fired">Triggered</span>' 
                  : '<span class="status-pill status--active">Scheduled</span>'}
              </td>
              <td class="text-right">
                <button type="button" class="btn btn--subtle btn--xs mr-2" data-action="test-reminder-chime" title="Test alert sound">🔔 Test</button>
                <button type="button" class="btn btn--ghost btn--xs text-rose" data-action="delete-reminder" data-id="${r.id}">Delete</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ============================================================================
// 9. ASSIGNMENT & SUBTASK ACTIONS (SYNCED TO BACKEND)
// ============================================================================

async function toggleComplete(id) {
  const item = assignments.find(a => a.id === id);
  if (!item) return;

  const prevStatus = item.completed;
  const newStatus = !prevStatus;

  try {
    const res = await apiRequest(`/api/assignments/${id}/complete`, {
      method: 'PATCH',
      body: { completed: newStatus }
    });

    item.completed = res.assignment.completed;

    executeAction({
      type: 'TOGGLE_COMPLETE',
      id: item.id,
      previousCompleted: prevStatus
    });

    refreshUI();
    checkImmediateDueAlerts();
    const msg = item.completed 
      ? `Completed "${item.title}"! Next in queue updated.` 
      : `Reopened "${item.title}".`;
    showToast(msg, true);
  } catch (err) {
    showToast('Failed to update status: ' + err.message);
  }
}

async function toggleSubtaskComplete(subtaskId, assignmentId) {
  try {
    const res = await apiRequest(`/api/subtasks/${subtaskId}/complete`, {
      method: 'PATCH'
    });

    // Update assignment local state
    const parent = assignments.find(a => a.id === assignmentId);
    if (parent && parent.subtasks) {
      const step = parent.subtasks.find(s => s.id === subtaskId);
      if (step) {
        step.completed = res.subtask.completed;
      }
    }

    refreshUI();
    showToast(res.subtask.completed ? 'Step marked complete!' : 'Step reopened');
  } catch (err) {
    showToast('Failed to update subtask: ' + err.message);
  }
}

async function deleteAssignment(id) {
  const index = assignments.findIndex(a => a.id === id);
  if (index === -1) return;

  const removed = assignments[index];

  try {
    await apiRequest(`/api/assignments/${id}`, { method: 'DELETE' });
    assignments.splice(index, 1);

    executeAction({
      type: 'DELETE',
      item: removed,
      index: index
    });

    refreshUI();
    checkImmediateDueAlerts();
    showToast(`Deleted "${removed.title}"`, true);
  } catch (err) {
    showToast('Failed to delete assignment: ' + err.message);
  }
}

async function clearCompletedAssignments() {
  const completedItems = [];
  assignments.forEach((item, index) => {
    if (item.completed) {
      completedItems.push({ index, data: { ...item } });
    }
  });

  if (completedItems.length === 0) {
    showToast('No completed assignments to clear.');
    return;
  }

  try {
    await apiRequest('/api/assignments/clear-completed', { method: 'POST' });
    assignments = assignments.filter(item => !item.completed);

    executeAction({
      type: 'CLEAR_COMPLETED',
      items: completedItems
    });

    refreshUI();
    showToast(`Cleared ${completedItems.length} completed assignment(s)`, true);
  } catch (err) {
    showToast('Could not clear completed assignments: ' + err.message);
  }
}

async function saveAssignmentFromForm(formData, reminderOption) {
  const isEditing = Boolean(formData.id);

  try {
    let savedAssignment = null;

    if (isEditing) {
      const res = await apiRequest(`/api/assignments/${formData.id}`, {
        method: 'PUT',
        body: formData
      });

      savedAssignment = res.assignment;
      const index = assignments.findIndex(a => a.id === formData.id);
      if (index !== -1) {
        const previousState = { ...assignments[index] };
        assignments[index] = res.assignment;

        executeAction({
          type: 'EDIT',
          id: formData.id,
          previousState: previousState
        });

        showToast(`Updated "${res.assignment.title}"`, true);
      }
    } else {
      const res = await apiRequest('/api/assignments', {
        method: 'POST',
        body: formData
      });

      savedAssignment = res.assignment;
      assignments.unshift(res.assignment);

      executeAction({
        type: 'ADD',
        item: res.assignment
      });

      showToast(`Added "${res.assignment.title}" to queue`, true);
    }

    // Schedule reminder if user selected an option
    if (savedAssignment && reminderOption && reminderOption.remindAt) {
      try {
        await apiRequest('/api/reminders', {
          method: 'POST',
          body: {
            assignmentId: savedAssignment.id,
            remindAt: reminderOption.remindAt
          }
        });
        await loadRemindersFromBackend();
        showToast('Deadline reminder scheduled!');
      } catch (remErr) {
        console.warn('Reminder scheduling error', remErr);
      }
    }

    refreshUI();
    checkImmediateDueAlerts();
    closeAssignmentModal();
  } catch (err) {
    showToast('Failed to save assignment: ' + err.message);
  }
}

// ============================================================================
// 10. MODALS & FORMS (ASSIGNMENTS & RECURRING STUDY SESSIONS)
// ============================================================================

const modalBackdrop = document.getElementById('assignment-modal');
const assignmentForm = document.getElementById('assignment-form');
const howModal = document.getElementById('how-modal');
const sessionModal = document.getElementById('study-session-modal');
const sessionForm = document.getElementById('study-session-form');

function openAssignmentModal(idToEdit = null) {
  if (!modalBackdrop || !assignmentForm) return;

  const modalTitle = document.getElementById('modal-title');
  const submitText = document.getElementById('btn-submit-text');
  const idInput = document.getElementById('form-assignment-id');
  const titleInput = document.getElementById('form-title');
  const subjectInput = document.getElementById('form-subject');
  const priorityInput = document.getElementById('form-priority');
  const dueInput = document.getElementById('form-due-date');
  const hoursInput = document.getElementById('form-est-hours');
  const minsInput = document.getElementById('form-est-mins');
  const durationInput = document.getElementById('form-duration');
  const notesInput = document.getElementById('form-notes');
  const subtasksContainer = document.getElementById('form-subtasks-container');
  const linksContainer = document.getElementById('form-links-container');
  const reminderSelect = document.getElementById('form-reminder-preset');
  const reminderCustom = document.getElementById('form-reminder-custom');

  clearFormErrors();
  if (subtasksContainer) subtasksContainer.innerHTML = '';
  if (linksContainer) linksContainer.innerHTML = '';
  if (reminderSelect) reminderSelect.value = 'none';
  if (reminderCustom) {
    reminderCustom.style.display = 'none';
    reminderCustom.value = '';
  }

  if (idToEdit) {
    const item = assignments.find(a => a.id === idToEdit);
    if (item) {
      modalTitle.textContent = 'Edit Assignment';
      submitText.textContent = 'Save Changes';
      idInput.value = item.id;
      titleInput.value = item.title;
      subjectInput.value = item.subject;
      priorityInput.value = item.priority;
      durationInput.value = item.duration || '1.5 hrs';
      notesInput.value = item.notes || '';

      const estMins = item.estimatedMinutes || item.estimated_minutes || 90;
      if (hoursInput) hoursInput.value = Math.floor(estMins / 60);
      if (minsInput) minsInput.value = estMins % 60;
      updateTimeChipsState(estMins);

      try {
        const d = new Date(item.dueDate);
        const localISO = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        dueInput.value = localISO;
      } catch (e) {
        dueInput.value = '';
      }

      // Populate existing subtasks
      const itemSubtasks = item.subtasks || [];
      itemSubtasks.forEach(st => addSubtaskRow(st));

      // Populate existing links
      const itemLinks = item.links || [];
      itemLinks.forEach(lnk => addLinkRow(lnk));
    }
  } else {
    modalTitle.textContent = 'Add New Assignment';
    submitText.textContent = 'Add to Queue';
    assignmentForm.reset();
    idInput.value = '';

    if (hoursInput) hoursInput.value = 1;
    if (minsInput) minsInput.value = 30;
    if (durationInput) durationInput.value = '1.5 hrs';
    updateTimeChipsState(90);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(17, 0, 0, 0);
    const localISO = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    dueInput.value = localISO;

    // Add 1 blank subtask row for convenience
    addSubtaskRow();
  }

  modalBackdrop.classList.add('is-open');
  modalBackdrop.setAttribute('aria-hidden', 'false');
  document.getElementById('btn-add-assignment')?.setAttribute('aria-expanded', 'true');
  titleInput.focus();
}

function closeAssignmentModal() {
  if (!modalBackdrop) return;
  modalBackdrop.classList.remove('is-open');
  modalBackdrop.setAttribute('aria-hidden', 'true');
  document.getElementById('btn-add-assignment')?.setAttribute('aria-expanded', 'false');
}

function addSubtaskRow(data = null) {
  const container = document.getElementById('form-subtasks-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'subtask-builder-row';
  if (data && data.id) row.setAttribute('data-subtask-id', data.id);

  const titleVal = data ? escapeHTML(data.title) : '';
  const dateVal = data && (data.dueDate || data.due_date) ? escapeHTML(data.dueDate || data.due_date) : '';
  const isDone = data && data.completed ? 'checked' : '';

  row.innerHTML = `
    <input type="checkbox" class="subtask-complete-check" ${isDone} title="Mark completed" aria-label="Step completed">
    <input type="text" class="form-input subtask-title-input" placeholder="Step description (e.g., Read chapter 4)" value="${titleVal}" required>
    <input type="date" class="form-input subtask-date-input" value="${dateVal}" title="Optional milestone due date" aria-label="Milestone due date">
    <button type="button" class="btn-remove-row" aria-label="Remove step">&times;</button>
  `;

  row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addLinkRow(data = null) {
  const container = document.getElementById('form-links-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'link-builder-row';

  const titleVal = data ? escapeHTML(data.title || '') : '';
  const urlVal = data ? escapeHTML(data.url || '') : '';

  row.innerHTML = `
    <input type="text" class="form-input link-title-input" placeholder="Title (e.g., Canvas Rubric)" value="${titleVal}">
    <input type="url" class="form-input link-url-input" placeholder="https://..." value="${urlVal}" required>
    <button type="button" class="btn-remove-row" aria-label="Remove link">&times;</button>
  `;

  row.querySelector('.btn-remove-row')?.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function updateTimeChipsState(targetMins) {
  document.querySelectorAll('.time-chips-preset .btn-time-preset').forEach(chip => {
    const chipMins = Number(chip.getAttribute('data-mins'));
    chip.classList.toggle('is-active', chipMins === targetMins);
  });
}

function openHowModal() {
  if (!howModal) return;
  howModal.classList.add('is-open');
  howModal.setAttribute('aria-hidden', 'false');
  document.getElementById('btn-how-it-works')?.setAttribute('aria-expanded', 'true');
  document.getElementById('btn-how-close')?.focus();
}

function closeHowModal() {
  if (!howModal) return;
  howModal.classList.remove('is-open');
  howModal.setAttribute('aria-hidden', 'true');
  document.getElementById('btn-how-it-works')?.setAttribute('aria-expanded', 'false');
}

function clearFormErrors() {
  document.getElementById('title-error').textContent = '';
  document.getElementById('subject-error').textContent = '';
  document.getElementById('date-error').textContent = '';
}

function validateAssignmentForm() {
  clearFormErrors();
  let isValid = true;

  const title = document.getElementById('form-title').value.trim();
  const subject = document.getElementById('form-subject').value.trim();
  const dueDate = document.getElementById('form-due-date').value;

  if (!title) {
    document.getElementById('title-error').textContent = 'Please enter an assignment title.';
    isValid = false;
  }

  if (!subject) {
    document.getElementById('subject-error').textContent = 'Please specify a course or subject.';
    isValid = false;
  }

  if (!dueDate) {
    document.getElementById('date-error').textContent = 'Please choose a due date and time.';
    isValid = false;
  }

  return isValid;
}

// ============================================================================
// 10B. RECURRING STUDY SESSION MODAL & HANDLERS
// ============================================================================

function openStudySessionModal(idToEdit = null) {
  if (!sessionModal || !sessionForm) return;

  const titleEl = document.getElementById('session-modal-title');
  const idInput = document.getElementById('form-session-id');
  const subjectInput = document.getElementById('session-subject');
  const daySelect = document.getElementById('session-day');
  const startInput = document.getElementById('session-start');
  const durationInput = document.getElementById('session-duration');
  const notesInput = document.getElementById('session-notes');

  document.getElementById('session-subject-error').textContent = '';
  document.getElementById('session-time-error').textContent = '';

  if (idToEdit) {
    const s = studySessions.find(item => item.id === idToEdit);
    if (s) {
      titleEl.textContent = 'Edit Recurring Study Block';
      idInput.value = s.id;
      subjectInput.value = s.subject;
      daySelect.value = s.dayOfWeek !== undefined ? s.dayOfWeek : s.day_of_week;
      startInput.value = s.startTime || s.start_time;
      durationInput.value = s.durationMinutes || s.duration_minutes || 60;
      notesInput.value = s.notes || '';
      updateSessionChips(durationInput.value);
    }
  } else {
    titleEl.textContent = 'Schedule Recurring Study Block';
    sessionForm.reset();
    idInput.value = '';
    durationInput.value = 60;
    startInput.value = '16:00';
    updateSessionChips(60);
  }

  sessionModal.classList.add('is-open');
  sessionModal.setAttribute('aria-hidden', 'false');
  subjectInput.focus();
}

function closeStudySessionModal() {
  if (!sessionModal) return;
  sessionModal.classList.remove('is-open');
  sessionModal.setAttribute('aria-hidden', 'true');
}

function updateSessionChips(targetMins) {
  document.querySelectorAll('#session-time-chips .btn-time-preset').forEach(chip => {
    const mins = Number(chip.getAttribute('data-mins'));
    chip.classList.toggle('is-active', mins === Number(targetMins));
  });
}

async function saveStudySessionFromForm(formData) {
  try {
    if (formData.id) {
      await apiRequest(`/api/study-sessions/${formData.id}`, {
        method: 'PUT',
        body: formData
      });
      showToast('Updated recurring study block!');
    } else {
      await apiRequest('/api/study-sessions', {
        method: 'POST',
        body: formData
      });
      showToast('Scheduled recurring study block!');
    }

    closeStudySessionModal();
    await loadStudySessionsFromBackend();
  } catch (err) {
    showToast('Failed to save study block: ' + err.message);
  }
}

async function deleteStudySession(id) {
  try {
    await apiRequest(`/api/study-sessions/${id}`, { method: 'DELETE' });
    showToast('Deleted study block.');
    await loadStudySessionsFromBackend();
  } catch (err) {
    showToast('Failed to delete study block: ' + err.message);
  }
}

// ============================================================================
// 11. AUTHENTICATION UI EVENT HANDLERS
// ============================================================================

function setAuthAlert(message, type = 'error') {
  const alertEl = document.getElementById('auth-alert');
  if (!alertEl) return;
  if (!message) {
    alertEl.hidden = true;
    alertEl.textContent = '';
    alertEl.className = 'auth-alert';
    return;
  }
  alertEl.hidden = false;
  alertEl.className = `auth-alert is-${type}`;
  alertEl.textContent = message;
}

function initAuthHandlers() {
  const tabLogin = document.getElementById('auth-tab-login');
  const tabSignup = document.getElementById('auth-tab-signup');
  const tabForgot = document.getElementById('auth-tab-forgot');

  const panelLogin = document.getElementById('auth-panel-login');
  const panelSignup = document.getElementById('auth-panel-signup');
  const panelForgot = document.getElementById('auth-panel-forgot');

  const switchTab = (activeTab, activePanel) => {
    [tabLogin, tabSignup, tabForgot].forEach(tab => {
      const isSel = tab === activeTab;
      tab.classList.toggle('is-active', isSel);
      tab.setAttribute('aria-selected', isSel ? 'true' : 'false');
    });

    [panelLogin, panelSignup, panelForgot].forEach(panel => {
      panel.hidden = panel !== activePanel;
    });

    setAuthAlert('');
  };

  tabLogin?.addEventListener('click', () => switchTab(tabLogin, panelLogin));
  tabSignup?.addEventListener('click', () => switchTab(tabSignup, panelSignup));
  tabForgot?.addEventListener('click', () => switchTab(tabForgot, panelForgot));

  // Login Form
  const formLogin = document.getElementById('form-login');
  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthAlert('');

    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    const emailErr = document.getElementById('login-email-err');
    const passErr = document.getElementById('login-password-err');

    emailErr.textContent = '';
    passErr.textContent = '';

    const email = emailEl.value.trim();
    const password = passEl.value;
    const rememberMe = document.getElementById('login-remember')?.checked ?? true;

    let valid = true;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailErr.textContent = 'Please provide a valid university email address.';
      valid = false;
    }
    if (!password) {
      passErr.textContent = 'Please enter your password.';
      valid = false;
    }

    if (!valid) return;

    const btnSubmit = document.getElementById('btn-submit-login');
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Verifying Credentials...';

    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password, rememberMe }
      });

      passEl.value = '';
      currentUser = data.user;

      let savedRedirect = null;
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        try {
          savedRedirect = sessionStorage.getItem('studypath_redirect_after_login');
          sessionStorage.removeItem('studypath_redirect_after_login');
        } catch (e) {}
      }
      const target = redirectAfterLogin || savedRedirect || 'queue';
      redirectAfterLogin = null;

      showAppView(target);
      await loadAllUserData();
      showToast(`Welcome back, ${currentUser.name}!`);
    } catch (err) {
      setAuthAlert(err.message, 'error');
      passEl.value = '';
      passEl.focus();
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Sign In to Your Planner';
    }
  });

  // Intercept protected page navigation & login redirection
  window.addEventListener('hashchange', () => {
    const rawHash = (typeof window !== 'undefined' && window.location?.hash)
      ? window.location.hash.replace(/^#\/?/, '').toLowerCase()
      : '';
    const validViews = ['queue', 'calendar', 'workload', 'sessions', 'reminders'];

    if (currentUser) {
      if (rawHash === 'login' || rawHash === 'auth' || rawHash === 'signup') {
        // Authenticated user opening the login page: take them straight to the planner!
        showAppView('queue');
        return;
      }
      if (validViews.includes(rawHash)) {
        switchView(rawHash);
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      }
    } else {
      if (validViews.includes(rawHash)) {
        redirectAfterLogin = rawHash;
        if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
          try {
            sessionStorage.setItem('studypath_redirect_after_login', rawHash);
          } catch (e) {}
        }
        showAuthView();
        setAuthAlert('Please sign in to access your student planner.', 'info');
      }
    }
  });

  // Sign Up Form
  const formSignup = document.getElementById('form-signup');
  formSignup?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthAlert('');

    const nameEl = document.getElementById('signup-name');
    const emailEl = document.getElementById('signup-email');
    const passEl = document.getElementById('signup-password');
    const confirmEl = document.getElementById('signup-confirm-password');
    const majorEl = document.getElementById('signup-major');

    const nameErr = document.getElementById('signup-name-err');
    const emailErr = document.getElementById('signup-email-err');
    const passErr = document.getElementById('signup-password-err');
    const confirmErr = document.getElementById('signup-confirm-err');

    nameErr.textContent = '';
    emailErr.textContent = '';
    passErr.textContent = '';
    confirmErr.textContent = '';

    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    const password = passEl.value;
    const confirm = confirmEl.value;
    const major = majorEl.value.trim();

    let valid = true;
    if (!name) {
      nameErr.textContent = 'Please enter your full name.';
      valid = false;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailErr.textContent = 'Please provide a valid university email address.';
      valid = false;
    }
    if (!password || password.length < 8) {
      passErr.textContent = 'Password must be at least 8 characters.';
      valid = false;
    }
    if (password !== confirm) {
      confirmErr.textContent = 'Passwords do not match.';
      valid = false;
    }

    if (!valid) return;

    const btnSubmit = document.getElementById('btn-submit-signup');
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Creating Account...';

    try {
      const data = await apiRequest('/api/auth/signup', {
        method: 'POST',
        body: { name, email, password, major }
      });

      passEl.value = '';
      confirmEl.value = '';
      currentUser = data.user;
      showAppView();
      await loadAllUserData();
      showToast(`Account created! Welcome, ${currentUser.name}.`);
    } catch (err) {
      setAuthAlert(err.message, 'error');
      passEl.value = '';
      confirmEl.value = '';
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Create Your Account';
    }
  });

  // Forgot Password
  const formForgotReq = document.getElementById('form-forgot-request');
  formForgotReq?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthAlert('');

    const emailEl = document.getElementById('forgot-email');
    const emailErr = document.getElementById('forgot-email-err');
    emailErr.textContent = '';

    const email = emailEl.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailErr.textContent = 'Please provide a valid email address.';
      return;
    }

    const btnSubmit = document.getElementById('btn-submit-forgot');
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Generating...';

    try {
      const data = await apiRequest('/api/auth/forgot-password', {
        method: 'POST',
        body: { email }
      });

      setAuthAlert(data.message, 'success');

      if (data.resetToken) {
        document.getElementById('form-forgot-request').hidden = true;
        const confirmForm = document.getElementById('form-reset-confirm');
        confirmForm.hidden = false;
        document.getElementById('reset-token').value = data.resetToken;
        document.getElementById('reset-new-password')?.focus();
      }
    } catch (err) {
      setAuthAlert(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Generate Reset Token';
    }
  });

  const formResetConfirm = document.getElementById('form-reset-confirm');
  formResetConfirm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthAlert('');

    const tokenEl = document.getElementById('reset-token');
    const newPassEl = document.getElementById('reset-new-password');
    const tokenErr = document.getElementById('reset-token-err');
    const newPassErr = document.getElementById('reset-new-pass-err');

    tokenErr.textContent = '';
    newPassErr.textContent = '';

    const token = tokenEl.value.trim();
    const newPassword = newPassEl.value;

    let valid = true;
    if (!token) {
      tokenErr.textContent = 'Reset token required.';
      valid = false;
    }
    if (!newPassword || newPassword.length < 8) {
      newPassErr.textContent = 'Password must be at least 8 characters.';
      valid = false;
    }

    if (!valid) return;

    const btnSubmit = document.getElementById('btn-submit-reset-confirm');
    btnSubmit.disabled = true;
    btnSubmit.textContent = 'Updating Password...';

    try {
      const data = await apiRequest('/api/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword }
      });

      newPassEl.value = '';
      tokenEl.value = '';

      switchTab(tabLogin, panelLogin);
      setAuthAlert(data.message, 'success');
      document.getElementById('login-password')?.focus();
    } catch (err) {
      setAuthAlert(err.message, 'error');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Update Password & Return to Login';
    }
  });
}

// ============================================================================
// 12. 3D RESTRAINED CARD MOTION & MICRO-INTERACTIONS
// ============================================================================

function attach3DTilt() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  const cards = document.querySelectorAll('.tilt-card');
  cards.forEach(card => {
    if (card._hasTiltListener) return;
    card._hasTiltListener = true;

    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((centerY - y) / centerY) * 3.5;
      const rotateY = ((x - centerX) / centerX) * 3.5;

      card.style.transform = `perspective(800px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-2px)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
}

// ============================================================================
// 13. UTILITIES, COUNTDOWN LOGIC & TOAST SYSTEM
// ============================================================================

function showToast(message, showUndoOption = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');

  let html = `<span>${escapeHTML(message)}</span>`;
  if (showUndoOption && !undoStack.isEmpty()) {
    html += `<button class="toast-action-btn" aria-label="Undo this change">Undo</button>`;
  }
  toast.innerHTML = html;

  if (showUndoOption && !undoStack.isEmpty()) {
    const undoBtn = toast.querySelector('.toast-action-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        performUndo();
        toast.remove();
      });
    }
  }

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast--closing');
    setTimeout(() => toast.remove(), 220);
  }, 4200);
}

function announceToScreenReader(message) {
  const announcer = document.getElementById('sr-announcements');
  if (announcer) {
    announcer.textContent = message;
  }
}

/**
 * Exact Countdown String Calculator:
 * Floor minutes remaining, shows hours & minutes when >= 60m, minutes when < 60m, 'Overdue' when past due.
 */
function getCountdownString(diffMs) {
  if (diffMs <= 0) {
    return 'Overdue';
  }
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 60) {
    return `${Math.max(0, totalMinutes)}m left`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m left`;
}

function formatDueCountdown(dueDateStr) {
  if (!dueDateStr) {
    return { 
      text: 'No due date', 
      countdown: '', 
      isOverdue: false, 
      isDueSoon: false 
    };
  }

  const due = new Date(dueDateStr);
  if (isNaN(due.getTime())) {
    return { 
      text: 'Invalid date', 
      countdown: '', 
      isOverdue: false, 
      isDueSoon: false 
    };
  }

  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  const isOverdue = diffMs <= 0;
  const isDueSoon = !isOverdue && diffMs <= 48 * 60 * 60 * 1000;
  const countdown = getCountdownString(diffMs);

  if (isOverdue) {
    return { 
      text: 'Overdue', 
      countdown: 'Overdue', 
      isOverdue: true, 
      isDueSoon: false 
    };
  }

  const timeStr = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const nowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDate = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const msPerDay = 86400000;
  const dayDiff = Math.round((dueDate.getTime() - nowDate.getTime()) / msPerDay);

  if (dayDiff === 0) {
    return { 
      text: `Today at ${timeStr} (${countdown})`, 
      countdown, 
      isOverdue: false, 
      isDueSoon: true 
    };
  }

  if (dayDiff === 1) {
    return { 
      text: `Tomorrow at ${timeStr} (${countdown})`, 
      countdown, 
      isOverdue: false, 
      isDueSoon: true 
    };
  }

  if (diffMs <= 48 * 60 * 60 * 1000) {
    return { 
      text: `In ~2 days (${timeStr})`, 
      countdown, 
      isOverdue: false, 
      isDueSoon: true 
    };
  }

  const formattedDate = due.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return { 
    text: `${formattedDate} • ${timeStr}`, 
    countdown, 
    isOverdue: false, 
    isDueSoon: false 
  };
}

let countdownInterval = null;

function updateCountdownDisplays() {
  if (!currentUser) return;
  updateTodayDateDisplay();
  renderSpotlightCard();
  renderAssignmentList();
  updateMetricCounts();
  checkImmediateDueAlerts();
  checkDueReminders();
}

function startCountdownTimer() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  // Runs every 30 seconds (at least once per minute)
  countdownInterval = setInterval(() => {
    if (document.visibilityState === 'visible') {
      updateCountdownDisplays();
    }
  }, 30000);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMins(mins) {
  const m = Number(mins) || 60;
  if (m < 60) return `${m} mins`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hrs` : `${h}h ${rem}m`;
}

function updateTodayDateDisplay() {
  const liveDateEl = document.getElementById('live-date');
  if (liveDateEl) {
    const options = { weekday: 'long', month: 'short', day: 'numeric' };
    liveDateEl.textContent = `Today: ${new Date().toLocaleDateString(undefined, options)}`;
  }
}

// ============================================================================
// 14. EVENT LISTENERS INITIALIZATION
// ============================================================================

function initEventListeners() {
  // Undo & Redo buttons
  document.getElementById('btn-undo')?.addEventListener('click', performUndo);
  document.getElementById('btn-redo')?.addEventListener('click', performRedo);

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (!isInputFocused && currentUser) {
        e.preventDefault();
        performUndo();
      }
    }

    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
      if (!isInputFocused && currentUser) {
        e.preventDefault();
        performRedo();
      }
    }

    if (e.key === '/' && !isInputFocused && currentUser) {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      searchInput?.focus();
      searchInput?.select();
    }

    if (e.key === 'Escape') {
      if (modalBackdrop?.classList.contains('is-open')) closeAssignmentModal();
      if (sessionModal?.classList.contains('is-open')) closeStudySessionModal();
      if (howModal?.classList.contains('is-open')) closeHowModal();
    }
  });

  // Modal open/close
  document.getElementById('btn-add-assignment')?.addEventListener('click', () => openAssignmentModal());
  document.getElementById('btn-modal-close')?.addEventListener('click', closeAssignmentModal);
  document.getElementById('btn-modal-cancel')?.addEventListener('click', closeAssignmentModal);

  document.getElementById('btn-how-it-works')?.addEventListener('click', openHowModal);
  document.getElementById('btn-how-close')?.addEventListener('click', closeHowModal);
  document.getElementById('btn-how-done')?.addEventListener('click', closeHowModal);

  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

  modalBackdrop?.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeAssignmentModal();
  });
  sessionModal?.addEventListener('click', (e) => {
    if (e.target === sessionModal) closeStudySessionModal();
  });
  howModal?.addEventListener('click', (e) => {
    if (e.target === howModal) closeHowModal();
  });

  // Navigation View Tabs
  document.querySelectorAll('.view-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      if (view) switchView(view);
    });
  });

  // Sound Controls
  const toggleSound = async () => {
    if (isSoundEnabled && soundChimeAudioCtx && soundChimeAudioCtx.state === 'running') {
      // Toggle off
      isSoundEnabled = false;
      if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        try {
          localStorage.setItem('studypath_sound_enabled', 'false');
        } catch (e) {}
      }
      updateSoundUI();
      showToast('Audio chime muted.');
    } else {
      // Toggle on / unlock
      isSoundEnabled = true;
      if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
        try {
          localStorage.setItem('studypath_sound_enabled', 'true');
        } catch (e) {}
      }
      const played = await playNotificationChime(true);
      updateSoundUI();
      if (played) {
        showToast('🔔 Audio chime enabled and test tone played!');
      } else {
        showToast('Click anywhere on the planner to enable browser audio.');
      }
    }
  };

  document.getElementById('btn-sound-toggle')?.addEventListener('click', toggleSound);
  document.getElementById('btn-enable-sound-banner')?.addEventListener('click', toggleSound);

  // Due Alerts Banner controls
  document.getElementById('btn-dismiss-all-alerts')?.addEventListener('click', () => {
    assignments.forEach(a => dismissedAlertIds.add(a.id));
    const banner = document.getElementById('due-alerts-banner');
    if (banner) banner.hidden = true;
    showToast('All due alerts dismissed for this session.');
  });

  document.getElementById('due-alerts-list')?.addEventListener('click', (e) => {
    const openBtn = e.target.closest('[data-action="open-alert-task"]');
    if (openBtn) {
      const id = openBtn.getAttribute('data-id');
      if (id) openAssignmentModal(id);
      return;
    }

    const dismissBtn = e.target.closest('[data-action="dismiss-alert-item"]');
    if (dismissBtn) {
      const id = dismissBtn.getAttribute('data-id');
      if (id) {
        dismissedAlertIds.add(id);
        checkImmediateDueAlerts();
      }
      return;
    }
  });

  // Assignment Modal: Time estimate chips & inputs
  document.querySelectorAll('.time-chips-preset .btn-time-preset').forEach(chip => {
    chip.addEventListener('click', () => {
      const mins = Number(chip.getAttribute('data-mins'));
      const hrsInput = document.getElementById('form-est-hours');
      const minsInput = document.getElementById('form-est-mins');
      const durInput = document.getElementById('form-duration');
      if (hrsInput) hrsInput.value = Math.floor(mins / 60);
      if (minsInput) minsInput.value = mins % 60;
      if (durInput) durInput.value = formatMins(mins);
      updateTimeChipsState(mins);
    });
  });

  const syncDurationInputs = () => {
    const hrs = parseInt(document.getElementById('form-est-hours')?.value, 10) || 0;
    const mins = parseInt(document.getElementById('form-est-mins')?.value, 10) || 0;
    const total = hrs * 60 + mins;
    const durInput = document.getElementById('form-duration');
    if (durInput) durInput.value = formatMins(total);
    updateTimeChipsState(total);
  };
  document.getElementById('form-est-hours')?.addEventListener('input', syncDurationInputs);
  document.getElementById('form-est-mins')?.addEventListener('input', syncDurationInputs);

  // Subtasks & Links Builder in Assignment Modal
  document.getElementById('btn-add-subtask-step')?.addEventListener('click', () => addSubtaskRow());
  document.getElementById('btn-add-link-item')?.addEventListener('click', () => addLinkRow());

  // Reminder Select Dropdown in Assignment Modal
  document.getElementById('form-reminder-preset')?.addEventListener('change', (e) => {
    const customInput = document.getElementById('form-reminder-custom');
    if (customInput) {
      customInput.style.display = e.target.value === 'custom' ? 'block' : 'none';
      if (e.target.value === 'custom') customInput.focus();
    }
  });

  // Assignment Modal Form submit
  assignmentForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validateAssignmentForm()) return;

    // Collect Subtasks
    const subtaskRows = document.querySelectorAll('.subtask-builder-row');
    const subtasks = [];
    subtaskRows.forEach(row => {
      const title = row.querySelector('.subtask-title-input')?.value.trim();
      if (title) {
        const id = row.getAttribute('data-subtask-id') || null;
        const completed = row.querySelector('.subtask-complete-check')?.checked || false;
        const dueDate = row.querySelector('.subtask-date-input')?.value || null;
        subtasks.push({ id, title, completed, dueDate });
      }
    });

    // Collect Links
    const linkRows = document.querySelectorAll('.link-builder-row');
    const links = [];
    linkRows.forEach(row => {
      let url = row.querySelector('.link-url-input')?.value.trim();
      const title = row.querySelector('.link-title-input')?.value.trim();
      if (url) {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        links.push({ title: title || url, url });
      }
    });

    const hrs = parseInt(document.getElementById('form-est-hours')?.value, 10) || 0;
    const mins = parseInt(document.getElementById('form-est-mins')?.value, 10) || 0;
    const estimatedMinutes = Math.max(15, hrs * 60 + mins);
    const duration = formatMins(estimatedMinutes);

    const dueDateISO = new Date(document.getElementById('form-due-date').value).toISOString();

    const formData = {
      id: document.getElementById('form-assignment-id').value || null,
      title: document.getElementById('form-title').value.trim(),
      subject: document.getElementById('form-subject').value.trim(),
      dueDate: dueDateISO,
      priority: document.getElementById('form-priority').value,
      duration: duration,
      estimatedMinutes: estimatedMinutes,
      notes: document.getElementById('form-notes').value.trim(),
      subtasks: subtasks,
      links: links
    };

    // Calculate reminder time if set
    let reminderOption = null;
    const reminderPreset = document.getElementById('form-reminder-preset')?.value;
    if (reminderPreset && reminderPreset !== 'none') {
      const dueTime = new Date(dueDateISO).getTime();
      let remindAt = null;

      if (reminderPreset === 'custom') {
        const customVal = document.getElementById('form-reminder-custom')?.value;
        if (customVal) remindAt = new Date(customVal).toISOString();
      } else {
        const offsetMins = Number(reminderPreset);
        remindAt = new Date(dueTime - offsetMins * 60000).toISOString();
      }

      if (remindAt) {
        reminderOption = { remindAt };
      }
    }

    saveAssignmentFromForm(formData, reminderOption);
  });

  // Study Session Controls
  document.getElementById('btn-create-session-view')?.addEventListener('click', () => openStudySessionModal());
  document.getElementById('btn-cal-add-session')?.addEventListener('click', () => openStudySessionModal());
  document.getElementById('btn-cal-add-task')?.addEventListener('click', () => openAssignmentModal());
  document.getElementById('btn-session-modal-close')?.addEventListener('click', closeStudySessionModal);
  document.getElementById('btn-session-cancel')?.addEventListener('click', closeStudySessionModal);

  document.querySelectorAll('#session-time-chips .btn-time-preset').forEach(chip => {
    chip.addEventListener('click', () => {
      const mins = chip.getAttribute('data-mins');
      const input = document.getElementById('session-duration');
      if (input) input.value = mins;
      updateSessionChips(mins);
    });
  });

  sessionForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const subject = document.getElementById('session-subject').value.trim();
    const day = document.getElementById('session-day').value;
    const start = document.getElementById('session-start').value;
    const duration = parseInt(document.getElementById('session-duration').value, 10) || 60;
    const notes = document.getElementById('session-notes').value.trim();

    if (!subject) {
      document.getElementById('session-subject-error').textContent = 'Please specify a course.';
      return;
    }

    const formData = {
      id: document.getElementById('form-session-id').value || null,
      subject,
      dayOfWeek: parseInt(day, 10),
      startTime: start,
      durationMinutes: duration,
      notes
    };

    saveStudySessionFromForm(formData);
  });

  // Calendar Controls - exact matching IDs from index.html
  document.getElementById('btn-cal-prev')?.addEventListener('click', () => {
    if (calendarViewMode === 'week') {
      calendarDate.setDate(calendarDate.getDate() - 7);
    } else {
      calendarDate.setDate(calendarDate.getDate() - 1);
    }
    renderCalendarView();
  });

  document.getElementById('btn-cal-next')?.addEventListener('click', () => {
    if (calendarViewMode === 'week') {
      calendarDate.setDate(calendarDate.getDate() + 7);
    } else {
      calendarDate.setDate(calendarDate.getDate() + 1);
    }
    renderCalendarView();
  });

  document.getElementById('btn-cal-today')?.addEventListener('click', () => {
    calendarDate = new Date();
    renderCalendarView();
  });

  document.getElementById('btn-view-week')?.addEventListener('click', () => {
    calendarViewMode = 'week';
    renderCalendarView();
  });

  document.getElementById('btn-view-day')?.addEventListener('click', () => {
    calendarViewMode = 'day';
    renderCalendarView();
  });

  // Delegate Calendar item click-to-edit
  const calGrid = document.getElementById('calendar-body');
  calGrid?.addEventListener('click', (e) => {
    const sessionTarget = e.target.closest('[data-action="edit-session"]');
    if (sessionTarget) {
      const sessionId = sessionTarget.getAttribute('data-session-id');
      if (sessionId) openStudySessionModal(sessionId);
      return;
    }

    const assignmentTarget = e.target.closest('[data-action="edit-assignment"]');
    if (assignmentTarget) {
      const id = assignmentTarget.getAttribute('data-id');
      if (id) openAssignmentModal(id);
      return;
    }
  });

  // Reminders Controls: Request notifications & table actions
  document.getElementById('btn-enable-notifications')?.addEventListener('click', requestNotificationPermission);
  document.getElementById('btn-test-chime')?.addEventListener('click', async () => {
    const played = await playNotificationChime(true);
    sendDesktopNotification('StudyPath Test Alert', 'Audio chime and desktop notification verified!');
    if (played) {
      showToast('🔔 Chime played and alert verified!');
    } else {
      showToast('Sound enabled! Click again to play test tone.');
    }
  });

  const remindersTableWrap = document.getElementById('reminders-table-container');
  remindersTableWrap?.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-action="delete-reminder"]');
    if (deleteBtn) {
      const id = deleteBtn.getAttribute('data-id');
      try {
        await apiRequest(`/api/reminders/${id}`, { method: 'DELETE' });
        showToast('Reminder deleted.');
        await loadRemindersFromBackend();
      } catch (err) {
        showToast('Failed to delete reminder: ' + err.message);
      }
      return;
    }

    const testBtn = e.target.closest('[data-action="test-reminder-chime"]');
    if (testBtn) {
      await playNotificationChime(true);
      sendDesktopNotification('StudyPath Test Alert', 'Audio chime and desktop notification verified!');
      showToast('🔔 Chime played and desktop notification sent!');
      return;
    }
  });

  // Study Sessions List Action delegation
  const sessionsContainer = document.getElementById('sessions-container');
  sessionsContainer?.addEventListener('click', (e) => {
    const newBtn = e.target.closest('[data-action="new-session"]');
    if (newBtn) {
      openStudySessionModal();
      return;
    }

    const editBtn = e.target.closest('[data-action="edit-session"]');
    if (editBtn) {
      const id = editBtn.getAttribute('data-session-id');
      if (id) openStudySessionModal(id);
      return;
    }

    const deleteBtn = e.target.closest('[data-action="delete-session"]');
    if (deleteBtn) {
      const id = deleteBtn.getAttribute('data-session-id');
      if (id) deleteStudySession(id);
      return;
    }
  });

  // Search input live filtering
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('btn-clear-search');

  searchInput?.addEventListener('input', (e) => {
    currentSearchQuery = e.target.value;
    if (clearSearchBtn) {
      clearSearchBtn.hidden = !currentSearchQuery;
    }
    renderAssignmentList();
  });

  clearSearchBtn?.addEventListener('click', () => {
    if (searchInput) {
      searchInput.value = '';
      currentSearchQuery = '';
      clearSearchBtn.hidden = true;
      searchInput.focus();
      renderAssignmentList();
    }
  });

  // Filter dropdowns
  document.getElementById('filter-status')?.addEventListener('change', (e) => {
    currentFilterStatus = e.target.value;
    renderAssignmentList();
  });

  document.getElementById('filter-priority')?.addEventListener('change', (e) => {
    currentFilterPriority = e.target.value;
    renderAssignmentList();
  });

  document.getElementById('filter-subject')?.addEventListener('change', (e) => {
    currentFilterSubject = e.target.value;
    renderAssignmentList();
  });

  // Sort dropdown
  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    currentSort = e.target.value;
    renderAssignmentList();
  });

  // Reset filters
  const resetFilters = () => {
    currentFilterStatus = 'all';
    currentFilterPriority = 'all';
    currentFilterSubject = 'all';
    currentSearchQuery = '';
    currentSort = 'queue-smart';

    const statusSel = document.getElementById('filter-status');
    const prioritySel = document.getElementById('filter-priority');
    const subjectSel = document.getElementById('filter-subject');
    const sortSel = document.getElementById('sort-select');

    if (statusSel) statusSel.value = 'all';
    if (prioritySel) prioritySel.value = 'all';
    if (subjectSel) subjectSel.value = 'all';
    if (sortSel) sortSel.value = 'queue-smart';
    if (searchInput) searchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.hidden = true;

    renderAssignmentList();
    showToast('Filters reset to show all items');
  };

  document.getElementById('btn-reset-filters')?.addEventListener('click', resetFilters);
  document.getElementById('btn-empty-reset')?.addEventListener('click', resetFilters);
  document.getElementById('btn-empty-add')?.addEventListener('click', () => openAssignmentModal());

  // Interactive Metric Cards
  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const filterKey = card.getAttribute('data-filter-status');
      if (filterKey) {
        currentFilterStatus = filterKey;
        const statusSelect = document.getElementById('filter-status');
        if (statusSelect) statusSelect.value = filterKey;
        switchView('queue');
        renderAssignmentList();
        showToast(`Filtered queue by: ${card.querySelector('.stat-label')?.textContent}`);
      }
    });
  });

  // Clear completed assignments
  document.getElementById('btn-clear-completed')?.addEventListener('click', clearCompletedAssignments);

  // Delegate queue list actions
  const queueContainer = document.getElementById('queue-container');
  queueContainer?.addEventListener('click', (e) => {
    // 1. Expand / collapse subtasks
    const toggleSubtasksBtn = e.target.closest('[data-action="toggle-expand-subtasks"]');
    if (toggleSubtasksBtn) {
      const id = toggleSubtasksBtn.getAttribute('data-id');
      if (expandedSubtasksAssignmentIds.has(id)) {
        expandedSubtasksAssignmentIds.delete(id);
      } else {
        expandedSubtasksAssignmentIds.add(id);
      }
      renderAssignmentList();
      return;
    }

    // 2. Toggle subtask step checkbox
    const subtaskCheck = e.target.closest('[data-action="toggle-step-check"]');
    if (subtaskCheck) {
      const stepId = subtaskCheck.getAttribute('data-step-id');
      const assignmentId = subtaskCheck.getAttribute('data-assignment-id');
      if (stepId && assignmentId) {
        toggleSubtaskComplete(stepId, assignmentId);
      }
      return;
    }

    // 3. Assignment item action buttons
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-id');

    if (action === 'toggle') {
      toggleComplete(id);
    } else if (action === 'edit') {
      openAssignmentModal(id);
    } else if (action === 'delete') {
      deleteAssignment(id);
    }
  });

  // Insights View subtask checklist delegation
  document.getElementById('milestones-tracker-list')?.addEventListener('click', (e) => {
    const subtaskCheck = e.target.closest('[data-action="toggle-step-check"]');
    if (subtaskCheck) {
      const stepId = subtaskCheck.getAttribute('data-step-id');
      const assignmentId = subtaskCheck.getAttribute('data-assignment-id');
      if (stepId && assignmentId) {
        toggleSubtaskComplete(stepId, assignmentId);
      }
    }
  });

  // Automatic countdown updates when tab becomes visible or focused
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateCountdownDisplays();
    }
  });

  window.addEventListener('focus', () => {
    updateCountdownDisplays();
  });

  // Auth form handlers
  initAuthHandlers();
}

// ============================================================================
// 15. PROGRESSIVE WEB APP (PWA) & OFFLINE RESILIENCE
// ============================================================================

let deferredInstallPrompt = null;

function isAppInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://');
}

function initPwaHandlers() {
  const installBtn = document.getElementById('btn-install-app');
  const installModal = document.getElementById('install-modal');
  const closeInstallModalBtn = document.getElementById('btn-close-install-modal');
  const dismissInstallModalBtn = document.getElementById('btn-dismiss-install-modal');
  const offlineBanner = document.getElementById('offline-banner');
  const retryConnectionBtn = document.getElementById('btn-retry-connection');
  const swUpdateBanner = document.getElementById('sw-update-banner');
  const btnSwRefresh = document.getElementById('btn-sw-refresh');
  const btnSwDismiss = document.getElementById('btn-sw-dismiss');

  const isStandalone = isAppInStandaloneMode();

  // 1. Initial Offline Check & Sync Listeners
  updateOfflineStatus();

  window.addEventListener('online', () => {
    updateOfflineStatus();
    showToast('🌐 Internet connection restored. Re-syncing with server...', 'success');
    if (currentUser) {
      loadAllUserData();
    } else {
      checkAuthSession();
    }
  });

  window.addEventListener('offline', () => {
    updateOfflineStatus();
    showToast('⚠️ Network connection lost. Working in offline read mode.', 'warning');
  });

  if (retryConnectionBtn) {
    retryConnectionBtn.addEventListener('click', async () => {
      retryConnectionBtn.disabled = true;
      retryConnectionBtn.textContent = 'Checking...';
      try {
        const ping = await fetch('/api/auth/me', { method: 'GET', credentials: 'include', cache: 'no-store' });
        if (ping.ok || ping.status === 401) {
          updateOfflineStatus();
          showToast('✅ Connection confirmed! You are online.', 'success');
          if (currentUser) {
            await loadAllUserData();
          } else {
            await checkAuthSession();
          }
        } else {
          showToast('Still offline. Please check your WiFi or mobile data.', 'warning');
        }
      } catch (e) {
        showToast('Connection test failed. Network is currently unreachable.', 'warning');
      } finally {
        retryConnectionBtn.disabled = false;
        retryConnectionBtn.textContent = 'Check Connection';
      }
    });
  }

  function updateOfflineStatus() {
    const isOffline = !navigator.onLine;
    if (offlineBanner) {
      if (isOffline) {
        offlineBanner.removeAttribute('hidden');
      } else {
        offlineBanner.setAttribute('hidden', 'true');
      }
    }
  }

  // 2. Service Worker Registration & Graceful Updates
  let swWaitingWorker = null;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((registration) => {
          console.log('[PWA] Service Worker registered with scope:', registration.scope);

          // Check if an updated worker is already waiting
          if (registration.waiting) {
            swWaitingWorker = registration.waiting;
            showSwUpdateNotice();
          }

          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;

            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                swWaitingWorker = newWorker;
                showSwUpdateNotice();
              }
            });
          });
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    });
  }

  function showSwUpdateNotice() {
    let isDismissed = false;
    if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
      try {
        isDismissed = sessionStorage.getItem('studypath_update_dismissed') === 'true';
      } catch (e) {}
    }
    if (isDismissed) {
      return;
    }
    if (swUpdateBanner) {
      swUpdateBanner.removeAttribute('hidden');
      swUpdateBanner.style.display = 'flex';
    }
  }

  function hideSwUpdateNotice() {
    if (swUpdateBanner) {
      swUpdateBanner.setAttribute('hidden', 'true');
      swUpdateBanner.style.display = 'none';
    }
  }

  if (btnSwRefresh) {
    btnSwRefresh.addEventListener('click', () => {
      btnSwRefresh.disabled = true;
      btnSwRefresh.textContent = 'Updating...';
      if (swWaitingWorker) {
        swWaitingWorker.postMessage({ type: 'SKIP_WAITING' });
      }
      hideSwUpdateNotice();
      setTimeout(() => {
        window.location.reload();
      }, 350);
    });
  }

  if (btnSwDismiss) {
    btnSwDismiss.addEventListener('click', () => {
      if (typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem('studypath_update_dismissed', 'true');
        } catch (e) {}
      }
      hideSwUpdateNotice();
    });
  }

  // 3. Install App Action & Prompt Detection
  // If already running in standalone mode, hide install action
  if (isStandalone) {
    if (installBtn) installBtn.setAttribute('hidden', 'true');
  } else {
    // Show install action button for supported browsers & mobile
    if (installBtn) installBtn.removeAttribute('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] beforeinstallprompt captured');
    if (!isStandalone && installBtn) {
      installBtn.removeAttribute('hidden');
    }
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] StudyPath successfully installed to home screen / desktop');
    deferredInstallPrompt = null;
    if (installBtn) installBtn.setAttribute('hidden', 'true');
    closeInstallInstructionsModal();
    showToast('✨ StudyPath was installed! You can now launch it anytime from your desktop or home screen.', 'success');
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        // Native install prompt available (Chrome, Edge, Android)
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          console.log('[PWA] User accepted browser installation prompt');
          installBtn.setAttribute('hidden', 'true');
        } else {
          console.log('[PWA] User dismissed browser installation prompt');
        }
        deferredInstallPrompt = null;
      } else {
        // Browser without direct prompt API (e.g. Safari iOS, Firefox, macOS Safari)
        openInstallInstructionsModal();
      }
    });
  }

  // 4. Install Instructions Modal Controls
  function openInstallInstructionsModal() {
    renderInstallInstructions();
    if (installModal) {
      installModal.removeAttribute('hidden');
      dismissInstallModalBtn?.focus();
    }
  }

  function closeInstallInstructionsModal() {
    if (installModal) {
      installModal.setAttribute('hidden', 'true');
      installBtn?.focus();
    }
  }

  if (closeInstallModalBtn) closeInstallModalBtn.addEventListener('click', closeInstallInstructionsModal);
  if (dismissInstallModalBtn) dismissInstallModalBtn.addEventListener('click', closeInstallInstructionsModal);
  if (installModal) {
    installModal.addEventListener('click', (e) => {
      if (e.target === installModal) closeInstallInstructionsModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !installModal.hasAttribute('hidden')) {
        closeInstallInstructionsModal();
      }
    });
  }

  function renderInstallInstructions() {
    const container = document.getElementById('install-instructions-content');
    if (!container) return;

    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
    const isMacSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua) && /Macintosh/.test(ua);

    let defaultTab = isIos ? 'ios' : (isMacSafari ? 'mac' : 'desktop');

    container.innerHTML = `
      <div class="install-platform-tabs" role="tablist" aria-label="Device install instructions">
        <button type="button" class="platform-tab-btn ${defaultTab === 'desktop' ? 'is-active' : ''}" data-platform="desktop">Chrome & Edge</button>
        <button type="button" class="platform-tab-btn ${defaultTab === 'ios' ? 'is-active' : ''}" data-platform="ios">iPhone & iPad</button>
        <button type="button" class="platform-tab-btn ${defaultTab === 'mac' ? 'is-active' : ''}" data-platform="mac">Mac Safari</button>
      </div>

      <div id="platform-instructions-panel" class="install-steps-list">
        ${getPlatformStepsHtml(defaultTab)}
      </div>

      <div class="pwa-feature-pill-row">
        <span class="pwa-pill">☕ Coffee & Cream Theme</span>
        <span class="pwa-pill">🔒 Backend User Isolation</span>
        <span class="pwa-pill">⚡ Instant App Shell Loading</span>
        <span class="pwa-pill">📱 Standalone Window</span>
      </div>
    `;

    // Tab switching in modal
    container.querySelectorAll('.platform-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.platform-tab-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const platform = btn.getAttribute('data-platform');
        const panel = document.getElementById('platform-instructions-panel');
        if (panel) {
          panel.innerHTML = getPlatformStepsHtml(platform);
        }
      });
    });
  }

  function getPlatformStepsHtml(platform) {
    if (platform === 'ios') {
      return `
        <div class="install-step-card">
          <div class="install-step-badge">1</div>
          <div class="install-step-text">
            <strong>Tap the Share Button</strong>
            <p>At the bottom of Safari, tap the <strong>Share</strong> icon (the square with an upward arrow).</p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">2</div>
          <div class="install-step-text">
            <strong>Select "Add to Home Screen"</strong>
            <p>Scroll down the share options list and tap <strong>Add to Home Screen</strong>.</p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">3</div>
          <div class="install-step-text">
            <strong>Tap Add</strong>
            <p>Confirm the app name "StudyPath" and tap <strong>Add</strong> in the top-right corner. The app will launch with full standalone display.</p>
          </div>
        </div>
      `;
    } else if (platform === 'mac') {
      return `
        <div class="install-step-card">
          <div class="install-step-badge">1</div>
          <div class="install-step-text">
            <strong>Open the File Menu</strong>
            <p>In Safari on macOS Sonoma or later, click <strong>File</strong> in the top menu bar.</p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">2</div>
          <div class="install-step-text">
            <strong>Add to Dock</strong>
            <p>Select <strong>Add to Dock…</strong> and confirm the name "StudyPath".</p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">3</div>
          <div class="install-step-text">
            <strong>Launch from Dock</strong>
            <p>StudyPath runs in its own dedicated, clean application window with no browser tabs.</p>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="install-step-card">
          <div class="install-step-badge">1</div>
          <div class="install-step-text">
            <strong>Address Bar Install Icon</strong>
            <p>Look for the <strong>Install app</strong> icon (a computer monitor with a downward arrow) on the right side of the address bar.</p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">2</div>
          <div class="install-step-text">
            <strong>Or Open Browser Menu (⋮)</strong>
            <p>Click the <strong>Three Dots (⋮)</strong> in Chrome or Edge menu &gt; <strong>Cast, save, and share</strong> &gt; <strong>Install StudyPath…</strong></p>
          </div>
        </div>
        <div class="install-step-card">
          <div class="install-step-badge">3</div>
          <div class="install-step-text">
            <strong>Instant Desktop Shortcut</strong>
            <p>Click <strong>Install</strong> to add StudyPath to your desktop, taskbar, and Start Menu.</p>
          </div>
        </div>
      `;
    }
  }
}

// ============================================================================
// 16. BOOTSTRAP
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  loadStoredPreferences();
  updateTodayDateDisplay();
  initEventListeners();
  startCountdownTimer();
  checkAuthSession();
  attach3DTilt();
  initPwaHandlers();
});

