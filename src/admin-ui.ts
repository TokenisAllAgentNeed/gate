/**
 * admin-ui.ts — Unified Admin Dashboard UI for Gate.
 *
 * Provides a single dashboard for:
 * 1. Viewing Gate ecash balance and melting to Lightning
 * 2. Metrics overview (requests, success rate, revenue, cost)
 * 3. Charts (revenue vs cost, error breakdown, model usage)
 * 4. Error analysis (recent API errors, token decode errors)
 *
 * Design: Modern dark theme, card-based layout, responsive.
 */
import type { Context, Handler } from "hono";

export interface AdminUiConfig {
  adminToken?: string;
}

import { timingSafeEqual } from "./lib/auth.js";

/**
 * Admin authentication helper.
 * Supports both Authorization header and ?token= query param for browser access.
 */
function requireAdminOrQuery(c: Context, adminToken?: string): Response | null {
  if (!adminToken) {
    return c.json({ error: "Admin endpoint not available" }, 503);
  }

  // Try query param first (for browser access)
  const queryToken = c.req.query("token");
  if (queryToken) {
    if (timingSafeEqual(queryToken, adminToken)) {
      return null; // Auth success
    }
    return c.json({ error: "Invalid token" }, 401);
  }

  // Try Authorization header
  const auth = c.req.header("Authorization");
  const expected = `Bearer ${adminToken}`;
  if (!auth || !timingSafeEqual(auth, expected)) {
    return c.json({ error: "Unauthorized — admin only" }, 401);
  }

  return null;
}

/**
 * Create the GET /homo/ui handler.
 *
 * Returns an HTML dashboard for Gate admin operations.
 */
export function createAdminUiRoute(config: AdminUiConfig): Handler {
  const { adminToken } = config;

  return async (c) => {
    // Auth check — support both header and query param
    const authErr = requireAdminOrQuery(c, adminToken);
    if (authErr) return authErr;

    return c.html(renderAdminDashboard());
  };
}

/**
 * Render inline HTML dashboard for Gate admin operations.
 */
export function renderAdminDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate Admin — token2chat</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-2: #1a1a25;
    --border: #2a2a3a;
    --border-light: #3a3a4a;
    --text: #e4e4ef;
    --text-muted: #8b8b9e;
    --accent: #6366f1;
    --accent-light: #818cf8;
    --green: #22c55e;
    --green-muted: rgba(34, 197, 94, 0.15);
    --red: #ef4444;
    --red-muted: rgba(239, 68, 68, 0.15);
    --yellow: #eab308;
    --yellow-muted: rgba(234, 179, 8, 0.15);
    --purple: #a855f7;
    --purple-muted: rgba(168, 85, 247, 0.15);
    --blue: #3b82f6;
    --blue-muted: rgba(59, 130, 246, 0.15);
    --orange: #f97316;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Helvetica, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }

  /* Header */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .header-title h1 {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
  }
  .header-title .badge {
    font-size: 0.7rem;
    padding: 2px 8px;
    background: var(--accent);
    color: white;
    border-radius: 12px;
    font-weight: 500;
  }
  .header-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  /* Main Content */
  .main { padding: 1.5rem; max-width: 1600px; margin: 0 auto; }

  /* Controls Bar */
  .controls-bar {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }
  .date-range {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    background: var(--surface);
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .date-range label {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .date-range input[type="date"] {
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.85rem;
  }

  /* Grid System */
  .grid { display: grid; gap: 1rem; margin-bottom: 1rem; }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-3 { grid-template-columns: repeat(3, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  .grid-1 { grid-template-columns: 1fr; }
  @media (max-width: 1200px) {
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    .grid-3 { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 768px) {
    .grid-4, .grid-3, .grid-2 { grid-template-columns: 1fr; }
    .main { padding: 1rem; }
  }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--border-light); }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.75rem;
  }
  .card-title {
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .card-icon {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
  }
  .card-icon.green { background: var(--green-muted); }
  .card-icon.yellow { background: var(--yellow-muted); }
  .card-icon.blue { background: var(--blue-muted); }
  .card-icon.purple { background: var(--purple-muted); }
  .card-icon.red { background: var(--red-muted); }

  /* Stats */
  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 0.25rem;
  }
  .stat-value.green { color: var(--green); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.blue { color: var(--blue); }
  .stat-value.purple { color: var(--purple); }
  .stat-value.red { color: var(--red); }
  .stat-value.accent { color: var(--accent-light); }
  .stat-sub {
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .stat-loading {
    height: 2rem;
    background: linear-gradient(90deg, var(--surface-2) 25%, var(--border) 50%, var(--surface-2) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
    width: 60%;
    margin-bottom: 0.25rem;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* Section Headers */
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 1.5rem 0 1rem;
  }
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .section-title .icon { font-size: 1.1rem; }

  /* Buttons */
  .btn {
    padding: 0.5rem 1rem;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-light); }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-danger:hover { background: #dc2626; }
  .btn-secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--border); }
  .btn-ghost { background: transparent; color: var(--text-muted); }
  .btn-ghost:hover { color: var(--text); background: var(--surface-2); }
  .btn-sm { padding: 0.35rem 0.75rem; font-size: 0.8rem; }

  /* Inputs */
  input[type="text"], input[type="password"], textarea {
    width: 100%;
    padding: 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.9rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
    transition: border-color 0.2s;
  }
  input:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea { resize: vertical; min-height: 100px; }
  .form-group { margin-bottom: 1rem; }
  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.85rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  /* Messages */
  .msg {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin: 0.75rem 0;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .msg-error { background: var(--red-muted); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }
  .msg-success { background: var(--green-muted); color: var(--green); border: 1px solid rgba(34, 197, 94, 0.3); }
  .msg-warning { background: var(--yellow-muted); color: var(--yellow); border: 1px solid rgba(234, 179, 8, 0.3); }

  /* Pills */
  .pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 16px;
    font-size: 0.75rem;
    font-weight: 600;
    gap: 4px;
  }
  .pill-green { background: var(--green-muted); color: var(--green); }
  .pill-red { background: var(--red-muted); color: var(--red); }
  .pill-yellow { background: var(--yellow-muted); color: var(--yellow); }
  .pill-purple { background: var(--purple-muted); color: var(--purple); }
  .pill-blue { background: var(--blue-muted); color: var(--blue); }
  .pill-gray { background: var(--surface-2); color: var(--text-muted); }

  /* Bar Chart */
  .bar-chart { display: flex; flex-direction: column; gap: 0.75rem; }
  .bar-row { display: flex; align-items: center; gap: 0.75rem; }
  .bar-label {
    min-width: 100px;
    font-size: 0.8rem;
    color: var(--text-muted);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-track {
    flex: 1;
    height: 24px;
    background: var(--surface-2);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  .bar-fill {
    height: 100%;
    border-radius: 6px;
    transition: width 0.5s ease-out;
    position: relative;
  }
  .bar-fill::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%);
  }
  .bar-value {
    min-width: 70px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }

  /* Error List */
  .error-list { max-height: 400px; overflow-y: auto; }
  .error-item {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.2s;
  }
  .error-item:hover { background: var(--surface-2); }
  .error-item:last-child { border-bottom: none; }
  .error-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .error-time { font-size: 0.75rem; color: var(--text-muted); }
  .error-model { font-size: 0.8rem; color: var(--text); }
  .error-detail {
    display: none;
    padding: 0.75rem;
    margin-top: 0.75rem;
    background: var(--bg);
    border-radius: 8px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .error-item.open .error-detail { display: block; }

  /* Token Error List */
  .token-error-list { max-height: 500px; overflow-y: auto; }
  .token-error-item {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.2s;
  }
  .token-error-item:hover { background: var(--surface-2); }
  .token-error-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .token-error-preview {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .token-error-detail {
    display: none;
    padding: 0.75rem;
    margin-top: 0.75rem;
    background: var(--bg);
    border-radius: 8px;
  }
  .token-error-item.open .token-error-detail { display: block; }
  .token-field { margin: 0.5rem 0; }
  .token-field-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 2px;
  }
  .token-field-value {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    word-break: break-all;
    background: var(--surface-2);
    padding: 0.5rem;
    border-radius: 4px;
  }

  /* Melt Result */
  .melt-result {
    background: var(--bg);
    border-radius: 8px;
    padding: 1rem;
    margin-top: 0.75rem;
  }
  .melt-result-row {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }
  .melt-result-row:last-child { border-bottom: none; }
  .melt-result-label { color: var(--text-muted); font-size: 0.85rem; }
  .melt-result-value { font-weight: 600; }
  .melt-result-value.success { color: var(--green); }
  .melt-result-value.amount { color: var(--yellow); }

  /* History */
  .history-list { max-height: 300px; overflow-y: auto; }
  .history-item {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .history-item:hover { background: var(--surface-2); }
  .history-time { color: var(--text-muted); font-size: 0.75rem; }

  /* Auth Screen */
  .auth-screen {
    max-width: 400px;
    margin: 15vh auto;
    padding: 2rem;
    text-align: center;
  }
  .auth-logo {
    font-size: 3rem;
    margin-bottom: 1rem;
  }
  .auth-title {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .auth-subtitle {
    color: var(--text-muted);
    margin-bottom: 2rem;
  }
  .auth-input {
    margin-bottom: 1rem;
  }
  .auth-input input {
    text-align: center;
  }

  /* Loading States */
  .loading-text {
    color: var(--text-muted);
    text-align: center;
    padding: 2rem;
  }
  .spinner {
    display: inline-block;
    width: 18px;
    height: 18px;
    border: 2px solid var(--border);
    border-radius: 50%;
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Alert Banner */
  .alert-banner {
    background: var(--red-muted);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.5rem;
    display: none;
  }
  .alert-banner.visible { display: flex; align-items: center; gap: 1rem; }
  .alert-icon { font-size: 1.5rem; }
  .alert-content { flex: 1; }
  .alert-title { font-weight: 600; color: var(--red); }
  .alert-text { font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }
  .alert-text a { color: var(--accent-light); }

  /* Pie Chart */
  .pie-container { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
  .pie-legend { flex: 1; min-width: 120px; }
  .pie-legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    font-size: 0.85rem;
  }
  .pie-legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  .pie-legend-count { color: var(--text-muted); font-size: 0.8rem; }

  /* Copy Button */
  .copy-btn {
    font-size: 0.7rem;
    padding: 2px 8px;
    background: var(--border);
    border: none;
    border-radius: 4px;
    color: var(--text-muted);
    cursor: pointer;
    margin-left: 0.5rem;
  }
  .copy-btn:hover { background: var(--accent); color: white; }

  /* Filter Controls */
  .filter-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .filter-bar select {
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.8rem;
  }

  /* Summary Pills */
  .summary-pills {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
</style>
</head>
<body>

<!-- Auth Screen -->
<div id="auth" class="auth-screen" style="display:none">
  <div class="auth-logo">⚡</div>
  <div class="auth-title">Gate Admin</div>
  <div class="auth-subtitle">Enter your admin token to continue</div>
  <div class="auth-input">
    <input type="password" id="token-input" placeholder="Admin token" />
  </div>
  <button class="btn btn-primary" onclick="authenticate()" style="width:100%">Login</button>
  <div id="auth-error" class="msg msg-error" style="display:none"></div>
</div>

<!-- Loading Screen -->
<div id="loading" class="auth-screen" style="display:none">
  <div class="auth-logo">⚡</div>
  <div class="auth-title">Gate Admin</div>
  <div class="auth-subtitle"><span class="spinner"></span> Authenticating...</div>
</div>

<!-- Dashboard -->
<div id="dashboard" style="display:none">

  <!-- Header -->
  <header class="header">
    <div class="header-title">
      <h1>⚡ Gate Admin</h1>
      <span class="badge">token2chat</span>
    </div>
    <div class="header-actions">
      <button class="btn btn-secondary btn-sm" onclick="refreshAll()">🔄 Refresh All</button>
      <button class="btn btn-ghost btn-sm" onclick="logout()">Logout</button>
    </div>
  </header>

  <main class="main">
    <!-- Alert Banner for Token Errors -->
    <div id="token-error-banner" class="alert-banner">
      <div class="alert-icon">⚠️</div>
      <div class="alert-content">
        <div class="alert-title">Token Decode Errors Detected</div>
        <div class="alert-text">
          <span id="token-error-count">0</span> parsing failures in the last 24h.
          <a href="#token-errors-section">View details ↓</a>
        </div>
      </div>
    </div>

    <!-- Controls Bar -->
    <div class="controls-bar">
      <div class="date-range">
        <label>From</label>
        <input type="date" id="date-from" />
        <label>To</label>
        <input type="date" id="date-to" />
        <button class="btn btn-sm btn-secondary" onclick="loadMetrics()">Apply</button>
      </div>
    </div>

    <!-- Summary Cards -->
    <div class="grid grid-4">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Total Requests</span>
          <div class="card-icon blue">📊</div>
        </div>
        <div class="stat-value accent" id="s-total"><div class="stat-loading"></div></div>
        <div class="stat-sub" id="s-total-sub">Loading...</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Success Rate</span>
          <div class="card-icon green">✓</div>
        </div>
        <div class="stat-value green" id="s-rate"><div class="stat-loading"></div></div>
        <div class="stat-sub" id="s-rate-sub">Loading...</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Revenue</span>
          <div class="card-icon yellow">💰</div>
        </div>
        <div class="stat-value yellow" id="s-revenue"><div class="stat-loading"></div></div>
        <div class="stat-sub" id="s-revenue-sub">Loading...</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Ecash Balance</span>
          <div class="card-icon purple">⚡</div>
        </div>
        <div class="stat-value purple" id="s-balance"><div class="stat-loading"></div></div>
        <div class="stat-sub" id="s-balance-sub">Loading...</div>
      </div>
    </div>

    <!-- Melt Section -->
    <div class="section-header">
      <h2 class="section-title"><span class="icon">⚡</span> Melt to Lightning</h2>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">
          Convert Gate ecash balance to Lightning by paying an invoice.
        </p>
        <form id="melt-form" onsubmit="handleMelt(event)">
          <div class="form-group">
            <label for="invoice">Lightning Invoice (bolt11)</label>
            <textarea id="invoice" name="invoice" placeholder="lnbc..." required></textarea>
          </div>
          <button type="submit" class="btn btn-danger" id="melt-btn">🔥 Melt All</button>
        </form>
        <div id="melt-status"></div>
        <div id="melt-result" style="display:none"></div>
      </div>
      <div class="card">
        <h3 style="font-size:0.9rem;color:var(--text-muted);margin-bottom:0.75rem">📜 Session History</h3>
        <div id="history-list" class="history-list">
          <p class="loading-text">No operations in this session yet.</p>
        </div>
      </div>
    </div>

    <!-- Charts Section -->
    <div class="section-header">
      <h2 class="section-title"><span class="icon">📈</span> Analytics</h2>
    </div>
    <div class="grid grid-3">
      <div class="card">
        <h3 style="font-size:0.9rem;margin-bottom:1rem;color:var(--text-muted)">Revenue vs Cost</h3>
        <div id="revenue-chart" class="bar-chart">
          <div class="loading-text"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
      <div class="card">
        <h3 style="font-size:0.9rem;margin-bottom:1rem;color:var(--text-muted)">Error Breakdown</h3>
        <div id="error-chart">
          <div class="loading-text"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
      <div class="card">
        <h3 style="font-size:0.9rem;margin-bottom:1rem;color:var(--text-muted)">Model Usage</h3>
        <div id="model-chart" class="bar-chart">
          <div class="loading-text"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
    </div>

    <!-- Errors Section -->
    <div class="section-header">
      <h2 class="section-title"><span class="icon">🔴</span> Error Analysis</h2>
    </div>
    <div class="grid grid-2">
      <div class="card">
        <h3 style="font-size:0.9rem;margin-bottom:0.75rem;color:var(--text-muted)">Recent API Errors</h3>
        <div id="error-list" class="error-list">
          <div class="loading-text"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
      <div class="card" id="token-errors-section">
        <h3 style="font-size:0.9rem;margin-bottom:0.75rem;color:var(--text-muted)">Token Decode Errors</h3>
        <div class="filter-bar">
          <select id="token-error-filter" onchange="renderTokenErrors()">
            <option value="all">All Versions</option>
            <option value="V3">V3 Only</option>
            <option value="V4">V4 Only</option>
            <option value="unknown">Unknown</option>
          </select>
          <button class="btn btn-sm btn-ghost" onclick="loadTokenErrors()">Refresh</button>
        </div>
        <div id="token-error-summary" class="summary-pills"></div>
        <div id="token-error-list" class="token-error-list">
          <div class="loading-text"><span class="spinner"></span> Loading...</div>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const STORAGE_KEY = 'adminToken';
let TOKEN = '';
const API = '';
let tokenErrorsData = [];
const sessionHistory = [];

// ── Init ────────────────────────────────────────────────────────
(function init() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  
  if (urlToken) {
    document.getElementById('loading').style.display = 'block';
    validateAndStore(urlToken);
    return;
  }
  
  const storedToken = localStorage.getItem(STORAGE_KEY);
  if (storedToken) {
    document.getElementById('loading').style.display = 'block';
    validateAndStore(storedToken);
    return;
  }
  
  document.getElementById('auth').style.display = 'block';
})();

function validateAndStore(token) {
  fetch(API + '/homo/balance', {
    headers: { Authorization: 'Bearer ' + token }
  }).then(r => {
    if (r.status === 401 || r.status === 503) {
      localStorage.removeItem(STORAGE_KEY);
      document.getElementById('loading').style.display = 'none';
      document.getElementById('auth').style.display = 'block';
      if (r.status === 401) {
        showAuthError('Session expired. Please login again.');
      }
      if (window.location.search.includes('token=')) {
        history.replaceState(null, '', window.location.pathname);
      }
      return;
    }
    TOKEN = token;
    localStorage.setItem(STORAGE_KEY, token);
    if (window.location.search.includes('token=')) {
      history.replaceState(null, '', window.location.pathname);
    }
    document.getElementById('loading').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    initDashboard();
    return r.json();
  }).then(data => {
    if (data) {
      renderBalance(data);
    }
  }).catch(e => {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('auth').style.display = 'block';
    showAuthError('Connection failed: ' + e.message);
  });
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'flex';
}

function authenticate() {
  const inputToken = document.getElementById('token-input').value.trim();
  if (!inputToken) return;
  document.getElementById('auth').style.display = 'none';
  document.getElementById('loading').style.display = 'block';
  document.getElementById('auth-error').style.display = 'none';
  validateAndStore(inputToken);
}

function logout() {
  localStorage.removeItem(STORAGE_KEY);
  TOKEN = '';
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('auth').style.display = 'block';
  document.getElementById('token-input').value = '';
  document.getElementById('auth-error').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  const tokenInput = document.getElementById('token-input');
  if (tokenInput) {
    tokenInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') authenticate();
    });
  }
});

// ── Dashboard Init ──────────────────────────────────────────────
function initDashboard() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('date-from').value = today;
  document.getElementById('date-to').value = today;
  
  // Load all data in parallel for fast initial render
  Promise.all([
    loadMetrics(),
    loadTokenErrors(),
  ]);
}

function refreshAll() {
  loadBalance();
  loadMetrics();
  loadTokenErrors();
}

// ── API Helpers ─────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = {
    ...options.headers,
    'Authorization': 'Bearer ' + TOKEN,
  };
  const res = await fetch(API + path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || 'Request failed: ' + res.status);
  }
  return res.json();
}

// ── Balance ─────────────────────────────────────────────────────
async function loadBalance() {
  document.getElementById('s-balance').innerHTML = '<div class="stat-loading"></div>';
  document.getElementById('s-balance-sub').textContent = 'Loading...';
  
  try {
    const data = await apiFetch('/homo/balance');
    renderBalance(data);
  } catch (e) {
    document.getElementById('s-balance').textContent = '—';
    document.getElementById('s-balance-sub').textContent = e.message;
  }
}

function renderBalance(data) {
  document.getElementById('s-balance').textContent = data.balance_units.toLocaleString() + ' sat';
  document.getElementById('s-balance-sub').textContent = 
    data.proof_count + ' proofs • ' + data.entry_count + ' entries';
}

// ── Metrics ─────────────────────────────────────────────────────
async function loadMetrics() {
  const from = document.getElementById('date-from').value;
  const to = document.getElementById('date-to').value;
  
  try {
    const [summary, errors] = await Promise.all([
      apiFetch('/v1/gate/metrics/summary?from=' + from + '&to=' + to),
      apiFetch('/v1/gate/metrics/errors?date=' + to),
    ]);
    renderSummary(summary);
    renderRevenueChart(summary);
    renderErrorChart(summary);
    renderModelChart(summary);
    renderErrorList(errors.errors || []);
  } catch (e) {
    console.error('Failed to load metrics:', e);
  }
}

function renderSummary(s) {
  document.getElementById('s-total').textContent = s.total_requests.toLocaleString();
  const streamPct = s.total_requests > 0 ? ((s.stream_count / s.total_requests) * 100).toFixed(0) : 0;
  document.getElementById('s-total-sub').textContent = streamPct + '% streaming';
  
  const rate = s.total_requests > 0 ? ((s.success_count / s.total_requests) * 100).toFixed(1) : 0;
  document.getElementById('s-rate').textContent = rate + '%';
  document.getElementById('s-rate-sub').textContent = 
    s.success_count.toLocaleString() + ' succeeded • ' + (s.total_requests - s.success_count).toLocaleString() + ' failed';
  
  document.getElementById('s-revenue').textContent = s.ecash_received.toLocaleString() + ' sat';
  const profit = s.ecash_received - s.estimated_cost;
  const profitClass = profit >= 0 ? 'green' : 'red';
  document.getElementById('s-revenue-sub').innerHTML = 
    'Cost: ' + s.estimated_cost.toLocaleString() + ' • Profit: <span style="color:var(--' + profitClass + ')">' + 
    (profit >= 0 ? '+' : '') + profit.toLocaleString() + '</span>';
}

function renderRevenueChart(s) {
  const el = document.getElementById('revenue-chart');
  const max = Math.max(s.ecash_received, s.estimated_cost, 1);
  el.innerHTML = 
    barRow('Revenue', s.ecash_received, max, 'var(--green)') +
    barRow('Est. Cost', s.estimated_cost, max, 'var(--red)') +
    barRow('Profit', Math.max(0, s.ecash_received - s.estimated_cost), max, 'var(--accent)');
}

function barRow(label, value, max, color) {
  const pct = max > 0 ? (value / max * 100).toFixed(1) : 0;
  return '<div class="bar-row"><span class="bar-label">' + label + '</span>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
    '<span class="bar-value">' + value.toLocaleString() + ' sat</span></div>';
}

function renderErrorChart(s) {
  const el = document.getElementById('error-chart');
  const entries = Object.entries(s.error_breakdown || {});
  if (entries.length === 0) {
    el.innerHTML = '<p style="color:var(--green);text-align:center;padding:1rem">✅ No errors!</p>';
    return;
  }
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const colors = ['#ef4444','#eab308','#a855f7','#3b82f6','#22c55e','#f97316'];
  
  let svg = '<div class="pie-container"><svg viewBox="-1 -1 2 2" width="100" height="100" style="transform:rotate(-90deg)">';
  let legend = '<div class="pie-legend">';
  let offset = 0;
  
  entries.forEach(([code, count], i) => {
    const pct = count / total;
    const color = colors[i % colors.length];
    const x1 = Math.cos(2 * Math.PI * offset);
    const y1 = Math.sin(2 * Math.PI * offset);
    const x2 = Math.cos(2 * Math.PI * (offset + pct));
    const y2 = Math.sin(2 * Math.PI * (offset + pct));
    const largeArc = pct > 0.5 ? 1 : 0;
    svg += '<path d="M 0 0 L ' + x1 + ' ' + y1 + ' A 1 1 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z" fill="' + color + '"/>';
    legend += '<div class="pie-legend-item"><div class="pie-legend-dot" style="background:' + color + '"></div>' + 
      '<span>' + esc(code) + '</span><span class="pie-legend-count">' + count + '</span></div>';
    offset += pct;
  });
  svg += '</svg>';
  legend += '</div>';
  el.innerHTML = svg + legend + '</div>';
}

function renderModelChart(s) {
  const el = document.getElementById('model-chart');
  const entries = Object.entries(s.model_breakdown || {});
  if (entries.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);text-align:center">No data</p>';
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v.count));
  el.innerHTML = entries.map(([model, data]) => {
    const color = data.errors > 0 ? 'var(--yellow)' : 'var(--accent)';
    return barRow(model.split('/').pop(), data.count, max, color).replace(' sat', '');
  }).join('');
}

function renderErrorList(errors) {
  const el = document.getElementById('error-list');
  if (errors.length === 0) {
    el.innerHTML = '<p style="color:var(--green);text-align:center;padding:1rem">✅ No errors!</p>';
    return;
  }
  const recent = errors.slice(-20).reverse();
  el.innerHTML = recent.map(e => {
    const time = new Date(e.ts).toLocaleTimeString();
    return '<div class="error-item" onclick="this.classList.toggle(' + "'open'" + ')">' +
      '<div class="error-header">' +
        '<span class="pill pill-red">' + esc(e.error_code || 'error') + '</span>' +
        '<span class="error-time">' + esc(time) + '</span>' +
        '<span class="error-model">' + esc(e.model) + '</span>' +
        '<span class="pill pill-gray">HTTP ' + esc(e.status) + '</span>' +
      '</div>' +
      '<div class="error-detail">' + esc(JSON.stringify(e, null, 2)) + '</div>' +
    '</div>';
  }).join('');
}

// ── Token Errors ────────────────────────────────────────────────
async function loadTokenErrors() {
  try {
    const [errors, summary] = await Promise.all([
      apiFetch('/v1/gate/token-errors?limit=100'),
      apiFetch('/v1/gate/token-errors/summary'),
    ]);
    tokenErrorsData = errors.errors || [];
    
    const banner = document.getElementById('token-error-banner');
    const countSpan = document.getElementById('token-error-count');
    countSpan.textContent = summary.recentCount24h;
    if (summary.recentCount24h > 0) {
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
    }
    
    renderTokenErrorSummary(summary);
    renderTokenErrors();
  } catch (e) {
    console.error('Failed to load token errors:', e);
    document.getElementById('token-error-list').innerHTML = 
      '<p style="color:var(--red);padding:1rem">Failed to load: ' + esc(e.message) + '</p>';
  }
}

function renderTokenErrorSummary(summary) {
  const el = document.getElementById('token-error-summary');
  let html = '';
  
  for (const [version, count] of Object.entries(summary.byVersion || {})) {
    const pillClass = version === 'V4' ? 'pill-purple' : version === 'V3' ? 'pill-blue' : 'pill-yellow';
    html += '<span class="pill ' + pillClass + '">' + version + ': ' + count + '</span>';
  }
  
  for (const [errType, count] of Object.entries(summary.byError || {})) {
    html += '<span class="pill pill-red">' + esc(errType) + ': ' + count + '</span>';
  }
  
  el.innerHTML = html || '<span style="color:var(--text-muted);font-size:0.8rem">No errors</span>';
}

function renderTokenErrors() {
  const el = document.getElementById('token-error-list');
  const filter = document.getElementById('token-error-filter').value;
  
  let filtered = tokenErrorsData;
  if (filter !== 'all') {
    filtered = tokenErrorsData.filter(e => e.tokenVersion === filter);
  }
  
  if (filtered.length === 0) {
    el.innerHTML = '<p style="color:var(--green);text-align:center;padding:1rem">✅ No token errors!</p>';
    return;
  }
  
  el.innerHTML = filtered.map((e, i) => {
    const time = new Date(e.ts).toLocaleString();
    const versionClass = e.tokenVersion === 'V4' ? 'pill-purple' : e.tokenVersion === 'V3' ? 'pill-blue' : 'pill-yellow';
    const tokenPreview = e.rawToken ? e.rawToken.slice(0, 50) + (e.rawToken.length > 50 ? '...' : '') : e.rawPrefix;
    
    return '<div class="token-error-item" onclick="this.classList.toggle(' + "'open'" + ')">' +
      '<div class="token-error-header">' +
        '<span class="pill ' + versionClass + '">' + esc(e.tokenVersion) + '</span>' +
        '<span style="color:var(--text-muted);font-size:0.75rem">' + esc(time) + '</span>' +
        '<span class="pill pill-red">' + esc(e.error) + '</span>' +
      '</div>' +
      '<div class="token-error-preview">' + esc(tokenPreview) + '</div>' +
      '<div class="token-error-detail">' +
        '<div class="token-field">' +
          '<div class="token-field-label">Timestamp</div>' +
          '<div class="token-field-value">' + esc(time) + ' (' + e.ts + ')</div>' +
        '</div>' +
        '<div class="token-field">' +
          '<div class="token-field-label">Token Version</div>' +
          '<div class="token-field-value">' + esc(e.tokenVersion) + '</div>' +
        '</div>' +
        '<div class="token-field">' +
          '<div class="token-field-label">Error</div>' +
          '<div class="token-field-value">' + esc(e.error) + '</div>' +
        '</div>' +
        '<div class="token-field">' +
          '<div class="token-field-label">Decode Time</div>' +
          '<div class="token-field-value">' + e.decodeTimeMs.toFixed(2) + ' ms</div>' +
        '</div>' +
        (e.userAgent ? '<div class="token-field"><div class="token-field-label">User Agent</div><div class="token-field-value">' + esc(e.userAgent) + '</div></div>' : '') +
        (e.ipHash ? '<div class="token-field"><div class="token-field-label">IP Hash</div><div class="token-field-value">' + esc(e.ipHash) + '</div></div>' : '') +
        '<div class="token-field">' +
          '<div class="token-field-label">Raw Token <button class="copy-btn" onclick="event.stopPropagation();copyToClipboard(' + "'" + escJS(e.rawToken || e.rawPrefix) + "'" + ')">Copy</button></div>' +
          '<div class="token-field-value" style="max-height:150px;overflow-y:auto">' + esc(e.rawToken || e.rawPrefix) + '</div>' +
        '</div>' +
        (e.rawCborStructure ? '<div class="token-field"><div class="token-field-label">CBOR Structure</div><div class="token-field-value" style="white-space:pre-wrap;max-height:200px;overflow-y:auto">' + esc(e.rawCborStructure) + '</div></div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(e => console.error('Copy failed:', e));
}

function escJS(str) {
  if (!str) return '';
  return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/\\n/g, '\\\\n');
}

// ── Melt ────────────────────────────────────────────────────────
async function handleMelt(event) {
  event.preventDefault();
  
  const invoice = document.getElementById('invoice').value.trim();
  if (!invoice) return;
  
  const btn = document.getElementById('melt-btn');
  const status = document.getElementById('melt-status');
  const result = document.getElementById('melt-result');
  
  btn.disabled = true;
  btn.textContent = '⏳ Melting...';
  status.innerHTML = '<div class="msg msg-warning"><span class="spinner"></span> Submitting to mint...</div>';
  result.style.display = 'none';
  
  try {
    const data = await apiFetch('/homo/melt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoice }),
    });
    
    status.innerHTML = '<div class="msg msg-success">✅ Melt successful!</div>';
    result.style.display = 'block';
    result.innerHTML = renderMeltResult(data);
    
    sessionHistory.unshift({
      ts: Date.now(),
      type: 'melt',
      success: data.success,
      amount_units: data.amount_units,
      fee_units: data.fee_units,
      preimage: data.payment_preimage,
    });
    renderHistory();
    
    document.getElementById('invoice').value = '';
    loadBalance();
    
  } catch (e) {
    status.innerHTML = '<div class="msg msg-error">❌ ' + esc(e.message) + '</div>';
    result.style.display = 'none';
    
    sessionHistory.unshift({
      ts: Date.now(),
      type: 'melt',
      success: false,
      error: e.message,
    });
    renderHistory();
  } finally {
    btn.disabled = false;
    btn.textContent = '🔥 Melt All';
  }
}

function renderMeltResult(data) {
  return '<div class="melt-result">' +
    '<div class="melt-result-row"><span class="melt-result-label">Status</span><span class="melt-result-value success">' + (data.success ? '✅ Paid' : '❌ Failed') + '</span></div>' +
    '<div class="melt-result-row"><span class="melt-result-label">Amount</span><span class="melt-result-value amount">' + data.amount_units.toLocaleString() + ' sats</span></div>' +
    '<div class="melt-result-row"><span class="melt-result-label">Fee</span><span class="melt-result-value">' + data.fee_units + ' sats</span></div>' +
    '<div class="melt-result-row"><span class="melt-result-label">Input</span><span class="melt-result-value">' + data.input_units.toLocaleString() + ' sats</span></div>' +
    (data.change_units > 0 ? '<div class="melt-result-row"><span class="melt-result-label">Change</span><span class="melt-result-value">' + data.change_units + ' sats</span></div>' : '') +
    (data.payment_preimage ? '<div class="melt-result-row"><span class="melt-result-label">Preimage</span><span class="melt-result-value" style="font-size:0.75rem;word-break:break-all">' + esc(data.payment_preimage) + '</span></div>' : '') +
    '</div>';
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (sessionHistory.length === 0) {
    el.innerHTML = '<p class="loading-text">No operations in this session yet.</p>';
    return;
  }
  
  el.innerHTML = sessionHistory.slice(0, 20).map(h => {
    const time = new Date(h.ts).toLocaleTimeString();
    const pillClass = h.success ? 'pill-green' : 'pill-red';
    const pillText = h.success ? 'Success' : 'Failed';
    
    if (h.type === 'melt') {
      if (h.success) {
        return '<div class="history-item">' +
          '<span class="pill ' + pillClass + '">' + pillText + '</span>' +
          '<span class="history-time">' + time + '</span>' +
          '<span>Melted <strong>' + h.amount_units.toLocaleString() + ' sats</strong> (fee: ' + h.fee_units + ' sats)</span>' +
          '</div>';
      } else {
        return '<div class="history-item">' +
          '<span class="pill ' + pillClass + '">' + pillText + '</span>' +
          '<span class="history-time">' + time + '</span>' +
          '<span style="color:var(--red)">' + esc(h.error) + '</span>' +
          '</div>';
      }
    }
    return '';
  }).join('');
}

// ── Utils ───────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}
