(function () {
    // ===== AUTH CHECK =====
    const token = localStorage.getItem('hk_token');
    const username = localStorage.getItem('hk_user') || 'admin';
    if (!token) { window.location.href = '/'; return; }

    document.getElementById('userNameEl').textContent = username;
    document.getElementById('userAvatar').textContent = username[0].toUpperCase();

    // ===== STATE =====
    let apps = {};
    let allLogs = [];
    let pendingList = {};   // requestId -> meta
    let currentFilter = 'all';
    let searchQuery = '';

    // ===== SOCKET.IO =====
    const socket = io({ auth: { token } });

    socket.on('connect_error', () => { showToast('error', 'Connection error'); });
    // Suppress disconnect toast when user deliberately navigates away / logs out
    let _intentionalLeave = false;
    window.addEventListener('beforeunload', () => { _intentionalLeave = true; });
    socket.on('disconnect', () => { if (!_intentionalLeave) showToast('error', 'Disconnected from server'); });

    socket.on('init', (data) => {
        apps = {};
        data.apps.forEach(a => { apps[a.id] = a; });
        allLogs = data.logs || [];
        pendingList = {};
        (data.pending || []).forEach(p => { pendingList[p.requestId] = p; });
        renderAll();
        renderPending();
        // Show dashboard approval panel if any pending exist on load
        const section = document.getElementById('dashApprovalSection');
        if (section) section.style.display = Object.keys(pendingList).length > 0 ? 'block' : 'none';
    });

    socket.on('app:update', (app) => {
        const prev = apps[app.id];
        const wasOnline = prev?.status === 'online';
        const wasOffline = prev?.status === 'offline';
        apps[app.id] = app;
        renderAll();
        // Only toast on status transitions, not on regular pings
        if (!prev && app.status === 'online') showToast('success', `${app.name} connected`);
        else if (wasOffline && app.status === 'online') showToast('success', `${app.name} back online`);
        else if (wasOnline && app.status === 'offline') showToast('error', `${app.name} went offline`);
    });

    socket.on('app:offline', (app) => {
        // server uses app:update for offline — kept for backward compat
        const prev = apps[app.id];
        apps[app.id] = app;
        renderAll();
        if (prev?.status === 'online') showToast('error', `${app.name} went offline`);
    });

    socket.on('app:delete', ({ id }) => {
        delete apps[id];
        renderAll();
    });

    socket.on('log:new', (entry) => {
        allLogs.unshift(entry);
        if (allLogs.length > 200) allLogs.pop();
        renderLogs();
        updateStatLogs();
    });

    // Clear events from server
    socket.on('logs:cleared', () => { allLogs = []; renderLogs(); updateStatLogs(); });
    socket.on('apps:cleared', () => { apps = {}; renderAll(); });

    // ===== APPROVAL SOCKET EVENTS =====
    socket.on('approval:request', (meta) => {
        pendingList[meta.requestId] = meta;
        renderPending();
        updatePendingBadge();
        // Show inline dashboard panel
        const section = document.getElementById('dashApprovalSection');
        const msg = document.getElementById('dashApprovalAlertMsg');
        if (section) { section.style.display = 'block'; }
        if (msg) msg.textContent = `⚠ New connection waiting: ${meta.name} from ${meta.ip}`;
        showToast('error', `🔔 Approval needed: ${meta.name}`);
    });

    socket.on('approval:resolved', ({ requestId, approved }) => {
        delete pendingList[requestId];
        renderPending();
        updatePendingBadge();
        if (Object.keys(pendingList).length === 0) {
            const section = document.getElementById('dashApprovalSection');
            if (section) section.style.display = 'none';
        }
    });

    socket.on('approval:timeout', ({ requestId }) => {
        delete pendingList[requestId];
        renderPending();
        updatePendingBadge();
        showToast('error', 'Approval timed out');
        if (Object.keys(pendingList).length === 0) {
            const section = document.getElementById('dashApprovalSection');
            if (section) section.style.display = 'none';
        }
    });

    // Client disconnected while waiting for approval
    socket.on('approval:disconnected', ({ requestId, name }) => {
        if (pendingList[requestId]) {
            pendingList[requestId]._disconnected = true;
            renderPending();
            updatePendingBadge();
            showToast('error', `${name} disconnected while pending`);
        } else {
            // already removed – just hide section if empty
            if (Object.keys(pendingList).length === 0) {
                const section = document.getElementById('dashApprovalSection');
                if (section) section.style.display = 'none';
            }
        }
    });

    socket.on('stats:update', (stats) => {
        document.getElementById('statTotal').textContent = stats.total;
        document.getElementById('statOnline').textContent = stats.online;
        document.getElementById('statOffline').textContent = stats.offline;
        document.getElementById('appCount').textContent = stats.total;
        const sysApps = document.getElementById('sysApps');
        if (sysApps) sysApps.textContent = stats.total;
    });

    // ===== CLOCK =====
    setInterval(() => {
        const now = new Date();
        const t = now.toTimeString().split(' ')[0];
        const tEl = document.getElementById('topbarTime');
        const stEl = document.getElementById('sysTime');
        if (tEl) tEl.textContent = t;
        if (stEl) stEl.textContent = now.toLocaleString();
        // Only re-render table if any online apps (uptime changes)
        if (Object.values(apps).some(a => a.status === 'online')) {
            Object.values(apps).forEach(a => {
                if (a.status === 'online') {
                    a.totalUptimeSeconds = Math.floor((Date.now() - new Date(a.firstSeen).getTime()) / 1000);
                }
            });
            renderAppsTable();
        }
    }, 1000);

    // ===== RENDER =====
    function renderAll() {
        renderAppsTable();
        renderLogs();
        updateStatLogs();
    }

    function getFilteredApps() {
        return Object.values(apps).filter(a => {
            const matchFilter = currentFilter === 'all' || a.status === currentFilter;
            const matchSearch = !searchQuery || a.name.toLowerCase().includes(searchQuery) || a.id.toLowerCase().includes(searchQuery);
            return matchFilter && matchSearch;
        });
    }

    function renderAppsTable() {
        const filtered = getFilteredApps();
        const emptyMain = `<tr><td colspan="8"><div class="empty">
          <i class="ph ph-wifi-slash"></i>
          <div class="empty-title">No apps connected yet</div>
          <div class="empty-sub">GET /api/ping/:appId to register</div>
        </div></td></tr>`;
        const emptyFull = `<tr><td colspan="9"><div class="empty">
          <i class="ph ph-wifi-slash"></i>
          <div class="empty-title">No apps yet</div>
          <div class="empty-sub">GET /api/ping/:appId</div>
        </div></td></tr>`;
        const html = filtered.length ? filtered.map(a => appRow(a, false)).join('') : emptyMain;
        const html2 = filtered.length ? filtered.map(a => appRow(a, true)).join('') : emptyFull;
        document.getElementById('appsTableBody').innerHTML = html;
        document.getElementById('appsFullTableBody').innerHTML = html2;
        const total = Object.keys(apps).length;
        const online = Object.values(apps).filter(a => a.status === 'online').length;
        document.getElementById('appCount').textContent = total;
        document.getElementById('statTotal').textContent = total;
        document.getElementById('statOnline').textContent = online;
        document.getElementById('statOffline').textContent = total - online;
        const sysApps = document.getElementById('sysApps');
        if (sysApps) sysApps.textContent = total;
    }

    function appRow(a, full) {
        const uptime = formatUptime(a.totalUptimeSeconds || 0);
        const lastPing = timeAgo(a.lastPing);
        const firstSeen = full ? `<td class="td-mono">${formatDate(a.firstSeen)}</td>` : '';
        return `
      <tr onclick="window.viewApp('${a.id}')">
        <td><b>${esc(a.name)}</b>${a.version ? `<span style="font-size:10px;color:var(--text-muted);margin-left:6px">v${esc(a.version)}</span>` : ''}</td>
        <td class="td-mono" style="color:var(--text-muted)">${esc(a.id)}</td>
        <td><span class="badge ${a.status}"><span class="dot"></span>${a.status.toUpperCase()}</span></td>
        <td class="td-mono">${esc(a.ip)}</td>
        ${firstSeen}
        <td class="td-mono" style="color:var(--text-muted)">${lastPing}</td>
        <td class="td-mono">${a.totalPings}</td>
        <td class="td-mono" style="color:var(--success)">${uptime}</td>
        <td>
          <div class="td-actions" onclick="event.stopPropagation()">
            <button class="action-btn view" onclick="window.viewApp('${a.id}')" title="View">
              <i class="ph ph-eye"></i>
            </button>
            <button class="action-btn del" onclick="window.deleteApp('${a.id}')" title="Delete">
              <i class="ph ph-trash"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }

    function renderLogs() {
        const emptyHtml = `<div class="empty" style="padding:30px 20px"><i class="ph ph-list-dashes"></i><div class="empty-title">No logs yet</div></div>`;
        const emptyHtmlFull = `<div class="empty" style="padding:40px 20px"><i class="ph ph-files"></i><div class="empty-title">No events recorded yet</div></div>`;
        document.getElementById('logList').innerHTML = allLogs.length ? allLogs.slice(0, 50).map(logEntry).join('') : emptyHtml;
        document.getElementById('logListFull').innerHTML = allLogs.length ? allLogs.map(logEntry).join('') : emptyHtmlFull;
    }

    function logEntry(l) {
        const icons = {
            connect: `<i class="ph ph-check-circle"></i>`,
            ping: `<i class="ph ph-broadcast"></i>`,
            offline: `<i class="ph ph-x-circle"></i>`,
            delete: `<i class="ph ph-trash"></i>`,
            pending: `<i class="ph ph-clock"></i>`,
            reject: `<i class="ph ph-prohibit"></i>`,
        };
        const type = l.type || 'ping';
        return `<div class="log-entry">
      <div class="log-icon ${type}">${icons[type] || icons.ping}</div>
      <div class="log-body">
        <div class="log-msg">${esc(l.message)}</div>
        <div class="log-meta">${esc(l.appName)} · ${l.ip ? esc(l.ip) : ''}</div>
      </div>
      <div class="log-time">${timeAgo(l.timestamp)}</div>
    </div>`;
    }

    function updateStatLogs() {
        const logCount = allLogs.length;
        const statLogs = document.getElementById('statLogs');
        const sysLogs = document.getElementById('sysLogs');
        if (statLogs) statLogs.textContent = logCount;
        if (sysLogs) sysLogs.textContent = logCount;
    }

    // ===== NAVIGATION =====
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            item.classList.add('active');
            document.getElementById('page-' + page).classList.add('active');
            const titles = { dashboard: 'Dashboard', apps: 'Connected Apps', logs: 'Event Logs', approvals: 'Approvals', settings: 'Settings' };
            document.getElementById('topbarTitle').textContent = titles[page] || page;
        });
    });

    // ===== SEARCH + FILTER =====
    document.getElementById('searchInput')?.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderAppsTable();
    });
    document.querySelectorAll('[data-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderAppsTable();
        });
    });

    // ===== MODAL =====
    window.viewApp = function (id) {
        const a = apps[id]; if (!a) return;
        document.getElementById('modalTitle').textContent = a.name;
        const pingHist = (a.pingHistory || []).slice(0, 20).map(p =>
            `<div class="ping-history-item"><span>${formatDate(p.time)}</span><span class="ph-ip">${esc(p.ip)}</span></div>`
        ).join('') || '<div style="color:var(--text-muted);font-size:12px;padding:8px">No history</div>';
        document.getElementById('modalBody').innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-key">App ID</div><div class="detail-val">${esc(a.id)}</div></div>
        <div class="detail-item"><div class="detail-key">Status</div><div class="detail-val"><span class="badge ${a.status}"><span class="dot"></span>${a.status.toUpperCase()}</span></div></div>
        <div class="detail-item"><div class="detail-key">Version</div><div class="detail-val">${esc(a.version || '—')}</div></div>
        <div class="detail-item"><div class="detail-key">IP Address</div><div class="detail-val">${esc(a.ip)}</div></div>
        <div class="detail-item"><div class="detail-key">First Seen</div><div class="detail-val">${formatDate(a.firstSeen)}</div></div>
        <div class="detail-item"><div class="detail-key">Last Ping</div><div class="detail-val">${formatDate(a.lastPing)}</div></div>
        <div class="detail-item"><div class="detail-key">Total Pings</div><div class="detail-val">${a.totalPings}</div></div>
        <div class="detail-item"><div class="detail-key">Uptime</div><div class="detail-val" style="color:var(--success)">${formatUptime(a.totalUptimeSeconds || 0)}</div></div>
      </div>
      <div class="detail-item" style="margin-bottom:16px"><div class="detail-key" style="margin-bottom:4px">User Agent</div><div class="detail-val" style="font-size:11px;color:var(--text-muted)">${esc(a.userAgent || '—')}</div></div>
      <div class="ping-history-title">Recent Pings (last 20)</div>
      <div class="ping-history-list">${pingHist}</div>`;
        document.getElementById('modalOverlay').classList.add('open');
    };

    window.deleteApp = async function (id) {
        const a = apps[id]; if (!a) return;
        if (!confirm(`Delete app "${a.name}"?`)) return;
        try {
            const res = await fetch(`/api/apps/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
                delete apps[id];
                renderAll();
                showToast('success', `${a.name} deleted`);
            } else {
                showToast('error', 'Failed to delete');
            }
        } catch { showToast('error', 'Network error'); }
    };

    document.getElementById('modalClose').addEventListener('click', () => {
        document.getElementById('modalOverlay').classList.remove('open');
    });
    document.getElementById('modalOverlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
    });

    // ===== CLEAR LOGS (server-side persistent) =====
    document.getElementById('clearLogsBtn')?.addEventListener('click', async () => {
        try {
            await fetch('/api/logs', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
            showToast('success', 'Logs cleared');
        } catch { showToast('error', 'Failed to clear logs'); }
    });

    // ===== CLEAR ALL APPS =====
    document.getElementById('clearAllAppsBtn')?.addEventListener('click', async () => {
        if (!confirm('Clear ALL connected apps? This action cannot be undone.')) return;
        try {
            await fetch('/api/apps', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
            showToast('success', 'All apps cleared');
        } catch { showToast('error', 'Failed to clear apps'); }
    });

    // ===== EXPORT CSV =====
    document.getElementById('exportCsvBtn')?.addEventListener('click', () => {
        const rows = [['Time', 'Type', 'App', 'Message', 'IP']];
        allLogs.forEach(l => rows.push([l.timestamp, l.type, l.appName, l.message, l.ip]));
        const csv = rows.map(r => r.map(v => `"${(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'av4x04-logs.csv'; a.click();
        URL.revokeObjectURL(url);
        showToast('success', 'CSV exported');
    });

    // ===== SETTINGS =====
    document.getElementById('savePwBtn')?.addEventListener('click', async () => {
        const np = document.getElementById('newPw').value;
        const cp = document.getElementById('confirmPw').value;
        if (np !== cp) { showToast('error', 'Passwords do not match'); return; }
        if (np.length < 6) { showToast('error', 'Password too short (min 6)'); return; }
        try {
            const res = await fetch('/auth/change-password', {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ newPassword: np })
            });
            const d = await res.json();
            if (d.success) { showToast('success', 'Password updated!'); document.getElementById('newPw').value = ''; document.getElementById('confirmPw').value = ''; }
            else showToast('error', d.message);
        } catch { showToast('error', 'Network error'); }
    });

    // Update ping URL with current host
    document.getElementById('pingUrlBox').textContent = `${location.protocol}//${location.host}/api/ping/:appId?name=MyApp`;

    // ===== LOGOUT =====
    document.getElementById('btnLogout').addEventListener('click', () => {
        localStorage.removeItem('hk_token'); localStorage.removeItem('hk_user');
        window.location.href = '/';
    });

    // Live waiting-time ticker — updates approval cards every second
    setInterval(() => {
        const list = Object.values(pendingList);
        if (!list.length) return;
        list.forEach(p => {
            const el = document.getElementById(`pwait-${p.requestId}`);
            if (el) el.textContent = waitingTime(p.requestedAt);
        });
    }, 1000);

    function waitingTime(iso) {
        const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (sec < 60) return sec + 's';
        return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    }

    function renderPending() {
        const list = Object.values(pendingList);
        const el = document.getElementById('approvalList');
        if (!el) return;
        const countEl = document.getElementById('pendingCount');
        if (countEl) countEl.textContent = list.length;
        if (!list.length) {
            el.innerHTML = `<div class="empty" style="padding:40px 20px">
              <i class="ph ph-shield-check"></i>
              <div class="empty-title">No pending connections</div>
              <div class="empty-sub">New approvals will appear here instantly</div>
            </div>`;
            return;
        }
        el.innerHTML = list.map(p => {
            const payloadStr = p.payload && Object.keys(p.payload).length
                ? JSON.stringify(p.payload, null, 2) : null;
            const isDisconnected = !!p._disconnected;
            const waited = waitingTime(p.requestedAt);
            const statusBadge = isDisconnected
                ? `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(100,100,100,0.15);color:#888;padding:3px 12px;border-radius:999px;font-size:11px;font-family:JetBrains Mono,monospace;font-weight:600"><i class="ph ph-wifi-slash"></i> DISCONNECTED</span>`
                : `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,157,0,0.1);color:var(--warning);padding:3px 12px;border-radius:999px;font-size:11px;font-family:JetBrains Mono,monospace;font-weight:600"><i class="ph ph-clock"></i> PENDING</span>`;
            const waitBadge = isDisconnected
                ? `<span style="font-size:10px;color:#666;font-family:JetBrains Mono,monospace">waited ${waited}</span>`
                : `<span id="pwait-${p.requestId}" style="font-size:10px;color:var(--warning);font-family:JetBrains Mono,monospace">${waited}</span>`;
            const approveBtn = isDisconnected
                ? `<button class="btn-approve" disabled style="opacity:0.35;cursor:not-allowed"><i class="ph ph-check"></i> Approve</button>`
                : `<button class="btn-approve" onclick="approveConn('${p.requestId}')"><i class="ph ph-check"></i> Approve</button>`;
            const rejectBtn = isDisconnected
                ? `<button class="btn-reject" onclick="rejectConn('${p.requestId}')"><i class="ph ph-x"></i> Dismiss</button>`
                : `<button class="btn-reject" onclick="rejectConn('${p.requestId}')"><i class="ph ph-x"></i> Reject</button>`;
            return `<div class="approval-card" id="pcard-${p.requestId}" style="${isDisconnected ? 'opacity:0.7;border-color:rgba(100,100,100,0.25)' : ''}">
              <div class="approval-card-header">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  ${statusBadge}
                  <span style="font-size:15px;font-weight:700">${esc(p.name)}</span>
                  <span style="font-size:11px;color:var(--text-muted);font-family:JetBrains Mono,monospace">v${esc(p.version || '1.0')}</span>
                  ${waitBadge}
                </div>
                <div style="display:flex;gap:8px">
                  ${approveBtn}
                  ${rejectBtn}
                </div>
              </div>
              <div class="approval-meta">
                <div class="approval-meta-item">
                  <div class="approval-meta-label">APP ID</div>
                  <div class="approval-meta-val">${esc(p.appId)}</div>
                </div>
                <div class="approval-meta-item">
                  <div class="approval-meta-label">IP ADDRESS</div>
                  <div class="approval-meta-val" style="color:${isDisconnected ? '#666' : 'var(--success)'}">${esc(p.ip)}</div>
                </div>
                <div class="approval-meta-item">
                  <div class="approval-meta-label">REQUESTED AT</div>
                  <div class="approval-meta-val">${formatDate(p.requestedAt)}</div>
                </div>
              </div>
              ${payloadStr ? `<div class="payload-box">${esc(payloadStr)}</div>` : ''}
              ${isDisconnected ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(255,0,0,0.06);border-radius:8px;font-size:11px;color:#888;font-family:JetBrains Mono,monospace;display:flex;align-items:center;gap:6px"><i class="ph ph-warning-circle" style="color:var(--error)"></i> Client disconnected — cannot approve. Dismiss to remove.</div>` : ''}
            </div>`;
        }).join('');
    }

    function updatePendingBadge() {
        const count = Object.keys(pendingList).length;
        const badge = document.getElementById('pendingBadge');
        if (!badge) return;
        badge.textContent = count;
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    window.approveConn = async function (requestId) {
        const p = pendingList[requestId];
        if (p?._disconnected) { showToast('error', 'Client already disconnected'); return; }
        try {
            const res = await fetch(`/api/approve/${requestId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) showToast('success', 'Connection approved');
            else if (res.status === 404) {
                // Already gone (client disconnected between render and click)
                delete pendingList[requestId];
                renderPending(); updatePendingBadge();
                if (!Object.keys(pendingList).length) {
                    const s = document.getElementById('dashApprovalSection'); if (s) s.style.display = 'none';
                }
                showToast('error', 'Client already disconnected');
            } else showToast('error', 'Failed to approve');
        } catch { showToast('error', 'Network error'); }
    };

    window.rejectConn = async function (requestId) {
        const p = pendingList[requestId];
        // If disconnected, just remove from local list — server already removed it
        if (p?._disconnected) {
            delete pendingList[requestId];
            renderPending();
            updatePendingBadge();
            if (!Object.keys(pendingList).length) {
                const s = document.getElementById('dashApprovalSection'); if (s) s.style.display = 'none';
            }
            showToast('success', 'Dismissed');
            return;
        }
        try {
            const res = await fetch(`/api/reject/${requestId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) showToast('error', 'Connection rejected');
            else if (res.status === 404) {
                // Already gone
                delete pendingList[requestId];
                renderPending(); updatePendingBadge();
                if (!Object.keys(pendingList).length) {
                    const s = document.getElementById('dashApprovalSection'); if (s) s.style.display = 'none';
                }
                showToast('success', 'Dismissed (already gone)');
            } else showToast('error', 'Failed to reject');
        } catch { showToast('error', 'Network error'); }
    };

    // ===== TOAST =====
    let toastTimer;
    function showToast(type, msg) {
        const t = document.getElementById('toast');
        const i = document.getElementById('toastIcon');
        const m = document.getElementById('toastMsg');
        i.className = type === 'success' ? 'ph ph-check-circle' : 'ph ph-warning-circle';
        t.className = `toast ${type}`;
        m.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
    }

    // ===== UTILS =====
    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function formatUptime(sec) {
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
        return h + 'h ' + m + 'm';
    }
    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('vi-VN', { hour12: false });
    }
    function timeAgo(iso) {
        if (!iso) return '—';
        const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (diff < 5) return 'just now';
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        return Math.floor(diff / 86400) + 'd ago';
    }

})();
