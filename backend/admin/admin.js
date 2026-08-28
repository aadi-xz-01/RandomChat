const state = { view: "dashboard" };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
}
function showError(message) { $("#pageError").textContent = message; }
function clearError() { $("#pageError").textContent = ""; }
function emptyRow(columns, text = "No data available.") { return `<tr><td class="empty-row" colspan="${columns}">${text}</td></tr>`; }
function formatDate(value) { return value ? new Date(value).toLocaleString() : "Never"; }

async function start() {
    try {
        const session = await api("/api/admin/session");
        if (session.authenticated) showDashboard();
        else $("#loginView").classList.remove("hidden");
    } catch {
        $("#loginView").classList.remove("hidden");
    }
}
function showDashboard() {
    $("#loginView").classList.add("hidden");
    $("#dashboardView").classList.remove("hidden");
    loadView("dashboard");
}
async function loadView(view = state.view) {
    state.view = view;
    clearError();
    $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
    $$(".view").forEach(item => item.classList.toggle("active", item.id === `view-${view}`));
    $("#viewTitle").textContent = view[0].toUpperCase() + view.slice(1);
    try {
        if (view === "dashboard") await loadDashboard();
        if (view === "users") await loadUsers();
        if (view === "reports") await loadReports();
        if (view === "bans") await loadBans();
        if (view === "announcements") await loadAnnouncement();
        if (view === "settings") await loadDashboard();
    } catch (error) { showError(error.message); }
}
async function loadDashboard() {
    const data = await api("/api/admin/dashboard");
    $("#statOnline").textContent = data.stats.onlineUsers;
    $("#statChats").textContent = data.stats.activeChats;
    $("#statWaiting").textContent = data.stats.waitingUsers;
    $("#statConnections").textContent = data.stats.totalConnections;
    $("#statReports").textContent = data.reports;
    $("#statBans").textContent = data.bannedUsers;
    $("#settingAge").textContent = `${data.settings.minAge}+`;
    $("#settingBio").textContent = data.settings.maxBioLength;
    $("#settingMode").textContent = data.settings.maintenance ? "Maintenance" : "Online";
    $("#maintenance").checked = data.settings.maintenance;
}
async function loadUsers() {
    const { users } = await api("/api/admin/users");
    $("#usersTable").innerHTML = users.length ? users.map(user => `<tr><td>#${user.id}</td><td class="profile-cell"><strong>${escapeHtml(user.profile?.name || "Unprofiled")}</strong><small>${user.profile ? `${user.profile.age} years${user.profile.bio ? ` · ${escapeHtml(user.profile.bio)}` : ""}` : "Profile pending"}</small></td><td><span class="status-tag">${user.status}</span></td><td>${formatDate(user.connectedAt)}</td><td><button class="action-button" data-disconnect="${user.id}">Disconnect</button> <button class="action-button" data-ban-user="${user.id}">Ban</button></td></tr>`).join("") : emptyRow(5, "No connected users.");
}
async function loadReports() {
    const { reports } = await api("/api/admin/reports");
    $("#reportsTable").innerHTML = reports.length ? reports.map(report => `<tr><td>#${report.id}</td><td>User #${report.reportedUserId}<br><small>Reporter #${report.reporterUserId}</small></td><td>${escapeHtml(report.reason)}</td><td>${formatDate(report.timestamp)}</td><td><span class="status-tag">${report.status}</span></td><td>${report.status !== "resolved" ? `<button class="action-button" data-review="${report.id}">Review</button> <button class="action-button" data-resolve="${report.id}">Resolve</button> <button class="action-button" data-ban-user="${report.reportedUserId}">Ban</button>` : "Done"}</td></tr>`).join("") : emptyRow(6, "No reports in this server session.");
}
async function loadBans() {
    const { bans } = await api("/api/admin/bans");
    $("#bansTable").innerHTML = bans.length ? bans.map(ban => `<tr><td>#${ban.userId}</td><td>${ban.type}</td><td>${formatDate(ban.createdAt)}</td><td>${ban.expiresAt ? formatDate(ban.expiresAt) : "Never (session only)"}</td><td><button class="action-button" data-unban="${ban.userId}">Unban</button></td></tr>`).join("") : emptyRow(5, "No active bans.");
}
async function loadAnnouncement() { const data = await api("/api/admin/dashboard"); $("#announcement").value = data.settings.announcement || ""; }
function escapeHtml(value) { const element = document.createElement("span"); element.textContent = value; return element.innerHTML; }

$("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("#loginError").textContent = "";
    const form = new FormData(event.currentTarget);
    try { await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) }); showDashboard(); }
    catch (error) { $("#loginError").textContent = error.message; }
});
 $$(".nav-item").forEach(item => item.addEventListener("click", () => loadView(item.dataset.view)));
 $$(".refresh-button").forEach(button => button.addEventListener("click", () => loadView()));
$("#logoutButton").addEventListener("click", async () => { await api("/api/admin/logout", { method: "POST" }); location.reload(); });
async function banUser(id) {
    const duration = prompt("Enter ban duration: temporary or permanent", "temporary");
    if (!["temporary", "permanent"].includes(duration)) return;
    await api("/api/admin/bans", { method: "POST", body: JSON.stringify({ userId: Number(id), duration }) });
}
$("#usersTable").addEventListener("click", async event => { const disconnectId = event.target.dataset.disconnect; const banId = event.target.dataset.banUser; try { if (disconnectId && confirm(`Disconnect user #${disconnectId}?`)) await api(`/api/admin/users/${disconnectId}/disconnect`, { method: "POST" }); if (banId) await banUser(banId); if (disconnectId || banId) loadView(); } catch (error) { showError(error.message); } });
$("#reportsTable").addEventListener("click", async event => { const id = event.target.dataset.resolve || event.target.dataset.review; const banId = event.target.dataset.banUser; try { if (id) await api(`/api/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify({ status: event.target.dataset.resolve ? "resolved" : "reviewed" }) }); if (banId) await banUser(banId); if (id || banId) loadView(); } catch (error) { showError(error.message); } });
$("#bansTable").addEventListener("click", async event => { const id = event.target.dataset.unban; if (!id || !confirm(`Unban user #${id}?`)) return; try { await api(`/api/admin/bans/${id}`, { method: "DELETE" }); loadView(); } catch (error) { showError(error.message); } });
$("#announcementForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ announcement: $("#announcement").value }) }); $("#announcementMessage").textContent = "Announcement saved."; } catch (error) { showError(error.message); } });
$("#clearAnnouncement").addEventListener("click", async () => { $("#announcement").value = ""; $("#announcementForm").requestSubmit(); });
$("#settingsForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ maintenance: $("#maintenance").checked }) }); $("#settingsMessage").textContent = "Settings saved."; await loadDashboard(); } catch (error) { showError(error.message); } });
start();
