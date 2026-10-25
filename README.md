# StudyPath • Intelligent Student Assignment Planner

A full-stack, secure student assignment planner web application. Built with **Vanilla HTML/CSS/JavaScript**, a native **Node.js HTTP REST Backend**, and an **ACID Relational SQLite Database** (`node:sqlite`).

---

## 🚀 Quick Start

### Prerequisites
* **Node.js**: v22+ (v26.10.0 tested)
* **Zero External Dependencies**: Uses native standard libraries (`node:sqlite`, `crypto`, `http`, `fs`, `path`). No `npm install` delays or native C++ build tool requirements.

### Running the Application

```powershell
npm run dev
```

The server starts up and opens your default browser at `http://localhost:3000` (or automatically falls back to `3001` if port `3000` is busy).

---

## 🔒 Security & Authentication Architecture

1. **Mandatory Account Gateway**:
   * Users **cannot view, edit, or access** planner data until they sign up or log in.
   * Unauthenticated requests to `/api/assignments/*` immediately receive `401 Unauthorized`.
   * Client interface hides the planner view until `GET /api/auth/me` validates the session.

2. **OWASP-Grade Password Hashing**:
   * Passwords are **never stored in plaintext, local storage, or session storage**.
   * Hashed on the backend using salted **`crypto.scryptSync`** with cryptographically secure random 16-byte salts.
   * Password checks employ **`crypto.timingSafeEqual`** to prevent side-channel timing attacks.

3. **Session Management**:
   * Successful logins issue cryptographically random session tokens stored in the `sessions` table.
   * Tokens are delivered via **HTTP-only, SameSite=Lax** cookies, preventing XSS-based token theft.
   * Sessions persist across page refreshes and browser restarts, expiring automatically after 72 hours (configurable).

4. **Strict Per-User Relational Isolation**:
   * All database queries enforce user boundaries:
     ```sql
     SELECT * FROM assignments WHERE user_id = ?;
     UPDATE assignments SET ... WHERE id = ? AND user_id = ?;
     DELETE FROM assignments WHERE id = ? AND user_id = ?;
     ```
   * Account and assignment data are strictly isolated between users. Foreign keys enforce referential integrity (`ON DELETE CASCADE`).

---

## 📋 Data Structures in Action

1. **Priority Queue (`AssignmentPriorityQueue`)**:
   * Powers the **“What should I work on next?”** Spotlight centerpiece.
   * Evaluates an urgency heuristic scoring function combining deadline proximity (spikes for overdue and $< 12$h tasks) with priority rankings (High=300, Medium=200, Low=100).
   * Automatically bubbles the most urgent work to the queue head.

2. **Action Stack (`ActionStack` - LIFO)**:
   * Provides real **Undo** and **Redo** for recent assignment mutations (Adding, Editing, Deleting, Toggling Completion, Clearing Completed).
   * Supports **`Ctrl + Z`** (Undo) and **`Ctrl + Y`** (Redo).
   * Unlike static client stacks, undoing an action **synchronizes with the backend database** (e.g., restoring deleted items or reverting edits).

3. **Multi-Token Search Engine**:
   * Performs sub-millisecond conjunctive matching over titles, subjects, and notes.

4. **Dynamic Stable Sort**:
   * Offers instant sorting by Urgency Queue, Due Date (Ascending/Descending), Priority Rank, Subject (A–Z), and Title (A–Z).

---

## ⚙️ Environment Configuration

Configuration is managed via `.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the HTTP server (auto-increments if in use) |
| `NODE_ENV` | `development` | Runtime environment (`development` / `production`) |
| `SESSION_EXPIRY_HOURS` | `72` | Session lifetime in hours |
| `SESSION_COOKIE_NAME` | `studypath_session` | Name of the HTTP-only session cookie |

---

## 🛠️ API Reference

### Authentication Endpoints
* `POST /api/auth/signup` — Register a new account (`name`, `email`, `password`, `major`).
* `POST /api/auth/login` — Sign in (`email`, `password`). Sets HTTP-only cookie.
* `GET /api/auth/me` — Retrieve active authenticated user profile.
* `POST /api/auth/logout` — Invalidate session and clear cookie.
* `POST /api/auth/forgot-password` — Generate a password reset token (`email`).
* `POST /api/auth/reset-password` — Set new password using token (`token`, `newPassword`).

### Protected Assignment Endpoints
* `GET /api/assignments` — Retrieve current user's assignments with nested subtasks and links.
* `POST /api/assignments` — Create a new assignment with estimated minutes, subtasks, notes, and links.
* `PUT /api/assignments/:id` — Update assignment details, time estimates, notes, subtasks, and links.
* `PATCH /api/assignments/:id/complete` — Toggle assignment completion status.
* `DELETE /api/assignments/:id` — Delete assignment and cascade associated subtasks/reminders.
* `POST /api/assignments/clear-completed` — Clear all completed assignments (undoable).
* `POST /api/assignments/batch-restore` — Restore assignments (used by Stack Undo/Redo).

### Subtasks & Milestones Endpoints
* `POST /api/assignments/:id/subtasks` — Add a new step or milestone to an assignment.
* `PATCH /api/subtasks/:id/complete` — Toggle completion status of a subtask step.
* `DELETE /api/subtasks/:id` — Remove a subtask step.

### Recurring Study Sessions Endpoints
* `GET /api/study-sessions` — Retrieve user's recurring study sessions.
* `POST /api/study-sessions` — Schedule a new recurring study block (`subject`, `dayOfWeek`, `startTime`, `durationMinutes`, `notes`).
* `PUT /api/study-sessions/:id` — Update a recurring study block.
* `DELETE /api/study-sessions/:id` — Delete a recurring study block.

### Reminders & Deadline Alerts Endpoints
* `GET /api/reminders` — Retrieve user's active deadline reminders.
* `GET /api/reminders/due` — Query reminders that have reached their scheduled alert time.
* `POST /api/reminders` — Schedule a deadline reminder (`assignmentId`, `remindAt`).
* `POST /api/reminders/:id/dismiss` — Mark reminder as dismissed/delivered.
* `DELETE /api/reminders/:id` — Cancel and delete a scheduled reminder.

### Workload & Progress Insights Endpoints
* `GET /api/insights` — Calculate real-time aggregations from actual user data:
  * **Weekly Workload**: Total estimated study hours for the current Monday–Sunday week.
  * **Overdue Backlog**: Hours and task count of overdue assignments, tracked separately so overdue work does not distort daily forward scheduling.
  * **Daily Distribution**: 7-day Monday through Sunday breakdown of assignment workload and scheduled study session blocks.
  * **Course Breakdown**: Subject-by-subject distribution of estimated hours and assignment counts.
  * **Milestone Progress**: Completion rate and step-by-step milestone checklist.

---

## 🔔 Reminders & Notification Delivery Architecture

StudyPath delivers **real deadline reminders** using a multi-tiered architecture:

1. **Active Browser Delivery (Web Notifications + Web Audio Chime)**:
   * **Visual Desktop Alert**: Uses the standard **Web Notifications API** (`Notification.requestPermission()`) to display OS-level desktop notifications when due.
   * **Synthesized Audio Bell**: Employs the **Web Audio API** (`AudioContext`) to generate a clean, audible two-tone alert chime (D5 587.33Hz & A5 880Hz) with no external media file dependencies.
   * **Active Polling**: The client polls `/api/reminders/due` every 30 seconds and on tab visibility/focus changes.

2. **Closed-Browser & Offline Delivery Configuration**:
   * For delivery when the student's browser is closed, StudyPath supports integration with SMTP email relays, Web Push (VAPID), or scheduled cron/daemon runners.
   * **SMTP Email Delivery Setup**:
     ```bash
     SMTP_HOST=smtp.mailgun.org
     SMTP_PORT=587
     SMTP_USER=postmaster@studypath.domain.com
     SMTP_PASS=your-smtp-password
     SMTP_FROM="StudyPath Reminders <alerts@studypath.domain.com>"
     ```
   * **Web Push (VAPID) Setup**:
     ```bash
     VAPID_PUBLIC_KEY=your-public-vapid-key
     VAPID_PRIVATE_KEY=your-private-vapid-key
     VAPID_SUBJECT=mailto:admin@studypath.domain.com
     ```
   * *Transparency Guarantee*: The UI clearly reflects delivery status via `#notification-status-badge` and informs users of required setup, never falsely claiming offline delivery is active without configured credentials.

---

## 🗄️ Database Relational Schema

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  major TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  due_date TEXT NOT NULL,
  priority TEXT NOT NULL,
  duration TEXT,
  estimated_minutes INTEGER DEFAULT 90,
  notes TEXT,
  links TEXT,
  completed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT,
  completed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE study_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  dismissed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
```

---

## 📱 Progressive Web App (PWA) & Offline Resilience

StudyPath is installable as a native-like Progressive Web App (PWA) across desktop computers and mobile devices.

### Key PWA Capabilities
1. **Web App Manifest (`manifest.json`)**:
   - `display: "standalone"` — opens in an uncluttered, standalone app window with no browser URL address bars.
   - `start_url: "/"` & `scope: "/"` — launches directly into the student planner.
   - **Coffee & Cream Palette**: Matches app aesthetic with `theme_color: "#8C532B"` and `background_color: "#FAF7F2"`.
   - **Icons Suite**: 192x192 and 512x512 standard icons, maskable icons for Android adaptive launchers, high-resolution SVG, and `apple-touch-icon.png` for iOS home screens.

2. **Strict Multi-User Security & Privacy Cache Guardrails (`sw.js`)**:
   - **App Shell Only**: The service worker caches *only* static user interface assets (`/`, `/index.html`, `/styles.css`, `/app.js`, `/manifest.json`, and icon assets).
   - **Zero API Caching**: Authenticated backend routes (`/api/*`) and non-GET requests are **strictly network-only**. Private assignment data, user notes, and session tokens are **NEVER** saved into the cache storage. This completely eliminates any risk of private academic data leaking across different student accounts or shared computers.
   - **Graceful Updates**: Service worker updates trigger an in-app update banner (`#sw-update-banner`) allowing users to apply updates seamlessly without unexpected disruptions.

3. **Install App Action & Browser Detection**:
   - **Native Prompt Support**: In Chrome, Edge, and Android, StudyPath captures the `beforeinstallprompt` event and triggers the browser's native install dialog when the user clicks **Install App** (`#btn-install-app`).
   - **iOS & Safari Fallback**: On browsers without programmatic install events (such as iOS Safari or macOS Safari), clicking **Install App** opens a step-by-step guidance modal (`#install-modal`) with visual instructions (e.g., *Tap Share &gt; Add to Home Screen*).
   - **Standalone Mode Awareness**: When running in standalone mode, the app automatically hides the install button.

4. **Offline Resilience & Data Integrity**:
   - If the network becomes unreachable, the app shell still opens instantly from local cache.
   - An informative offline banner (`#offline-banner`) notifies the student that the app is in offline read mode. To prevent data desynchronization or conflicting updates, creating and editing assignments requires an active network connection to synchronize with the backend SQLite database.

---

## 🌐 Setup, Testing & HTTPS Publishing Guide

### Local Verification (Development)
Modern browsers treat `http://localhost` and `http://127.0.0.1` as **secure origins**, allowing you to test PWA installation locally:
1. Start the server:
   ```powershell
   npm run dev
   ```
2. Open Google Chrome or Microsoft Edge at `http://localhost:3000`.
3. In Chrome/Edge:
   - Notice the **Install App** button in the header, or the install icon in the address bar (omnibox).
   - Open Developer Tools (`F12`) &gt; **Application** tab:
     - **Manifest**: Verify all metadata, theme colors, and icons are loaded without errors.
     - **Service Workers**: Verify `sw.js` is active and running.
   - Click **Install App** to install StudyPath as a desktop application.
   - Launch StudyPath from your Start Menu, Applications folder, or desktop shortcut. Verify it opens in a standalone window, prompts for student sign-in, and loads real coursework data.

### Production HTTPS Publishing
When deploying to a public server or cloud provider:
1. **HTTPS is Mandatory**: Progressive Web App installation, service workers, and Web Notification APIs require an HTTPS certificate (TLS 1.2+).
2. **Reverse Proxy Configuration (e.g., Nginx, Caddy, or Cloudflare)**:
   - Route traffic through an SSL terminator with Let's Encrypt or your SSL provider.
   - Forward cookies and authorization headers:
     ```nginx
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto https;
     }
     ```
3. **Environment Settings**:
   - In production `.env`, set:
     ```env
     NODE_ENV=production
     PORT=3000
     ```

### Browser & Platform Limitations
* **Desktop Chrome & Edge (Windows, macOS, Linux, ChromeOS)**: Full native support for programmatic install prompt (`beforeinstallprompt`) and standalone window mode.
* **Android (Chrome, Edge, Samsung Internet)**: Full native support for Web App Manifest, maskable icons, and native installation.
* **Apple iOS & iPadOS (Safari)**: Does not support the `beforeinstallprompt` JavaScript API. Users must manually tap the **Share** button in Safari and select **Add to Home Screen**. Once added, iOS launches the PWA in standalone mode (`apple-mobile-web-app-capable: yes`). Note that third-party browsers on iOS (Chrome/Firefox for iOS) only support web clips or redirect through Safari for Home Screen addition.
* **Mozilla Firefox (Desktop)**: Firefox Desktop does not support standalone desktop PWA installation natively without third-party extensions. Users can bookmark or use desktop notifications.

