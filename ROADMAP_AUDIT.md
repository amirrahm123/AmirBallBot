# AmirBallBot / HoopMind — Full Audit & Roadmap

**Audit date:** 2026-05-09
**Repo state at audit:** master @ `b1da469` (commits since fork from `6215186`: tier-cap feature, video TTL fix, plan+landing docs)
**Auditor caveats:**
- **Training cutoff is January 2026.** Post-cutoff Gemini model lineup (Gemini 3.x family, May 19 I/O announcements, June 1 retirement dates) is taken as user-supplied ground truth. Where API/SDK compatibility differences between model versions cannot be verified from the current code or training data, this is flagged as **[VERIFY-VS-SDK]**.
- All claims about code behavior cite file:line.
- "Gemini Omni" is correctly excluded per user instruction — it's a generation model, not an analysis model.

---

## 1. Full project roadmap & current state

### 1.1 Project structure

```
src/
├── server.ts                          Express entry point, route wiring, CORS, MongoDB connect, startup video cleanup
├── database.ts                        Mongoose models: Player, Game, TeamKnowledge, Analysis, Verification, Job (jobs queue)
├── analyzer.ts                        2288 lines — the entire pipeline (uploads, timestamp detection, per-clip, enrichment, insights)
├── routes/
│   ├── analyze.ts                     POST /api/analyze (creates Job, returns 202), /upload-video, GET /api/job/:jobId, corrections
│   ├── analyses.ts                    CRUD on saved analyses + coach notes
│   ├── chat.ts                        POST /api/chat — SSE-streamed Claude Sonnet 4 chat
│   ├── knowledge.ts                   PDF upload + team philosophy/system knowledge storage
│   ├── players.ts                     Roster CRUD + Claude-based roster text parser + per-player AI insights
│   ├── verify.ts                      Post-hoc verification of saved analyses against Gemini (internal consistency check)
│   └── video.ts                       GET /api/video/:jobId — streams persisted .mp4 from /app/videos with HTTP Range support
└── knowledge/
    └── basketballBrain.ts             Static Hebrew/English domain-knowledge strings (vocab, principles, KPIs, framework)

Top-level files:
├── package.json                       Deps: @google/genai ^1.49.0, @anthropic-ai/sdk ^0.39.0, express, mongoose, multer, yt-dlp-exec, pdf-parse
├── Dockerfile                         node:20-slim + ffmpeg + python3 + yt-dlp; builds dist/, runs node dist/server.js, exposes 3000
├── vercel.json                        Vercel deploys outputDirectory "." with rewrite: /(.*) → /index.html
├── index.html                         135 KB root frontend (the main app served via Vercel)
├── landing/index.html                 28 KB Hebrew RTL HoopMind marketing page (NOT the served frontend — vercel.json points to root)
├── FULL_BETA_PLAN.md                  34 KB beta plan doc (just committed in b1da469)
├── api/index.js                       Single 109-byte file (legacy Vercel serverless stub, probably dead — see §1.6)
├── bin/                               ffmpeg.exe / ffprobe.exe — Windows-only local-dev binaries (not used on Railway)
└── .env / .env.example                ANTHROPIC_API_KEY, GEMINI_API_KEY, MONGODB_URI, PORT
```

### 1.2 API routes — full inventory

| Method | Path | File:line | Purpose |
|---|---|---|---|
| GET | `/health` | [server.ts:34](src/server.ts#L34) | Health check |
| POST | `/api/analyze` | [analyze.ts:116](src/routes/analyze.ts#L116) | Create job, return 202 + jobId; processes async via `setImmediate` |
| POST | `/api/analyze/upload-video` | [analyze.ts:164](src/routes/analyze.ts#L164) | Direct passthrough to Gemini Files API |
| POST | `/api/analyze/correction` | [analyze.ts:216](src/routes/analyze.ts#L216) | Coach marks a play correct/incorrect with text |
| GET | `/api/analyze/corrections/:jobId` | [analyze.ts:238](src/routes/analyze.ts#L238) | List corrections for one job |
| GET | `/api/job/:jobId` | [analyze.ts:191](src/routes/analyze.ts#L191) | Poll job status/progress/result (frontend long-polls this) |
| POST | `/api/chat` | [chat.ts:6](src/routes/chat.ts#L6) | SSE-streamed Claude Sonnet 4 chat with optional analysis context |
| GET | `/api/players` | [players.ts:8](src/routes/players.ts#L8) | List roster |
| POST | `/api/players` | [players.ts:20](src/routes/players.ts#L20) | Add player |
| POST | `/api/players/parse-roster` | [players.ts:42](src/routes/players.ts#L42) | Claude parses free-text roster |
| GET | `/api/players/:id` | [players.ts:86](src/routes/players.ts#L86) | Player profile + AI-generated insights |
| DELETE | `/api/players/all` | [players.ts:129](src/routes/players.ts#L129) | Wipe roster |
| DELETE | `/api/players/:id` | [players.ts:141](src/routes/players.ts#L141) | Delete single player |
| GET | `/api/knowledge` | [knowledge.ts:13](src/routes/knowledge.ts#L13) | Get team knowledge doc |
| POST | `/api/knowledge/settings` | [knowledge.ts:30](src/routes/knowledge.ts#L30) | Save philosophy + offense/defense systems |
| POST | `/api/knowledge/upload` | [knowledge.ts:55](src/routes/knowledge.ts#L55) | Upload PDFs, parse with pdf-parse, store first 50000 chars per file |
| DELETE | `/api/knowledge/document/:index` | [knowledge.ts:110](src/routes/knowledge.ts#L110) | Remove indexed doc |
| GET | `/api/analyses` | [analyses.ts:17](src/routes/analyses.ts#L17) | List analysis summaries |
| GET | `/api/analyses/:id` | [analyses.ts:30](src/routes/analyses.ts#L30) | Full analysis |
| POST | `/api/analyses/:id/notes` | [analyses.ts:45](src/routes/analyses.ts#L45) | Add coach timestamped note |
| PUT | `/api/analyses/:id/notes/:noteId` | [analyses.ts:84](src/routes/analyses.ts#L84) | Edit note |
| DELETE | `/api/analyses/:id/notes/:noteId` | [analyses.ts:122](src/routes/analyses.ts#L122) | Delete note |
| DELETE | `/api/analyses/:id` | [analyses.ts:150](src/routes/analyses.ts#L150) | Delete analysis |
| POST | `/api/verify/verify/:analysisId` | [verify.ts:8](src/routes/verify.ts#L8) | **Bug**: doubled `verify/verify` path — verify router is mounted at `/api/verify` and the route is `/verify/:analysisId` |
| POST | `/api/verify/save/:analysisId` | [verify.ts:100](src/routes/verify.ts#L100) | Save verification score |
| GET | `/api/video/:jobId` | [video.ts:11](src/routes/video.ts#L11) | Range-streams persisted MP4 from `/app/videos/{jobId}.mp4` |

### 1.3 Pipeline end-to-end trace (video upload → response)

**Step 1: Client → POST /api/analyze** ([analyze.ts:116](src/routes/analyze.ts#L116))
- Multer writes uploaded file to `os.tmpdir()`.
- Server creates a `Job` row in MongoDB with `status: 'pending'`, returns `{ jobId, status: 'pending' }` with HTTP **202**.
- `setImmediate(() => processJob(jobId, input))` kicks off async processing in the *same Node process*. **There is no separate worker — see §2.4.**

**Step 2: processJob** ([analyze.ts:49](src/routes/analyze.ts#L49))
- Fetches roster from `Player.find()`.
- Marks job `processing`, progress 5%.
- Calls `runAnalysis()` → which dispatches to `analyzeVideo` / `analyzeYouTube` / `analyzeGeminiFile` / `analyzeImage` based on input shape.
- All three video paths funnel into `runVideoPipeline()` ([analyzer.ts:2089](src/analyzer.ts#L2089)).

**Step 3: runVideoPipeline** ([analyzer.ts:2089](src/analyzer.ts#L2089))
1. **Upload to Gemini Files API** ([analyzer.ts:489 uploadVideoToGemini](src/analyzer.ts#L489)) — single upload of the *entire video file*, blocks on `FileState.PROCESSING → ACTIVE`. No chunking.
2. **Jersey color detection** ([analyzer.ts:1887 extractSingleFrame](src/analyzer.ts#L1887)) — ffmpeg pulls ONE frame at t=8s, Claude Haiku 4.5 identifies both teams' jersey colors. Skipped if user provided values.
3. **Pass 1: detectPlayTimestamps** ([analyzer.ts:525](src/analyzer.ts#L525)) — ONE Gemini call against the full video file URI. Returns up to N timestamps in MM:SS, where N is tier-capped: ≤15min→15, ≤30min→30, ≤50min→45, >50min→65. Tier emitted as log line `📐 Video length: X min → tier: Y → cap: Z plays`.
4. **Pass 2: analyzeClipAtTimestamp** ([analyzer.ts:1032](src/analyzer.ts#L1032)) — for each timestamp, parallel Gemini call with `videoMetadata: { startOffset: (t-8)s, endOffset: (t+10)s }` to focus on an 18-second window. **Worker pool with `CLIP_CONCURRENCY = 5`** ([analyzer.ts:2145](src/analyzer.ts#L2145)) — 5 clips analyzed at once.
5. **Step 3: enrichPlaysWithClaude** ([analyzer.ts:1319](src/analyzer.ts#L1319)) — ONE Claude Sonnet 4 call. Converts structured Gemini play objects into Hebrew coaching narratives.
6. **dedupOverlappingPlays** ([analyzer.ts:1820](src/analyzer.ts#L1820)) — merges plays within 15s of each other.
7. **refineShotMechanicsWithHaiku** ([analyzer.ts:1170](src/analyzer.ts#L1170)) — Per-shot Claude Haiku 4.5 call verifying shot mechanic. Toggleable via `SHOT_MECHANIC_REFINE_ENABLED` env.
8. **generateObservationsForNegativePlays** ([analyzer.ts:1973](src/analyzer.ts#L1973)) — Per-negative-play (block/steal/missed/turnover) Claude Haiku 4.5 call generating factual observations.
9. **generateInsightsFromPlays** — Claude Sonnet 4 generates coaching insights (called once).
10. **Computes shot chart** from finish_location buckets in the Gemini plays.

**Step 4: Persist & save** ([analyze.ts:73-101](src/routes/analyze.ts#L73-L101))
- Copies uploaded MP4 to `/app/videos/{jobId}.mp4` (Railway volume).
- Constructs `videoUrl: BASE_URL/api/video/{jobId}.mp4`.
- Inserts `Analysis` row in MongoDB with plays/insights/shotChart.
- Updates Job: `status: 'done'`, `progress: 100`, `result: {plays, insights, shotChart, videoUrl}`.

**Step 5: Client polls** GET /api/job/:jobId until `status === 'done'`, then renders the result.

### 1.4 External services

| Service | Used for | Where it lives |
|---|---|---|
| **Railway** | Backend hosting (Node 20 container), 50 GB persistent volume at `/app/videos` | `Dockerfile`, `railway status` |
| **Vercel** | Frontend hosting (`amirballbot.vercel.app`), root `index.html` SPA-style with all routes rewriting to `/` | `vercel.json` |
| **MongoDB Atlas** | Jobs queue, Analysis records, Players, TeamKnowledge, Verifications | `MONGODB_URI` env var, `src/database.ts` |
| **Google Gemini Files API** | Video upload + retrieval for analysis (`gemini-2.5-flash` model — see §3) | `GEMINI_API_KEY` env var, [analyzer.ts:118](src/analyzer.ts#L118) |
| **Anthropic Claude API** | Sonnet 4 + Haiku 4.5 for Hebrew enrichment, shot-mechanic verify, observations, chat, player insights, roster parsing | `ANTHROPIC_API_KEY` env var |
| **yt-dlp (binary in container)** | YouTube/Google Drive video downloads | Installed in Dockerfile, called via `spawnSync('yt-dlp', ...)` at [analyzer.ts:262](src/analyzer.ts#L262) |
| **ffmpeg/ffprobe (binary in container)** | Single-frame extraction for jersey detection, duration probe | Installed in Dockerfile, called via `execFileSync(FFMPEG, ...)` |
| **pdf-parse (npm)** | Extract text from coach-uploaded PDFs into TeamKnowledge | [knowledge.ts:73](src/routes/knowledge.ts#L73) |

### 1.5 Env vars referenced in code

| Var | Required? | Used at |
|---|---|---|
| `GEMINI_API_KEY` | ✅ Yes | analyzer.ts, verify.ts, routes/analyze.ts |
| `ANTHROPIC_API_KEY` | ✅ Yes | analyzer.ts, chat.ts, players.ts |
| `MONGODB_URI` | ⚠️ Optional (DB disabled if missing — see [database.ts:194](src/database.ts#L194)) | database.ts |
| `PORT` | Defaults to 3000 | server.ts |
| `GEMINI_MODEL` | Optional override, default `gemini-2.5-flash` | [analyzer.ts:118](src/analyzer.ts#L118) |
| `VIDEOS_DIR` | Optional override, default `/app/videos` | [analyzer.ts:140](src/analyzer.ts#L140) |
| `BASE_URL` | Optional, default `https://amirballbot-production.up.railway.app` | [analyze.ts:77](src/routes/analyze.ts#L77) |
| `CORRECTIONS_INJECTION_ENABLED` | Optional toggle, default `'true'` (any other value disables) | [analyzer.ts:29](src/analyzer.ts#L29) |
| `SHOT_MECHANIC_REFINE_ENABLED` | Optional toggle, default `'true'` | [analyzer.ts:1174](src/analyzer.ts#L1174) |

### 1.6 What's working, half-built, broken

**Working well:**
- Core upload → analyze → display pipeline for short and medium clips.
- Tier-cap timestamp budget (live since commit `3ead859`).
- Coach corrections feedback loop ([analyzer.ts:28 loadRecentCorrections](src/analyzer.ts#L28)) — recent `correct: false` corrections are injected as few-shot examples into subsequent enrichments for the same team.
- Per-clip retry with exponential backoff + jitter (handles 503/529 gracefully).
- Persistent video volume on Railway, 90-day TTL cleanup with directory-skip guard.
- HTTP Range streaming for video scrubbing.
- Jersey color auto-detection from a single frame.

**Half-built / questionable:**
- **`api/index.js`** (109 bytes) — likely a vestigial Vercel serverless stub from a pre-Railway era. Should verify and probably delete. Vercel deploys `outputDirectory: "."` so this would be invoked if any path matched it, but the rewrite rule sends `/(.*)` to `/index.html`, effectively shadowing it. Dead code candidate.
- **`landing/`** (the HoopMind marketing page) was just committed to the repo but is **not wired into the Vercel deploy**: `vercel.json` deploys the root `index.html`, not `landing/index.html`. If you want the landing page live somewhere, you need to either point Vercel at `landing/` or add another deploy/route.
- **Verify endpoint pathing bug**: mounted at `/api/verify`, route is `/verify/:analysisId` → actual URL is `/api/verify/verify/:analysisId`. Either the mount should be `/api/` or the route should be `/:analysisId`. Probably a refactor leftover.
- **`extractFrames` + `analyzeFrames`** ([analyzer.ts:303-407](src/analyzer.ts#L303)) — the "Claude Vision" frame-extraction fallback path exists but is **only called by `analyzeImage`** for single-image inputs. For videos, the pipeline always uses Gemini Files API. The `extractFrames` cap of 20 frames is also basically meaningless because it's never used on a real video. Either delete this dead path or wire it up as an explicit fallback.
- **`extractFrames` 20-frame cap** ([analyzer.ts:332-339](src/analyzer.ts#L332)) — for any video longer than 100s (every game), this throws away frames to fit in 20. Even when this path IS exercised for images it's a no-op (single image), but the logic is broken-by-design for the only use it would have.
- **Hardcoded model string in verify.ts**: [verify.ts:49](src/routes/verify.ts#L49) hardcodes `'gemini-2.5-flash'` rather than reading `GEMINI_MODEL`. Diverges from analyzer.ts which uses the env var. Inconsistent.
- **Verify endpoint is fully sequential** ([verify.ts:22-80](src/routes/verify.ts#L22-L80)) — iterates plays one at a time, awaiting each Gemini call. For 65 plays that's many minutes of single-threaded calls.
- **Job processing dies on container restart** — `setImmediate` runs in the same Node process. A Railway redeploy or crash mid-analysis leaves the job stuck in `processing` forever with no resume mechanism.
- **PDF text storage capped at 50,000 chars per doc** ([knowledge.ts:79](src/routes/knowledge.ts#L79)) — silently truncates without warning the coach. A 20-page playbook will likely exceed this.

**Broken / suspicious:**
- No global Express error handler — if a route throws synchronously outside its try/catch, the server may crash or hang the client.
- `setImmediate(() => processJob(...))` has `.catch()` but **the catch only logs to console** ([analyze.ts:150](src/routes/analyze.ts#L150)) — if it throws *before* MongoDB update, the job sits forever in `pending`.
- `BASE_URL` defaults to Railway URL — but Railway URL is environment-specific. If you ever stage on a preview environment, video URLs will incorrectly point to prod.

### 1.7 TODOs / FIXMEs / hacky workarounds

No literal `TODO` / `FIXME` / `HACK` markers exist in src/ — verified by grep. But the workarounds I found:

| Location | What | Why it's hacky |
|---|---|---|
| [analyzer.ts:532-545](src/analyzer.ts#L532-L545) | `videoDurationSeconds = 600` fallback if Gemini doesn't return `videoMetadata.videoDuration` | Silently assumes 10 min on failure → tier cap defaults to "single quarter" (15) for what could be a full game. Should at least log+escalate, ideally probe with ffprobe as backup. |
| [analyzer.ts:1078-1080](src/analyzer.ts#L1078) | `(emptyErr as any).status = 503` to coerce empty responses into the retry loop | Conflates "Gemini returned `text: ''`" with "API gave 503". Functional but misleading in logs. |
| [analyze.ts:149-151](src/routes/analyze.ts#L149-L151) | `setImmediate(() => processJob(jobId, input))` for fire-and-forget background work | Not a queue. No retries on container restart. No backpressure. See §2.4. |
| [analyzer.ts:1061](src/analyzer.ts#L1061) | `} as any` cast on the Gemini `config` block to allow `thinkingConfig` | Suggests SDK types don't include `thinkingConfig` — could be SDK lag or a non-standard field. **[VERIFY-VS-SDK]** |
| [analyzer.ts:490, 527, 1042](src/analyzer.ts) | Dynamic `await import('@google/genai')` inside multiple functions instead of top-level import | Probably a leftover from CommonJS/ESM interop debugging. Replace with one top-level import. |
| [verify.ts:49](src/routes/verify.ts#L49) | Hardcoded `'gemini-2.5-flash'` instead of `GEMINI_MODEL` | Will be missed on model migration. |

### 1.8 Prioritized roadmap

**(a) Immediate fixes — this week**
1. **Migrate off `gemini-2.5-flash`** to the Gemini 3.x lineup. Even though your specific retirement-flagged model (2.0 Flash/Flash-Lite) isn't what we're using, 2.5 Flash is still pre-3.x and likely subject to its own deprecation window. See §3 for the diff.
2. **Fix verify.ts mount path bug** — change route from `/verify/:analysisId` to `/:analysisId` OR mount router at `/api`. Whichever the frontend is calling. Don't ship two PRs that contradict.
3. **Sync `verify.ts` to use `GEMINI_MODEL` env** — remove hardcoded string at [verify.ts:49](src/routes/verify.ts#L49).
4. **Decide what `landing/` is for and either wire it up to deploy or move it out of the deploy path.** Right now it's committed but invisible to users.
5. **Add a global Express error handler** (after route registration in `server.ts`) so unhandled throws return 500 instead of hanging.
6. **Run the baseline accuracy test on Maccabi vs Be'er Sheva Q1** (already on roadmap) — needs to happen BEFORE the model migration so you have a comparison baseline.

**(b) Next 2 weeks**
1. **Proper job queue / resumability** — replace `setImmediate` with one of:
   - **Lightweight**: a single resumer that on container start scans for `status: 'processing'` jobs older than N minutes, marks them as `failed` so the frontend stops polling forever.
   - **Heavier**: BullMQ + Redis (Railway has a Redis plugin), with retries and persistence. See §2.6.
2. **Phase 1 — auto-chunking for full-game uploads** (the planned next product feature). Detail in §2.6.
3. **Run verify.ts in parallel** — the sequential loop is unnecessary; use the same `CLIP_CONCURRENCY=5` worker pattern as the main pipeline.
4. **Add `extractFrames` + `analyzeFrames` fallback handling or delete them** — they're dead code for videos.
5. **Top-level the `@google/genai` import** instead of dynamic imports in 4 places.
6. **Add ffprobe-based duration fallback** when Gemini can't return `videoMetadata.videoDuration`. Today's silent 10-min default is hostile to long games.
7. **Phase 4 R2/Cloudflare doc removal** (separate PR, low priority — see [project_phase4_r2_removal.md] in memory).

**(c) Next 1-2 months**
1. **Move away from in-process job execution** entirely. Railway redeploy = lost analysis. Worker process or external queue.
2. **Tighten capacity story**: 50 GB volume @ 1.7 GB used today is fine, but at 100 games/month × ~80 MB persisted, you'll cross 70% around month 3-4. Either auto-prune low-value videos sooner than 90 days, or move to R2/S3 with longer cold storage. (Note: §3 in memory says capacity is on the post-beta backlog — don't act on this without the user's go-ahead.)
3. **Add a workspace/team model** — currently all knowledge/players are global (`teamId: 'default'` is hardcoded in knowledge.ts). For multi-coach beta you'll need auth + per-team scoping.
4. **Verification UX as a first-class flow** — `verify.ts` exists and writes scores but isn't surfaced in the main job flow. Consider running self-verification automatically on done jobs and surfacing `geminiAccuracy` to coaches.
5. **Coach correction loop visibility** — the corrections-injection logic at [analyzer.ts:28](src/analyzer.ts#L28) is silent; coaches don't see when their past corrections are influencing a new analysis. A small "based on 7 past corrections" banner would build trust.
6. **Cost dashboard** — current pipeline costs aren't tracked per-job. With 65 clips × Gemini 3 Flash + 65 Haiku refinements + 2 Sonnet enrichments per game, a per-job $/minute number would unlock pricing decisions.
7. **Long-video evaluation harness** — Phase 1 chunking decisions need a real test bed. Build a small tool that runs N different chunking/sampling strategies on the same Maccabi clip and diffs the play lists.

---

## 2. Long-video handling (e.g. 90-minute full game)

### 2.1 Current chunking strategy — **none, structurally**

The video is never split. [runVideoPipeline](src/analyzer.ts#L2089) uploads the entire file to Gemini Files API as a single upload, then passes the same `fileUri` to every downstream call. The "chunking" you might think you have is actually:

- **Timestamp budget** ([analyzer.ts:546-562](src/analyzer.ts#L546)) — picks how many timestamps to *return* based on duration tier (15/30/45/65). This is a quota on plays, not a video split.
- **Per-clip windowing** ([analyzer.ts:1067-1070](src/analyzer.ts#L1067)) — the per-clip call uses `videoMetadata: { startOffset: (t-8)s, endOffset: (t+10)s }` to narrow the model's attention to an 18-second window around each timestamp. The full file remains uploaded; only the per-call attention is windowed.

So a 90-minute game means:
- **One** ~500 MB-1 GB upload to Gemini Files API (Files API limit is ~2 GB — should fit).
- **One** Gemini call against the full 90-min video for timestamp detection.
- **Up to 65** Gemini calls, each pointing at an 18-second window inside the same file URI.

There is no quarter detection, no scoreboard parsing, no boundary-aware chunking.

### 2.2 Frame sampling — fixed, not adaptive, and not used on videos

- Only the dead `extractFrames` path ([analyzer.ts:303](src/analyzer.ts#L303)) does frame extraction, and it does **fixed 1 frame / 5 seconds**, capped at 20 frames total.
- For real video analysis, **the model handles its own internal frame sampling** when we hand it the Files API URI + a window. We have no control over its sampling rate beyond the prompt asking for "shot-clock visible" frames.
- **Adaptive sampling on score changes**: not implemented. Would require either an OCR pre-pass on the scoreboard or a heuristic on motion changes. Both are doable but unbuilt.

### 2.3 Request timeouts — and how the job survives

- **Express has no global timeout configured** in `server.ts`. Node's default HTTP server timeout has been `0` (no timeout) since Node 13, so the server itself won't kill the request.
- **Railway** has no documented in-bound HTTP timeout for HTTP services (long-poll-friendly platform).
- **The client never holds the connection**: POST /api/analyze returns 202 immediately ([analyze.ts:147](src/routes/analyze.ts#L147)). The actual processing happens in a `setImmediate` callback that runs after the request ends.
- **Job survives the original HTTP request** because it's running in the *Node process*, not the *request handler*. Frontend polls `GET /api/job/:jobId` to get status.

**The real failure mode** isn't timeout — it's **process death**. If Railway redeploys, the container is replaced and any `processing` job in flight is lost. The Job row in MongoDB will sit forever at `status: 'processing'` with stale progress. No mechanism resumes it; no mechanism marks it failed.

### 2.4 Progress reporting

- `processJob` builds a closure `makeProgress()` ([analyze.ts:50-55](src/routes/analyze.ts#L50)) that writes `progress` and `progressMessage` to MongoDB on each callback.
- This closure is passed through `runAnalysis` → `analyzeVideo`/`analyzeYouTube` → `runVideoPipeline` as `onProgress`.
- Inside `runVideoPipeline`, progress is reported at these breakpoints:
  - 2% — YouTube download start (analyzeYouTube path only)
  - 10% — Gemini upload start
  - 15% — Jersey detection
  - 20% — Timestamp detection
  - 30% — Timestamps found
  - 30→90% — Per-clip analysis (linearly proportional to completed clips)
  - 92% — Claude enrichment
  - 95% — Haiku mechanic refine
  - 96% — Negative-play observations
  - 97% — Insights generation
  - 100% — Done (set in processJob, not pipeline)
- Frontend polls `GET /api/job/:jobId` ([analyze.ts:191](src/routes/analyze.ts#L191)) → returns `{ progress, progressMessage, status, result }`. **Polling frequency is the frontend's choice — not visible from the backend.**

### 2.5 Context continuity between calls

This is one of the **strongest points** of the current design and also one of its hidden costs.

- **Jersey colors** are determined ONCE for the whole video (`extractSingleFrame` at t=8s → Haiku → cached), then passed verbatim into every per-clip prompt. Continuity = perfect.
- **Roster** is loaded ONCE from MongoDB at job start and threaded through every per-clip prompt. Continuity = perfect.
- **Score / clock state** — **NOT tracked**. Each per-clip call is independent. The model has no "score is 56-49 in Q3" context. It only knows the 18s of video around the given timestamp.
- **Possession history** — Not tracked. The model can't say "this is the 4th turnover by #11 this quarter."
- **Cross-clip pattern recognition** — Per-clip calls are isolated. Only the *enrichment step* (Claude Sonnet 4) sees all plays at once, but it sees them as a JSON array, not in temporal/causal sequence.

For most basketball play-classification, per-clip independence is **fine** (each play is a discrete event). But for any analysis that depends on game flow (momentum runs, fatigue trends, fouls accumulating), the current architecture is blind.

### 2.6 Bottleneck for 90-minute video — actual analysis

Let's estimate concretely for a 90-minute game in the >50min tier (65 timestamps):

| Stage | Count | Wall time | Bottleneck |
|---|---|---|---|
| Upload to Files API | 1 | 30-90s for ~600 MB | **Network bandwidth** + file processing on Gemini side |
| Wait for FileState=ACTIVE | 1 poll loop | 10-60s | Gemini-side processing |
| Timestamp detection (full video) | 1 call | 30-90s | **Gemini latency** + full-video reading |
| Per-clip analysis | 65 calls, concurrency 5 | 13 batches × ~20-30s/clip = 4-7 min | **Concurrency cap = 5** — this is the dominant cost |
| Claude enrichment | 1 call | 15-30s | Token volume (65 plays in input) |
| Shot mechanic refine (Haiku) | ~40-50 calls, serial | 1-3 min | Sequential — not parallelized |
| Observations on negatives (Haiku) | ~10-20 calls, parallel | 30s-1 min | Already in `Promise.all` |
| Insights | 1 call | 15-30s | OK |
| **Total** | — | **~10-15 minutes** | clips (concurrency=5) + Haiku mechanic refine (serial) |

**Not the bottleneck**: HTTP timeout, memory (the file is on Gemini, not loaded locally), token limits (each clip call is ~18s of video, well under context), cost (rough estimate: ~$0.40-0.80 per full game in Gemini, ~$0.10-0.20 Anthropic, but verify with actual usage stats).

**The actual bottlenecks for 90-min video:**
1. **CLIP_CONCURRENCY=5** at [analyzer.ts:2145](src/analyzer.ts#L2145). Raising to 10-15 would roughly halve wall time, at risk of hitting Gemini rate limits. Mitigation: the existing `retryWithBackoff` handles 429/503 with jitter.
2. **Haiku shot-mechanic refine is sequential** — needs to be parallelized like the clip pool. Easy fix.
3. **No timestamp-detection chunking** — if Gemini's full-video pass missed plays in Q4 because they're far from "the typical chunk it focused on," we have no way to know without re-running. A chunked pass (Q1, Q2, Q3, Q4) could improve recall at the cost of 4× the timestamp-detection latency.
4. **Job-loss on redeploy** — not a latency issue, but a 10-15 min job lost to a Railway deploy is a UX disaster. **This is the real "bottleneck for 90-min" in production reliability terms.**

### 2.7 Concrete fix proposals (referenced to actual code)

**Fix A — Quarter-based timestamp detection chunking** (improves recall on full games)

Today: [detectPlayTimestamps](src/analyzer.ts#L525) sends the full video URI in one call with `timestampCap = 65`. The model has to allocate attention across 90 minutes for one prompt.

Proposed: split timestamp detection into 4 quarter calls of ~22.5min each. Each call gets `videoMetadata: { startOffset, endOffset }` for its quarter and a `timestampCap = 18` (rough 65/4 + buffer). The Q4 call gets `cap = 22` per the existing "Q4 gets more attention" rule. Merge the 4 timestamp arrays, dedupe ±15s.

Cost: 4 Gemini calls instead of 1 (~2-3 min vs ~1 min). Benefit: higher recall on plays that the full-video pass under-attends.

```typescript
// detectPlayTimestamps refactor — sketch (not full diff)
const QUARTER_BOUNDARIES = (videoMinutes: number) => {
  const total = videoMinutes * 60;
  return [
    { startOffset: 0,            endOffset: total * 0.25, cap: 18 },
    { startOffset: total * 0.25, endOffset: total * 0.50, cap: 18 },
    { startOffset: total * 0.50, endOffset: total * 0.75, cap: 18 },
    { startOffset: total * 0.75, endOffset: total,        cap: 22 }, // Q4 gets more
  ];
};
// Send 4 parallel calls (or 2 + 2 to stay under rate limit), each with windowed videoMetadata
```

**Fix B — Parallelize Haiku mechanic refine**

Today: [refineShotMechanicsWithHaiku](src/analyzer.ts#L1170) iterates serially. For 40 shots × ~2s each = ~80s.

Use the same `Promise.all`-with-pool pattern as the clip analysis (see [analyzer.ts:2150-2169](src/analyzer.ts#L2150) for the existing template). 5x parallel → ~16s.

**Fix C — Real job queue with resumability**

Replace `setImmediate(() => processJob(...))` ([analyze.ts:149](src/routes/analyze.ts#L149)) with one of:

- **Minimal**: on server startup, scan for `Job.find({ status: 'processing', updatedAt: { $lt: Date.now() - 30*60*1000 } })` and mark them as `failed` with message "Process restarted, please retry." Doesn't resume, but at least the frontend stops polling forever.

- **Better**: use **BullMQ + Redis** (Railway has a Redis service). Move `processJob` into a worker file that imports the same analyzer. The web server only enqueues; the worker pool processes. Railway scaling becomes possible because workers are separate from web. On worker restart, BullMQ replays pending jobs.

- **Resumable mid-pipeline**: requires saving the Gemini fileUri + timestamps array to the Job row, so a restart can pick up at "I have timestamps, need to do per-clip." Not free but doable with the current Job schema (already has `result` as Mixed).

**Fix D — Adaptive sampling around score changes** (probably *don't* build this until baseline shows recall is the problem)

Pre-pass: take 1 frame every 30s with ffmpeg, send to Gemini 3 Flash-Lite asking "what's the score?" Build a score-change timeline. Then bias `timestampCap` allocation toward score-change windows. This is the kind of optimization that should wait for evidence that current uniform allocation is missing key moments.

**Fix E — Bump CLIP_CONCURRENCY to 10-15 with rate-limit observability**

Today: hardcoded `CLIP_CONCURRENCY = 5` at [analyzer.ts:2145](src/analyzer.ts#L2145). Add structured logging so when Gemini 429s start happening, you can tune down.

```typescript
const CLIP_CONCURRENCY = parseInt(process.env.CLIP_CONCURRENCY || '10', 10);
```

---

## 3. Gemini model audit

### 3.1 Every Gemini call site in the code

| Location | Model string source | Actual value | Purpose | Migration priority |
|---|---|---|---|---|
| [analyzer.ts:118](src/analyzer.ts#L118) | `GEMINI_MODEL = process.env.GEMINI_MODEL \|\| 'gemini-2.5-flash'` | `gemini-2.5-flash` | Default for all analyzer calls | **HIGH** |
| [analyzer.ts:636](src/analyzer.ts#L636) | `model: GEMINI_MODEL` | `gemini-2.5-flash` | **detectPlayTimestamps** — full-video timestamp detection | **HIGH** (long-context, expensive) |
| [analyzer.ts:1055](src/analyzer.ts#L1055) | `model: GEMINI_MODEL` | `gemini-2.5-flash` | **analyzeClipAtTimestamp** — per-clip play classification (×65 calls per full game) | **HIGH** (volume) |
| [routes/verify.ts:49](src/routes/verify.ts#L49) | `model: 'gemini-2.5-flash'` (hardcoded — bypasses env) | `gemini-2.5-flash` | Per-play consistency verification | **HIGH** + **fix hardcode** |
| [analyzer.ts:538](src/analyzer.ts#L538) | `ai.files.get({ name })` — no model param | n/a | Metadata fetch for `videoMetadata.videoDuration` — doesn't call a model | n/a |
| [analyzer.ts:496](src/analyzer.ts#L496) | `ai.files.upload(...)` — no model param | n/a | Files API upload — no model | n/a |

**Total live model-call sites: 4** (detectPlayTimestamps, analyzeClipAtTimestamp, verify route, plus the no-op-on-models file ops).

### 3.2 Retirement urgency

You flagged: *"Gemini 2.0 Flash and Flash-Lite are being retired on June 1, 2026."*

The code uses **`gemini-2.5-flash`**, not `gemini-2.0-flash` or `gemini-2.0-flash-lite`. So **the specific retirement you flagged does not apply** to our current model string.

However:
- 2.5 Flash is one minor version above the to-be-retired 2.0 family.
- Your stated current lineup (3.x family from Dec 2025–May 2026) is two generations ahead of 2.5.
- Google's deprecation pattern historically retires older Flash variants on roughly the same cadence as new ones land.
- **I cannot verify from training data whether `gemini-2.5-flash` has its own retirement date.** **[VERIFY-VS-SDK]** — check the Gemini API docs for `gemini-2.5-flash` status. If it has a retirement date < 6 months out, this becomes urgent.

**My recommendation**: migrate now regardless, because (a) the 3.x family is more capable per your description, (b) staying on 2.5 indefinitely will eventually require an emergency migration, and (c) you're running a baseline accuracy test on Maccabi vs Be'er Sheva Q1 anyway — that's the perfect moment to compare 2.5 Flash vs 3.x candidates head-to-head.

### 3.3 Per-call-site model recommendations

Given your stated lineup (Gemini 3.1 Pro, Gemini 3 Flash, Gemini 3.1 Flash-Lite, Gemini 3.5 Flash from May 19 I/O), and excluding Gemini Omni (generation-only):

| Call site | Today | Recommend | Why |
|---|---|---|---|
| **detectPlayTimestamps** ([analyzer.ts:636](src/analyzer.ts#L636)) | 2.5 Flash | **Gemini 3.1 Pro** (or **3.5 Flash** if cost matters) | This is the most consequential call — misses here mean the play is GONE downstream. Pro's recall on long-context video should be materially better on 90-min games. If cost is the concern, 3.5 Flash (the new I/O announcement) should be the cheaper compromise. |
| **analyzeClipAtTimestamp** ([analyzer.ts:1055](src/analyzer.ts#L1055)) | 2.5 Flash | **Gemini 3 Flash** (or **3.5 Flash**) | Per-clip windowed reasoning over 18 seconds is exactly the Flash sweet spot. ×65 per game = dominant token cost. Stay on Flash tier; just upgrade generation. |
| **verify route** ([verify.ts:49](src/routes/verify.ts#L49)) | 2.5 Flash | **Gemini 3.1 Flash-Lite** | This is text-only consistency checking (no video). Lite is built for cheap text. Switch + parallelize together for a 10x throughput win. |
| **(new) scoreboard OCR / quarter detection** (when you build it for Fix D) | n/a yet | **Gemini 3.1 Flash-Lite** | Reads digits off a sub-region of a frame. Smallest model that reliably reads numbers wins. |

### 3.4 Long-context video — should we send larger clip windows?

Today: each `analyzeClipAtTimestamp` sends an 18-second window via `videoMetadata: { startOffset, endOffset }`.

You asked: *"Should we use long-context Gemini 3 to send much longer video chunks per call instead of frame-by-frame?"*

Important distinction: **we're already not doing frame-by-frame for videos.** Frame extraction (the `extractFrames` path) is only used for single-image analysis. For videos, we hand Gemini the Files-API URI and let it handle internal frame sampling.

So the real question is: should we *widen the per-clip window*?

- **Pro**: more context = better grasp of who's setting screens off-ball, what the prior possession looked like, etc.
- **Con**: wider window = more places for the model to confuse "the play" with surrounding events. Today's 18s window is intentionally narrow to anchor the model on ONE play.

My recommendation: **don't widen until baseline data shows it helps.** What WOULD be valuable is letting per-clip calls *see the prior 2-3 plays' descriptions* as text context. That gives possession history without giving the model more video to confuse itself with. Cheap to add: just thread the last few enriched-play descriptions into `buildClipPrompt`.

### 3.5 Exact code diffs

Below are the before/after patches. **All assume the current `@google/genai` SDK call signatures are valid for the new model strings — [VERIFY-VS-SDK]** for any SDK type changes between 2.x and 3.x. If the SDK uses different param names for Gemini 3.x (e.g., `thinkingConfig` shape changes), apply those fixes too.

#### Diff 1: Make model selection per-call-site, not global

```diff
--- a/src/analyzer.ts
+++ b/src/analyzer.ts
@@ -115,8 +115,17 @@
 const FFPROBE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe'))
   ? path.join(BIN_DIR, 'ffprobe.exe')
   : 'ffprobe';

-// Gemini model identifier. Default keeps current behavior; override via env to A/B test.
-const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
+// Gemini model identifiers, per call site. Each can be overridden via env for A/B testing.
+// - DETECT: full-video timestamp pass — accuracy critical, prefer Pro tier.
+// - CLIP: per-clip windowed analysis (×N per game) — cost critical, Flash tier.
+// - VERIFY: text-only consistency check — cheap, Flash-Lite.
+const GEMINI_MODEL_DETECT = process.env.GEMINI_MODEL_DETECT || 'gemini-3.1-pro';
+const GEMINI_MODEL_CLIP   = process.env.GEMINI_MODEL_CLIP   || 'gemini-3-flash';
+const GEMINI_MODEL_VERIFY = process.env.GEMINI_MODEL_VERIFY || 'gemini-3.1-flash-lite';
+
+// Legacy export kept for any callers still reading the old single var; remove after audit confirms no external use.
+const GEMINI_MODEL = GEMINI_MODEL_CLIP; // alias — will be removed in a follow-up cleanup
```

#### Diff 2: Use per-site models at the two analyzer call sites

```diff
--- a/src/analyzer.ts
+++ b/src/analyzer.ts
@@ -633,7 +633,7 @@
     const result = await retryWithBackoff(async () => {
       const res = await ai.models.generateContent({
-        model: GEMINI_MODEL,
+        model: GEMINI_MODEL_DETECT,
         config: {
           temperature: 0.1,
           maxOutputTokens: 2048,
@@ -1052,7 +1052,7 @@
     const result = await retryWithBackoff(async () => {
       const res = await ai.models.generateContent({
-        model: GEMINI_MODEL,
+        model: GEMINI_MODEL_CLIP,
         config: {
           temperature: 0.1,
           maxOutputTokens: 8192,
@@ -2102,7 +2102,7 @@
   if (!fileUri) {
     throw new Error('No video file URI available for analysis');
   }

-  console.log(`🤖 Gemini model: ${GEMINI_MODEL}`);
+  console.log(`🤖 Gemini models — detect: ${GEMINI_MODEL_DETECT}, clip: ${GEMINI_MODEL_CLIP}`);
```

#### Diff 3: Fix verify.ts to use the env and migrate to Flash-Lite

```diff
--- a/src/routes/verify.ts
+++ b/src/routes/verify.ts
@@ -1,7 +1,9 @@
 import { Router, Request, Response } from 'express';
 import { GoogleGenAI } from '@google/genai';
 import { Analysis, Verification } from '../database';

+const VERIFY_MODEL = process.env.GEMINI_MODEL_VERIFY || 'gemini-3.1-flash-lite';
+
 const router = Router();
 const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
@@ -46,7 +48,7 @@

       try {
         const result = await ai.models.generateContent({
-          model: 'gemini-2.5-flash',
+          model: VERIFY_MODEL,
           contents: prompt,
         });
```

#### Diff 4: (optional, recommended) Parallelize verify.ts

Today verify.ts iterates plays serially. Migration is a great moment to parallelize:

```diff
--- a/src/routes/verify.ts
+++ b/src/routes/verify.ts
@@ -18,9 +20,11 @@
     if (!plays || plays.length === 0) {
       return res.status(400).json({ error: 'No plays to verify' });
     }

-    const results = [];
+    const VERIFY_CONCURRENCY = 5;

-    for (let i = 0; i < plays.length; i++) {
-      const play = plays[i];
+    // Build all per-play promises but cap concurrency with a worker pool.
+    const results: any[] = new Array(plays.length);
+    let nextIdx = 0;
+    const verifyOne = async (i: number) => {
+      const play = plays[i];
       const prompt = `You are verifying a basketball play analysis.

 Play #${i + 1}:
@@ -65,7 +69,7 @@
         const verification = JSON.parse(text);
-        results.push({
+        results[i] = {
           index: i,
           startTime: play.startTime,
           endTime: play.endTime,
@@ -76,9 +80,9 @@
           confidence: verification.confidence,
-        });
+        };
       } catch (e) {
-        results.push({
+        results[i] = {
           index: i,
           startTime: play.startTime,
           endTime: play.endTime,
@@ -88,8 +92,16 @@
           correct: false,
           actualPlay: 'שגיאה באימות',
           confidence: 'low',
-        });
+        };
       }
-    }
+    };
+    const worker = async () => {
+      while (true) {
+        const i = nextIdx++;
+        if (i >= plays.length) return;
+        await verifyOne(i);
+      }
+    };
+    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, plays.length) }, () => worker()));
```

#### Diff 5: Top-level the @google/genai import (cleanup)

```diff
--- a/src/analyzer.ts
+++ b/src/analyzer.ts
@@ -1,4 +1,5 @@
 import Anthropic from '@anthropic-ai/sdk';
+import { GoogleGenAI, FileState } from '@google/genai';
 import { execSync, execFileSync, spawnSync } from 'child_process';
 import fs from 'fs';
 import path from 'path';
@@ -489,7 +490,6 @@

 async function uploadVideoToGemini(videoPath: string): Promise<{ fileUri: string; mimeType: string }> {
-  const { GoogleGenAI, FileState } = await import('@google/genai');
   const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
```
(Repeat the line removal for the three other dynamic imports at lines 527, 1042 — same pattern.)

### 3.6 Roll-out plan

1. **Pre-migration baseline**: capture full Maccabi vs Be'er Sheva Q1 analysis output on current `gemini-2.5-flash`. Save the JSON of plays + insights as `baseline_q1_2-5-flash.json`. Counts of plays, types, accuracy spot-check by you.
2. **A/B in one env var**: set `GEMINI_MODEL_DETECT=gemini-3.1-pro` and `GEMINI_MODEL_CLIP=gemini-3-flash` in Railway env. Re-run the same Q1 clip. Save as `baseline_q1_3-x.json`.
3. **Diff & coach review**: hand both JSONs to a coach. Which plays are new, missing, mislabeled?
4. **If 3.x wins**: merge Diff 1+2 (env-driven), set the new defaults in code, ship.
5. **Separate PR for verify.ts** (Diff 3+4) — independent migration, can land any time.
6. **Cleanup PR**: Diff 5 (top-level imports), kill the legacy `GEMINI_MODEL` alias.

**Do NOT bundle the model migration with the auto-chunking work** (Phase 1). One variable at a time so you can attribute accuracy/speed changes correctly.

---

## Appendix A — Anthropic model usage (out of scope but for completeness)

The audit found Claude usage at:

| Location | Model | Purpose |
|---|---|---|
| [analyzer.ts:384](src/analyzer.ts#L384) | `claude-sonnet-4-20250514` | Legacy analyzeFrames Vision path (only invoked by image upload) |
| [analyzer.ts:1240](src/analyzer.ts#L1240) | `claude-haiku-4-5-20251001` | Shot mechanic refinement |
| [analyzer.ts:1444](src/analyzer.ts#L1444) | `claude-sonnet-4-20250514` | enrichPlaysWithClaude main call |
| [analyzer.ts:1765](src/analyzer.ts#L1765) | `claude-sonnet-4-20250514` | generateInsightsFromPlays |
| [analyzer.ts:1923](src/analyzer.ts#L1923) | `claude-haiku-4-5-20251001` | findJerseyColors |
| [analyzer.ts:2057](src/analyzer.ts#L2057) | `claude-haiku-4-5-20251001` | generateObservationsForNegativePlays per call |
| [chat.ts:32](src/routes/chat.ts#L32) | `claude-sonnet-4-20250514` | SSE chat |
| [players.ts:52](src/routes/players.ts#L52) | `claude-sonnet-4-20250514` | Roster parser |
| [players.ts:102](src/routes/players.ts#L102) | `claude-sonnet-4-20250514` | Per-player insights |

Per your system context, the most recent Anthropic lineup is Claude 4.6/4.7. `claude-sonnet-4-20250514` and `claude-haiku-4-5-20251001` are both 4.x family models from 2025. Not urgent, but a future "upgrade Claude side too" pass would consolidate model strings into env vars (same anti-pattern as the Gemini side has today).

---

## Appendix B — What I did NOT verify (honest gaps)

- I did not run the pipeline. All claims about runtime behavior are derived from reading code.
- I did not verify any Gemini 3.x model string actually exists or is callable in `@google/genai` v1.49 — see [VERIFY-VS-SDK] flags.
- I did not inspect `knowledge/basketballBrain.ts` in detail — it's static prompt material, not code that needs auditing.
- I did not check the frontend code (`index.html`, `landing/index.html`) — out of scope per the request.
- I did not verify Railway's actual deploy-time behavior matches the Dockerfile.
- I did not check `node_modules/@google/genai` for the actual config schema — recommended next step for the SDK compatibility verification.

End of audit.
