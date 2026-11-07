# HoopAssist

Basketball game analysis tool for Israeli Liga Leumit. Backend on Railway, frontend on Vercel, MongoDB Atlas for storage, Gemini + Anthropic Claude for the analysis pipeline.

## Running locally for free (no Railway)

The frontend auto-detects whether it's running locally and talks to a local backend instead of Railway. Useful while the Railway trial is paused, or for any iteration that doesn't need prod data.

### One-time setup

1. Create a `.env` file in the repo root with these keys (values from your own accounts — never commit this file):
   ```
   ANTHROPIC_API_KEY=...
   GEMINI_API_KEY=...
   MONGODB_URI=...     # Atlas connection string, optional but the job queue / saved analyses need it
   PORT=3000          # optional; this is the default
   ```
   `.env` is already gitignored. If it doesn't exist on your machine, create it before starting the server.

2. `npm install` — pulls dev dependencies including `tsx`.

### Each session

1. **Start the backend** in one terminal:
   ```
   npm run dev
   ```
   This runs `tsx watch src/server.ts`, which auto-reloads on every file save. Look for `🏀 HoopAssist API running on port 3000`.

2. **Open the frontend** by any of these methods:
   - Double-click `index.html` (opens via `file://`) — works because CORS allows `file://` and any `localhost:*` origin.
   - VS Code Live Server (`localhost:5500`).
   - `python -m http.server 3000` then visit `http://localhost:3000/index.html`.

3. The frontend detects `localhost` / `127.0.0.1` / empty hostname (file://) and talks to `http://localhost:3000`. Anywhere else (Vercel, prod) it talks to Railway.

### Testing the verify scoring flow

1. Have at least one analysis already saved in your MongoDB (or run a fresh analysis through the local backend).
2. Open the analysis in the frontend.
3. Mark some plays ✅, mark some ❌, leave some unscored.
4. Click `שמור ציון`. The save payload now includes `scoredPlays` and is persisted on the Verification document.

## Production deploy

- Push to `master` → Railway auto-deploys the backend.
- Vercel auto-deploys `index.html` from the root on push to `master`.
- See `FULL_BETA_PLAN.md` for the broader product roadmap.
