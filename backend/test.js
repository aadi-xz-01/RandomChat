const assert = require("assert");
const WebSocket = require("ws");

const url = process.env.TEST_WS_URL || "ws://127.0.0.1:3000";
const timeoutMs = 5000;

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const events = [];
        let settled = false;

        const fail = error => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        };

        ws.on("message", raw => {
            let event;
            try {
                event = JSON.parse(raw.toString());
            } catch (error) {
                fail(error);
                return;
            }
            events.push(event);
            if (!settled && event.type === "connected") {
                settled = true;
                resolve({ ws, events });
            }
        });
        ws.once("error", fail);
    });
}

function waitFor(events, type, startIndex = 0) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => {
            const eventIndex = events.findIndex((event, index) => index >= startIndex && event.type === type);
            if (eventIndex >= 0) {
                resolve({ event: events[eventIndex], nextIndex: eventIndex + 1 });
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Timed out waiting for ${type}`));
                return;
            }
            setTimeout(check, 20);
        };
        check();
    });
}

function send(client, data) {
    client.ws.send(JSON.stringify(data));
}

function closeClient(client) {
    return new Promise(resolve => {
        if (client.ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
        }
        client.ws.once("close", resolve);
        client.ws.close();
    });
}

async function closeAll(clients) {
    await Promise.all(clients.map(closeClient));
}

async function run() {
    const clients = [];
    try {
        const invalid = await connect();
        clients.push(invalid);
        send(invalid, { type: "find", profile: { name: "Too Young", age: 17, bio: "" } });
        const invalidResult = await waitFor(invalid.events, "error");
        assert.match(invalidResult.event.message, /18/);
        await closeClient(invalid);

        const malformed = await connect();
        clients.push(malformed);
        malformed.ws.send("null");
        malformed.ws.send("not-json");
        send(malformed, { type: "find", profile: { name: "Clean User", age: 18, bio: "\u0000hello" } });
        const malformedWaiting = await waitFor(malformed.events, "waiting");
        assert.strictEqual(malformedWaiting.event.type, "waiting");
        await closeClient(malformed);

        const alice = await connect();
        const bob = await connect();
        clients.push(alice, bob);
        send(alice, { type: "find", profile: { name: "Alice", age: 25, bio: "Loves chat" } });
        send(bob, { type: "find", profile: { name: "Brave Bob", age: 20, bio: "Hello there" } });
        const aliceMatch = await waitFor(alice.events, "matched");
        const bobMatch = await waitFor(bob.events, "matched");
        assert.deepStrictEqual(aliceMatch.event.profile, { name: "Brave Bob", age: 20, bio: "Hello there" });
        assert.deepStrictEqual(bobMatch.event.profile, { name: "Alice", age: 25, bio: "Loves chat" });

        send(alice, { type: "message", text: "hello from Alice" });
        const bobMessage = await waitFor(bob.events, "message");
        assert.strictEqual(bobMessage.event.text, "hello from Alice");
        send(bob, { type: "message", text: "hello from Bob" });
        const aliceMessage = await waitFor(alice.events, "message");
        assert.strictEqual(aliceMessage.event.text, "hello from Bob");
        send(alice, { type: "leave" });
        await waitFor(bob.events, "partner-left");

        const bobEventStart = bob.events.length;
        const carol = await connect();
        clients.push(carol);
        send(bob, { type: "find", profile: { name: "Bob Again", age: 30, bio: "New bio" } });
        send(carol, { type: "find", profile: { name: "Carol", age: 22, bio: "Hi" } });
        const bobRematch = await waitFor(bob.events, "matched", bobEventStart);
        const carolRematch = await waitFor(carol.events, "matched");
        assert.deepStrictEqual(bobRematch.event.profile, { name: "Carol", age: 22, bio: "Hi" });
        assert.deepStrictEqual(carolRematch.event.profile, { name: "Bob Again", age: 30, bio: "New bio" });

        console.log("PASS: 18+ validation, malformed payload handling, matching, bidirectional messaging, leave, and fresh-event rematching");
    } finally {
        await closeAll(clients);
    }
}

run().catch(error => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
});