🏀 AmirBallBot
AI game-film analysis for basketball coaches. Upload a full game, get back timestamped plays with Hebrew coaching notes, an annotatable film room, and an AI assistant that knows the game — built for Israeli Liga Leumit coaches who don't have a video department.

Status: in active development. The core analysis loop is built and working end-to-end. A few surfaces (scouting reports, practice plans, Notion export) are UI-staged and on the roadmap — see Feature status below. I'd rather tell you exactly what's real than overclaim.

<!-- 👇 HIGHEST-IMPACT THING TO ADD: a screen-recording GIF of the upload → analysis → editor flow. -->
<!-- ![AmirBallBot demo](docs/demo.gif) -->
▶ [Add a 60-second demo GIF or video link here]
<!-- Optional: 2–3 screenshots of the strongest screens (the timestamped-notes editor is the best one). -->

What it does
A coach uploads game footage (file or YouTube link). A few minutes later they get:

Detected plays — the system watches the whole game, finds the meaningful possessions, and returns each as a structured play (type, finish, shot mechanic, jersey numbers) with explicit confidence levels.
Hebrew coaching notes — each play is enriched into 2–3 sentences of actual coaching language, grounded in an embedded basketball knowledge base (FIBA rules, shot-quality rubric, offensive/defensive principles).
An annotatable film room — a video editor where the coach scrubs to any play and adds their own timestamped notes right alongside what the AI flagged.
An AI coach chat — ask questions about the game, a player, or a tactic, with the analysis as context.
A correction loop — the coach marks plays right or wrong; those corrections are fed back into future analyses, so the tool gets better at their team over time.

It's a single-coach product solving a real workflow: turning two hours of raw film into a reviewable, annotated, searchable game in minutes.

How it works
The pipeline orchestrates three AI models across 6+ calls per game, with code-level safety nets around the LLM output.
Upload (file / YouTube)
        │
        ▼
[ingest] download + probe ──► [jersey colors] one frame → Claude Haiku names team colors
        │
        ▼
[Gemini · pass 1]  watch the FULL video → return candidate play timestamps
        │            (count tiered by game length; biased to over-include, skip replays)
        ▼
[Gemini · pass 2]  re-watch an ~18s window around each timestamp (worker pool, concurrency 5,
        │            retry + backoff) → one structured play object w/ confidence fields
        ▼
[Claude Sonnet]    enrich each play into Hebrew coaching notes using the embedded
        │            "Basketball Brain" knowledge base + team knowledge + shot-quality overlay
        ▼
[dedup]            drop overlapping possessions (>50% time-window overlap)
        │
        ▼
[Claude Haiku]     refine shot mechanics + add factual observations on negative plays
        │
        ▼
[Claude Sonnet]    generate up to 4 game-level insights
        │
        ▼
[shot chart + persist]  bucket plays into a shot chart, save analysis, stream video back
On "player recognition": there's no biometric model. Gemini reads jersey numbers off the frames (with low/medium/high confidence gating) and string-matches them against the coach's roster to attach names. Honest and reliable when the number is legible; it skips when it isn't, rather than guessing.

Tech stack
LayerChoiceBackendNode.js + Express, TypeScriptFrontendSingle-file HTML/CSS/JS (no framework), deployed on VercelDatabaseMongoDB (Mongoose) — 6 models: Job, Analysis, Player, Correction, Verification, TeamKnowledgeVision AIGoogle Gemini 2.5 Flash — full-video understanding + per-clip structured extractionLanguage AIAnthropic Claude — Sonnet (coaching notes, insights, chat, roster parsing) + Haiku (jersey colors, shot-mechanic refinement, observations)Mediaffmpeg / ffprobe (frame extraction, probing), yt-dlp (YouTube ingest)InfraRailway (Dockerized API + video volume), MongoDB Atlas, async job queue with status polling
~7,900 lines of source. The AI pipeline lives in one ~2,300-line module; the embedded basketball knowledge base is another ~900 lines. ~25 REST endpoints across 8 route modules.

Feature status
Honest accounting of what's live versus staged:
FeatureStatusVideo upload → analysis✅ WorkingYouTube URL import → analysis✅ WorkingPlay detection (timestamps + structured plays)✅ Working (LLM-based; accuracy improving)Hebrew coaching notes & labels per play✅ WorkingGame-level insights✅ WorkingTimestamped video-notes editor (full CRUD)✅ WorkingAI coach chat (streaming)✅ WorkingRoster management + free-text roster parsing✅ WorkingSaved analyses (list / open / delete)✅ WorkingCoach correction & verification feedback loop✅ WorkingTeam knowledge base (philosophy + PDF upload)✅ WorkingPlayer recognition (jersey number → roster name)🟡 Partial — number reading, not identity trackingShot chart🟡 Partial — estimated from play locations, not tracked coordinatesQuarter segmentation🟡 Partial — duration-aware, not yet true segmentationScouting reports🔜 Planned — UI staged, backend in progressPractice / training plans🔜 PlannedNotion export🔜 Planned

Engineering notes
A few things I'm proud of under the hood:

Confidence-gated extraction — every play carries explicit confidence; low-confidence reads are flagged or dropped rather than presented as fact.
Worker pool with retry/backoff — per-clip analysis runs concurrently with graceful handling of provider rate limits (503/529).
Overlap-dedup — a code-level pass removes duplicate possessions the LLM occasionally double-reports.
Correction feedback loop — coach corrections are persisted and injected into future prompts, so the system adapts to a specific team.
Feature flags — the heavier analysis layers (shot-mechanic refinement, shot-quality overlay, observations) are individually toggleable.


Running locally
Required environment variables (names only):
ANTHROPIC_API_KEY     # required
GEMINI_API_KEY        # required
MONGODB_URI           # required in prod; optional locally (disables job queue / saved analyses)
PORT                  # optional, default 3000
BASE_URL              # optional, for prod video-serving URLs
GEMINI_MODEL          # optional, default gemini-2.5-flash
Also requires ffmpeg, ffprobe, and yt-dlp on your PATH.
bashnpm install
npm run dev        # tsx watch → http://localhost:3000
# serve index.html (Live Server, or: python -m http.server)

# production build
npm run build      # tsc → dist/
npm start          # node dist/server.js

Roadmap

 True quarter segmentation
 Scouting reports (opponent tendencies from past analyses)
 Practice-plan generation from flagged weaknesses
 Notion export
 Real per-player stat tracking (currently placeholder)


<sub>Designed and built solo, end to end — product, pipeline, and UI — using Claude Code.</sub>
