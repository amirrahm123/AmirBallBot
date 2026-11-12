# 🏀 HoopAssist

**An AI film room for basketball coaches.** Upload a game and get back the possessions that matter, each as a timestamped coaching card in Hebrew, inside a film room where the coach can filter, annotate and correct the analysis.

Built for Israeli club coaches who don't have a video department.

▶ **[Watch the 65-second explainer](https://portfolio-amirrahm.vercel.app)** (HoopAssist section)

> **Status: in active development.** The analysis loop and the film room work end to end. Auth, billing and a few screens are not built yet, and full-length games are still being validated. See [Feature status](#feature-status) for exactly what is real.

## What a coach gets

- **Every possession, logged.** The whole game is surveyed and each possession is written down as an ordered event chain: who did what, where, and when.
- **The 10–15 that matter.** The most instructive possessions are picked and turned into coaching cards: what happened, where everyone stood, and what to fix, each marked good / bad / could be better.
- **A film room.** Every selected play is a marker on the video timeline. Filter by offense, defense or transition, change playback speed, jump play to play from the keyboard, and add your own timestamped notes.
- **A coach in the loop.** Mark a play correct or fix it. Corrections are stored and fed into the next analysis for the same team.
- **Game insights and a shot chart**, a streaming AI chat that knows the game, a roster (paste free text and it is parsed), and a library of saved analyses.

## How it works

```
Game film (file or YouTube link)
        │
        ▼
SURVEY   Gemini watches the game in 2-minute chunks (2 fps, low resolution) and logs
         EVERY possession as a literal event chain with timestamps. Strict JSON schema,
         one call per chunk; chunks that come back implausibly empty are re-scanned once.
        │
        ▼
COACH    Claude gets the full possession log plus key frames, cut locally with ffmpeg
         at the exact moments Gemini named. It picks the 10–15 most instructive
         possessions and writes the Hebrew coaching analysis in ONE call.
        │
        ▼
FILM ROOM   timeline markers, filters, notes, corrections
        ▲                                   │
        └────── coach corrections ──────────┘   (injected into the next COACH call)
```

Design choices worth knowing about:

- **Fewer calls, not faster calls.** One survey call per chunk and a single coaching call, instead of a call per play.
- **Cached survey.** Gemini's survey is cached by video file hash, so re-running the same video only costs the Claude pass.
- **Events, not guessed set names.** The survey records what literally happened, with a confidence level per possession; the coaching layer reasons on top of that log.
- **Resilience.** Retry with backoff on rate limits and network errors, request timeouts, and a fallback chain across Gemini models when a daily quota runs out.
- **Jersey numbers, not biometrics.** Players are identified by reading jersey numbers and matching them to the coach's roster.
- **Deep dive on demand.** A single possession can be re-watched at a higher frame rate and its card rewritten.
- The original per-clip pipeline (v1) is still in `src/analyzer.ts` and can be restored with `ANALYZER=v1`.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express, TypeScript |
| Frontend | Single-file HTML/CSS/JS, no framework (Hebrew, RTL) |
| Database | MongoDB (Mongoose) |
| Vision | Google Gemini (video survey) |
| Language | Anthropic Claude (coaching analysis, chat, roster parsing) |
| Media | ffmpeg / ffprobe, yt-dlp |
| Hosting | Railway (API), Vercel (frontend), MongoDB Atlas |

## Feature status

| Feature | Status |
|---|---|
| Video upload / YouTube link → analysis | ✅ Working |
| Possession survey + selected coaching cards (Hebrew) | ✅ Working |
| Game insights, shot chart (estimated from shot locations) | ✅ Working |
| Film room: timeline markers, filters, speed, keyboard navigation | ✅ Working |
| Timestamped coach notes (add / edit / delete) | ✅ Working |
| Coach corrections fed into the next analysis | ✅ Working |
| AI coach chat (streaming) | ✅ Working |
| Roster management + free-text roster parsing | ✅ Working |
| Saved analyses | ✅ Working |
| Team knowledge (philosophy, playbook PDFs) | 🟡 Backend only, no screen yet |
| Accounts / multi-team separation | 🔜 Planned |
| Scouting reports, practice plans, Notion export | 🔜 Planned (buttons are disabled in the UI) |

See `FULL_BETA_PLAN.md` and `ROADMAP_AUDIT.md` for the roadmap.

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

<sub>Designed and built solo, end to end (product, pipeline and UI), using Claude Code.</sub>
