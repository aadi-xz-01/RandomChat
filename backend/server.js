const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

if (typeof process.loadEnvFile === "function") {
    try {
        process.loadEnvFile(path.join(__dirname, ".env"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const ADMIN_ASSETS = path.join(__dirname, "admin");
const PUBLIC_ASSET_ROOTS = [__dirname, path.dirname(__dirname)].filter((value, index, array) => array.indexOf(value) === index);
const PUBLIC_ASSETS = PUBLIC_ASSET_ROOTS[0] || __dirname;

const settings = {
    minAge: 18,
    maxBioLength: 160,
    maintenance: false,
    announcement: ""
};

let waitingUser = null;
let userCount = 0;
let totalConnections = 0;
const users = new Map();
const sessions = new Map();
const bans = new Map();
const reports = [];
const loginAttempts = new Map();

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function validateProfile(profile) {
    if (!profile || typeof profile.name !== "string" || !profile.name.trim()) {
        return null;
    }

    const age = Number(profile.age);
    if (!Number.isInteger(age) || age < settings.minAge || age > 120) {
        return null;
    }

    const name = profile.name.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40);
    if (!name) return null;

    return {
        name,
        age,
        bio: typeof profile.bio === "string"
            ? profile.bio.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, settings.maxBioLength)
            : ""
    };
}

function isBanned(ws) {
    const ban = bans.get(String(ws.id));
    if (!ban) return false;
    if (ban.expiresAt && ban.expiresAt <= Date.now()) {
        bans.delete(String(ws.id));
        return false;
    }
    return true;
}

function disconnectUser(ws, notice = "The other person disconnected.") {
    if (!ws) return;

    leaveUser(ws, notice);

    if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Disconnected by administrator");
    }
}

function leaveUser(ws, notice = "The other person left the chat.") {
    if (!ws) return;

    if (waitingUser === ws) waitingUser = null;

    if (ws.partner) {
        const partner = ws.partner;
        ws.partner = null;
        partner.partner = null;
        send(partner, { type: "partner-left", message: notice });
    }

}

function findPartner(ws) {
    if (settings.maintenance) {
        send(ws, { type: "error", message: "RandomChat is temporarily unavailable." });
        return;
    }

    if (waitingUser === ws) {
        send(ws, { type: "waiting", message: "Waiting for someone to connect..." });
        return;
    }

    if (ws.partner) {
        send(ws, { type: "error", message: "You are already chatting with someone." });
        return;
    }

    while (waitingUser && (waitingUser.readyState !== WebSocket.OPEN || !users.has(waitingUser.id))) {
        waitingUser = null;
    }

    if (waitingUser && waitingUser !== ws) {
        const partner = waitingUser;
        waitingUser = null;
        ws.partner = partner;
        partner.partner = ws;

        send(ws, {
            type: "matched",
            message: "You are connected to a new person.",
            profile: partner.profile
        });
        send(partner, {
            type: "matched",
            message: "You are connected to a new person.",
            profile: ws.profile
        });
        return;
    }

    waitingUser = ws;
    send(ws, { type: "waiting", message: "Waiting for someone to connect..." });
}

function parseCookies(req) {
    const header = req.headers.cookie || "";
    return Object.fromEntries(header.split(";").map(part => {
        const index = part.indexOf("=");
        if (index < 0) return ["", ""];
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key));
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signSessionToken(token) {
    return crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

function getAdminSession(req) {
    const cookie = parseCookies(req).admin_session || "";
    const separator = cookie.lastIndexOf(".");
    const token = separator > 0 ? cookie.slice(0, separator) : "";
    const signature = separator > 0 ? cookie.slice(separator + 1) : "";
    if (!token || !safeEqual(signature, signSessionToken(token))) return null;
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        return null;
    }
    return session;
}

function adminEnabled() {
    return Boolean(ADMIN_USERNAME && ADMIN_PASSWORD && SESSION_SECRET);
}

function sendJson(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...extraHeaders
    });
    res.end(body);
}

function sendAsset(res, filename, contentType) {
    const filePath = path.join(ADMIN_ASSETS, filename);
    if (!filePath.startsWith(ADMIN_ASSETS)) {
        sendJson(res, 404, { error: "Not found" });
        return;
    }
    fs.readFile(filePath, (error, content) => {
        if (error) {
            sendJson(res, 404, { error: "Not found" });
            return;
        }
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        res.end(content);
    });
}

function sendPublicAsset(res, filename, contentType) {
    const filePath = PUBLIC_ASSET_ROOTS
        .map(root => path.resolve(root, filename))
        .find(candidate => fs.existsSync(candidate));

    const resolvedFilePath = filePath || path.resolve(PUBLIC_ASSETS, filename);
    const isAllowed = PUBLIC_ASSET_ROOTS.some(root => {
        const relativePath = path.relative(root, resolvedFilePath);
        return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    });

    if (!isAllowed) {
        sendJson(res, 404, { error: "Not found" });
        return;
    }

    fs.readFile(resolvedFilePath, (error, content) => {
        if (error) {
            sendJson(res, 404, { error: "Not found" });
            return;
        }
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
        res.end(content);
    });
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", chunk => {
            raw += chunk;
            if (Buffer.byteLength(raw) > MAX_BODY_BYTES) reject(new Error("Request too large"));
        });
        req.on("end", () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON")); }
        });
        req.on("error", reject);
    });
}

function requireAdmin(req, res) {
    if (!adminEnabled()) {
        sendJson(res, 503, { error: "Admin authentication is not configured." });
        return null;
    }
    const session = getAdminSession(req);
    if (!session) {
        sendJson(res, 401, { error: "Authentication required." });
        return null;
    }
    return session;
}

function userView(ws) {
    return {
        id: ws.id,
        profile: ws.profile || null,
        status: ws.partner ? "chatting" : waitingUser === ws ? "waiting" : "connected",
        connectedAt: ws.connectedAt
    };
}

function dashboardView() {
    const onlineUsers = [...users.values()].filter(ws => ws.readyState === WebSocket.OPEN);
    return {
        stats: {
            onlineUsers: onlineUsers.length,
            activeChats: onlineUsers.filter(ws => ws.partner).length / 2,
            waitingUsers: onlineUsers.filter(ws => waitingUser === ws).length,
            totalConnections
        },
        reports: reports.filter(report => report.status === "open").length,
        bannedUsers: [...bans.values()].filter(ban => !ban.expiresAt || ban.expiresAt > Date.now()).length,
        settings: { ...settings }
    };
}

async function handleAdminRequest(req, res, url) {
    if (url.pathname === "/api/admin/login" && req.method === "POST") {
        if (!adminEnabled()) {
            sendJson(res, 503, { error: "Admin authentication is not configured." });
            return true;
        }

        const ip = req.socket.remoteAddress || "unknown";
        const attempt = loginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
        if (attempt.blockedUntil > Date.now()) {
            sendJson(res, 429, { error: "Too many attempts. Try again later." });
            return true;
        }

        let body;
        try { body = await readJson(req); } catch {
            sendJson(res, 400, { error: "Invalid request." });
            return true;
        }

        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) {
            attempt.failures++;
            if (attempt.failures >= 5) attempt.blockedUntil = Date.now() + 15 * 60 * 1000;
            loginAttempts.set(ip, attempt);
            sendJson(res, 401, { error: "Invalid credentials." });
            return true;
        }

        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        sendJson(res, 200, { authenticated: true }, {
            "Set-Cookie": `admin_session=${encodeURIComponent(`${token}.${signSessionToken(token)}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
        });
        return true;
    }

    if (url.pathname === "/api/admin/logout" && req.method === "POST") {
        const cookie = parseCookies(req).admin_session || "";
        const separator = cookie.lastIndexOf(".");
        if (separator > 0) sessions.delete(cookie.slice(0, separator));
        sendJson(res, 200, { authenticated: false }, {
            "Set-Cookie": "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        });
        return true;
    }

    if (url.pathname === "/api/admin/session" && req.method === "GET") {
        sendJson(res, 200, { authenticated: Boolean(getAdminSession(req)) });
        return true;
    }

    if (!url.pathname.startsWith("/api/admin/")) return false;
    if (!requireAdmin(req, res)) return true;

    if (url.pathname === "/api/admin/dashboard" && req.method === "GET") {
        sendJson(res, 200, dashboardView());
        return true;
    }
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
        sendJson(res, 200, { users: [...users.values()].map(userView) });
        return true;
    }
    if (url.pathname === "/api/admin/bans" && req.method === "GET") {
        sendJson(res, 200, { bans: [...bans.values()] });
        return true;
    }
    if (url.pathname === "/api/admin/reports" && req.method === "GET") {
        sendJson(res, 200, { reports });
        return true;
    }
    if (url.pathname === "/api/admin/announcement" && req.method === "GET") {
        sendJson(res, 200, { announcement: settings.announcement, enabled: Boolean(settings.announcement) });
        return true;
    }
    if (url.pathname === "/api/admin/settings" && req.method === "PATCH") {
        let body;
        try { body = await readJson(req); } catch {
            sendJson(res, 400, { error: "Invalid request." });
            return true;
        }
        if (body.announcement !== undefined) {
            if (typeof body.announcement !== "string" || body.announcement.length > 240) {
                sendJson(res, 400, { error: "Announcement must be 240 characters or fewer." });
                return true;
            }
            settings.announcement = body.announcement.trim();
        }
        if (body.maintenance !== undefined) settings.maintenance = Boolean(body.maintenance);
        sendJson(res, 200, { settings: { ...settings } });
        return true;
    }

    const userMatch = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/disconnect$/);
    if (userMatch && req.method === "POST") {
        const ws = users.get(Number(userMatch[1]));
        if (!ws) { sendJson(res, 404, { error: "User not found." }); return true; }
        disconnectUser(ws);
        sendJson(res, 200, { disconnected: true });
        return true;
    }

    const banMatch = url.pathname.match(/^\/api\/admin\/bans\/(\d+)$/);
    if (banMatch && req.method === "DELETE") {
        bans.delete(banMatch[1]);
        sendJson(res, 200, { unbanned: true });
        return true;
    }
    if (url.pathname === "/api/admin/bans" && req.method === "POST") {
        let body;
        try { body = await readJson(req); } catch {
            sendJson(res, 400, { error: "Invalid request." });
            return true;
        }
        const id = Number(body.userId);
        const ws = users.get(id);
        if (!ws || !Number.isInteger(id)) { sendJson(res, 404, { error: "User not found." }); return true; }
        const duration = body.duration === "temporary" ? 60 * 60 * 1000 : null;
        const ban = { userId: String(id), type: duration ? "temporary" : "permanent", expiresAt: duration ? Date.now() + duration : null, createdAt: new Date().toISOString() };
        bans.set(String(id), ban);
        disconnectUser(ws, "You have been disconnected by an administrator.");
        sendJson(res, 200, { ban });
        return true;
    }

    const reportMatch = url.pathname.match(/^\/api\/admin\/reports\/(\d+)$/);
    if (reportMatch && req.method === "PATCH") {
        const report = reports.find(item => item.id === Number(reportMatch[1]));
        if (!report) { sendJson(res, 404, { error: "Report not found." }); return true; }
        let body;
        try { body = await readJson(req); } catch { body = {}; }
        if (!["open", "reviewed", "resolved"].includes(body.status)) {
            sendJson(res, 400, { error: "Invalid report status." });
            return true;
        }
        report.status = body.status;
        sendJson(res, 200, { report });
        return true;
    }

    sendJson(res, 404, { error: "Not found." });
    return true;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
        sendPublicAsset(res, "index.html", "text/html; charset=utf-8");
        return;
    }
    if (url.pathname === "/script.js") {
        sendPublicAsset(res, "script.js", "text/javascript; charset=utf-8");
        return;
    }
    if (url.pathname === "/style.css") {
        sendPublicAsset(res, "style.css", "text/css; charset=utf-8");
        return;
    }
    if (url.pathname === "/api/announcement" && req.method === "GET") {
        sendJson(res, 200, { announcement: settings.announcement, enabled: Boolean(settings.announcement) }, { "Access-Control-Allow-Origin": "*" });
        return;
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
        sendAsset(res, "admin.html", "text/html; charset=utf-8");
        return;
    }
    if (url.pathname === "/admin/admin.js") { sendAsset(res, "admin.js", "text/javascript; charset=utf-8"); return; }
    if (url.pathname === "/admin/admin.css") { sendAsset(res, "admin.css", "text/css; charset=utf-8"); return; }
    if (await handleAdminRequest(req, res, url)) return;
    sendJson(res, 404, { error: "Not found." });
});

const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
    userCount++;
    totalConnections++;
    ws.id = userCount;
    ws.partner = null;
    ws.connectedAt = new Date().toISOString();
    users.set(ws.id, ws);

    send(ws, { type: "connected", message: "Connected to RandomChat server." });

    ws.on("message", data => {
        if (isBanned(ws)) {
            disconnectUser(ws, "Your session is banned.");
            return;
        }

        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }

        if (!message || typeof message !== "object" || Array.isArray(message)) return;

        if (message.type === "find" || message.type === "join") {
            const validatedProfile = validateProfile(message.profile);
            if (!validatedProfile) {
                send(ws, { type: "error", message: `A display name and a valid age between ${settings.minAge} and 120 are required.` });
                return;
            }
            ws.profile = validatedProfile;
            findPartner(ws);
            return;
        }

        if (message.type === "message" || message.type === "chat") {
            const text = typeof message.text === "string"
                ? message.text
                : typeof message.message === "string" ? message.message : "";
            const trimmedText = text.trim().slice(0, 500);
            if (ws.partner && trimmedText) send(ws.partner, { type: "message", text: trimmedText });
            return;
        }

        if (message.type === "report" && ws.partner) {
            const reason = typeof message.reason === "string" ? message.reason.trim().slice(0, 120) : "Unspecified";
            reports.push({ id: reports.length + 1, reportedUserId: ws.partner.id, reporterUserId: ws.id, reason, timestamp: new Date().toISOString(), status: "open" });
            send(ws, { type: "report-received", message: "Thanks. Your report has been received." });
            return;
        }

        if (message.type === "leave") {
            leaveUser(ws);
            return;
        }

        if (message.type === "next") {
            if (message.profile !== undefined) {
                const validatedProfile = validateProfile(message.profile);
                if (!validatedProfile) {
                    send(ws, { type: "error", message: `A display name and a valid age between ${settings.minAge} and 120 are required.` });
                    return;
                }
                ws.profile = validatedProfile;
            }
            leaveUser(ws);
            findPartner(ws);
        }
    });

    ws.on("close", () => {
        if (waitingUser === ws) waitingUser = null;
        if (ws.partner) {
            const partner = ws.partner;
            ws.partner = null;
            partner.partner = null;
            send(partner, { type: "partner-left", message: "The other person disconnected." });
        }
        users.delete(ws.id);
    });
});

server.on("error", error => {
    console.error(`RandomChat backend failed to start: ${error.message}`);
    process.exitCode = 1;
});

server.listen(PORT, () => {
    console.log(`RandomChat backend running on port ${PORT}`);
    if (!adminEnabled()) console.warn("Admin panel disabled: set ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET.");
});