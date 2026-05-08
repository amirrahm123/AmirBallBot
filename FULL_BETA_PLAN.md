# AmirBallBot — Full Beta Plan

**Status as of 2026-05-08:** functional for ≤5-min clips, zero auth, zero payments, no proof points on long videos.
**Goal:** sellable to 10 paying Liga Ha'al coaches by end of June 2026.
**Source-of-truth horizon:** next 6-8 weeks.

This plan is sequenced so each phase de-risks the next. Phase 1 proves the product can handle real games. Phase 2 makes it safe for multiple customers. Phase 3 makes it billable. Phase 4 makes it survivable in production. Phase 5 proves it's worth paying for.

---

## Phase 1 — Auto-chunk full game uploads (no manual cutting)

### Goal
Coach uploads / pastes a 60-90 minute Liga Ha'al broadcast. The system silently splits it into ~12-minute chunks, runs the existing pipeline on each, merges the timestamps back into one analysis. No manual cutting in iMovie/Premiere.

### Why first
Phase 2-5 are all wasted effort if the bot still crashes at 25 min. Today the binding ceiling is ~25 min — see the timeout matrix in `BETA_READINESS_AUDIT.md`. The code already has tier logic for >50 min videos at [src/analyzer.ts:558-561](src/analyzer.ts#L558-L561) but no chunking, and three timeouts kick in before a 90-min video can finish: yt-dlp 5-min spawn ([analyzer.ts:263](src/analyzer.ts#L263)), frontend 35-min abort ([index.html:1016](index.html#L1016)), Railway proxy body-size on direct upload.

### Files to modify

| File | Lines | Change |
|---|---|---|
| [src/analyzer.ts](src/analyzer.ts) | 243-287 | `downloadYouTube`: bump spawn timeout from 300_000 → **1_800_000** (30 min), add `--max-filesize 4G` and `--retries 3` flags |
| [src/analyzer.ts](src/analyzer.ts) | 519-699 | `detectPlayTimestamps`: keep tier logic but add a `chunkOffsetSeconds` parameter so timestamps emitted by Gemini get shifted to absolute game-time before being returned |
| [src/analyzer.ts](src/analyzer.ts) | 2089-2234 | `runVideoPipeline`: rename to `runVideoPipelineForChunk`. Add new `runVideoPipeline` wrapper that calls the chunker, runs each chunk in series (NOT parallel — Gemini rate limits), concatenates per-chunk `geminiPlays[]` with offset, then runs ONE enrichment + insights pass at the end |
| [src/analyzer.ts](src/analyzer.ts) | 2241-2270 | `analyzeYouTube` and `analyzeVideo`: add chunking call before pipeline |
| [src/database.ts](src/database.ts) | 160-188 | `JobSchema`: add `chunks: [{ index, status, startSeconds, endSeconds, playCount, error }]` so frontend can show per-chunk progress |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 49-113 | `processJob`: update progress messages to include chunk index ("מנתח רבע 2 מתוך 4") |
| [index.html](index.html) | 1009-1016 | Frontend abort: bump 35 min → **75 min** to accommodate full games |
| [index.html](index.html) | ~1067-1078 | Polling: render the new `chunks[]` field as a progress strip, not just a single percentage |
| [Dockerfile](Dockerfile) | 1-29 | No change required — ffmpeg + yt-dlp already installed |

### Files to create

| File | Purpose |
|---|---|
| `src/chunking.ts` | Pure functions: `getVideoDuration(path)` (wraps ffprobe), `splitVideoIntoChunks(path, chunkSeconds=720)` returning `{ chunkPath, startSeconds, endSeconds }[]`, `cleanupChunks(chunks)`. ffmpeg invocation: `ffmpeg -ss {start} -i {input} -t {duration} -c copy {output}` so chunking is stream-copy fast (no re-encode), takes <30 s for a 90-min file. |
| `src/mergeChunkResults.ts` | `mergeGeminiPlays(perChunkResults)`: concat `GeminiPlay[]` after shifting each `startTime`/`endTime` by the chunk's `startSeconds`. Re-run `dedupOverlappingPlays` on chunk seams (a play at 11:55 in chunk 1 and 12:05 in chunk 2 would otherwise both fire). |
| `src/routes/jobChunks.ts` | Optional: `GET /api/job/:jobId/chunks` for granular UI updates. Skip if the inline `chunks[]` in `Job` is enough. |

### External services to set up
- **None for this phase.** Storage remains on Railway ephemeral disk for now (Phase 4 fixes that). The chunking is purely in-container ffmpeg.

### Operational decisions to nail down before coding
1. **Chunk size: 12 minutes.** Falls inside the `≤15 min → 15 plays` tier at [analyzer.ts:549-551](src/analyzer.ts#L549-L551), maximizing the per-chunk play cap usage. A 90-min game = 8 chunks × 15 plays = 120-play cap, vs. the current single-pass 65-play cap that loses 1/3 of a real game's plays.
2. **Sequential, not parallel.** Gemini Files API throttles per-project; running 8 parallel uploads will trip 503s. Sequential per chunk, parallel within a chunk's 15 clips (existing `CLIP_CONCURRENCY = 5` at [analyzer.ts:2144](src/analyzer.ts#L2144)).
3. **One enrichment call at the end.** Sonnet enrichment is the most expensive single call. Don't run it 8 times — collect all 80-120 raw `GeminiPlay[]` then enrich once. The prompt at [analyzer.ts:1442-1684](src/analyzer.ts#L1442-L1684) already accepts an arbitrary play array; just verify token budget (8 chunks × 15 plays × ~500 tokens/play ≈ 60K tokens of input, well within Sonnet 4's 200K context).
4. **Halt on chunk failure?** Default: continue with partial results, mark `chunks[i].status = 'failed'`, surface in UI. Coach gets analysis of 7 of 8 quarters rather than nothing.

### Estimated work
**5-7 days.** ~2 days chunking + merging, 1 day backend wiring, 1-2 days frontend progress UI, 1-2 days testing on at least 3 real games of different lengths.

### Risks / things that might break
- **Stream-copy chunks at non-keyframe boundaries** can produce un-decodable first frames. Mitigation: use `-ss {start} -i {input}` (input seek, slow) instead of `-i {input} -ss {start}` (output seek, fast), or transcode with `-c:v libx264 -preset ultrafast` (adds 2-5 min for a 90-min game — acceptable).
- **Railway 8 GB ephemeral disk:** a 90-min broadcast at 1080p can be 2-3 GB; chunks add another 2-3 GB. Consider downscaling to 720p in yt-dlp args (already capped at `height<=720` at [analyzer.ts:252](src/analyzer.ts#L252)) and deleting source after chunking.
- **Gemini Files API 48-hour expiry:** chunks are uploaded one at a time and processed within minutes — no concern unless the pipeline stalls.
- **Timestamp seam dedup:** a play that starts at 11:58 of chunk 1 may also be detected at 00:02 of chunk 2 (same possession, both windows include it). Dedup at chunk seams must happen post-merge.
- **Cost per game:** ≈ $0.50-$1.20 per 90-min analysis at current model selection. Verify against margins before turning on for paying users.

### Acceptance criteria
- [ ] Three real Liga Ha'al broadcasts (≥75 min each) processed end-to-end, all returning ≥40 enriched plays
- [ ] Per-chunk progress strip visible in UI, advancing without stalls
- [ ] Total wall time for a 90-min game: <60 min on Railway production
- [ ] Zero `processing` jobs left dangling 24 hours after submission (must complete or fail cleanly)
- [ ] No timestamp regressions: spot-check 10 random plays from 90-min run, all timestamps within ±5 s of actual game-time

---

## Phase 2 — Auth + multi-tenant scoping (Supabase Auth)

### Goal
Each coach has an account. Coach A literally cannot see, query, or modify Coach B's roster, analyses, knowledge base, or jobs. The existing 6 production analyses all migrate to a single `demo-user` so they don't leak.

### Why second
Without this, the moment two paying customers exist, every `Player.find()` ([routes/players.ts:11](src/routes/players.ts#L11)) and `Analysis.find()` ([routes/analyses.ts:19](src/routes/analyses.ts#L19)) returns mixed data across tenants. This is a **legal-and-trust dealbreaker**, not a feature gap.

### Files to modify

| File | Lines | Change |
|---|---|---|
| [src/server.ts](src/server.ts) | 38-46 | Wrap each `app.use('/api/...', ...)` with `authMiddleware` (except `/health`). Add `app.use('/api/auth', authRouter)` for the login bridge endpoints. |
| [src/database.ts](src/database.ts) | 56-70 | `PlayerSchema`: add `userId: { type: String, required: true, index: true }`. Drop the unused `teamId` field OR repurpose it as a per-roster-bucket inside one user. |
| [src/database.ts](src/database.ts) | 100-110 | `TeamKnowledgeSchema`: add `userId: { type: String, required: true, index: true }`. Compound unique index on `{ userId, teamId }` instead of just `teamId`. |
| [src/database.ts](src/database.ts) | 118-131 | `AnalysisSchema`: add `userId: { type: String, required: true, index: true }`. |
| [src/database.ts](src/database.ts) | 134-141 | `VerificationSchema`: add `userId`. |
| [src/database.ts](src/database.ts) | 160-188 | `JobSchema`: `userId` field already exists at line 154,172 — change `default: null` to `required: true`. |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 60-65 | `processJob`: scope `Player.find()` to `{ userId: req.userId }`. |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 116-161 | `POST /api/analyze`: read `req.userId` from auth middleware, write to `Job.create({ userId, ... })`. |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 191-212 | `GET /api/job/:jobId`: enforce `{ jobId, userId: req.userId }` lookup so jobId guessing can't leak. |
| [src/routes/analyses.ts](src/routes/analyses.ts) | 19-27 | `GET /api/analyses`: `Analysis.find({ userId: req.userId })`. |
| [src/routes/analyses.ts](src/routes/analyses.ts) | 30-42 | `GET /api/analyses/:id`: `findOne({ _id, userId: req.userId })`. |
| [src/routes/analyses.ts](src/routes/analyses.ts) | 45-163 | All notes/delete endpoints: scope by `userId`. |
| [src/routes/players.ts](src/routes/players.ts) | 8-153 | Every endpoint: scope by `userId`. The `parse-roster` endpoint at line 42 should not need scoping (no DB read), but the `POST /api/players` create at line 20 must inject `userId`. |
| [src/routes/knowledge.ts](src/routes/knowledge.ts) | (full file) | Same treatment — scope all `TeamKnowledge` queries. |
| [src/routes/verify.ts](src/routes/verify.ts) | 8-97 | Scope all queries. |
| [src/routes/chat.ts](src/routes/chat.ts) | 6-58 | No DB queries today, but require auth so usage is metered per user (foundation for Phase 3 quotas). |
| [src/routes/video.ts](src/routes/video.ts) | 11-56 | `GET /api/video/:jobId.mp4`: enforce `{ jobId, userId: req.userId }` lookup before streaming. Currently anyone with a UUID can stream any analysis video. |
| [src/analyzer.ts](src/analyzer.ts) | 28-65 | `loadRecentCorrections`: take `userId` parameter, scope query: `Job.find({ 'corrections.0': { $exists: true }, 'input.teamName': trimmedTeam, userId })`. |
| [src/analyzer.ts](src/analyzer.ts) | 80-106 | `getKnowledgeContext`: take `userId`, scope `TeamKnowledge.findOne({ userId, teamId })`. |
| [index.html](index.html) | 790-794 | Replace bare API constant with a `fetchAuthed` wrapper that injects `Authorization: Bearer <jwt>`. |
| [index.html](index.html) | (new sections) | Add Hebrew login screen + signup screen + session-expired interstitial. ~150-300 lines. |

### Files to create

| File | Purpose |
|---|---|
| `src/middleware/auth.ts` | `authMiddleware(req, res, next)`: read `Authorization: Bearer <jwt>`, verify with Supabase JWKS (cached), attach `req.userId = jwt.sub`. Return 401 on missing/invalid. Returns `next()` for `OPTIONS` preflight without auth. |
| `src/routes/auth.ts` | Thin endpoints: `POST /api/auth/me` returns the verified user info (frontend uses this to confirm session). The actual login flow happens client-side via `@supabase/supabase-js`. |
| `scripts/migrate-add-userid.ts` | One-shot script: connect to Mongo, find the canonical `demo-user@amirballbot.dev` Supabase user UUID, set `userId` on every existing `Analysis` (6 docs), `Player` (0 docs), `TeamKnowledge` (unknown count), `Job`, `Verification`. Idempotent — skip docs that already have `userId`. Print a count summary. |
| `scripts/create-demo-user.md` | Instructions: in Supabase dashboard, create user `demo@amirballbot.dev`, copy the UUID into `MIGRATION_DEMO_USER_ID` env var, run migrate. |

### External services to set up
- **Supabase project** (free tier is enough for beta).
  - Email + password auth + Google OAuth (Hebrew coaches mostly use Google).
  - Disable email confirmation requirement OR configure Hebrew email template (Supabase → Auth → Templates).
  - Copy `SUPABASE_URL`, `SUPABASE_ANON_KEY` (frontend), `SUPABASE_JWT_SECRET` or JWKS URL (backend) into Railway env vars.
- **Railway env additions:** `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `MIGRATION_DEMO_USER_ID`.

### Estimated work
**6-9 days.** ~1 day Supabase setup + frontend login UI, ~2 days middleware + backend scoping (mechanical but touches every route), ~1 day migration script + dry run + production migration, ~2 days end-to-end testing with two test accounts, ~1-2 days buffer for the inevitable "I forgot to scope X" bug.

### Risks / things that might break
- **The 6 existing analyses get orphaned** if the migration script runs against a user that doesn't exist in Supabase. Always create the demo user first; the script should hard-fail if the env var UUID isn't a valid Supabase user.
- **JobId-as-secret cross-tenant leak:** before scoping, anyone can guess a UUID and stream `/api/video/{jobId}.mp4` ([routes/video.ts:11-56](src/routes/video.ts#L11-L56)). UUIDs are unguessable in practice but failing closed is correct.
- **Frontend `/api/save-notion` and `/api/practice-plan`** still 404 — auth-wrapping them just means they 401 instead. Phase 4 removes the dead buttons.
- **Race condition in /api/analyze/upload-video at [routes/analyze.ts:163-186](src/routes/analyze.ts#L163-L186)**: Gemini file URI is returned to client and later re-passed via `geminiFileUri`. Without scoping, Coach A could analyze Coach B's uploaded file URI. Add `Job.create` userId check in `processJob` even when `geminiFileUri` is supplied.
- **Supabase free tier limits** (50K MAU). Fine for beta; budget upgrade for scale.
- **Hebrew email deliverability** — check spam-folder rate before launch.

### Acceptance criteria
- [ ] `curl https://amirballbot-production.up.railway.app/api/analyses` without auth returns **401** (currently returns the full list)
- [ ] Two test accounts (coach-a@test, coach-b@test) each upload a clip; coach-a logged in cannot list, get, delete, or stream any of coach-b's resources via any endpoint
- [ ] All 6 pre-migration analyses still appear in the demo-user account, untouched
- [ ] Frontend login + signup + logout work in Hebrew RTL
- [ ] Session persists across browser refresh, expires after 7 days
- [ ] Penetration spot-check: pick 10 random endpoints, hit each with a forged JWT (wrong signature, expired, mismatched user) — all return 401

---

## Phase 3 — Stripe payments + Hebrew pricing/ToS/privacy

### Goal
Coach signs up → sees a Hebrew pricing page → picks a plan → enters card → gets charged monthly. Free trial of 1 game so coaches can try before paying. Privacy policy and ToS legally cover us under Israeli Consumer Protection Law.

### Why third
Phase 1 makes the product work. Phase 2 makes it safe. Phase 3 makes it billable. Without Phase 2, Stripe webhooks have no `userId` to attach a subscription to.

### Files to modify

| File | Lines | Change |
|---|---|---|
| [src/server.ts](src/server.ts) | 30 | `app.use('/api/billing/webhook', express.raw({ type: 'application/json' }))` MUST be registered before `express.json()` so Stripe signature verification has the raw body. |
| [src/server.ts](src/server.ts) | 38-46 | Register `billingRouter` under `/api/billing`. |
| [src/middleware/auth.ts](src/middleware/auth.ts) (created in Phase 2) | (new) | Add `requireActiveSubscription` middleware that calls a `User.findOne({ userId })` and rejects with 402 (Payment Required) when `subscriptionStatus !== 'active' && trialJobsRemaining <= 0`. |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 116 | Apply `requireActiveSubscription` to `POST /api/analyze`. Decrement `trialJobsRemaining` on Job creation. |
| [src/database.ts](src/database.ts) | (new schema) | Add `UserSchema` mirroring Supabase user UUID + Stripe customer/subscription state + trial counter. |
| [index.html](index.html) | (new screen) | Hebrew pricing page screen. Three plans (e.g. ₪149/month assistant coach, ₪299/month head coach, ₪599/month team). Stripe Checkout redirect button per plan. |
| [index.html](index.html) | (new sections) | Hebrew Terms of Service + Privacy Policy as separate scrollable screens. |
| [index.html](index.html) | (footer) | Add links: תנאי שימוש / מדיניות פרטיות / יצירת קשר. |

### Files to create

| File | Purpose |
|---|---|
| `src/routes/billing.ts` | `POST /api/billing/checkout` (creates a Stripe Checkout session for the logged-in user, returns `url`), `POST /api/billing/portal` (returns Stripe Customer Portal URL for subscription management), `POST /api/billing/webhook` (handles `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`). Webhook updates the local `User.subscriptionStatus`. |
| `src/billing/stripe.ts` | Wrapper around `stripe` Node SDK with the secret key, helper functions: `createCheckoutSession(userId, priceId)`, `createPortalSession(stripeCustomerId)`, `verifyWebhookSignature(req)`. |
| `src/billing/plans.ts` | Plan definitions matching Stripe Product IDs: `{ id: 'assistant', priceId: 'price_xxx', monthlyJobs: 5, hebrewName: 'מאמן עוזר' }`, etc. Single source of truth for plan limits. |
| `legal/terms-of-service.he.md` | Hebrew ToS draft. **MUST be reviewed by Israeli lawyer.** |
| `legal/privacy-policy.he.md` | Hebrew privacy policy draft covering: data we collect (video uploads, coach corrections, roster data), retention (7-day video TTL per [analyzer.ts:156](src/analyzer.ts#L156)), third-party processors (Gemini, Anthropic, Stripe, MongoDB Atlas, Supabase, Railway). **Lawyer review required.** |
| `legal/refund-policy.he.md` | Israeli law allows cooling-off; explicit policy required. |
| `package.json` | Add `stripe: ^17` dependency. |

### External services to set up
- **Stripe account** (Israeli VAT registration if you're invoicing as an Israeli business — check with accountant).
  - Create 3 Products in Stripe Dashboard with monthly recurring prices in ILS.
  - Copy Product Price IDs into `src/billing/plans.ts`.
  - Enable Customer Portal so users can self-service cancel.
  - Configure webhook endpoint `https://amirballbot-production.up.railway.app/api/billing/webhook` listening on subscription + invoice events.
  - Copy `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` into Railway env.
- **Israeli lawyer consultation** for ToS + privacy + refund policy. Budget 2-4 hours of legal time (~₪1500-3000).
- **Optional but recommended:** Israeli accountant signoff that the Stripe billing structure works for Israeli VAT.

### Estimated work
**5-8 days code + 3-5 days legal/finance setup (parallel).**
- Day 1-2: Stripe products, Checkout integration, webhook skeleton.
- Day 3-4: User schema, subscription enforcement middleware, trial counter.
- Day 5-6: Hebrew pricing page, ToS/privacy pages.
- Day 7: End-to-end test with Stripe test mode.
- Day 8: Legal text incorporated, production go-live.

### Risks / things that might break
- **Webhook out-of-order delivery:** Stripe doesn't guarantee order. Always trust the latest `subscription` object in each event payload, never compute state from event sequence.
- **Trial bypass via account churn:** a coach signs up, uses their free trial, deletes account, signs up again with same email. Mitigation: track free trials by email (or IP, but coaches share IPs in a club). Acceptable for beta — flag for post-beta.
- **VAT compliance:** Israeli law requires VAT on digital services to consumers. Stripe Tax can handle this but adds setup work.
- **Hebrew ToS legal accuracy:** AI-drafted Hebrew legal text is dangerous to ship. Lawyer review is non-negotiable.
- **Webhook security:** the `express.json()` global at [server.ts:30](src/server.ts#L30) eats the raw body and breaks Stripe signature verification. Order matters — register the raw-body middleware BEFORE the JSON middleware.

### Acceptance criteria
- [ ] New coach signs up → sees Hebrew pricing → clicks "התחל ניסיון חינם" → gets 1 free analysis → after that, `POST /api/analyze` returns 402 with a Hebrew "אנא שדרג" message
- [ ] Coach in free trial clicks "שדרג" → Stripe Checkout in Hebrew → enters test card → returns to app with active subscription
- [ ] Stripe webhook updates `User.subscriptionStatus` to `active` within 30 s of payment
- [ ] Customer Portal works: coach can update card, cancel, view invoices
- [ ] All 3 legal pages render correctly in Hebrew RTL with print-friendly CSS
- [ ] Failed payment (test card 4000 0000 0000 0341) flips status to `past_due` and gates further analyses
- [ ] Cancellation respects period: coach who cancels mid-month keeps access until period_end
- [ ] Israeli lawyer signoff on legal/* documents (signed/dated record kept)

---

## Phase 4 — Production polish (404s, WhatsApp, mobile UX, persistence)

### Goal
Eliminate the embarrassing rough edges that will get refund requests in week 1. Specifically: dead buttons, ephemeral video storage, no completion notifications, broken phone UX.

### Files to modify

| File | Lines | Change |
|---|---|---|
| [index.html](index.html) | 1448 | Remove or replace the dead `POST /api/save-notion` call. Either implement it or remove the button. |
| [index.html](index.html) | 1467 | Same for `POST /api/practice-plan`. |
| [src/analyzer.ts](src/analyzer.ts) | 138-189 | Replace `VIDEOS_DIR = /app/videos` ephemeral path with S3 / Cloudflare R2 storage. `persistVideoFile` becomes `persistVideoToObjectStore(srcPath, jobId)`, returns a permanent CDN URL. |
| [src/analyzer.ts](src/analyzer.ts) | 506-510 | Gemini Files processing poll — add max-iterations cap (e.g. 60 iterations × 3 s = 3 min) to escape the unbounded loop documented in the audit. |
| [src/analyzer.ts](src/analyzer.ts) | 195-236 | `retryWithBackoff`: add wall-clock budget per call (e.g. abort after 8 min total elapsed) so a single bad clip can't push wall time past the new chunk-aware limits. |
| [src/routes/video.ts](src/routes/video.ts) | 11-56 | Replace local-disk reads with redirect-to-R2-signed-URL. Keep the 206-range pattern for clients that want it. |
| [src/routes/analyze.ts](src/routes/analyze.ts) | 49-113 | After job completes, fire a `notifyCoach(userId, jobId)` call. |
| [index.html](index.html) | 171-176, 361-376 | Mobile breakpoints: rework upload zone for touch (no drag-drop), fix timeline pinch-zoom, ensure file picker triggers iOS Safari camera-roll correctly (`<input type="file" accept="video/*" capture="environment">`). |
| [index.html](index.html) | (new screen) | Account / settings page: subscription status, default team, notification preferences (WhatsApp on/off, phone number). |
| [Dockerfile](Dockerfile) | (new line) | If S3 client needs extra deps, add to npm install. Likely none. |

### Files to create

| File | Purpose |
|---|---|
| `src/storage/objectStore.ts` | `uploadVideo(localPath, jobId): Promise<cdnUrl>`, `getSignedUrl(jobId, ttlSeconds): string`, `deleteVideo(jobId)`. Wrap Cloudflare R2 (S3-compatible API, free 10 GB egress). |
| `src/notify/whatsapp.ts` | `sendAnalysisDoneMessage(phone, analysisId, hebrewSummary)`. Uses Twilio WhatsApp Business API or **GreenAPI** (Israeli-friendly, cheaper for low volume) — pick one in setup. |
| `src/notify/email.ts` | Fallback: send via Resend or Supabase email if user opted out of WhatsApp. |
| `src/cron/cleanup.ts` | Periodic (cron-style) cleanup: delete R2 videos older than 90 days, mark analyses as `archived`. Replaces the startup-only cleanup at [analyzer.ts:154-177](src/analyzer.ts#L154-L177). Run via Railway cron or simple `setInterval` on boot. |

### External services to set up
- **Cloudflare R2** (S3-compatible, free up to 10 GB storage + 10 GB egress/month). Add `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_ENDPOINT` to Railway env.
- **WhatsApp Business API** — choose between:
  - **Twilio WhatsApp** (~$0.005-$0.07 per message depending on country): mature, but Twilio's Israel WhatsApp pricing is high.
  - **GreenAPI** (Israeli vendor): cheaper, Hebrew-friendly support, but uses an unofficial WhatsApp Web automation under the hood — risk of the underlying account getting banned. Acceptable for beta; migrate later.
  - **Wati** (officially WhatsApp Business API reseller, Israeli customer support): middle ground.
- Add `WHATSAPP_PROVIDER`, `WHATSAPP_API_KEY`, `WHATSAPP_FROM_NUMBER` env vars.

### Estimated work
**5-8 days.**
- Day 1: R2 bucket + objectStore wrapper + migrate existing 6 analyses' videos.
- Day 2: video.ts route + analyzer.ts persistence path swap.
- Day 3-4: WhatsApp integration + opt-in UI + phone-number validation (Israeli +972 format).
- Day 5-6: Mobile UX rework — actually open on a phone and fix what's broken (the audit says "two @media blocks exist" but real-device testing will surface a dozen issues).
- Day 7: Remove the dead 404 buttons + smoke-test all error paths.
- Day 8: Add the wall-clock budgets in retry/poll loops.

### Risks / things that might break
- **R2 migration of existing 6 analyses' videos:** the persisted videos at `/app/videos/*.mp4` may already be gone (Railway container restarts wipe ephemeral disk). Migration script: skip missing, log them, accept that the editor-playback feature for those specific old analyses is dead. Coaches can re-run.
- **WhatsApp opt-in compliance:** users must explicitly consent before receiving messages. Build the consent into account creation, not as a default.
- **WhatsApp template approval:** outbound business-initiated messages require pre-approved templates. "ניתוח המשחק שלך מוכן 🏀 — צפה כאן: {link}" must be submitted and approved before launch (1-3 day approval).
- **iOS Safari quirks** are the worst part of mobile work — expect the file picker to surprise you. Test on real iPhone, not simulator.
- **R2 cost-spike risk:** if a coach uploads 5 GB in a single video, you eat egress every time someone scrubs the timeline. Add a per-user upload size limit (Phase 1 + 4 cooperate here — chunk THEN upload thumbnails-only to R2, not full videos).

### Acceptance criteria
- [ ] All buttons in the UI either work or are removed; zero 404 console errors during normal use
- [ ] An analysis from week 1 is still streamable in week 4 (R2 persistence proven)
- [ ] WhatsApp message arrives within 60 s of job completion to the opted-in coach's phone
- [ ] Full upload + analysis + playback flow works on iPhone Safari (real device, not simulator) end-to-end
- [ ] Container restart mid-job: job correctly fails with a recoverable error, coach is notified, video is preserved (not lost to ephemeral disk)
- [ ] Wall-clock budget caps verified: a Gemini 503 storm cannot push a single chunk past 8 min

---

## Phase 5 — 10-game accuracy validation on real Liga Ha'al footage

### Goal
Prove that on **10 real Liga Ha'al games**, the bot generates plays that a head coach would call useful, accurate, and actionable. Surface and fix the systematic failure modes before paying customers find them. This is the gate to charging real money.

### Why last
You can't validate accuracy until Phase 1 lets you actually process a real game, Phase 2 lets you isolate test data, and Phase 3-4 give you the production rails to instrument.

### Files to modify

| File | Lines | Change |
|---|---|---|
| [src/analyzer.ts](src/analyzer.ts) | 700-1027 | `buildClipPrompt`: iterate based on validation findings. The prompt is the lever — most accuracy gains come from prompt tweaks, not architectural changes. Track each prompt revision as a git commit with the validation delta. |
| [src/routes/verify.ts](src/routes/verify.ts) | 8-97 | Self-verification endpoint exists but is Gemini self-grading itself, which is a known weak signal. Replace with a coach-grading workflow that reads back to MongoDB for accuracy tracking. |
| [src/database.ts](src/database.ts) | 134-141 | `VerificationSchema`: extend to track per-play coach verdicts (correct, wrong-player, wrong-action, wrong-outcome, missed-context). |
| [index.html](index.html) | (new screen) | Coach grading UI: thumbs-up/edit per play with a short categorical reason. Already partially present (corrections endpoint at [analyze.ts:216-235](src/routes/analyze.ts#L216-L235)) — extend to a structured rubric, not just free-text. |

### Files to create

| File | Purpose |
|---|---|
| `validation/games.json` | Manifest of the 10 validation games: source URL, opponent, date, jersey colors, expected difficulty (full broadcast vs scout-cam vs coach-uploaded angle). |
| `validation/run-batch.ts` | One-command script: read games.json, fire all 10 to `/api/analyze`, wait, dump results to `validation/results/{gameId}.json`. |
| `validation/grade.html` | Standalone tool: load a game's results + video side-by-side, mark each play correct/wrong/missing, save to MongoDB. |
| `validation/score.ts` | Aggregate the coach grades across all 10 games, output: per-team accuracy, per-playType accuracy, per-shot-mechanic accuracy, false-positive rate, missed-play rate. |
| `validation/REPORT.md` | Living document of findings + prompt revisions + before/after deltas. |

### External services to set up
- **Liga Ha'al footage source:** the league's official YouTube/website (if available) OR direct upload from a partner team's coach. **Critical that this is licensed/permission-given footage** — broadcasting rights matter.
- **One paid head coach** as the grading partner (offer free year, reduced rate, or co-branding). Without a coach grading the output, any accuracy claim is internal-only.

### Estimated work
**7-12 days, partially overlappable with Phase 4 polish.**
- Day 1-2: Validation harness (run-batch + grade UI).
- Day 3-5: Run the 10 games (each takes ~30-60 min in production + grading time).
- Day 6-9: Iterate prompts/heuristics based on top failure patterns. Re-run the failing games. Repeat.
- Day 10-12: Accuracy scoring + final REPORT + decision: ship to paid beta or re-cycle.

### Risks / things that might break
- **Footage licensing:** scraping broadcasts is not okay even for "research". Get permission in writing from a partner team or league before uploading anything.
- **Coach time is the bottleneck:** grading 10 games × 50-100 plays each at ~30 s/play = 5-15 hours of coach work. Pay them or barter for it.
- **Prompt iteration without regression tests** is dangerous. Every prompt change should be re-run on the prior set of validated plays to ensure it didn't break what already worked. Version every prompt, log every accuracy delta.
- **Selection bias in 10 games:** stratify across team styles (uptempo / half-court), broadcast angles (single-cam scout vs multi-cam broadcast), opponent skill — otherwise you'll over-fit to one style.
- **Hebrew translation drift:** as prompts evolve, the Hebrew label vocabulary at [analyzer.ts:1502-1525](src/analyzer.ts#L1502-L1525) and [analyzer.ts:1181-1209](src/analyzer.ts#L1181-L1209) needs to stay consistent. Coaches will roast inconsistent terms more than wrong plays.

### Acceptance criteria
- [ ] 10 real Liga Ha'al games processed end-to-end
- [ ] ≥ 70% of all generated plays graded "correct" by the partner coach (label + players + outcome all right)
- [ ] ≥ 60% per-play accuracy on **defensive_failure** plays specifically (the highest-value, hardest-to-get category)
- [ ] False-positive rate <15% (plays that are not actually plays — replays, dead-ball moments)
- [ ] Missed-play rate <30% on the partner coach's "must-include" list per game
- [ ] Hebrew vocabulary judged "natural" by the coach (no jarring translations)
- [ ] Final accuracy report (validation/REPORT.md) written, sharable with prospective buyers
- [ ] At least one "this is genuinely useful" testimonial from the validating coach, in writing

---

## Total schedule

| Phase | Work days | Calendar (with parallelism) |
|---|---|---|
| 1. Auto-chunk full games | 5-7 | Week 1-2 |
| 2. Auth + multi-tenancy | 6-9 | Week 2-3 |
| 3. Stripe + legal | 5-8 (+legal in parallel) | Week 3-5 |
| 4. Production polish | 5-8 | Week 4-6 (overlap with 3) |
| 5. 10-game validation | 7-12 | Week 5-8 (overlap with 4) |
| **Total focused dev time** | **28-44 days** | **6-8 weeks** |

Realistic single-developer calendar: **8 weeks to a sellable beta**, assuming no major architectural surprises and reasonable cooperation from the validating coach + lawyer + accountant.

## What this plan deliberately does NOT include
- **Practice plan generator** (frontend already references `/api/practice-plan` — currently 404). Cut from beta scope. Add post-beta if coaches request it.
- **Notion sync** (frontend references `/api/save-notion` — currently 404). Cut.
- **Sharing analyses with assistant coaches via signed link.** Useful but not blocking — punt to post-beta.
- **Player season-stats tracking** (the `seasonStats` field in [database.ts:62-69](src/database.ts#L62-L69) is currently inert). Cut.
- **Native mobile app.** Mobile web is enough for beta. Native is a 3-month project.
- **Multi-language support beyond Hebrew.** Beta is Israel-only.
- **Self-hosted Gemini / model swap.** API costs are tolerable at beta scale; revisit at 100+ paying customers.

## Open decisions before Phase 1 starts
1. **Pricing tiers** — the ₪149 / ₪299 / ₪599 in this doc is a placeholder. Validate with 3-5 prospective coaches before locking in.
2. **WhatsApp provider** — Twilio vs Wati vs GreenAPI. Decide in Phase 4 setup; affects cost per coach.
3. **Cloud hosting strategy** — Railway is fine for beta but ephemeral disk is a real constraint. Consider Fly.io or moving to a Railway plan with persistent volumes if R2 alone isn't enough.
4. **Demo-user UUID** — create the Supabase user account before starting Phase 2 migration.
5. **Validating coach** — line them up before Phase 5 starts. They are the bottleneck.
