import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TeamKnowledge, Job } from './database';
import BASKETBALL_BRAIN from './knowledge/basketballBrain';

/**
 * Pull recent coach corrections from MongoDB and format them as a Hebrew
 * prompt block. Used by enrichPlaysWithClaude as few-shot guidance — the
 * coach's "this was actually X, not Y" feedback teaches the next analysis
 * which terms to use.
 *
 * Filter rules: last 5 jobs that have any corrections, then per-correction
 * keep only those with correct=false AND non-trivial text (>3 chars after
 * trim). Cap at 20 bullets so the prompt stays bounded.
 *
 * Returns '' when nothing usable is found — caller concatenates blindly.
 */
async function loadRecentCorrections(): Promise<string> {
  try {
    const recentJobs = await Job.find(
      { 'corrections.0': { $exists: true } },
      { corrections: 1, createdAt: 1 },
    ).sort({ createdAt: -1 }).limit(5);

    const bullets: string[] = [];
    for (const job of recentJobs) {
      for (const c of job.corrections || []) {
        if (!c.correct && c.correction && c.correction.trim().length > 3) {
          bullets.push(`- ${c.correction.trim()}`);
        }
      }
    }
    if (bullets.length === 0) {
      console.log('🆕 No past corrections found, running enrichment without feedback');
      return '';
    }
    const last20 = bullets.slice(0, 20);
    console.log(`📚 Injecting ${last20.length} past corrections from ${recentJobs.length} recent games into prompt`);
    return `\n\nCOACH CORRECTIONS — real examples from this team's games. Study these carefully and apply the same patterns:\n${last20.join('\n')}\n\nWhen you see a similar situation, use these corrections to identify the play correctly.`;
  } catch (err) {
    console.warn('⚠️ Could not load corrections:', err);
    return '';
  }
}

async function getKnowledgeContext(): Promise<string> {
  try {
    const knowledge = await TeamKnowledge.findOne({ teamId: 'default' });
    if (!knowledge) return '';
    const parts: string[] = [];
    if (knowledge.philosophy) parts.push(`Philosophy: ${knowledge.philosophy}`);
    if (knowledge.offenseSystem) parts.push(`Offense system: ${knowledge.offenseSystem}`);
    if (knowledge.defenseSystem) parts.push(`Defense system: ${knowledge.defenseSystem}`);
    if (knowledge.documents?.length) {
      const docText = knowledge.documents.map(d => d.content).join('\n').substring(0, 1000);
      if (docText) parts.push(docText);
    }
    if (parts.length === 0) return '';
    return `\nCoaching context:\n${parts.join('\n')}\n`;
  } catch (err) {
    console.warn('⚠️ Could not fetch knowledge base:', err);
    return '';
  }
}

// ffmpeg/ffprobe: use local Windows binaries if available, otherwise system-installed (Linux/Railway)
const BIN_DIR = path.join(__dirname, '..', 'bin');
const FFMPEG = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))
  ? path.join(BIN_DIR, 'ffmpeg.exe')
  : 'ffmpeg';
const FFPROBE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe'))
  ? path.join(BIN_DIR, 'ffprobe.exe')
  : 'ffprobe';

const SYSTEM_PROMPT = `אתה אנליסט כדורסל מקצועי ישראלי. נתח את התמונות האלה ממשחק כדורסל והחזר JSON בלבד:
{
  "game": "תיאור קצר של המשחק",
  "plays": [{ "startTime": "00:00", "endTime": "00:15", "type": "Offense|Defense|Transition", "label": "שם המהלך", "note": "הערה", "players": ["#5", "#10"] }],
  "insights": [{ "type": "good|warn|bad", "title": "כותרת", "body": "פירוט" }],
  "shotChart": { "paint": 45, "midRange": 30, "corner3": 35, "aboveBreak3": 28, "pullUp": 20 }
}
כל הטקסט בעברית.`;

export interface AnalysisResult {
  game: string;
  plays: { startTime: string; endTime: string; time?: string; type: string; label: string; note: string; players: string[] }[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
}

export type ProgressCb = (pct: number, msg: string) => void;

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Retry a Gemini call on 503/529/overloaded responses.
 *
 * Backoff schedule (seconds): 5, 10, 20, 40, 80, 90, 90. Caps at 90s so a
 * single clip's retry loop can't exceed ~6.7min wall time. Each wait is
 * multiplied by a 0.8–1.2 jitter factor so parallel clip retries don't
 * stampede the API after a shared outage.
 *
 * On terminal failure, logs a single line `❌ Gemini permanently failed…`
 * keyed by `label` so lost plays are grep-countable in Railway logs.
 */
async function retryWithBackoff(fn: () => Promise<any>, label = 'Gemini'): Promise<any> {
  const RETRIES = 7;
  const DELAYS_SEC = [5, 10, 20, 40, 80, 90, 90];
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const is503 = err?.status === 503 ||
        err?.status === 529 ||
        err?.message?.includes('503') ||
        err?.message?.includes('529') ||
        err?.message?.includes('high demand') ||
        err?.message?.includes('overloaded') ||
        err?.message?.includes('Overloaded');
      if (is503 && i < RETRIES - 1) {
        const base = DELAYS_SEC[i] * 1000;
        const jitter = 0.8 + Math.random() * 0.4; // [0.8, 1.2)
        const delay = Math.round(base * jitter);
        console.log(`Gemini 503 — retry ${i + 1}/${RETRIES} in ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (is503) {
        console.error(`❌ Gemini permanently failed after ${RETRIES} retries — ${label} lost`);
      }
      throw err;
    }
  }
}

// ============================================================
// LOCAL MODE: yt-dlp + ffmpeg + Claude Vision (full pipeline)
// ============================================================

/** Download YouTube video using yt-dlp */
export function downloadYouTube(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-yt-'));
  const outPath = path.join(tmpDir, 'video.mp4');
  console.log(`\n📥 [1/4] Downloading YouTube video: ${url}`);

  const cleanUrl = url.split('&t=')[0];
  const cmd = `yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]/best" --no-part --buffer-size 16K -o "${outPath}" "${cleanUrl}"`;
  console.log(`   CMD: ${cmd}`);

  execSync(cmd, { stdio: 'inherit', timeout: 300000 });

  const stat = fs.statSync(outPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${outPath}`);
  return outPath;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface FrameWithTime {
  path: string;
  seconds: number;
  timestamp: string;
}

/** Extract 1 frame every 5 seconds using local ffmpeg */
export function extractFrames(videoPath: string): FrameWithTime[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-frames-'));
  const INTERVAL = 5;
  console.log(`\n📸 [2/4] Extracting frames (1 every ${INTERVAL}s)...`);

  console.log(`   ffprobe: getting duration...`);
  const durationStr = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
  ], { encoding: 'utf-8', timeout: 30000 }).trim();
  const duration = parseFloat(durationStr);
  console.log(`   📹 Video duration: ${duration.toFixed(1)}s (${formatTimestamp(duration)})`);

  const pattern = path.join(tmpDir, 'frame_%04d.jpg');
  console.log(`   ffmpeg: extracting frames fps=1/${INTERVAL} ...`);
  execFileSync(FFMPEG, [
    '-i', videoPath, '-vf', `fps=1/${INTERVAL}`, '-q:v', '2', pattern, '-y'
  ], { stdio: 'inherit', timeout: 600000 });

  let frames: FrameWithTime[] = fs.readdirSync(tmpDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map((f, i) => {
      const seconds = i * INTERVAL;
      return { path: path.join(tmpDir, f), seconds, timestamp: formatTimestamp(seconds) };
    });

  console.log(`   ✅ Extracted ${frames.length} frames from ${duration.toFixed(0)}s video`);

  if (frames.length > 20) {
    console.log(`   ⚠️ Too many frames (${frames.length}), keeping every Nth to get ~20`);
    const step = Math.ceil(frames.length / 20);
    const selected = frames.filter((_, i) => i % step === 0).slice(0, 20);
    frames.filter(f => !selected.includes(f)).forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    console.log(`   ✅ Kept ${selected.length} frames (${selected[0].timestamp} - ${selected[selected.length-1].timestamp})`);
    return selected;
  }

  return frames;
}

/** Send frame files to Claude Vision API */
export async function analyzeFrames(frames: FrameWithTime[], context: string, focus: string, geminiDescription?: string | null): Promise<AnalysisResult> {
  console.log(`\n🤖 [3/4] Sending ${frames.length} frames to Claude Vision...`);
  const client = getClient();

  // Interleave text labels with images so Claude knows each frame's timestamp
  const contentBlocks: (Anthropic.ImageBlockParam | Anthropic.TextBlockParam)[] = [];
  frames.forEach((frame, i) => {
    const data = fs.readFileSync(frame.path).toString('base64');
    const sizeKB = (Buffer.byteLength(data, 'base64') / 1024).toFixed(0);
    console.log(`   📷 Frame ${i + 1}/${frames.length}: ${frame.timestamp} (${sizeKB}KB)`);
    contentBlocks.push({
      type: 'text' as const,
      text: `פריים ${i + 1} — זמן בסרטון: ${frame.timestamp}`,
    });
    contentBlocks.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });
  });

  // Cleanup frame files after reading into memory
  const frameDirs = new Set(frames.map(f => path.dirname(f.path)));
  frameDirs.forEach(dir => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const geminiContext = geminiDescription
    ? `\n\nתיאור וידאו מ-AI נוסף (השתמש כהקשר בלבד):\n${geminiDescription}\n`
    : '';

  const frameList = frames.map((f, i) => `פריים ${i + 1} = ${f.timestamp}`).join(', ');
  contentBlocks.push({
    type: 'text' as const,
    text: `${geminiContext}פוקוס ניתוח: ${focus}\nהקשר: ${context || 'אין הקשר נוסף'}\n\nמיפוי זמנים: ${frameList}\nהשתמש בזמנים האלה עבור startTime ו-endTime של כל מהלך. אל תמציא זמנים — השתמש רק בזמנים מהרשימה למעלה.\n\nנתח את הפריימים האלה מהמשחק והחזר JSON.`,
  });

  console.log(`   📡 Calling Claude claude-sonnet-4-20250514 with ${frames.length} images...`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: contentBlocks }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log(`   ✅ Claude responded (${text.length} chars)`);
  console.log(`   📊 Usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('   ❌ Raw response:', text.substring(0, 500));
    throw new Error('לא נמצא JSON בתגובת Claude');
  }

  const result: AnalysisResult = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Parsed: ${result.plays?.length || 0} plays, ${result.insights?.length || 0} insights`);
  return result;
}

// ============================================================
// NEW PIPELINE: Gemini full video → Claude enrichment
// ============================================================

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, delayMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable = err?.status === 503 || err?.status === 429 || err?.message?.includes('503') || err?.message?.includes('429');
      if (attempt === maxAttempts || !isRetryable) throw err;
      console.log(`   ⚠️ Gemini attempt ${attempt} failed (${err?.status || err?.message}), retrying in ${delayMs/1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

interface GeminiPlay {
  startTime: string;
  endTime: string;
  type: string;
  players: string[];
  description: string;
  playType: string;
  possession_origin?: string;
  setup?: string;
  action?: string;
  finish?: string;        // outcome only (made_2/3, missed_2/3, block, steal, etc.)
  shot_mechanic?: string; // motion only (floater, pull_up, step_back, etc.); omit if no shot attempted
  finish_location?: string;
  perspective?: string;
}

/** Helper: upload video to Gemini Files API and return fileUri */
async function uploadVideoToGemini(videoPath: string): Promise<{ fileUri: string; mimeType: string }> {
  const { GoogleGenAI, FileState } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const fileSizeMB = fs.statSync(videoPath).size / (1024 * 1024);
  console.log(`   📤 Uploading ${fileSizeMB.toFixed(1)}MB to Gemini Files API...`);

  const uploadResult = await ai.files.upload({
    file: videoPath,
    config: {
      mimeType: 'video/mp4',
      displayName: path.basename(videoPath),
    },
  });
  console.log(`   ✅ Uploaded: ${uploadResult.name} (state: ${uploadResult.state})`);

  // Wait for file to become ACTIVE
  let file = uploadResult;
  while (file.state === FileState.PROCESSING) {
    console.log('   ⏳ Waiting for file processing...');
    await new Promise(r => setTimeout(r, 3000));
    file = await ai.files.get({ name: file.name! });
  }
  if (file.state !== FileState.ACTIVE) {
    throw new Error(`Gemini file processing failed: ${file.state}`);
  }
  console.log('   ✅ File ready');
  return { fileUri: file.uri!, mimeType: 'video/mp4' };
}

/** PASS 1: Detect play timestamps from full video */
async function detectPlayTimestamps(
  fileUri: string,
  mimeType: string,
  jerseyColor: string,
  opponentJerseyColor: string
): Promise<string[]> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const prompt = `You are watching a basketball game video.
Your ONLY job is to find timestamps where important plays happened.

Important plays are:
- Any basket scored (by either team)
- Any steal or clear turnover
- Any fast break

Return ONLY a valid JSON array of timestamp strings in MM:SS format.
Example: ["02:34", "04:11", "07:22", "13:05"]

Rules:
- Return the array only. No text before or after. No markdown.
- Maximum 25 timestamps.
- If two events are within 15 seconds of each other, keep only one.
- The analyzing team wears ${jerseyColor}. Opponent wears ${opponentJerseyColor}.
- Focus on plays involving the analyzing team.
- IMPORTANT: Only include timestamps where the shot clock is visible on screen. If the shot clock is not visible (replay, celebration, timeout, close-up) — skip that moment.`;

  try {
    const rawResponse = await retryWithBackoff(async () => {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        config: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
        contents: [{
          role: 'user',
          parts: [
            { fileData: { fileUri, mimeType } },
            { text: prompt },
          ],
        }],
      });
      const text = typeof res.text === 'string' ? res.text : '';
      console.log('🔍 res.text length:', text.length, 'preview:', text.substring(0, 200));
      if (!text.trim()) {
        const emptyErr = new Error('Gemini returned empty response');
        (emptyErr as any).status = 503;
        throw emptyErr;
      }
      return text;
    }, 'timestamp detection');

    const rawText = rawResponse
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    console.log('🔍 FULL rawText length:', rawText.length);
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    console.log('🔍 jsonMatch found:', !!jsonMatch);
    if (!jsonMatch) {
      console.log('⚠️ No timestamp array found. Full rawText:', rawText);
      const fallbackMatches = rawText.match(/\d{2}:\d{2}/g);
      if (fallbackMatches && fallbackMatches.length > 0) {
        console.log(`⚠️ Using fallback extraction: ${fallbackMatches.length} timestamps`);
        return fallbackMatches.slice(0, 25);
      }
      return [];
    }
    const timestamps: string[] = JSON.parse(jsonMatch[0]);
    console.log(`🎯 Detected ${timestamps.length} play timestamps:`, timestamps);
    return timestamps;
  } catch (err) {
    console.error('⚠️ Timestamp detection failed:', err);
    return [];
  }
}

/** Build the clip analysis prompt */
function buildClipPrompt(
  timestampStr: string,
  jerseyColor: string,
  opponentJerseyColor: string,
  teamName: string,
  roster: string,
  context: string
): string {
  const rosterText = roster || '(no roster provided)';
  return `You are watching an 18-second clip from a basketball game.
This clip was extracted around timestamp ${timestampStr} in the full game.
There is ONE play in this clip. Identify and describe ONLY that play.
Return a JSON array with exactly ONE play object.

═══ GAME CONTEXT ═══
Team being analyzed: ${teamName || 'unknown'}
Their jersey color: ${jerseyColor || 'unknown'}
Opponent jersey color: ${opponentJerseyColor || 'unknown'}
Game situation: ${context || 'none'}
Analyzing team roster (jersey numbers only):
${rosterText}

Use the roster ONLY to confirm which jersey numbers belong to the analyzing team.
NEVER use player names in any field.
Use jersey numbers only: "#11", "#0", etc.

═══ DEFINITIONS ═══

PLAY TYPES — pick the most accurate:
Offensive half court:
- pick_and_roll_finish = screen action, roller or ball handler finishes at basket
- pick_and_roll_kickout_3 = screen action, kick out to corner or wing 3-pointer
- pick_and_pop = screener pops to perimeter for jump shot instead of rolling
- dribble_handoff = ball handler dribbles toward teammate and hands off while moving
- isolation_drive = one on one, player drives to basket
- isolation_fadeaway = one on one, player shoots jumping away from defender. If the shot misses and ball goes out of bounds, finish = out_of_bounds NOT missed_2. NEVER assume the shot went in — only write made_2 if you clearly see the ball go through the net.
- post_up_finish = player received ball IN the paint or low post, finishes from there. STRICT LOCATION RULE: if player received ball outside the paint or beyond the three point line, this is NEVER post_up_finish — use isolation_drive or isolation_fadeaway instead, regardless of which player it is or their usual tendencies. A spin move or dribble move that creates separation = isolation type, not post.
- post_up_pass_out = player received in post, could not finish, passed back out to shooter
- high_low = pass from high post (elbow/free throw line) to low post cutter under the basket
- *** CRITICAL — drive_and_kick: The play belongs to the SHOOTER. The player who PASSED is NOT the finisher. setup = describe the driver. action = describe the shooter catching and scoring. players array = [driver_number, shooter_number]
- backdoor_cut = player cuts behind overplaying defender to receive lob near basket
- skip_pass_corner_3 = long cross-court pass to corner shooter
- elevator_screen = two players open and close like elevator doors for shooter running through
- inbound_play = BLOB or SLOB set play from out of bounds
- alley_oop_set = lob pass + mid-air catch and finish near basket

Transition:
- transition_steal_dunk = steal leads directly to fast break finish
- transition_leak_out = player leaks out early before rebound for easy basket
- fast_break_2on1 = 2 attackers vs 1 defender
- fast_break_3on2 = 3 attackers vs 2 defenders
- secondary_break = not pure fast break, offense pushes pace before defense sets (3-5 seconds after rebound)
- coast_to_coast = player personally gains ball in OWN half and carries full court alone

Offensive rebounds:
- offensive_rebound_putback = offensive rebound finished immediately
- offensive_rebound_tip_in = soft tip into basket

Defensive:
- defensive_stop = significant half court stop
- defensive_block = block shot
- charge_taken = defender takes offensive foul
- shot_clock_violation = defense forces shot clock to expire
- foul_drawn = offensive player draws foul

FINISH TYPES — describe the OUTCOME of the possession (was a shot made, missed, blocked, etc.). Use ONE value. The shooting MOTION goes in the separate shot_mechanic field below — do NOT put motion words like "fadeaway" or "pull_up" here.
"made_2" = 2-point shot scored (any motion).
"made_3" = 3-point shot scored (any motion). Only write made_3 if you clearly see the ball pass through the net.
"missed_2" = 2-point shot missed (any motion).
"missed_3" = 3-point shot missed (any motion). Step-back 3-pointers miss more often than they go in — do NOT assume a step-back shot was made.
"and_one" = basket scored while being fouled.
"block" = our shot was blocked by defender.
"steal" = defender took the ball before/instead of a shot completing.
"charge_taken" = defender drew an offensive foul.
"foul_drawn" = offensive player drew a defensive foul, no shot completed.
"out_of_bounds" = ball went out before resolution. Note in setup: did offense step out (turnover) or defense knock it out (defensive play).
"shot_clock_violation" = clock expired with no shot.
"unknown_finish" = camera cut or unclear outcome.

WHEN IN DOUBT → "unknown_finish"
NEVER assume basket scored unless you CLEARLY see ball go through hoop.

SHOT TYPE IDENTIFICATION — emit one of these values in the shot_mechanic field. Pick the most specific value that clearly fits the visible motion. If ambiguous, fall back to a generic (layup / jumper / dunk). The shot_mechanic field is INDEPENDENT of the finish field — a missed step-back three is finish: missed_3, shot_mechanic: step_back. Both are recorded.
- floater: high-arc one-hander, 5-12 ft, released before reaching rim
- scoop_layup: low underhand release, usually avoiding shot blocker
- finger_roll: high one-hander rolling softly off fingertips
- reverse_layup: finishes on opposite side of backboard from drive
- euro_step: two lateral steps between gather and release
- jump_hook: post hook shot from a jump, release over the head
- running_hook: hook shot while moving laterally
- up_and_under: pump fake in post, score from below the defender
- tip_in: mid-air deflection into rim, no catch
- putback: catch + immediate score, no dribble reset
- putback_dunk: offensive rebound dunked in one motion
- catch_and_shoot: jumper with no dribble between catch and release
- pull_up: jumper off the dribble, feet set before release
- step_back: backward step creates space before jumper
- fadeaway: body leans back during release
- turnaround: back-to-basket pivot into jumper
- pump_fake_shot: shot fake makes defender commit, then real shot follows
- one_hand_dunk: ball through rim from above, one hand
- two_hand_dunk: ball through rim from above, two hands
- bank_shot: explicit use of backboard square for a direct (non-layup) shot
- layup: generic layup when the specific motion isn't clear (fallback)
- jumper: generic jumper when the specific motion isn't clear (fallback)
- dunk: generic dunk when one-hand vs two-hand isn't visible (fallback)

OMIT shot_mechanic entirely when no shot was attempted (steal, foul_drawn, out_of_bounds, shot_clock_violation, charge_taken).

Three-pointers: there is no compound shot_mechanic value — keep finish: made_3 or missed_3, and put the motion (pull_up, step_back, catch_and_shoot, fadeaway, turnaround, pump_fake_shot, or jumper) in shot_mechanic. The Hebrew translator combines them into 'סטפ-באק שלשה'-style labels downstream.

POSSESSION ORIGINS:
"steal" = defender clearly intercepts ball.
"deflection" = ball bounces off player accidentally into another's hands.
"defensive_rebound" = defender catches missed shot.
"offensive_rebound" = attacker catches missed shot.
"inbound" = play restarts from out of bounds.
"after_timeout" = first play out of timeout.
"after_foul" = possession after opponent foul.
"press_break" = team breaks full court pressure.
"live_ball" = continuous live action.
"unknown" = cannot clearly see origin.

═══ RULES ═══

RULE 1 — JERSEY COLOR FIRST:
Before writing any play, identify jersey color of the player with the ball.
${jerseyColor || 'unknown'} = analyzing team → write normally, perspective: "offense" or "transition"
${opponentJerseyColor || 'unknown'} scores → write as defensive failure, perspective: "defensive_failure"
${opponentJerseyColor || 'unknown'} no score → SKIP
Truly cannot identify → use roster numbers to determine team. Only skip if impossible.

RULE 2 — PLAY TYPE LOCATION RULE:
playType determined by WHERE player RECEIVED ball.
Received in paint/low post = post_up_finish.
Received above free throw line = isolation type, EVEN IF they spin or drive into paint afterward.
EXCEPTION: if ball was received AS RESULT of a screen action = use pick_and_roll play type regardless of location.
drive_and_kick finish = belongs to the SHOOTER.

RULE 3 — FINISH AND MECHANIC ACCURACY:
shot_mechanic: "layup" only if continuous momentum, no stop.
shot_mechanic: "one_hand_dunk" or "two_hand_dunk" only if you CLEARLY see hands above rim. Use generic "dunk" if you can't tell which hand.
Player stops and jumps to shoot (any distance) = shot_mechanic: "pull_up", finish: whichever outcome occurred (made_2 / missed_2 / made_3 / missed_3 / block).
When motion is unclear = shot_mechanic: "layup" or "jumper" (generic). When outcome is unclear = finish: "unknown_finish".
NEVER assume a shot was made unless you clearly see the ball pass through the net. If the shot misses, write finish: missed_3 or missed_2 (shot_mechanic still describes the motion that missed). After a missed shot — check: did anyone get the offensive rebound and score? If yes, that is a SEPARATE play entry with playType offensive_rebound_putback (shot_mechanic: putback or putback_dunk).

RULE — SECOND CHANCE: After every missed shot, watch what happens next in the clip. If a player gets the offensive rebound and scores immediately, that is a SEPARATE play entry with playType offensive_rebound_putback. Write it as a second object in the JSON array. Never stop at the miss if the possession continues in the same clip.

RULE 4 — WHISTLE/FOUL:
Whistle = play ends immediately.
Write what happened BEFORE whistle only.
finish: "foul_drawn" or "charge_taken".

RULE 5 — CAMERA CUTS:
Cut during play = play ends there.
Never combine two possessions.
A deflection off a missed shot that causes the ball to go out of bounds is NOT a defensive play. Write it as: perspective: offense, finish: out_of_bounds, possession_origin: deflection.

RULE 6 — SETUP AND ACTION FIELDS:
setup = 1-2 sentences. For chain plays (pick and roll → defensive collapse → open cutter), describe ALL phases: what the first action was, how the defense reacted, what space was created. Jersey numbers only. No names.
action = ONE sentence only. The decisive moment.
description = ONE sentence in English. Full sequence from origin to finish. Jersey numbers only. No names.

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON array with exactly ONE play, no markdown:

[{
  "startTime": "${timestampStr}",
  "endTime": "...",
  "playType": "pick_and_roll_finish | pick_and_roll_kickout_3 | pick_and_pop | dribble_handoff | isolation_drive | isolation_fadeaway | post_up_finish | post_up_pass_out | high_low | drive_and_kick | backdoor_cut | skip_pass_corner_3 | elevator_screen | inbound_play | alley_oop_set | transition_steal_dunk | transition_leak_out | fast_break_2on1 | fast_break_3on2 | secondary_break | coast_to_coast | offensive_rebound_putback | offensive_rebound_tip_in | defensive_stop | defensive_block | charge_taken | shot_clock_violation | foul_drawn",
  "possession_origin": "live_ball | steal | deflection | defensive_rebound | offensive_rebound | inbound | after_timeout | after_foul | press_break | unknown",
  "setup": "1-2 sentences, jersey numbers only",
  "action": "one sentence, jersey numbers only",
  // "finish" describes the OUTCOME of the possession. Use ONE value. unknown_finish only if camera cut or occluded view.
  "finish": "made_2 | made_3 | missed_2 | missed_3 | and_one | block | steal | charge_taken | foul_drawn | out_of_bounds | shot_clock_violation | unknown_finish",
  // "shot_mechanic" describes the shooting MOTION (independent of made/missed). OMIT this field entirely if no shot was attempted.
  "shot_mechanic": "floater | scoop_layup | finger_roll | reverse_layup | euro_step | jump_hook | running_hook | up_and_under | tip_in | putback | putback_dunk | catch_and_shoot | pull_up | step_back | fadeaway | turnaround | pump_fake_shot | one_hand_dunk | two_hand_dunk | bank_shot | layup | jumper | dunk",
  "finish_location": "paint | midrange_left | midrange_right | corner_3_left | corner_3_right | above_break_3 | free_throw_line",
  "players": ["#11", "#2"],
  "type": "offense | defense | transition",
  "perspective": "offense | defense | defensive_failure",
  "description": "one sentence in English, jersey numbers only"
}]`;
}

/** PASS 2: Analyze a single clip around a timestamp */
async function analyzeClipAtTimestamp(
  fileUri: string,
  mimeType: string,
  timestampStr: string,
  jerseyColor: string,
  opponentJerseyColor: string,
  teamName: string,
  roster: string,
  context: string
): Promise<GeminiPlay | null> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const [mins, secs] = timestampStr.split(':').map(Number);
  const centerSeconds = mins * 60 + secs;
  const startSeconds = Math.max(0, centerSeconds - 8);
  const endSeconds = centerSeconds + 10;

  const clipPrompt = buildClipPrompt(timestampStr, jerseyColor, opponentJerseyColor, teamName, roster, context);

  try {
    const result = await retryWithBackoff(async () => {
      const res = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        config: {
          temperature: 0.1,
          maxOutputTokens: 4096,
        },
        contents: [{
          role: 'user',
          parts: [
            {
              fileData: { fileUri, mimeType },
              videoMetadata: {
                startOffset: `${startSeconds}s`,
                endOffset: `${endSeconds}s`,
              },
            },
            { text: clipPrompt },
          ],
        }],
      });
      const text = res.text || '';
      if (!text.trim()) {
        const emptyErr = new Error('Gemini returned empty response');
        (emptyErr as any).status = 503;
        throw emptyErr;
      }
      return res;
    }, `clip at ${timestampStr}`);

    const rawText = (result.text || '')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.log(`   ⚠️ Clip ${timestampStr}: no JSON found`);
      return null;
    }
    const plays: GeminiPlay[] = JSON.parse(jsonMatch[0]);
    const play = plays[0] || null;
    if (play) {
      console.log(`   🏀 Clip ${timestampStr}: ${play.playType} → ${play.finish}`);
    }
    return play;
  } catch (err) {
    console.error(`   ❌ Clip ${timestampStr} failed:`, err);
    return null;
  }
}

/** STEP 2: Enrich Gemini plays with Hebrew coaching analysis via Claude */
async function enrichPlaysWithClaude(
  geminiPlays: GeminiPlay[],
  roster: string,
  teamName: string,
  focus: string
): Promise<AnalysisResult['plays']> {
  console.log(`\n🤖 [2/3] Claude enrichment (${geminiPlays.length} plays)...`);
  const client = getClient();
  const knowledgeContext = await getKnowledgeContext();
  const correctionsBlock = await loadRecentCorrections();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a professional Israeli basketball coaching analyst writing Hebrew coaching notes.

You will receive plays detected by a video analyst. Each play has:
- playType: the action that occurred
- possession_origin: how possession was gained
- setup: what happened before the finish
- action: the decisive moment
- finish: how it ended
- finish_location: where on court
- players: jersey numbers involved
- perspective: offense | defense | defensive_failure
- description: English physical summary

Your job: convert each play into a Hebrew coaching note using the roster provided.

Return ONLY a valid JSON array, no markdown:

[{
  "startTime": "...",
  "endTime": "...",
  "type": "offense | defense | transition",
  "label": "קצר בעברית — מקסימום 5 מילים",
  "note": "2-3 משפטים בעברית — הערה אימונית",
  "players": ["#11"],
  "perspective": "offense | defense | defensive_failure"
}]

═══ WRITING RULES ═══

PERSPECTIVE RULE — most important:
- perspective "offense" = write from attacking perspective. What did we do well or poorly?
- perspective "defense" = write from defensive perspective. How did we force the stop?
- perspective "defensive_failure" = opponent scored against us. Write as coaching critique: what did our defense fail to do? Start with: "הגנה אפשרה ל..." NEVER praise the opponent. Focus on our failure.

PLAYER NAMES:
- Use roster name for analyzing team players
- Hebrew names in Hebrew, English names in English
- NEVER transliterate English names to Hebrew
- Opponent players = "היריב" or "#X של היריב"
- Never mention opponent player names

LANGUAGE RULES:
- שלשה (never שלושה)
- פאול (not עבירה אישית)
- דאנק (not תקיעה)
- לייאפ (not כניסה)
- סטיל (not חטיפה)
- דרייב (not חדירה)
- פיק אנד רול (acceptable alongside מסך ומסירה)

SHOT MECHANIC + OUTCOME → HEBREW LABEL:
The label combines two fields: "finish" (outcome) and "shot_mechanic" (motion). If shot_mechanic is missing, fall back to a generic phrase per outcome. Always end with "של <player>".

Mechanic → Hebrew root term:
- floater → פלוטר
- scoop_layup → לייאפ סקופ
- finger_roll → פינגר רול
- reverse_layup → לייאפ הפוך
- euro_step → אירו סטפ
- jump_hook → הוק בקפיצה
- running_hook → הוק בריצה
- up_and_under → אפ-אנד-אנדר
- tip_in → טיפ-אין
- putback → פוטבק
- putback_dunk → פוטבק דאנק
- catch_and_shoot → קאץ' אנד שוט
- pull_up → פול-אפ
- step_back → סטפ-באק
- fadeaway → פייד-אווי
- turnaround → טרנ-אראונד
- pump_fake_shot → הטעיית קליעה
- one_hand_dunk → דאנק ביד אחת
- two_hand_dunk → סלאם
- bank_shot → זריקת לוח
- layup (generic) → לייאפ
- jumper (generic) → קפיצה
- dunk (generic) → דאנק

MADE SHOTS (finish: made_2 or made_3):
- made_2 + any specific mechanic → "<mechanic Hebrew> של <player>" (e.g. פלוטר של דורט, פייד-אווי של שיי, דאנק ביד אחת של שיי)
- made_2 + jumper (generic) → "סל של <player>"
- made_2 + mechanic missing → "סל של <player>"
- made_3 + step_back → "סטפ-באק שלשה של <player>"
- made_3 + pull_up → "פול-אפ שלשה של <player>"
- made_3 + fadeaway → "פייד-אווי שלשה של <player>"
- made_3 + catch_and_shoot → "קאץ' אנד שוט שלשה של <player>"
- made_3 + turnaround → "טרנ-אראונד שלשה של <player>"
- made_3 + pump_fake_shot → "שלשה אחרי הטעיית קליעה של <player>"
- made_3 + jumper (generic) or missing → "שלשה של <player>"

MISSED SHOTS (finish: missed_2 or missed_3):
Same composition as made, then append " — החטיא".
- missed_2 + pull_up → "פול-אפ של <player> — החטיא"
- missed_3 + step_back → "סטפ-באק שלשה של <player> — החטיא"
- missed + mechanic missing → "<2-נקודות or שלשה> של <player> — החטיא"

AND-ONE (finish: and_one):
- and_one + any specific mechanic → "<mechanic Hebrew> ועבירה של <player>" (e.g. דאנק ועבירה של דורט)
- and_one + mechanic missing → "אנד-וואן של <player>"

BLOCKED (finish: block):
- block + any mechanic → "<mechanic Hebrew> של <player> נחסם" (e.g. פלוטר של דורט נחסם, דאנק ביד אחת של שיי נחסם)
- block + mechanic missing → "זריקה של <player> נחסמה"

OTHER OUTCOMES (no shot completed — shot_mechanic typically absent):
- steal → "סטיל על <player>" (we lost the ball; perspective: defensive_failure)
- charge_taken → "פאול התקפי של <player>"
- foul_drawn → "<player> סחב פאול"
- out_of_bounds → "כדור החוצה — <player>"
- shot_clock_violation → "הפרת שעון התקפי"
- unknown_finish + mechanic present → mechanic alone, no outcome word (e.g. "סטפ-באק של שיי")
- unknown_finish + mechanic missing → describe the action via setup/note instead, do not invent an outcome

NOTE STRUCTURE — follow this order:
1. How did possession start? (from possession_origin)
2. What was the setup? (from setup field)
3. What was the decisive action? (from action field)
4. Coaching observation:
   - offense: what made this work or fail?
   - defense: what did we do right?
   - defensive_failure: what must we fix?

COACHING KNOWLEDGE:
${BASKETBALL_BRAIN}

${knowledgeContext}
${correctionsBlock}

═══ INPUTS ═══
Roster: ${roster}
Team: ${teamName}
Focus: ${focus}

Plays:
${JSON.stringify(geminiPlays, null, 2)}`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  console.log(`   ✅ Claude responded (${text.length} chars)`);
  console.log(`   📊 Usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('   ❌ Raw Claude response:', text.substring(0, 500));
    throw new Error('Claude enrichment did not return valid JSON');
  }

  const enriched = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Enriched ${enriched.length} plays`);
  return enriched;
}

/** STEP 3: Generate coaching insights from enriched plays */
async function generateInsightsFromPlays(
  plays: AnalysisResult['plays'],
  context: string
): Promise<AnalysisResult['insights']> {
  console.log(`\n💡 [3/3] Generating insights from ${plays.length} plays...`);
  const client = getClient();
  const knowledgeContext = await getKnowledgeContext();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Based on these basketball plays from a game, provide coaching insights in Hebrew.
Return ONLY a valid JSON array, maximum 4 insights, no explanation or markdown:
[{"type":"good|warn|bad","title":"Hebrew title","body":"Hebrew explanation"}]

Context: ${context || 'אין הקשר נוסף'}
${knowledgeContext}
Plays:
${JSON.stringify(plays, null, 2)}`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  console.log(`   ✅ Claude responded (${text.length} chars)`);

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('   ❌ Raw response:', text.substring(0, 500));
    return [{ type: 'warn', title: 'שגיאה', body: 'לא הצלחתי לייצר תובנות' }];
  }

  const insights = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Generated ${insights.length} insights`);
  return insights;
}

/** Parse "MM:SS" or "HH:MM:SS" into total seconds. Returns 0 on malformed input. */
function timeToSeconds(t: string): number {
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Drop duplicate plays that describe the same possession from two angles.
 *
 * Why this exists: the per-clip analyzer looks at an 18-second window around
 * each Gemini-supplied timestamp. When Gemini emits two timestamps 1–2 seconds
 * apart (ignoring its own "keep one within 15s" prompt rule), the two clip
 * windows overlap almost entirely and the pipeline writes two plays for the
 * same possession — one from the attacker's POV, one from the defender's.
 * This is a code-level safety net for that failure mode.
 *
 * Rule: if two plays' time windows overlap by more than 50% of the shorter
 * window, they are the same event. Keep the one with the richer label+note
 * (more characters = analyst had more to say = better data). Drop the other.
 */
function dedupOverlappingPlays(plays: AnalysisResult['plays']): AnalysisResult['plays'] {
  if (plays.length < 2) return plays;

  // Sort by startTime so the inner loop can early-exit once a later play
  // starts past the current play's end.
  const sorted = [...plays].sort(
    (a, b) => timeToSeconds(a.startTime) - timeToSeconds(b.startTime),
  );

  const dropped = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (dropped.has(i)) continue;
    const aStart = timeToSeconds(sorted[i].startTime);
    const aEnd = timeToSeconds(sorted[i].endTime);
    const aDur = Math.max(1, aEnd - aStart); // floor at 1s to avoid /0

    for (let j = i + 1; j < sorted.length; j++) {
      if (dropped.has(j)) continue;
      const bStart = timeToSeconds(sorted[j].startTime);
      const bEnd = timeToSeconds(sorted[j].endTime);
      const bDur = Math.max(1, bEnd - bStart);

      // Sorted by startTime → no overlap possible once bStart ≥ aEnd.
      if (bStart >= aEnd) break;

      const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
      const overlapRatio = overlap / Math.min(aDur, bDur);

      if (overlapRatio > 0.5) {
        // Richer description wins. Tie → keep the earlier play (i) because
        // the attacker's-POV entry usually comes first and reads more naturally.
        const aRich = (sorted[i].label || '').length + (sorted[i].note || '').length;
        const bRich = (sorted[j].label || '').length + (sorted[j].note || '').length;
        const dropIdx = aRich >= bRich ? j : i;
        const keepIdx = aRich >= bRich ? i : j;

        console.log(
          `🔀 Dedup: ${Math.round(overlapRatio * 100)}% overlap between ` +
            `[${sorted[i].startTime}-${sorted[i].endTime}] "${sorted[i].label}" and ` +
            `[${sorted[j].startTime}-${sorted[j].endTime}] "${sorted[j].label}" — ` +
            `kept "${sorted[keepIdx].label}", dropped "${sorted[dropIdx].label}"`,
        );
        dropped.add(dropIdx);
        if (dropIdx === i) break; // current i is gone, advance outer loop
      }
    }
  }

  return sorted.filter((_, idx) => !dropped.has(idx));
}

/**
 * Extract a single frame from a local video at a given offset (seconds).
 * Used by jersey color detection — one cheap frame per video, not per clip.
 * Returns the tmp jpg path on success, or null on any ffmpeg failure.
 */
function extractSingleFrame(videoPath: string, atSeconds = 8): string | null {
  try {
    const tmpFrame = path.join(os.tmpdir(), `ballbot-jersey-${Date.now()}.jpg`);
    execFileSync(FFMPEG, [
      '-ss', String(atSeconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '2',
      tmpFrame,
      '-y',
    ], { stdio: 'pipe', timeout: 15000 });
    return fs.existsSync(tmpFrame) ? tmpFrame : null;
  } catch {
    return null;
  }
}

/**
 * Ask Claude Haiku to identify each team's primary jersey color from one frame.
 * Returns null on any failure (missing frame, API error, unparseable JSON,
 * or "unclear" verdict from the model). Callers continue without color
 * context when null is returned — this is a best-effort enrichment, not
 * a blocker for the analysis pipeline.
 */
async function findJerseyColors(
  framePath: string,
  teamName?: string,
  opponentName?: string,
): Promise<{ teamA: { name?: string; color: string }; teamB: { name?: string; color: string } } | null> {
  try {
    if (!fs.existsSync(framePath)) return null;
    const frameData = fs.readFileSync(framePath).toString('base64');
    const client = getClient();
    const home = teamName || 'home team';
    const away = opponentName || 'opponent';
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: frameData },
          },
          {
            type: 'text' as const,
            text: `Two teams are playing: ${home} and ${away}. Look at the players on court and identify the PRIMARY jersey color of each team. Return color names in Hebrew (e.g. כחול, לבן, אדום, שחור, צהוב, ירוק). Return JSON only with no other text: {"teamA":{"name":"${home}","color":"<hebrew color>"},"teamB":{"name":"${away}","color":"<hebrew color>"}}. If jersey colors are not clearly visible, return {"error":"unclear"}.`,
          },
        ],
      }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.error) return null;
    if (parsed.teamA?.color && parsed.teamB?.color) {
      return {
        teamA: { name: parsed.teamA.name, color: parsed.teamA.color },
        teamB: { name: parsed.teamB.name, color: parsed.teamB.color },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Shared pipeline: Gemini video → Claude enrichment → insights */
async function runVideoPipeline(videoPath: string, context: string, focus: string, teamName: string, roster: string, geminiFileUri?: string, jerseyColor?: string, opponentJerseyColor?: string, onProgress?: ProgressCb): Promise<AnalysisResult> {
  // Determine fileUri — upload if needed
  let fileUri = geminiFileUri || '';
  const mimeType = 'video/mp4';

  if (!fileUri && videoPath) {
    onProgress?.(10, 'מעלה וידאו ל-Gemini...');
    const uploaded = await uploadVideoToGemini(videoPath);
    fileUri = uploaded.fileUri;
  }

  if (!fileUri) {
    throw new Error('No video file URI available for analysis');
  }

  // Jersey color auto-detect via Claude Haiku. Fills in blanks only — if the
  // user typed the colors in the form we trust them. Requires a local video
  // file (skipped on the direct-to-Gemini upload path, which is fine: the
  // clip prompt falls back to "unknown" as it always did).
  if (videoPath && (!jerseyColor || !opponentJerseyColor)) {
    onProgress?.(15, 'מזהה צבעי קבוצות...');
    const framePath = extractSingleFrame(videoPath, 8);
    const detected = framePath ? await findJerseyColors(framePath, teamName, undefined) : null;
    if (framePath) { try { fs.unlinkSync(framePath); } catch {} }
    if (detected) {
      if (!jerseyColor && detected.teamA.color) jerseyColor = detected.teamA.color;
      if (!opponentJerseyColor && detected.teamB.color) opponentJerseyColor = detected.teamB.color;
      console.log(`🎨 Jersey colors: detected by AI — teamA=${jerseyColor || '?'}, teamB=${opponentJerseyColor || '?'}`);
    } else {
      console.log('⚠️ Jersey detection failed, continuing without team colors');
    }
  } else if (videoPath) {
    console.log(`🎨 Jersey colors: using user-provided values (${jerseyColor} / ${opponentJerseyColor})`);
  } else {
    console.log('⚠️ Jersey detection skipped: no local videoPath (Gemini-direct-upload path)');
  }

  // Pass 1: detect timestamps
  console.log('🔍 [1/4] Detecting play timestamps...');
  onProgress?.(20, 'מזהה רגעי משחק...');
  const timestamps = await detectPlayTimestamps(fileUri, mimeType, jerseyColor || '', opponentJerseyColor || '');
  console.log(`⏱️ Found ${timestamps.length} timestamps`);
  onProgress?.(30, `נמצאו ${timestamps.length} מהלכים`);

  // Pass 2: analyze each clip
  console.log('🎬 [2/4] Analyzing individual clips...');
  const geminiPlays: GeminiPlay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    console.log(`   Clip ${i + 1}/${timestamps.length} at ${ts}`);
    const clipPct = timestamps.length > 0 ? 30 + Math.round(((i + 1) / timestamps.length) * 60) : 90;
    onProgress?.(clipPct, `מנתח קליפ ${i + 1} מתוך ${timestamps.length}`);
    const play = await analyzeClipAtTimestamp(fileUri, mimeType, ts, jerseyColor || '', opponentJerseyColor || '', teamName, roster, context);
    if (play) geminiPlays.push(play);
    if (i < timestamps.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`✅ Got ${geminiPlays.length} plays from clips`);

  // Step 3: Claude enriches with Hebrew coaching analysis
  console.log('🤖 [3/4] Claude enrichment...');
  onProgress?.(92, 'Claude מעבד הערות אימון...');
  const rawEnriched = await enrichPlaysWithClaude(geminiPlays, roster, teamName, focus);

  // Safety net: Gemini sometimes emits two timestamps for the same possession.
  const enrichedPlays = dedupOverlappingPlays(rawEnriched);
  if (enrichedPlays.length < rawEnriched.length) {
    console.log(`🧹 Dedup removed ${rawEnriched.length - enrichedPlays.length} overlapping plays`);
  }

  // Step 4: Claude generates coaching insights
  onProgress?.(97, 'מייצר תובנות...');
  const insights = await generateInsightsFromPlays(enrichedPlays, context);

  return {
    game: context || 'ניתוח משחק',
    plays: enrichedPlays,
    insights,
    shotChart: (() => {
      const chart = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
      const offensivePlays = enrichedPlays.filter((p: any) => p.type === 'offense');
      const total = offensivePlays.length || 1;
      offensivePlays.forEach((p: any) => {
        const loc = p.finish_location || '';
        const pt = p.playType || '';
        if (loc === 'paint') chart.paint++;
        else if (loc === 'corner_3_left' || loc === 'corner_3_right') chart.corner3++;
        else if (loc === 'above_break_3') chart.aboveBreak3++;
        else if (loc === 'midrange_left' || loc === 'midrange_right' || loc === 'free_throw_line') chart.midRange++;
        if (pt === 'pullUp3' || pt === 'isolation_fadeaway') chart.pullUp++;
      });
      chart.paint = Math.round((chart.paint / total) * 100);
      chart.midRange = Math.round((chart.midRange / total) * 100);
      chart.corner3 = Math.round((chart.corner3 / total) * 100);
      chart.aboveBreak3 = Math.round((chart.aboveBreak3 / total) * 100);
      chart.pullUp = Math.round((chart.pullUp / total) * 100);
      return chart;
    })(),
  };
}

// ============================================================
// PUBLIC API
// ============================================================

/** Analyze YouTube — download → Gemini → Claude */
export async function analyzeYouTube(url: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = '', onProgress?: ProgressCb): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  onProgress?.(2, 'מוריד וידאו מ-YouTube...');
  const videoPath = downloadYouTube(url);

  try {
    const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor, onProgress);
    console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
    return result;
  } finally {
    console.log('\n🧹 Cleaning up temp files...');
    try { fs.unlinkSync(videoPath); } catch {}
    console.log('   ✅ Cleanup done');
  }
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = '', onProgress?: ProgressCb): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');

  const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor, onProgress);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, _teamName = '', _roster = ''): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([{ path: imagePath, seconds: 0, timestamp: '0:00' }], context, focus);
}

/** Analyze a video already uploaded to Gemini Files API */
export async function analyzeGeminiFile(geminiFileUri: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = '', onProgress?: ProgressCb): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GEMINI FILE ANALYSIS PIPELINE ==========');
  console.log(`   File URI: ${geminiFileUri}`);

  const result = await runVideoPipeline('', context, focus, teamName, roster, geminiFileUri, jerseyColor, opponentJerseyColor, onProgress);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}
