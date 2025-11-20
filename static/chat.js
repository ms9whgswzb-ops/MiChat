// static/chat.js

const API_BASE = "";

let accessToken = null;
let currentUser = null;
let lastMessageId = null;
let pollIntervalId = null;

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

// ---------- Helper ----------

function setLoggedIn(user, token) {
    currentUser = user;
    accessToken = token;

    authForms.classList.add("hidden");
    userInfoCard.classList.remove("hidden");
    currentUsernameSpan.textContent = user.username;

    startPolling();
}

function setLoggedOut() {
    currentUser = null;
    accessToken = null;
    lastMessageId = null;

    authForms.classList.remove("hidden");
    userInfoCard.classList.add("hidden");
    currentUsernameSpan.textContent = "";

    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
}

function startPolling() {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
    }
    loadMessages(true);
    pollIntervalId = setInterval(() => loadMessages(false), 3000);
}

async function apiRequest(path, method = "GET", body = null, authenticated = false) {
    const headers = {
        "Content-Type": "application/json",
    };

    let url = API_BASE + path;

    if (authenticated && accessToken) {
        // Token wird als Query-Parameter geschickt, wie in main.py erwartet
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}token=${encodeURIComponent("Bearer " + accessToken)}`;
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

// ---------- Auth Actions ----------

registerBtn.addEventListener("click", async () => {
    regError.textContent = "";
    try {
        const user = await apiRequest(
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

        const user = await apiRequest(`/me?token=${encodeURIComponent("Bearer " + accessToken)}`, "GET");

        setLoggedIn(user, accessToken);
    } catch (err) {
        loginError.textContent = err.message;
    }
});

logoutBtn.addEventListener("click", () => {
    setLoggedOut();
});

// ---------- Chat ----------

sendBtn.addEventListener("click", async () => {
    if (!currentUser || !accessToken) {
        alert("Bitte zuerst einloggen.");
        return;
    }

    const text = messageInput.value.trim();
    if (!text) return;

    try {
        await apiRequest("/messages", "POST", { content: text }, true);
        messageInput.value = "";
        await loadMessages(true);
    } catch (err) {
        alert("Fehler beim Senden: " + err.message);
    }
});

messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendBtn.click();
    }
});

async function loadMessages(initial) {
    try {
        let path = "/messages?limit=50";
        if (!initial && lastMessageId !== null) {
            path += `&after_id=${lastMessageId}`;
        }

        const newMessages = await apiRequest(path, "GET", null, false);

        if (Array.isArray(newMessages) && newMessages.length > 0) {
            for (const msg of newMessages) {
                appendMessage(msg);
                lastMessageId = msg.id;
            }
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        } else if (initial) {
            messagesDiv.innerHTML = "";
            lastMessageId = null;
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

// Beim Laden der Seite: nur Nachrichten laden, wenn wir das später wollen.
// Hier starten wir das Polling erst nach Login.
