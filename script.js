const screens = {
    home: document.getElementById("homeScreen"),
    setup: document.getElementById("setupScreen"),
    matching: document.getElementById("matchingScreen"),
    chat: document.getElementById("chatScreen")
};

let socket = null;
let connectedToPartner = false;
let rematchPending = false;
let profile = { name: "", age: "", bio: "" };
let reconnectTimer = null;
let shouldReconnect = true;
const configuredBackendUrl = window.RANDOMCHAT_BACKEND_URL || document.querySelector('meta[name="randomchat-backend"]')?.content;
const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const localBackendUrl = window.location.protocol === "file:"
    ? "http://127.0.0.1:3000"
    : isLocalHost && window.location.port !== "3000"
        ? `${window.location.protocol === "https:" ? "https" : "http"}://${window.location.hostname}:3000`
        : "";
const backendHttpUrl = configuredBackendUrl || localBackendUrl || (window.location.protocol === "http:" || window.location.protocol === "https:" ? window.location.origin : "");
const BACKEND_URL = backendHttpUrl
    ? backendHttpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "")
    : "";

if (backendHttpUrl) fetch(`${backendHttpUrl}/api/announcement`)
    .then(response => response.ok ? response.json() : null)
    .then(data => {
        if (data && data.enabled) {
            const banner = document.getElementById("announcementBanner");
            banner.textContent = data.announcement;
            banner.hidden = false;
        }
    })
    .catch(() => {});

function showScreen(name) {
    Object.values(screens).forEach(screen => screen.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
}

function sendToBackend(data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
        return true;
    }
    return false;
}

function connectBackend() {
    if (!BACKEND_URL || (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))) return;

    const currentSocket = new WebSocket(BACKEND_URL);
    socket = currentSocket;

    currentSocket.addEventListener("open", () => {
        document.getElementById("matchingText").textContent = "Connected. Looking for a random person to chat with...";
        const activeScreen = document.querySelector(".screen.active")?.id;
        if (profile.name && (activeScreen === "matchingScreen" || activeScreen === "chatScreen") && !connectedToPartner) {
            sendToBackend({ type: "find", profile });
        }
    });
    currentSocket.addEventListener("message", event => {
        try {
            handleServerMessage(JSON.parse(event.data));
        } catch {
            console.warn("Received an invalid server message.");
        }
    });

    currentSocket.addEventListener("close", () => {
        if (socket !== currentSocket) return;
        socket = null;
        connectedToPartner = false;
        rematchPending = false;
        if (shouldReconnect) {
            const activeScreen = document.querySelector(".screen.active")?.id;
            if (activeScreen === "chatScreen") showScreen("matching");
            document.getElementById("matchingText").textContent = "Connection lost. Reconnecting...";
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                connectBackend();
            }, 1000);
        }
    });

    currentSocket.addEventListener("error", () => {
        document.getElementById("matchingText").textContent = "The chat server is unavailable. Please try again shortly.";
    });
}

function handleServerMessage(data) {
    if (data.type === "waiting") {
        rematchPending = false;
        showScreen("matching");
        document.getElementById("matchingText").textContent =
            "Looking for a random person to chat with...";
        return;
    }

    if (data.type === "matched") {
        connectedToPartner = true;
        rematchPending = false;
        updatePartnerProfile(data.profile);
        clearMessages();
        document.getElementById("nextBtn").disabled = false;
        showScreen("chat");
        if (!window.matchMedia("(pointer: coarse)").matches) {
            document.getElementById("messageInput").focus();
        }
        return;
    }

    if (data.type === "message") {
        receiveMessage(data.text);
        return;
    }

    if (data.type === "partner-left") {
        connectedToPartner = false;
        showScreen("home");
        alert("The stranger left the chat.");
        return;
    }

    if (data.type === "error") {
        rematchPending = false;
        document.getElementById("nextBtn").disabled = false;
        showProfileError(data.message || "That request could not be completed.");
    }
}

function showProfileError(message) {
    const warning = document.getElementById("profileWarning");
    warning.textContent = message;
    showScreen("setup");
}

function updatePartnerProfile(partnerProfile) {
    const name = partnerProfile && partnerProfile.name ? partnerProfile.name : "Stranger";
    const bio = partnerProfile && partnerProfile.bio ? partnerProfile.bio : "";
    document.getElementById("partnerName").textContent = name;
    document.getElementById("partnerBio").textContent = bio;
    document.getElementById("partnerBio").hidden = !bio;
    document.getElementById("partnerAvatar").textContent = name.charAt(0).toUpperCase();
}

function clearMessages() {
    document.getElementById("messages").innerHTML =
        '<div class="system-message">You are now chatting with a stranger.</div>';
}

function validateProfile() {
    const nameInput = document.getElementById("profileName");
    const ageInput = document.getElementById("profileAge");
    const bioInput = document.getElementById("profileBio");
    const warning = document.getElementById("profileWarning");
    const name = nameInput.value.trim();
    const age = Number(ageInput.value);

    warning.textContent = "";
    if (!name) {
        warning.textContent = "Please enter a display name.";
        nameInput.focus();
        return null;
    }
    if (!Number.isInteger(age) || age < 18 || age > 120) {
        warning.textContent = "You must be 18 or older to use RandomChat.";
        ageInput.focus();
        return null;
    }

    return { name, age, bio: bioInput.value.trim() };
}

document.getElementById("startChatBtn").addEventListener("click", () => {
    document.getElementById("profileName").value = profile.name;
    document.getElementById("profileAge").value = profile.age;
    document.getElementById("profileBio").value = profile.bio;
    showScreen("setup");
    document.getElementById("profileName").focus();
});

document.getElementById("profileForm").addEventListener("submit", event => {
    event.preventDefault();
    const nextProfile = validateProfile();
    if (!nextProfile) return;

    profile = nextProfile;
    connectedToPartner = false;
    if (!sendToBackend({ type: "find", profile })) {
        showProfileError("Connecting to the chat server. Please try again in a moment.");
        connectBackend();
        return;
    }
    showScreen("matching");
    document.getElementById("matchingText").textContent =
        "Looking for a random person to chat with...";
});

document.getElementById("cancelMatchBtn").addEventListener("click", () => {
    sendToBackend({ type: "leave" });
    rematchPending = false;
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    showScreen("home");
});

document.getElementById("nextBtn").addEventListener("click", () => {
    if (!connectedToPartner || rematchPending) return;
    rematchPending = true;
    connectedToPartner = false;
    document.getElementById("nextBtn").disabled = true;
    clearMessages();
    showScreen("matching");
    document.getElementById("matchingText").textContent = "Finding another stranger...";
    sendToBackend({ type: "next", profile });
});

document.getElementById("endChatBtn").addEventListener("click", () => {
    sendToBackend({ type: "leave" });
    connectedToPartner = false;
    rematchPending = false;
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    showScreen("home");
});

const messageInput = document.getElementById("messageInput");
function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !connectedToPartner) return;
    if (!sendToBackend({ type: "message", text })) {
        connectedToPartner = false;
        showScreen("matching");
        document.getElementById("matchingText").textContent = "Connection lost. Reconnecting...";
        return;
    }
    addMessage(text, true);
    messageInput.value = "";
}
function addMessage(text, mine) {
    const message = document.createElement("div");
    message.className = mine ? "message my-message" : "message stranger-message";
    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = mine ? "You" : "Stranger";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    message.append(name, paragraph);
    const messages = document.getElementById("messages");
    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
}
function receiveMessage(text) { addMessage(text, false); }
document.getElementById("sendBtn").addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") sendMessage();
});
document.getElementById("emojiBtn").addEventListener("click", () => {
    messageInput.value += " :)";
    messageInput.focus();
});

const settingsModal = document.getElementById("settingsModal");
document.getElementById("settingsBtn").addEventListener("click", () => {
    settingsModal.classList.add("show");
    settingsModal.setAttribute("aria-hidden", "false");
});
document.getElementById("closeSettingsBtn").addEventListener("click", () => {
    settingsModal.classList.remove("show");
    settingsModal.setAttribute("aria-hidden", "true");
});
document.getElementById("darkModeToggle").addEventListener("change", event => {
    document.body.classList.toggle("light-mode", !event.target.checked);
});
settingsModal.addEventListener("click", event => {
    if (event.target === settingsModal) document.getElementById("closeSettingsBtn").click();
});
document.addEventListener("keydown", event => {
    if (event.key === "Escape" && settingsModal.classList.contains("show")) {
        document.getElementById("closeSettingsBtn").click();
    }
});

window.addEventListener("pagehide", () => {
    shouldReconnect = false;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (socket) socket.close();
});

connectBackend();
showScreen("home");
