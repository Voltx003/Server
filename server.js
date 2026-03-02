require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';
const HEARTBEAT_TIMEOUT = parseInt(process.env.HEARTBEAT_TIMEOUT || '30') * 1000;
const APPROVE_TIMEOUT = 120_000; // 2 min before auto-reject if not reviewed

// ===================== IN-MEMORY STORE =====================
const apps = new Map();  // appId -> appData
const logs = [];         // global log array
const pending = new Map();  // requestId -> { resolve, reject, meta, timer }

function createLog(type, appId, appName, message, ip = '') {
    const entry = {
        id: uuidv4(), type, appId, appName, message, ip,
        timestamp: new Date().toISOString()
    };
    logs.unshift(entry);
    if (logs.length > 500) logs.pop();
    io.emit('log:new', entry);
    return entry;
}

function broadcastStats() {
    const total = apps.size;
    const online = [...apps.values()].filter(a => a.status === 'online').length;
    io.emit('stats:update', { total, online, offline: total - online, pending: pending.size });
}

// ===================== HEARTBEAT WATCHDOG =====================
setInterval(() => {
    const now = Date.now();
    apps.forEach((appData, appId) => {
        if (appData.status === 'online' && now - appData.lastPingTime > HEARTBEAT_TIMEOUT) {
            appData.status = 'offline';
            appData.offlineAt = new Date().toISOString();
            appData.totalUptimeSeconds = Math.floor((now - appData.firstSeenTime) / 1000);
            createLog('offline', appId, appData.name, `App went offline (no heartbeat)`, appData.ip);
            io.emit('app:update', { ...appData });
            broadcastStats();
        }
    });
}, 5000);

// ===================== AUTH =====================
app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, username });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token' });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ message: 'Invalid token' }); }
}

// ===================== PING ENDPOINT — with approval gate =====================
app.all('/api/ping/:appId', (req, res) => {
    const { appId } = req.params;
    const name = req.query.name || req.body?.name || appId;
    const version = req.query.version || req.body?.version || '1.0';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const payload = req.body || {};
    const now = Date.now();

    const existingApp = apps.get(appId);

    // ── Already approved app: normal ping, no gate ──
    if (existingApp && existingApp.approved) {
        existingApp.status = 'online';
        existingApp.lastPing = new Date().toISOString();
        existingApp.lastPingTime = now;
        existingApp.ip = ip;
        existingApp.offlineAt = null;
        existingApp.totalPings++;
        existingApp.pingHistory.unshift({ time: new Date().toISOString(), ip });
        if (existingApp.pingHistory.length > 50) existingApp.pingHistory.pop();
        existingApp.totalUptimeSeconds = Math.floor((now - existingApp.firstSeenTime) / 1000);
        createLog('ping', appId, existingApp.name, `Ping received from ${existingApp.name}`, ip);
        io.emit('app:update', { ...existingApp });
        broadcastStats();
        return res.json({ status: 'ok', message: 'pong — payload transmitted', appId, name: existingApp.name, serverTime: new Date().toISOString() });
    }

    // ── New / not-yet-approved: queue for manual approval ──
    const requestId = uuidv4();
    const meta = { requestId, appId, name, version, ip, userAgent, payload, requestedAt: new Date().toISOString() };

    // Notify dashboard immediately
    io.emit('approval:request', meta);
    createLog('pending', appId, name, `⏳ Awaiting approval: ${name} v${version} from ${ip}`, ip);
    broadcastStats();

    // Long-poll: hold the HTTP connection until admin approves/rejects or timeout
    const timer = setTimeout(() => {
        if (pending.has(requestId)) {
            pending.delete(requestId);
            io.emit('approval:timeout', { requestId, appId });
            createLog('reject', appId, name, `⏰ Connection timeout (no admin response): ${name}`, ip);
            broadcastStats();
            try { res.status(408).json({ status: 'timeout', message: 'Approval timeout — connection rejected', appId }); } catch { }
        }
    }, APPROVE_TIMEOUT);

    const entry = {
        resolve: () => {
            clearTimeout(timer);
            pending.delete(requestId);
            if (entry._disconnected) return; // client already gone — don't register
            const newApp = {
                id: appId, name, version, status: 'online', approved: true,
                ip, userAgent, payload,
                firstSeen: new Date().toISOString(), firstSeenTime: now,
                lastPing: new Date().toISOString(), lastPingTime: now,
                offlineAt: null, totalPings: 1, totalUptimeSeconds: 0,
                pingHistory: [{ time: new Date().toISOString(), ip }]
            };
            apps.set(appId, newApp);
            createLog('connect', appId, name, `✅ Approved & connected: ${name} v${version}`, ip);
            io.emit('app:update', { ...newApp });
            io.emit('approval:resolved', { requestId, appId, approved: true });
            broadcastStats();
            try { res.json({ status: 'ok', message: '✅ Approved — payload transmitted', appId, name, serverTime: new Date().toISOString() }); } catch { }
        },
        reject: () => {
            clearTimeout(timer);
            pending.delete(requestId);
            createLog('reject', appId, name, `🚫 Rejected by admin: ${name}`, ip);
            io.emit('approval:resolved', { requestId, appId, approved: false });
            broadcastStats();
            try { res.status(403).json({ status: 'rejected', message: '🚫 Connection rejected by admin', appId }); } catch { }
        },
        _disconnected: false,
        meta, timer
    };
    pending.set(requestId, entry);

    // Detect client disconnect while waiting for approval
    req.on('close', () => {
        if (!pending.has(requestId)) return; // already handled
        const p = pending.get(requestId);
        if (p._disconnected) return;
        p._disconnected = true;
        clearTimeout(p.timer);
        pending.delete(requestId);
        io.emit('approval:disconnected', { requestId, appId, name });
        createLog('offline', appId, name, `📵 Client disconnected while awaiting approval: ${name}`, ip);
        broadcastStats();
    });
});

// ===================== APPROVAL ACTIONS (Admin) =====================
app.post('/api/approve/:requestId', authMiddleware, (req, res) => {
    const p = pending.get(req.params.requestId);
    if (!p) return res.status(404).json({ message: 'Request not found or already handled' });
    p.resolve();
    res.json({ success: true });
});

app.post('/api/reject/:requestId', authMiddleware, (req, res) => {
    const p = pending.get(req.params.requestId);
    if (!p) return res.status(404).json({ message: 'Request not found or already handled' });
    p.reject();
    res.json({ success: true });
});

// Get pending list
app.get('/api/pending', authMiddleware, (req, res) => {
    res.json({ pending: [...pending.values()].map(p => p.meta) });
});

// ===================== REST API (Protected) =====================
app.get('/api/apps', authMiddleware, (req, res) => {
    const appList = [...apps.values()].map(a => ({
        ...a,
        totalUptimeSeconds: a.status === 'online'
            ? Math.floor((Date.now() - a.firstSeenTime) / 1000)
            : a.totalUptimeSeconds
    }));
    res.json({ apps: appList });
});

app.get('/api/apps/:id', authMiddleware, (req, res) => {
    const a = apps.get(req.params.id);
    if (!a) return res.status(404).json({ message: 'App not found' });
    res.json({ ...a, totalUptimeSeconds: a.status === 'online' ? Math.floor((Date.now() - a.firstSeenTime) / 1000) : a.totalUptimeSeconds });
});

app.delete('/api/apps/:id', authMiddleware, (req, res) => {
    const a = apps.get(req.params.id);
    if (!a) return res.status(404).json({ message: 'App not found' });
    createLog('delete', req.params.id, a.name, `App deleted: ${a.name}`);
    apps.delete(req.params.id);
    io.emit('app:delete', { id: req.params.id });
    broadcastStats();
    res.json({ success: true });
});

app.get('/api/stats', authMiddleware, (req, res) => {
    const total = apps.size, online = [...apps.values()].filter(a => a.status === 'online').length;
    res.json({ total, online, offline: total - online, pending: pending.size, totalLogs: logs.length });
});

app.get('/api/logs', authMiddleware, (req, res) => res.json({ logs: logs.slice(0, 200) }));

app.delete('/api/logs', authMiddleware, (req, res) => {
    logs.length = 0; io.emit('logs:cleared'); res.json({ success: true });
});

app.delete('/api/apps', authMiddleware, (req, res) => {
    apps.clear(); io.emit('apps:cleared'); broadcastStats(); res.json({ success: true });
});

app.post('/auth/change-password', authMiddleware, (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'Password too short' });
    process.env.ADMIN_PASSWORD = newPassword;
    res.json({ success: true, message: 'Password changed' });
});

// ===================== SOCKET.IO =====================
io.on('connection', (socket) => {
    try {
        jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
        const appList = [...apps.values()].map(a => ({
            ...a,
            totalUptimeSeconds: a.status === 'online'
                ? Math.floor((Date.now() - a.firstSeenTime) / 1000)
                : a.totalUptimeSeconds
        }));
        const pendingList = [...pending.values()].map(p => p.meta);
        socket.emit('init', { apps: appList, logs: logs.slice(0, 50), pending: pendingList });
    } catch { socket.disconnect(); }
});

// ===================== SERVE FRONTEND =====================
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
    console.log(`\n🚀 AV4X04 Monitor running at http://localhost:${PORT}`);
    console.log(`📡 Ping endpoint: http://localhost:${PORT}/api/ping/:appId`);
    console.log(`🔐 Admin: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}\n`);
});
