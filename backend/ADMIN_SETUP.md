# RandomChat admin panel

## Local setup

Copy `.env.example` to `.env` and replace the placeholder values:

```powershell
Copy-Item .env.example .env
```

Set a long, unique value for each of these variables:

- `ADMIN_USERNAME`: owner login name.
- `ADMIN_PASSWORD`: owner login password.
- `SESSION_SECRET`: random secret used to sign admin session cookies.

The server reads `.env` on supported Node versions, or you can set the variables in the shell before `npm start`. The `.env` file is ignored by Git.

Start the backend from this directory:

```powershell
npm start
```

Open `http://localhost:3000/` for the public app or `http://localhost:3000/admin` for the protected admin panel. For a separately hosted frontend, set the empty `randomchat-backend` meta tag in `index.html` to the backend HTTP(S) origin; the client derives `ws://` or `wss://` automatically.

## Current storage limits

Users, sessions, reports, announcements, settings, and bans are stored in server memory only. They are cleared when the server restarts. A permanent ban currently means permanent for the lifetime of the current server process; it is not persistent across restarts until a database is added. User IDs are temporary connection IDs and are not historical identities.

Admin sessions expire after eight hours and are stored in memory. Login failures are rate-limited per source address. Admin passwords are never sent to the browser, and admin API endpoints require the HTTP-only signed session cookie.
