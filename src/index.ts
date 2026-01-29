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

// Get single project with features and considerations
app.get("/api/projects/:id", async (c) => {
  const id = c.req.param("id");

  const project = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id = ?"
  ).bind(id).first();

  if (!project) {
    return c.json({ error: "Project not found" }, 404);
  }

  const { results: features } = await c.env.DB.prepare(
    "SELECT * FROM feature_status WHERE project_id = ? ORDER BY category, subcategory, sort_order, name"
  ).bind(id).all();

  const { results: considerations } = await c.env.DB.prepare(
    "SELECT * FROM considerations WHERE project_id = ? ORDER BY created_at DESC"
  ).bind(id).all();

  return c.json({ ...project, features, considerations });
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
  const { status, blocker, category, subcategory } = body;

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (status !== undefined) { updates.push("status = ?"); values.push(status); }
  if (blocker !== undefined) { updates.push("blocker = ?"); values.push(blocker || null); }
  if (category !== undefined) { updates.push("category = ?"); values.push(category || null); }
  if (subcategory !== undefined) { updates.push("subcategory = ?"); values.push(subcategory || null); }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE features SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();

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
  const { id, projectId, name, status, blocker, sortOrder, category, subcategory } = body;

  await c.env.DB.prepare(`
    INSERT INTO features (id, project_id, name, status, blocker, sort_order, category, subcategory)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, projectId, name, status || "not-started", blocker || null, sortOrder || 0, category || null, subcategory || null).run();

  return c.json({ success: true });
});

// =============
// CONSIDERATIONS API
// =============

// Create consideration
app.post("/api/considerations", async (c) => {
  const body = await c.req.json();
  const { projectId, featureId, category, content } = body;

  const id = crypto.randomUUID();

  await c.env.DB.prepare(`
    INSERT INTO considerations (id, project_id, feature_id, category, content)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, projectId, featureId || null, category || null, content).run();

  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  await room.fetch(new Request("http://internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ type: "consideration_created", projectId })
  }));

  return c.json({ success: true, id });
});

// Update consideration
app.patch("/api/considerations/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { status, content } = body;

  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (status !== undefined) {
    updates.push("status = ?");
    values.push(status);
    if (status === "resolved") {
      updates.push("resolved_at = datetime('now')");
    }
  }
  if (content !== undefined) { updates.push("content = ?"); values.push(content); }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  values.push(id);

  await c.env.DB.prepare(
    `UPDATE considerations SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return c.json({ success: true });
});

// =============
// LEADS API
// =============

// Get all leads
app.get("/api/leads", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM leads ORDER BY created_at DESC"
  ).all();
  return c.json(results);
});

// Create lead
app.post("/api/leads", async (c) => {
  const body = await c.req.json();
  const { id, source, businessType, name, phone, email, facebookUrl, status, notes } = body;

  const leadId = id || crypto.randomUUID();

  await c.env.DB.prepare(`
    INSERT INTO leads (id, source, business_type, name, phone, email, facebook_url, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    leadId,
    source,
    businessType,
    name,
    phone || null,
    email || null,
    facebookUrl || null,
    status || "new",
    notes || null
  ).run();

  // Notify connected clients
  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  await room.fetch(new Request("http://internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ type: "lead_created", leadId })
  }));

  return c.json({ success: true, id: leadId });
});

// Update lead
app.patch("/api/leads/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { status, notes, name, phone, email, facebookUrl, source, businessType } = body;

  // Build dynamic update
  const updates: string[] = [];
  const values: (string | null)[] = [];

  if (status !== undefined) { updates.push("status = ?"); values.push(status); }
  if (notes !== undefined) { updates.push("notes = ?"); values.push(notes || null); }
  if (name !== undefined) { updates.push("name = ?"); values.push(name); }
  if (phone !== undefined) { updates.push("phone = ?"); values.push(phone || null); }
  if (email !== undefined) { updates.push("email = ?"); values.push(email || null); }
  if (facebookUrl !== undefined) { updates.push("facebook_url = ?"); values.push(facebookUrl || null); }
  if (source !== undefined) { updates.push("source = ?"); values.push(source); }
  if (businessType !== undefined) { updates.push("business_type = ?"); values.push(businessType); }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE leads SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  // Notify connected clients
  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  await room.fetch(new Request("http://internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ type: "lead_updated", leadId: id })
  }));

  return c.json({ success: true });
});

// Delete lead
app.delete("/api/leads/:id", async (c) => {
  const id = c.req.param("id");

  await c.env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();

  // Notify connected clients
  const roomId = c.env.DASHBOARD_ROOM.idFromName("main");
  const room = c.env.DASHBOARD_ROOM.get(roomId);
  await room.fetch(new Request("http://internal/broadcast", {
    method: "POST",
    body: JSON.stringify({ type: "lead_deleted", leadId: id })
  }));

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
  <title>Ginger's Dashboard</title>
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
      margin-bottom: 20px;
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

    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 1px solid #2a2a2a;
      padding-bottom: 0;
    }
    .tab {
      padding: 12px 24px;
      font-size: 14px;
      font-weight: 600;
      color: #666;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.2s;
    }
    .tab:hover { color: #888; }
    .tab.active { color: #fff; border-bottom-color: #22c55e; }

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

    /* Lead badges */
    .badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      display: inline-block;
      font-weight: 500;
    }
    .badge.new { background: #1e3a5f; color: #60a5fa; }
    .badge.contacted { background: #422006; color: #fbbf24; }
    .badge.responded { background: #2e1065; color: #c084fc; }
    .badge.won { background: #052e16; color: #22c55e; }
    .badge.lost { background: #262626; color: #9ca3af; }

    .badge.dog-training { background: #1c1917; color: #fbbf24; }
    .badge.bounce-house { background: #1e1b4b; color: #a5b4fc; }
    .badge.web-design { background: #022c22; color: #34d399; }

    .badge.source { background: #1f1f1f; color: #888; }

    /* Lead form */
    .lead-form {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .lead-form h3 { color: #fff; margin-bottom: 16px; font-size: 16px; }
    .form-row {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .form-group {
      flex: 1;
      min-width: 150px;
    }
    .form-group label {
      display: block;
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
    }
    .form-group input, .form-group select, .form-group textarea {
      width: 100%;
      padding: 8px 12px;
      background: #0f0f0f;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      color: #fff;
      font-size: 14px;
    }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
      outline: none;
      border-color: #3a3a3a;
    }
    .form-group textarea { resize: vertical; min-height: 60px; }
    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
    }
    .btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border: none;
    }
    .btn-primary { background: #22c55e; color: #fff; }
    .btn-primary:hover { background: #1ea550; }
    .btn-secondary { background: #2a2a2a; color: #888; }
    .btn-secondary:hover { background: #3a3a3a; color: #fff; }
    .btn-danger { background: #7f1d1d; color: #fca5a5; }
    .btn-danger:hover { background: #991b1b; }

    /* Status dropdown in table */
    .status-select {
      padding: 4px 8px;
      background: transparent;
      border: 1px solid #2a2a2a;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 12px;
      cursor: pointer;
    }
    .status-select:focus { outline: none; border-color: #3a3a3a; }

    .lead-contact {
      font-size: 12px;
      color: #666;
    }
    .lead-contact a { color: #60a5fa; text-decoration: none; }
    .lead-contact a:hover { text-decoration: underline; }
    .lead-notes {
      font-size: 12px;
      color: #888;
      max-width: 200px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lead-name { font-weight: 500; color: #fff; }
    .lead-date { font-size: 12px; color: #525252; }

    .add-lead-btn {
      margin-bottom: 16px;
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: #666;
    }
    .empty-state p { margin-bottom: 16px; }

    /* Category grouping */
    .category-group { margin-bottom: 4px; }
    .category-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: #161616;
      border: 1px solid #222;
      border-radius: 8px;
      cursor: pointer;
      user-select: none;
      margin-bottom: 2px;
    }
    .category-header:hover { background: #1c1c1c; }
    .category-arrow {
      font-size: 10px;
      color: #555;
      transition: transform 0.15s;
      width: 12px;
    }
    .category-arrow.collapsed { transform: rotate(-90deg); }
    .category-name {
      font-size: 13px;
      font-weight: 600;
      color: #999;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .category-count {
      font-size: 11px;
      color: #555;
      margin-left: 4px;
    }
    .category-body { overflow: hidden; }
    .category-body.collapsed { display: none; }
    .subcategory-header {
      padding: 6px 16px 6px 36px;
      font-size: 12px;
      font-weight: 500;
      color: #666;
      border-bottom: 1px solid #1a1a1a;
    }
    .consideration-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: #2d2006;
      color: #f59e0b;
      margin-left: 8px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Ginger's Dashboard</h1>
    <div class="header-right">
      <span class="connection-status disconnected" id="status">Connecting...</span>
      <a href="/logout" class="logout-btn">Sign out</a>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="leads" onclick="switchTab('leads')">LEADS</div>
    <div class="tab" data-tab="projects" onclick="switchTab('projects')">PROJECTS</div>
  </div>

  <div id="app"><div class="loading">Loading...</div></div>

  <script>
    const app = document.getElementById('app');
    const statusEl = document.getElementById('status');
    let currentTab = 'leads';
    let currentView = 'list';
    let currentProject = null;
    let leads = [];
    let showAddForm = false;
    let editingLead = null;

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="' + tab + '"]').classList.add('active');

      if (tab === 'leads') {
        loadLeads();
        history.pushState({ tab: 'leads' }, '', '/?tab=leads');
        document.title = 'Leads - Ginger\\'s Dashboard';
      } else {
        currentView = 'list';
        currentProject = null;
        loadProjects();
        history.pushState({ tab: 'projects' }, '', '/?tab=projects');
        document.title = 'Projects - Ginger\\'s Dashboard';
      }
    }

    // ============= LEADS =============

    async function loadLeads() {
      try {
        const res = await fetch('/api/leads');
        if (res.status === 401) { window.location.href = '/login'; return; }
        leads = await res.json();
        renderLeads();
      } catch (e) {
        app.innerHTML = '<div class="loading">Error loading leads</div>';
      }
    }

    function renderLeads() {
      let html = '';

      // Add button
      html += '<button class="btn btn-primary add-lead-btn" onclick="toggleAddForm()">+ Add Lead</button>';

      // Add/Edit form
      if (showAddForm || editingLead) {
        const lead = editingLead || {};
        html += '<div class="lead-form">';
        html += '<h3>' + (editingLead ? 'Edit Lead' : 'New Lead') + '</h3>';
        html += '<div class="form-row">';
        html += '<div class="form-group"><label>Name *</label><input type="text" id="lead-name" value="' + escapeHtml(lead.name || '') + '" required></div>';
        html += '<div class="form-group"><label>Business Type *</label><select id="lead-business">';
        html += '<option value="dog-training"' + (lead.business_type === 'dog-training' ? ' selected' : '') + '>Dog Training</option>';
        html += '<option value="bounce-house"' + (lead.business_type === 'bounce-house' ? ' selected' : '') + '>Bounce House</option>';
        html += '<option value="web-design"' + (lead.business_type === 'web-design' ? ' selected' : '') + '>Web Design</option>';
        html += '</select></div>';
        html += '<div class="form-group"><label>Source *</label><input type="text" id="lead-source" value="' + escapeHtml(lead.source || '') + '" placeholder="facebook-group, referral, etc"></div>';
        html += '</div>';
        html += '<div class="form-row">';
        html += '<div class="form-group"><label>Phone</label><input type="tel" id="lead-phone" value="' + escapeHtml(lead.phone || '') + '"></div>';
        html += '<div class="form-group"><label>Email</label><input type="email" id="lead-email" value="' + escapeHtml(lead.email || '') + '"></div>';
        html += '<div class="form-group"><label>Facebook URL</label><input type="url" id="lead-fb" value="' + escapeHtml(lead.facebook_url || '') + '"></div>';
        html += '</div>';
        html += '<div class="form-row">';
        html += '<div class="form-group" style="flex:2"><label>Notes</label><textarea id="lead-notes">' + escapeHtml(lead.notes || '') + '</textarea></div>';
        html += '</div>';
        html += '<div class="form-actions">';
        html += '<button class="btn btn-primary" onclick="saveLead()">' + (editingLead ? 'Update' : 'Add Lead') + '</button>';
        html += '<button class="btn btn-secondary" onclick="cancelForm()">Cancel</button>';
        if (editingLead) {
          html += '<button class="btn btn-danger" onclick="deleteLead(\\'' + editingLead.id + '\\')">Delete</button>';
        }
        html += '</div></div>';
      }

      if (leads.length === 0 && !showAddForm) {
        html += '<div class="empty-state"><p>No leads yet</p></div>';
        app.innerHTML = html;
        return;
      }

      // Leads table
      html += '<table class="status-table"><thead><tr>';
      html += '<th style="width:18%">Name</th>';
      html += '<th style="width:12%">Business</th>';
      html += '<th style="width:12%">Source</th>';
      html += '<th style="width:12%">Status</th>';
      html += '<th style="width:18%">Contact</th>';
      html += '<th style="width:18%">Notes</th>';
      html += '<th style="width:10%">Date</th>';
      html += '</tr></thead><tbody>';

      for (const lead of leads) {
        html += '<tr onclick="editLead(\\'' + lead.id + '\\')" style="cursor:pointer">';
        html += '<td><span class="lead-name">' + escapeHtml(lead.name) + '</span></td>';
        html += '<td><span class="badge ' + lead.business_type + '">' + formatBusinessType(lead.business_type) + '</span></td>';
        html += '<td><span class="badge source">' + escapeHtml(lead.source) + '</span></td>';
        html += '<td><select class="status-select" onclick="event.stopPropagation()" onchange="updateLeadStatus(\\'' + lead.id + '\\', this.value)">';
        html += '<option value="new"' + (lead.status === 'new' ? ' selected' : '') + '>New</option>';
        html += '<option value="contacted"' + (lead.status === 'contacted' ? ' selected' : '') + '>Contacted</option>';
        html += '<option value="responded"' + (lead.status === 'responded' ? ' selected' : '') + '>Responded</option>';
        html += '<option value="won"' + (lead.status === 'won' ? ' selected' : '') + '>Won</option>';
        html += '<option value="lost"' + (lead.status === 'lost' ? ' selected' : '') + '>Lost</option>';
        html += '</select></td>';
        html += '<td class="lead-contact">';
        if (lead.phone) html += lead.phone + '<br>';
        if (lead.email) html += '<a href="mailto:' + escapeHtml(lead.email) + '">' + escapeHtml(lead.email) + '</a><br>';
        if (lead.facebook_url) html += '<a href="' + escapeHtml(lead.facebook_url) + '" target="_blank">Facebook</a>';
        if (!lead.phone && !lead.email && !lead.facebook_url) html += '—';
        html += '</td>';
        html += '<td class="lead-notes" title="' + escapeHtml(lead.notes || '') + '">' + escapeHtml(lead.notes || '—') + '</td>';
        html += '<td class="lead-date">' + formatDate(lead.created_at) + '</td>';
        html += '</tr>';
      }

      html += '</tbody></table>';
      app.innerHTML = html;
    }

    function toggleAddForm() {
      showAddForm = !showAddForm;
      editingLead = null;
      renderLeads();
    }

    function cancelForm() {
      showAddForm = false;
      editingLead = null;
      renderLeads();
    }

    function editLead(id) {
      editingLead = leads.find(l => l.id === id);
      showAddForm = false;
      renderLeads();
    }

    async function saveLead() {
      const name = document.getElementById('lead-name').value.trim();
      const businessType = document.getElementById('lead-business').value;
      const source = document.getElementById('lead-source').value.trim();
      const phone = document.getElementById('lead-phone').value.trim();
      const email = document.getElementById('lead-email').value.trim();
      const facebookUrl = document.getElementById('lead-fb').value.trim();
      const notes = document.getElementById('lead-notes').value.trim();

      if (!name || !source) {
        alert('Name and Source are required');
        return;
      }

      const data = { name, businessType, source, phone, email, facebookUrl, notes };

      try {
        if (editingLead) {
          await fetch('/api/leads/' + editingLead.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
        } else {
          await fetch('/api/leads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
        }
        showAddForm = false;
        editingLead = null;
        await loadLeads();
      } catch (e) {
        alert('Error saving lead');
      }
    }

    async function updateLeadStatus(id, status) {
      try {
        await fetch('/api/leads/' + id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status })
        });
        await loadLeads();
      } catch (e) {
        alert('Error updating status');
      }
    }

    async function deleteLead(id) {
      if (!confirm('Delete this lead?')) return;
      try {
        await fetch('/api/leads/' + id, { method: 'DELETE' });
        editingLead = null;
        await loadLeads();
      } catch (e) {
        alert('Error deleting lead');
      }
    }

    function formatBusinessType(type) {
      const map = {
        'dog-training': 'Dog Training',
        'bounce-house': 'Bounce House',
        'web-design': 'Web Design'
      };
      return map[type] || type;
    }

    // ============= PROJECTS =============

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
          backToProjects();
          return;
        }
        currentProject = project;
        currentView = 'project';
        renderProject(project);
        if (!skipPush) {
          history.pushState({ tab: 'projects', project: id }, '', '?tab=projects&project=' + encodeURIComponent(id));
        }
        document.title = project.name + ' - Ginger\\'s Dashboard';
      } catch (e) {
        app.innerHTML = '<div class="loading">Error loading project</div>';
      }
    }

    function renderProjects(projects) {
      if (projects.length === 0) {
        app.innerHTML = '<div class="empty-state"><p>No projects yet</p></div>';
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
      const considerations = project.considerations || [];

      // Build pending consideration counts per feature
      const pendingByFeature = {};
      for (const con of considerations) {
        if (con.status === 'pending' && con.feature_id) {
          pendingByFeature[con.feature_id] = (pendingByFeature[con.feature_id] || 0) + 1;
        }
      }

      // Group features by category
      const groups = {};
      for (const f of features) {
        const cat = f.category || '__uncategorized__';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(f);
      }

      // Sort categories: named first alphabetically, uncategorized last
      const catKeys = Object.keys(groups).sort((a, b) => {
        if (a === '__uncategorized__') return 1;
        if (b === '__uncategorized__') return -1;
        return a.localeCompare(b);
      });

      let html = '<span class="back-btn" onclick="backToProjects()">← All Projects</span>';
      html += '<h2 style="color:#fff;margin-bottom:8px;">' + escapeHtml(project.name) + '</h2>';
      if (project.staging_url) {
        html += '<a href="' + project.staging_url + '" target="_blank" style="color:#60a5fa;font-size:13px;margin-bottom:16px;display:inline-block;">Open Staging</a>';
      }

      for (const cat of catKeys) {
        const catFeatures = groups[cat];
        const catLabel = cat === '__uncategorized__' ? 'Uncategorized' : cat;
        const catId = 'cat-' + cat.replace(/[^a-zA-Z0-9]/g, '_');

        html += '<div class="category-group">';
        html += '<div class="category-header" onclick="toggleCategory(\\'' + catId + '\\')">';
        html += '<span class="category-arrow" id="arrow-' + catId + '">▼</span>';
        html += '<span class="category-name">' + escapeHtml(catLabel) + '</span>';
        html += '<span class="category-count">' + catFeatures.length + '</span>';
        html += '</div>';
        html += '<div class="category-body" id="body-' + catId + '">';

        // Group by subcategory within category
        const subgroups = {};
        for (const f of catFeatures) {
          const sub = f.subcategory || '__none__';
          if (!subgroups[sub]) subgroups[sub] = [];
          subgroups[sub].push(f);
        }
        const subKeys = Object.keys(subgroups).sort((a, b) => {
          if (a === '__none__') return -1;
          if (b === '__none__') return 1;
          return a.localeCompare(b);
        });

        html += '<table class="status-table"><thead><tr>';
        html += '<th style="width:30%">Feature</th><th style="width:12%">Status</th><th style="width:20%">Tested</th><th style="width:19%">Last Modified</th><th style="width:19%">Last Tested</th>';
        html += '</tr></thead><tbody>';

        for (const sub of subKeys) {
          if (sub !== '__none__') {
            html += '<tr><td colspan="5" class="subcategory-header">' + escapeHtml(sub) + '</td></tr>';
          }
          for (const f of subgroups[sub]) {
            const isStale = f.is_stale === 1;
            const dotClass = f.status === 'blocked' ? 'blocked' : f.status === 'not-started' ? 'not-started' : isStale ? 'stale' : 'ready';
            const testedBadge = f.last_test_type ? '<span class="tested-badge ' + f.last_test_type + '">' + f.last_test_target + ' (' + f.last_test_type + ')</span>' : '—';
            const pendingCount = pendingByFeature[f.id] || 0;

            html += '<tr>';
            html += '<td><span class="status-dot ' + dotClass + '"></span>' + escapeHtml(f.name);
            if (pendingCount > 0) html += '<span class="consideration-badge">' + pendingCount + '</span>';
            if (f.blocker) html += '<div class="blocker-text">' + escapeHtml(f.blocker) + '</div>';
            html += '</td>';
            html += '<td>' + escapeHtml(f.status) + '</td>';
            html += '<td>' + testedBadge;
            if (isStale) html += '<span class="stale-warning">code changed since test</span>';
            html += '</td>';
            html += '<td>' + formatDateTime(f.last_modified) + '</td>';
            html += '<td>' + formatDateTime(f.last_tested) + '</td>';
            html += '</tr>';
          }
        }

        html += '</tbody></table>';
        html += '</div></div>';
      }

      if (features.length === 0) {
        html += '<div class="empty-state"><p>No features yet</p></div>';
      }

      app.innerHTML = html;
    }

    function toggleCategory(catId) {
      const body = document.getElementById('body-' + catId);
      const arrow = document.getElementById('arrow-' + catId);
      if (body.classList.contains('collapsed')) {
        body.classList.remove('collapsed');
        arrow.classList.remove('collapsed');
      } else {
        body.classList.add('collapsed');
        arrow.classList.add('collapsed');
      }
    }

    function backToProjects(skipPush) {
      currentView = 'list';
      currentProject = null;
      loadProjects();
      if (!skipPush) {
        history.pushState({ tab: 'projects' }, '', '?tab=projects');
      }
      document.title = 'Projects - Ginger\\'s Dashboard';
    }

    // ============= UTILS =============

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
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
        if (currentTab === 'leads') loadLeads();
        else if (currentView === 'list') loadProjects();
        else if (currentProject) loadProject(currentProject.id, true);
      };
    }

    // Handle browser back/forward
    window.addEventListener('popstate', function(e) {
      if (e.state) {
        if (e.state.tab === 'leads') {
          currentTab = 'leads';
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelector('.tab[data-tab="leads"]').classList.add('active');
          loadLeads();
        } else if (e.state.tab === 'projects') {
          currentTab = 'projects';
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelector('.tab[data-tab="projects"]').classList.add('active');
          if (e.state.project) {
            loadProject(e.state.project, true);
          } else {
            backToProjects(true);
          }
        }
      }
    });

    function init() {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab') || 'leads';
      const projectId = params.get('project');

      currentTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[data-tab="' + tab + '"]').classList.add('active');

      if (tab === 'leads') {
        history.replaceState({ tab: 'leads' }, '', '/?tab=leads');
        document.title = 'Leads - Ginger\\'s Dashboard';
        loadLeads();
      } else {
        if (projectId) {
          history.replaceState({ tab: 'projects', project: projectId }, '', '?tab=projects&project=' + encodeURIComponent(projectId));
          loadProject(projectId, true);
        } else {
          history.replaceState({ tab: 'projects' }, '', '?tab=projects');
          document.title = 'Projects - Ginger\\'s Dashboard';
          loadProjects();
        }
      }
      connectWS();
    }

    init();
  </script>
</body>
</html>`;
}

export default app;
