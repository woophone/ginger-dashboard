import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { DashboardRoom } from "./durable-objects/DashboardRoom";

export { DashboardRoom };

type Bindings = {
  DB: D1Database;
  DASHBOARD_ROOM: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Auth credentials
const AUTH_EMAIL = "mchrislay@gmail.com";
const AUTH_PASSWORD = "Adjustme123!";
const SESSION_SECRET = "ginger-dashboard-2026-secret-key";

// Simple hash for session token
function createSessionToken(email: string): string {
  const data = `${email}:${SESSION_SECRET}:${Date.now()}`;
  // Simple base64 encoding - in production use proper JWT
  return btoa(data);
}

function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const decoded = atob(token);
    return decoded.includes(AUTH_EMAIL) && decoded.includes(SESSION_SECRET);
  } catch {
    return false;
  }
}

// Robots.txt - block all crawlers
app.get("/robots.txt", (c) => {
  return c.text("User-agent: *\nDisallow: /", 200, {
    "Content-Type": "text/plain",
  });
});

// Login page
app.get("/login", (c) => {
  const error = c.req.query("error");
  return c.html(getLoginHTML(error === "1"));
});

// Login handler
app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const email = body.email as string;
  const password = body.password as string;

  if (email === AUTH_EMAIL && password === AUTH_PASSWORD) {
    const token = createSessionToken(email);
    setCookie(c, "session", token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });
    return c.redirect("/");
  }

  return c.redirect("/login?error=1");
});

// Logout
app.get("/logout", (c) => {
  setCookie(c, "session", "", { maxAge: 0, path: "/" });
  return c.redirect("/login");
});

// Auth middleware for protected routes
app.use("*", async (c, next) => {
  const path = c.req.path;
  
  // Public routes
  if (path === "/login" || path === "/robots.txt" || path.startsWith("/api/ws")) {
    return next();
  }

  const session = getCookie(c, "session");
  if (!verifySession(session)) {
    // For API routes, return 401
    if (path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // For UI routes, redirect to login
    return c.redirect("/login");
  }

  return next();
});

// CORS for API access
app.use("/api/*", cors());

// =============
// API ROUTES
// =============

// Get all projects
app.get("/api/projects", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM projects ORDER BY updated_at DESC"
  ).all();
  return c.json(results);
});

// Get single project with features
app.get("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  
  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?"
  ).bind(id).first();
  
  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }
  
  const { results: features } = await c.env.DB.prepare(
    "SELECT * FROM feature_status WHERE project_id = ? ORDER BY sort_order, name"
  ).bind(id).all();
  
  return c.json({ ...project, features });
});

// Get feature with test history
app.get("/api/features/:id", async (c) => {
  const id = c.req.param("id");
  
  const feature = await c.env.DB.prepare(
    "SELECT * FROM feature_status WHERE id = ?"
  ).bind(id).first();
  
  if (!feature) {
    return c.json({ error: "Feature not found" }, 404);
  }
  
  const { results: testHistory } = await c.env.DB.prepare(
    "SELECT * FROM test_logs WHERE feature_id = ? ORDER BY tested_at DESC LIMIT 20"
  ).bind(id).all();
  
  const { results: fileChanges } = await c.env.DB.prepare(
    "SELECT * FROM file_changes WHERE feature_id = ? ORDER BY changed_at DESC LIMIT 20"
  ).bind(id).all();
  
  return c.json({ ...feature, testHistory, fileChanges });
});

// Log a test (called by RHM)
app.post("/api/test-logs", async (c) => {
  const body = await c.req.json();
  const { projectId, featureId, featureName, testType, target, result, verified, note, testedAt } = body;
  
  await c.env.DB.prepare(`
    INSERT INTO test_logs (project_id, feature_id, feature_name, test_type, target, result, verified, note, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    projectId,
    featureId || null,
    featureName,
    testType,
    target,
    result,
    JSON.stringify(verified || []),
    note || null,
    testedAt || new Date().toISOString()
  ).run();
  
  // Notify connected clients
  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  await room.fetch(new Request("http://internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ type: "test_logged", projectId, featureId })
  }));
  
  return c.json({ success: true });
});

// Log a file change (called by sync script)
app.post("/api/file-changes", async (c) => {
  const body = await c.req.json();
  const { projectId, featureId, filePath, changedAt, commitHash } = body;
  
  await c.env.DB.prepare(`
    INSERT INTO file_changes (project_id, feature_id, file_path, changed_at, commit_hash)
    VALUES (?, ?, ?, ?, ?)
  `).bind(projectId, featureId || null, filePath, changedAt, commitHash || null).run();
  
  return c.json({ success: true });
});

// Update feature status
app.patch("/api/features/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { status, blocker } = body;
  
  await c.env.DB.prepare(`
    UPDATE features SET status = ?, blocker = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(status, blocker || null, id).run();
  
  return c.json({ success: true });
});

// Create project
app.post("/api/projects", async (c) => {
  const body = await c.req.json();
  const { id, name, description, repoPath, stagingUrl, productionUrl } = body;
  
  await c.env.DB.prepare(`
    INSERT INTO projects (id, name, description, repo_path, staging_url, production_url, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).bind(id, name, description || null, repoPath || null, stagingUrl || null, productionUrl || null).run();
  
  return c.json({ success: true });
});

// Create feature
app.post("/api/features", async (c) => {
  const body = await c.req.json();
  const { id, projectId, name, status, blocker, sortOrder } = body;
  
  await c.env.DB.prepare(`
    INSERT INTO features (id, project_id, name, status, blocker, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, projectId, name, status || "not-started", blocker || null, sortOrder || 0).run();
  
  return c.json({ success: true });
});

// WebSocket for live updates
app.get("/api/ws", async (c) => {
  const upgradeHeader = c.req.header("Upgrade");
  if (upgradeHeader !== "websocket") {
    return c.text("Expected WebSocket", 400);
  }
  
  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  return room.fetch(c.req.raw);
});

// =============
// DASHBOARD UI
// =============

app.get("/", async (c) => {
  return c.html(getDashboardHTML());
});

function getLoginHTML(error: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Ginger's Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      color: #666;
      margin-bottom: 24px;
    }
    .error {
      background: #2a1515;
      border: 1px solid #4a2020;
      color: #ef4444;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    label {
      display: block;
      font-size: 14px;
      color: #888;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 12px;
      background: #0f0f0f;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      color: #fff;
      font-size: 16px;
      margin-bottom: 16px;
    }
    input:focus {
      outline: none;
      border-color: #3a3a3a;
    }
    button {
      width: 100%;
      padding: 12px;
      background: #22c55e;
      border: none;
      border-radius: 6px;
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      background: #1ea550;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🧡 Ginger's Dashboard</h1>
    <p class="subtitle">Sign in to continue</p>
    ${error ? '<div class="error">Invalid email or password</div>' : ''}
    <form method="POST" action="/login">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ginger's Projects</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      padding: 20px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid #2a2a2a;
    }
    .header h1 { font-size: 24px; font-weight: 600; color: #fff; }
    .header-right { display: flex; align-items: center; gap: 16px; }
    .connection-status {
      font-size: 12px;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .connection-status.connected { background: #052e16; color: #22c55e; }
    .connection-status.disconnected { background: #2a1515; color: #ef4444; }
    .logout-btn {
      font-size: 12px;
      color: #666;
      text-decoration: none;
    }
    .logout-btn:hover { color: #fff; }
    .projects-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 16px;
    }
    .project-card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .project-card:hover {
      border-color: #3a3a3a;
      background: #1f1f1f;
    }
    .project-name { font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 8px; }
    .project-desc { font-size: 14px; color: #888; margin-bottom: 12px; }
    .project-stats { font-size: 12px; color: #666; }
    .loading { text-align: center; padding: 60px; color: #666; }
    .status-table {
      width: 100%;
      border-collapse: collapse;
      background: #1a1a1a;
      border-radius: 12px;
      overflow: hidden;
      margin-top: 16px;
    }
    .status-table th {
      text-align: left;
      padding: 14px 16px;
      font-size: 11px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      background: #141414;
      border-bottom: 1px solid #2a2a2a;
    }
    .status-table td {
      padding: 14px 16px;
      font-size: 14px;
      border-bottom: 1px solid #222;
    }
    .status-table tr:hover { background: #1f1f1f; }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 8px;
    }
    .status-dot.ready { background: #22c55e; }
    .status-dot.stale { background: #f97316; }
    .status-dot.blocked { background: #eab308; }
    .status-dot.not-started { background: #6b7280; }
    .back-btn {
      font-size: 14px; color: #888; cursor: pointer; margin-bottom: 20px; display: inline-block;
    }
    .back-btn:hover { color: #fff; }
    .stale-warning { font-size: 10px; color: #f97316; display: block; margin-top: 4px; }
    .blocker-text { font-size: 12px; color: #eab308; margin-top: 8px; padding: 8px 12px; background: #2a2000; border-radius: 6px; }
    .tested-badge {
      font-size: 11px; padding: 2px 6px; border-radius: 4px; display: inline-block;
    }
    .tested-badge.browser { background: #052e16; color: #22c55e; }
    .tested-badge.curl { background: #2d2a14; color: #ca8a04; }
    .tested-badge.local { background: #262626; color: #a3a3a3; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧡 Ginger's Projects</h1>
    <div class="header-right">
      <span class="connection-status disconnected" id="status">Connecting...</span>
      <a href="/logout" class="logout-btn">Sign out</a>
    </div>
  </div>
  <div id="app"><div class="loading">Loading projects...</div></div>
  
  <script>
    const app = document.getElementById('app');
    const statusEl = document.getElementById('status');
    let currentView = 'projects';
    let currentProject = null;
    
    async function loadProjects() {
      try {
        const res = await fetch('/api/projects');
        if (res.status === 401) { window.location.href = '/login'; return; }
        const projects = await res.json();
        renderProjects(projects);
      } catch (e) {
        app.innerHTML = '<div class="loading">Error loading projects</div>';
      }
    }
    
    async function loadProject(id, skipPush) {
      try {
        const res = await fetch('/api/projects/' + id);
        if (res.status === 401) { window.location.href = '/login'; return; }
        const project = await res.json();
        if (project.error) {
          // Project not found, go back to list
          backToProjects();
          return;
        }
        currentProject = project;
        currentView = 'project';
        renderProject(project);
        // Update URL with project id (unless triggered by popstate)
        if (!skipPush) {
          history.pushState({ project: id }, '', '?project=' + encodeURIComponent(id));
        }
        // Update page title
        document.title = project.name + ' - Ginger\\'s Projects';
      } catch (e) {
        app.innerHTML = '<div class="loading">Error loading project</div>';
      }
    }
    
    function renderProjects(projects) {
      if (projects.length === 0) {
        app.innerHTML = '<div class="loading">No projects yet</div>';
        return;
      }
      app.innerHTML = '<div class="projects-grid">' + projects.map(p => 
        '<div class="project-card" onclick="loadProject(\\'' + p.id + '\\')">' +
        '<div class="project-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="project-desc">' + escapeHtml(p.description || '') + '</div>' +
        '<div class="project-stats">Updated: ' + formatDate(p.updated_at) + '</div>' +
        '</div>'
      ).join('') + '</div>';
    }
    
    function renderProject(project) {
      const features = project.features || [];
      const sorted = features.sort((a, b) => {
        const aTime = Math.max(new Date(a.last_modified || 0).getTime(), new Date(a.last_tested || 0).getTime());
        const bTime = Math.max(new Date(b.last_modified || 0).getTime(), new Date(b.last_tested || 0).getTime());
        return bTime - aTime;
      });
      
      let html = '<span class="back-btn" onclick="backToProjects()">← All Projects</span>';
      html += '<h2 style="color:#fff;margin-bottom:8px;">' + escapeHtml(project.name) + '</h2>';
      if (project.staging_url) {
        html += '<a href="' + project.staging_url + '" target="_blank" style="color:#60a5fa;font-size:13px;margin-bottom:16px;display:inline-block;">🚀 Open Staging</a>';
      }
      html += '<table class="status-table"><thead><tr>';
      html += '<th style="width:30%">Feature</th><th style="width:12%">Status</th><th style="width:20%">Tested</th><th style="width:19%">Last Modified</th><th style="width:19%">Last Tested</th>';
      html += '</tr></thead><tbody>';
      
      for (const f of sorted) {
        const isStale = f.is_stale === 1;
        const dotClass = f.status === 'blocked' ? 'blocked' : f.status === 'not-started' ? 'not-started' : isStale ? 'stale' : 'ready';
        const testedBadge = f.last_test_type ? '<span class="tested-badge ' + f.last_test_type + '">' + f.last_test_target + ' (' + f.last_test_type + ')</span>' : '—';
        
        html += '<tr>';
        html += '<td><span class="status-dot ' + dotClass + '"></span>' + escapeHtml(f.name);
        if (f.blocker) html += '<div class="blocker-text">⚠️ ' + escapeHtml(f.blocker) + '</div>';
        html += '</td>';
        html += '<td>' + escapeHtml(f.status) + '</td>';
        html += '<td>' + testedBadge;
        if (isStale) html += '<span class="stale-warning">⚠️ code changed since test</span>';
        html += '</td>';
        html += '<td>' + formatDateTime(f.last_modified) + '</td>';
        html += '<td>' + formatDateTime(f.last_tested) + '</td>';
        html += '</tr>';
      }
      
      html += '</tbody></table>';
      app.innerHTML = html;
    }
    
    function backToProjects(skipPush) {
      currentView = 'projects';
      currentProject = null;
      loadProjects();
      // Clear URL params (unless triggered by popstate)
      if (!skipPush) {
        history.pushState({}, '', '/');
      }
      // Reset page title
      document.title = 'Ginger\\'s Projects';
    }
    
    function formatDate(d) {
      if (!d) return '—';
      const date = new Date(d);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    
    function formatDateTime(d) {
      if (!d) return '—';
      const date = new Date(d);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '<br><span style="color:#525252;font-size:11px">' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</span>';
    }
    
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    
    // WebSocket
    function connectWS() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/api/ws');
      ws.onopen = () => {
        statusEl.textContent = 'Live';
        statusEl.className = 'connection-status connected';
      };
      ws.onclose = () => {
        statusEl.textContent = 'Reconnecting...';
        statusEl.className = 'connection-status disconnected';
        setTimeout(connectWS, 3000);
      };
      ws.onmessage = () => {
        if (currentView === 'projects') loadProjects();
        else if (currentProject) loadProject(currentProject.id);
      };
    }
    
    // Handle browser back/forward buttons
    window.addEventListener('popstate', function(e) {
      if (e.state && e.state.project) {
        loadProject(e.state.project, true);
      } else {
        backToProjects(true);
      }
    });
    
    // Check URL for project param on initial load
    function init() {
      const params = new URLSearchParams(window.location.search);
      const projectId = params.get('project');
      if (projectId) {
        // Replace initial state so back button works correctly
        history.replaceState({ project: projectId }, '', '?project=' + encodeURIComponent(projectId));
        loadProject(projectId, true);
      } else {
        history.replaceState({}, '', '/');
        loadProjects();
      }
      connectWS();
    }
    
    init();
  </script>
</body>
</html>`;
}

export default app;
