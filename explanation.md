# Key Features — How They Work

A detailed walkthrough of every major feature in this chat application: what each one uses and how it is implemented.

---

## 1. Real-Time Messaging (Socket.IO)

**What it uses:** `socket.io` on the server, `socket.io-client` in the browser.

**How it works:**
When the server starts, it attaches Socket.IO to the same HTTP server that Express uses:

```js
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "http://localhost:3000" } });
```

Every browser that opens the app gets a persistent **WebSocket connection** with a unique `socket.id`. The client connects once on mount:

```js
const socket = io('http://localhost:5000');
```

When a user sends a message, the client emits a `sendMessage` event with `{ content, recipient }`. The server receives it, saves it to MongoDB, then pushes it directly to the recipient's socket:

```js
io.to(recipientUser.socketId).emit('message', message);
```

Only those two users receive the message. The sender also gets a copy via `socket.emit('message', message)` so their own UI updates immediately.

**Key point:** Socket.IO sits on top of WebSockets (with HTTP long-polling as a fallback). It is event-driven — you define named events (`sendMessage`, `message`, `login`, etc.) and listen/emit on both ends independently.

---

## 2. Authentication (Signup / Login)

**What it uses:** Express REST endpoints + `bcryptjs` for password hashing.

**How it works — Signup:**
`POST /signup` receives `{ username, password }`. The server checks if the username already exists in MongoDB. If not, it hashes the password:

```js
const hashedPassword = await bcrypt.hash(password, 10); // 10 = salt rounds
```

The hashed password is saved — the plaintext is never stored.

**How it works — Login:**
`POST /login` fetches the user from MongoDB and compares the incoming password against the stored hash:

```js
const isMatch = await bcrypt.compare(password, user.password);
```

bcrypt hashes the input internally and compares — so the original password never needs to be recovered.

After REST login succeeds, the client also emits a Socket.IO `login` event. This second step "activates" the user in the real-time layer — the server updates `socketId`, sets `isOnline: true`, and sends the user their chat history.

**Why two steps (REST + Socket)?**
REST handles credential verification and returns a proper HTTP status code. The Socket.IO login then registers the user in the live session.

---

## 3. Chat History on Login

**What it uses:** MongoDB `Message` collection + Socket.IO `chatHistory` event.

**How it works:**
Immediately after the Socket.IO `login` event succeeds, the server queries the last 100 messages and emits them back to only that user:

```js
const messages = await Message.find().sort({ timestamp: 1 }).limit(100);
socket.emit('chatHistory', messages);
```

The client sets them into state:

```js
socket.on('chatHistory', (history) => setMessages(history));
```

When you click on a specific user, the client emits `getPrivateMessages` with `{ withUser: selectedUser.username }`. The server runs a targeted query:

```js
Message.find({
  type: 'user',
  $or: [
    { sender: currentUser, recipient: withUser },
    { sender: withUser, recipient: currentUser }
  ]
}).sort({ timestamp: 1 });
```

The result comes back as a `privateMessages` event and replaces the current message list.

---

### How exactly does the 100-message limit work?

Three MongoDB operations are chained together:

```js
Message.find()        // no filter — all messages in the DB are candidates
  .sort({ timestamp: 1 })  // oldest first (ascending)
  .limit(100)         // stop after 100 documents
```

- `find()` with no filter does not care about who sent what to whom — it looks at the entire messages collection across all conversations.
- `.sort({ timestamp: 1 })` ensures you get the 100 **earliest** messages, not a random 100. Changing `1` to `-1` would give the latest 100 but in reverse order.
- `.limit(100)` is enforced **on the database side** — MongoDB stops sending after 100 documents. Node.js never sees the rest, so it is efficient regardless of how many total messages exist.

### What does "up to 100" mean — is it per user or across everyone?

It is across everyone. When Alice logs in, the server does not filter by Alice's conversations. It fetches the latest 100 messages from the entire app combined. So if Alice has chatted with 5 people, those 100 messages are spread across all 5 conversations based on recency — not 100 per conversation.

For example, if Alice's most recent activity was only with Bob, those 100 could all be Alice↔Bob messages, with her other 4 conversations not represented at all.

### Why does this not matter much in practice?

Because the moment Alice clicks on any user in the sidebar, the app fires a second fetch (`getPrivateMessages`) that **replaces** the message list entirely with that specific conversation's history. So the 100 messages loaded on login are essentially a warm-up — they get overwritten as soon as any user is selected.

### The per-conversation fetch has no limit

The `getPrivateMessages` query has no `.limit()`:

```js
Message.find({ $or: [...] }).sort({ timestamp: 1 }); // no .limit()
```

This means when Alice clicks on Bob, every message they have ever exchanged gets loaded at once — whether that is 10 messages or 10,000. For a long-running conversation this would be slow and memory-heavy. The standard fix for this is **pagination** (load the latest 50, fetch older ones only when the user scrolls up), but that is not implemented here.

---

## 4. Online/Offline Status & User List

**What it uses:** MongoDB `User` model (`isOnline`, `socketId`, `lastSeen` fields) + Socket.IO broadcast.

**How it works:**
On `login` event, the server sets `user.isOnline = true` and saves the current `socket.id` against the user record. It then fetches all online users and broadcasts to everyone:

```js
const onlineUsers = await User.find({ isOnline: true });
io.emit('userList', onlineUsers);
```

On `disconnect` (fires automatically when a browser tab closes or refreshes), the server looks up the user by `socketId`, sets `isOnline = false`, updates `lastSeen`, and broadcasts the updated list again.

The client sidebar re-renders on every `userList` event, so all connected users see the change in real time.

**Key distinction between emit methods:**
- `io.emit()` — sends to **all** connected clients
- `socket.emit()` — sends only to the **current** client
- `io.to(socketId).emit()` — sends to one **specific** client

### Why is online status tied to user login state specifically?

The `isOnline` flag is not set when the socket connects — it is set only after the `login` event fires and credentials are verified. This means simply opening the app does not mark someone online. They must successfully authenticate first. Equally, when the socket disconnects (tab close, refresh, network drop), the server's `disconnect` handler automatically sets `isOnline = false` — no explicit logout action is needed from the user.

This is why the `socketId` is stored in the User document. When a disconnect happens, Socket.IO only tells the server which `socket.id` dropped. The server uses that to look up which user it belongs to and updates their status accordingly.

### What happens if the server crashes while a user is online?

The `isOnline` flag in MongoDB would remain `true` because the `disconnect` event never fired. On server restart, all users would appear online even though no one is connected. This is a known limitation — a production app would reset all `isOnline` flags to `false` on server startup.

---

## 5. Typing Indicators

**What it uses:** Socket.IO `typing` / `userTyping` events + `setTimeout` debounce in React.

**How it works:**
Every keystroke in the message input calls `handleTyping`. On the first keystroke it emits:

```js
socket.emit('typing', true);
```

A 1-second timeout is set. If the user keeps typing, the timeout resets. When 1 second passes with no new keystrokes, it emits:

```js
socket.emit('typing', false);
```

The server receives the `typing` event and broadcasts it to everyone *except* the sender:

```js
socket.broadcast.emit('userTyping', { socketId, username, isTyping });
```

The client maintains a `Map` of `socketId → username` for all currently-typing users. The UI renders this as `"Alice is typing..."` or `"Alice, Bob are typing..."` depending on how many entries are in the map.

**Why a Map instead of an array?**
Multiple users can type at the same time. The Map lets you track each user independently — add them when `isTyping: true`, remove them when `isTyping: false` — without having to search and splice an array.

### Why debounce with setTimeout instead of emitting on every keystroke?

If the app emitted a socket event on every single keystroke, a fast typist writing a sentence could fire 50–60 events per second. This would flood the server and every connected client with events constantly. The debounce pattern batches this — it only emits once when typing starts, and once again after typing stops (1 second of silence). So no matter how fast or long someone types, only 2 events are emitted per typing session.

### Why use `socket.broadcast.emit` here instead of `io.emit`?

`socket.broadcast.emit` sends to everyone **except the sender**. There is no point in telling Alice that Alice is typing — she already knows. `io.emit` would send it back to her too, which is unnecessary noise.

---

## 6. User Sidebar with Recency Sorting

**What it uses:** React state (`users` + `userOrder` arrays) + derived sort logic.

**How it works:**
- `users` holds the full user list fetched once from `GET /all-users`.
- `userOrder` is a separate array that tracks which usernames you have interacted with, most-recent first.

Every time you select a user or a new message arrives, `userOrder` is updated by moving that username to the front:

```js
const filtered = prev.filter(u => u !== selectedUser.username);
return [selectedUser.username, ...filtered];
```

The displayed list is derived from both arrays:

```js
const sortedUsers = [
  ...userOrder.map(u => users.find(x => x.username === u)).filter(Boolean),
  ...users.filter(u => !userOrder.includes(u.username))
];
```

First come users you have talked to (sorted by recency). Then everyone else in default order.

---

## 7. Responsive Mobile Sidebar (Hamburger Menu)

**What it uses:** React conditional rendering + CSS overlay.

**How it works:**
On desktop, the sidebar is always visible via the `users-sidebar-desktop` class. On mobile it is hidden by default. A hamburger icon (≡) in the header sets `sidebarOpen = true`.

When `sidebarOpen` is true, a full-screen dark overlay renders with the sidebar inside it:

```jsx
{sidebarOpen && (
  <div className="sidebar-overlay" onClick={handleSidebarClose}>
    <div className="users-sidebar users-sidebar-mobile" onClick={e => e.stopPropagation()}>
      ...
    </div>
  </div>
)}
```

Clicking the overlay background or the `×` button closes it. Selecting a user also auto-closes the sidebar by calling `setSidebarOpen(false)` inside the `onClick` handler.

`e.stopPropagation()` on the inner sidebar div prevents clicks inside it from bubbling up to the overlay and accidentally closing it.

---

## Quick Reference

| Feature | Server-side mechanism | Client-side mechanism |
|---|---|---|
| Real-time messaging | `io.to(socketId).emit()` | `socket.on('message')` |
| Authentication | `bcrypt.compare()` + Express REST | `fetch POST /login` or `/signup` |
| Chat history | MongoDB query on login | `socket.on('chatHistory')` / `socket.on('privateMessages')` |
| Online/offline status | `isOnline` field + `io.emit('userList')` | `socket.on('userList')` |
| Typing indicator | `socket.broadcast.emit('userTyping')` | `setTimeout` debounce + `Map` state |
| Recency sorting | — | `userOrder` state array |
| Mobile sidebar | — | `sidebarOpen` boolean + CSS overlay |
