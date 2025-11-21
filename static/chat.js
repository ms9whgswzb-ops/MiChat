// static/chat.js

const API_BASE = "";

let accessToken = null;
let currentUser = null;
let socket = null;
let shouldReconnect = false;
let reconnectTimeoutId = null;

// userId -> hat ungelesene private Nachrichten
const unreadPrivate = new Set();

// DOM Elemente
const regUsername = document.getElementById("reg-username");
const regPassword = document.getElementById("reg-password");
const regColor = document.getElementById("reg-color");
const regError = document.getElementById("register-error");

const loginUsername = document.getElementById("login-username");
const loginPassword = document.getElementById("login-password");
const loginError = document.getElementById("login-error");

const registerBtn = document.getElementById("register-btn");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");

const messagesDiv = document.getElementById("messages");
const messageInput = document.getElementById("message-text");
const sendBtn = document.getElementById("send-btn");

const authForms = document.getElementById("auth-forms");
const userInfoCard = document.getElementById("user-info");
const currentUsernameSpan = document.getElementById("current-username");

const chatTargetSelect = document.getElementById("chat-target");
const chatSubtitle = document.getElementById("chat-subtitle");

// Admin-DOM
const adminPanel = document.getElementById("admin-panel");
const adminRefreshBtn = document.getElementById("admin-refresh-users-btn");
const adminError = document.getElementById("admin-error");
const adminUsersTbody = document.getElementById("admin-users-tbody");

// ---------- Helper ----------

function getCurrentChatTarget() {
    const value = chatTargetSelect.value;
    if (value === "global") {
        return { mode: "global" };
    } else {
        const userId = parseInt(value, 10);
        if (!isNaN(userId)) {
            return { mode: "private", userId };
        } else {
            return { mode: "global" };
        }
    }
}

function setLoggedIn(user, token) {
    currentUser = user;
    accessToken = token;

    authForms.classList.add("hidden");
    userInfoCard.classList.remove("hidden");
    currentUsernameSpan.textContent = user.username;

    messagesDiv.innerHTML = "";
    unreadPrivate.clear();

    shouldReconnect = true;
    connectWebSocket();
    loadUsersList();
    loadMessagesForCurrentTarget();

    // Admin-Panel sichtbar, wenn Admin
    if (currentUser.is_admin) {
        adminPanel.classList.remove("hidden");
        loadAdminUsers();
    } else {
        adminPanel.classList.add("hidden");
    }
}

function setLoggedOut() {
    currentUser = null;
    accessToken = null;

    authForms.classList.remove("hidden");
    userInfoCard.classList.add("hidden");
    currentUsernameSpan.textContent = "";

    messagesDiv.innerHTML = "";

    shouldReconnect = false;
    unreadPrivate.clear();

    if (socket) {
        try {
            socket.close();
        } catch {}
        socket = null;
    }
    if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = null;
    }

    chatTargetSelect.innerHTML = `<option value="global">🌍 Globaler Chat</option>`;
    chatSubtitle.textContent = "Öffentlicher Raum";

    adminPanel.classList.add("hidden");
    adminUsersTbody.innerHTML = "";
    adminError.textContent = "";
}

async function apiRequest(path, method = "GET", body = null, authenticated = false) {
    const headers = {
        "Content-Type": "application/json",
    };

    let url = API_BASE + path;

    if (authenticated && accessToken) {
        const sep = url.includes("?") ? "&" : "?";
        url = `${url}${sep}token=${encodeURIComponent("Bearer " + accessToken)}`;
    }

    const opts = { method, headers };
    if (body) {
        opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    if (!res.ok) {
        let errMsg = "Fehler";
        try {
            const data = await res.json();
            if (data.detail) errMsg = data.detail;
        } catch {}
        throw new Error(errMsg);
    }
    if (res.status === 204) return null;
    return res.json();
}

// ---------- WebSocket + Reconnect ----------

function connectWebSocket() {
    if (!accessToken) return;

    if (socket) {
        try {
            socket.close();
        } catch {}
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl =
        protocol +
        "://" +
        window.location.host +
        `/ws?token=${encodeURIComponent(accessToken)}`;

    console.log("[WS] Verbinde zu", wsUrl);
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("[WS] Verbunden");
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
    };

    socket.onclose = (event) => {
        console.log("[WS] Getrennt", event.code, event.reason);
        if (shouldReconnect) {
            if (!reconnectTimeoutId) {
                reconnectTimeoutId = setTimeout(() => {
                    reconnectTimeoutId = null;
                    console.log("[WS] Versuche Reconnect...");
                    connectWebSocket();
                }, 3000);
            }
        }
    };

    socket.onerror = (err) => {
        console.error("[WS] Fehler:", err);
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleIncomingMessage(msg);
        } catch (e) {
            console.error("Fehler beim Parsen der WS-Nachricht:", e);
        }
    };
}

// ---------- Unread-Badges für private Chats ----------

function markPrivateUnread(userId) {
    if (userId == null) return;
    unreadPrivate.add(userId);
    updateUserOptionsBadges();
}

function clearPrivateUnread(userId) {
    if (userId == null) return;
    if (unreadPrivate.has(userId)) {
        unreadPrivate.delete(userId);
        updateUserOptionsBadges();
    }
}

function updateUserOptionsBadges() {
    for (const option of chatTargetSelect.options) {
        if (option.value === "global") continue;

        const uid = parseInt(option.value, 10);
        if (isNaN(uid)) continue;

        const baseName =
            option.getAttribute("data-username") ||
            option.textContent.replace(/^●\s*/, "");

        option.setAttribute("data-username", baseName);

        if (unreadPrivate.has(uid)) {
            if (!option.textContent.startsWith("● ")) {
                option.textContent = "● " + baseName;
            }
        } else {
            option.textContent = baseName;
        }
    }
}

// ---------- Incoming Messages ----------

function handleIncomingMessage(msg) {
    if (!currentUser) return;

    const isPrivate = msg.recipient_id !== null && msg.recipient_id !== undefined;

    if (!isPrivate) {
        const target = getCurrentChatTarget();
        if (target.mode === "global") {
            appendMessage(msg);
            scrollMessagesToBottom();
        }
    } else {
        const involved =
            msg.user_id === currentUser.id || msg.recipient_id === currentUser.id;
        if (!involved) return;

        const partnerId =
            msg.user_id === currentUser.id ? msg.recipient_id : msg.user_id;

        const target = getCurrentChatTarget();
        if (target.mode === "private" && target.userId === partnerId) {
            appendMessage(msg);
            scrollMessagesToBottom();
        } else {
            // wir sind NICHT im Chat mit diesem User -> als "ungelesen" markieren
            markPrivateUnread(partnerId);
        }
    }
}

// ---------- Auth Actions ----------

registerBtn.addEventListener("click", async () => {
    regError.textContent = "";
    try {
        await apiRequest(
            "/register",
            "POST",
            {
                username: regUsername.value.trim(),
                password: regPassword.value,
                color: regColor.value,
            },
            false
        );
        regError.textContent = "Registrierung erfolgreich, bitte jetzt einloggen.";
        regError.classList.remove("error");
        regError.classList.add("success");
    } catch (err) {
        regError.textContent = err.message;
        regError.classList.remove("success");
        regError.classList.add("error");
    }
});

loginBtn.addEventListener("click", async () => {
    loginError.textContent = "";
    try {
        const tokenData = await apiRequest(
            "/login",
            "POST",
            {
                username: loginUsername.value.trim(),
                password: loginPassword.value,
            },
            false
        );

        accessToken = tokenData.access_token;

        const user = await apiRequest(
            `/me?token=${encodeURIComponent("Bearer " + accessToken)}`,
            "GET"
        );

        setLoggedIn(user, accessToken);
    } catch (err) {
        loginError.textContent = err.message;
    }
});

logoutBtn.addEventListener("click", () => {
    setLoggedOut();
});

// ---------- User-Liste / Chat-Ziel ----------

async function loadUsersList() {
    if (!accessToken) return;

    try {
        const users = await apiRequest(
            `/users?token=${encodeURIComponent("Bearer " + accessToken)}`,
            "GET",
            null,
            false
        );

        chatTargetSelect.innerHTML = `<option value="global">🌍 Globaler Chat</option>`;

        if (!Array.isArray(users)) return;

        users.forEach((user) => {
            if (user.id === currentUser.id) return;
            const opt = document.createElement("option");
            opt.value = String(user.id);
            opt.textContent = user.username;
            opt.setAttribute("data-username", user.username);
            chatTargetSelect.appendChild(opt);
        });

        updateUserOptionsBadges();
    } catch (err) {
        console.error("Fehler beim Laden der User-Liste:", err);
    }
}

chatTargetSelect.addEventListener("change", () => {
    const target = getCurrentChatTarget();
    if (target.mode === "global") {
        chatSubtitle.textContent = "Öffentlicher Raum";
    } else {
        const selectedOption =
            chatTargetSelect.options[chatTargetSelect.selectedIndex];
        chatSubtitle.textContent = `Privatchat mit ${selectedOption.textContent.replace(/^●\s*/, "")}`;
        clearPrivateUnread(target.userId);
    }

    loadMessagesForCurrentTarget();
});

// ---------- Nachrichten (HTTP + WS) ----------

sendBtn.addEventListener("click", () => {
    sendCurrentMessage();
});

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendCurrentMessage();
    }
});

function sendCurrentMessage() {
    if (!currentUser || !accessToken) {
        alert("Bitte zuerst einloggen.");
        return;
    }

    const text = messageInput.value.trim();
    if (!text) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        alert("Verbindung zum Chat-Server nicht aktiv.");
        return;
    }

    const target = getCurrentChatTarget();

    if (target.mode === "global") {
        socket.send(
            JSON.stringify({
                type: "public_message",
                content: text,
            })
        );
    } else {
        socket.send(
            JSON.stringify({
                type: "private_message",
                content: text,
                recipient_id: target.userId,
            })
        );
    }

    messageInput.value = "";
}

async function loadMessagesForCurrentTarget() {
    if (!currentUser) return;

    messagesDiv.innerHTML = "";

    const target = getCurrentChatTarget();

    try {
        let path;
        let authenticated = false;

        if (target.mode === "global") {
            path = "/messages?limit=50";
        } else {
            path = `/private/messages?with_user_id=${target.userId}&limit=100`;
            authenticated = true;
        }

        const msgs = await apiRequest(
            path,
            "GET",
            null,
            authenticated
        );

        if (Array.isArray(msgs)) {
            msgs.forEach((m) => appendMessage(m));
            scrollMessagesToBottom();
        }
    } catch (err) {
        console.error("Fehler beim Laden der Nachrichten:", err);
    }
}

function appendMessage(msg) {
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("message");
    if (msg.is_admin) {
        msgDiv.classList.add("admin-message");
    }

    const nameSpan = document.createElement("span");
    nameSpan.classList.add("message-username");
    nameSpan.textContent = msg.username + ": ";
    nameSpan.style.color = msg.color;

    const textSpan = document.createElement("span");
    textSpan.classList.add("message-text");
    textSpan.textContent = msg.content;

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);

    messagesDiv.appendChild(msgDiv);
}

function scrollMessagesToBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ---------- Admin Panel ----------

adminRefreshBtn.addEventListener("click", () => {
    loadAdminUsers();
});

async function loadAdminUsers() {
    if (!currentUser || !currentUser.is_admin) return;
    adminError.textContent = "";
    adminUsersTbody.innerHTML = "";

    try {
        const users = await apiRequest(
            "/admin/users",
            "GET",
            null,
            true
        );

        if (!Array.isArray(users)) return;

        users.forEach((user) => {
            const tr = document.createElement("tr");

            // ID
            const tdId = document.createElement("td");
            tdId.textContent = String(user.id);
            tr.appendChild(tdId);

            // Name
            const tdName = document.createElement("td");
            tdName.textContent = user.username;
            tr.appendChild(tdName);

            // Rolle
            const tdRole = document.createElement("td");
            tdRole.textContent = user.is_admin ? "Admin" : "User";
            tr.appendChild(tdRole);

            // Status
            const tdStatus = document.createElement("td");
            const statusParts = [];
            if (user.is_banned) {
                statusParts.push("Gebannt");
            }
            if (user.muted_until) {
                statusParts.push("Stumm bis " + new Date(user.muted_until).toLocaleString());
            }
            if (!user.is_banned && !user.muted_until) {
                statusParts.push("OK");
            }
            tdStatus.textContent = statusParts.join(" | ");
            tr.appendChild(tdStatus);

            // Aktionen
            const tdActions = document.createElement("td");
            tdActions.classList.add("admin-actions-cell");

            const isSelf = user.id === currentUser.id;

            const btnMute5 = document.createElement("button");
            btnMute5.textContent = "Mute 5m";
            btnMute5.classList.add("admin-btn", "admin-btn-mute");
            btnMute5.disabled = isSelf;
            btnMute5.onclick = () => adminMuteUser(user.id, 5);

            const btnMute60 = document.createElement("button");
            btnMute60.textContent = "Mute 60m";
            btnMute60.classList.add("admin-btn", "admin-btn-mute");
            btnMute60.disabled = isSelf;
            btnMute60.onclick = () => adminMuteUser(user.id, 60);

            const btnUnmute = document.createElement("button");
            btnUnmute.textContent = "Unmute";
            btnUnmute.classList.add("admin-btn");
            btnUnmute.disabled = isSelf;
            btnUnmute.onclick = () => adminUnmuteUser(user.id);

            const btnBan = document.createElement("button");
            btnBan.textContent = "Ban";
            btnBan.classList.add("admin-btn", "admin-btn-ban");
            btnBan.disabled = isSelf;
            btnBan.onclick = () => adminBanUser(user.id);

            const btnUnban = document.createElement("button");
            btnUnban.textContent = "Unban";
            btnUnban.classList.add("admin-btn");
            btnUnban.disabled = isSelf;
            btnUnban.onclick = () => adminUnbanUser(user.id);

            const btnDelete = document.createElement("button");
            btnDelete.textContent = "Löschen";
            btnDelete.classList.add("admin-btn", "admin-btn-delete");
            btnDelete.disabled = isSelf;
            btnDelete.onclick = () => {
                if (confirm(`Benutzer '${user.username}' wirklich löschen?`)) {
                    adminDeleteUser(user.id);
                }
            };

            tdActions.appendChild(btnMute5);
            tdActions.appendChild(btnMute60);
            tdActions.appendChild(btnUnmute);
            tdActions.appendChild(btnBan);
            tdActions.appendChild(btnUnban);
            tdActions.appendChild(btnDelete);

            tr.appendChild(tdActions);

            adminUsersTbody.appendChild(tr);
        });
    } catch (err) {
        adminError.textContent = err.message;
    }
}

async function adminMuteUser(userId, minutes) {
    try {
        await apiRequest(
            `/admin/users/${userId}/mute`,
            "POST",
            { minutes },
            true
        );
        await loadAdminUsers();
    } catch (err) {
        adminError.textContent = err.message;
    }
}

async function adminUnmuteUser(userId) {
    try {
        await apiRequest(
            `/admin/users/${userId}/unmute`,
            "POST",
            null,
            true
        );
        await loadAdminUsers();
    } catch (err) {
        adminError.textContent = err.message;
    }
}

async function adminBanUser(userId) {
    try {
        await apiRequest(
            `/admin/users/${userId}/ban`,
            "POST",
            null,
            true
        );
        await loadAdminUsers();
    } catch (err) {
        adminError.textContent = err.message;
    }
}

async function adminUnbanUser(userId) {
    try {
        await apiRequest(
            `/admin/users/${userId}/unban`,
            "POST",
            null,
            true
        );
        await loadAdminUsers();
    } catch (err) {
        adminError.textContent = err.message;
    }
}

async function adminDeleteUser(userId) {
    try {
        await apiRequest(
            `/users/${userId}`,
            "DELETE",
            null,
            true
        );
        await loadAdminUsers();
        await loadUsersList();
    } catch (err) {
        adminError.textContent = err.message;
    }
}
