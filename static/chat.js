// static/chat.js

const API_BASE = "";

let accessToken = null;
let currentUser = null;
let socket = null;

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

    connectWebSocket();
    loadUsersList();
    loadMessagesForCurrentTarget();
}

function setLoggedOut() {
    currentUser = null;
    accessToken = null;

    authForms.classList.remove("hidden");
    userInfoCard.classList.add("hidden");
    currentUsernameSpan.textContent = "";

    messagesDiv.innerHTML = "";

    if (socket) {
        try {
            socket.close();
        } catch {}
        socket = null;
    }

    // Reset Chat-Auswahl
    chatTargetSelect.innerHTML = `<option value="global">🌍 Globaler Chat</option>`;
    chatSubtitle.textContent = "Öffentlicher Raum";
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

// ---------- WebSocket ----------

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

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WebSocket verbunden");
    };

    socket.onclose = () => {
        console.log("WebSocket getrennt");
    };

    socket.onerror = (err) => {
        console.error("WebSocket Fehler:", err);
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

function handleIncomingMessage(msg) {
    if (!currentUser) return;

    const isPrivate = msg.recipient_id !== null && msg.recipient_id !== undefined;

    if (!isPrivate) {
        // Globaler Chat
        const target = getCurrentChatTarget();
        if (target.mode === "global") {
            appendMessage(msg);
            scrollMessagesToBottom();
        }
    } else {
        // Private Nachricht
        const involved =
            msg.user_id === currentUser.id || msg.recipient_id === currentUser.id;
        if (!involved) return;

        const partnerId =
            msg.user_id === currentUser.id ? msg.recipient_id : msg.user_id;

        const target = getCurrentChatTarget();
        if (target.mode === "private" && target.userId === partnerId) {
            appendMessage(msg);
            scrollMessagesToBottom();
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

        // Select leeren & Global hinzufügen
        chatTargetSelect.innerHTML = `<option value="global">🌍 Globaler Chat</option>`;

        if (!Array.isArray(users)) return;

        users.forEach((user) => {
            if (user.id === currentUser.id) return; // sich selbst nicht anzeigen
            const opt = document.createElement("option");
            opt.value = String(user.id);
            opt.textContent = user.username;
            chatTargetSelect.appendChild(opt);
        });
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
        chatSubtitle.textContent = `Privatchat mit ${selectedOption.textContent}`;
    }

    // Chat-Verlauf für das neue Ziel laden
    loadMessagesForCurrentTarget();
});

// ---------- Nachrichten (HTTP für History, WS für neue Nachrichten) ----------

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
