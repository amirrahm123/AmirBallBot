import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TeamKnowledge, Job } from './database';
import {
  BRAIN_VOCABULARY,
  BRAIN_OFFENSIVE_PRINCIPLES,
  BRAIN_DEFENSIVE_PRINCIPLES,
  BRAIN_OBSERVATION_FOCUS,
  BRAIN_INSIGHT_FRAMEWORK,
  BRAIN_HIGH_ATTENTION_PLAYS,
} from './knowledge/basketballBrain';

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
async function loadRecentCorrections(teamName: string): Promise<string> {
  const CORRECTIONS_INJECTION_ENABLED = process.env.CORRECTIONS_INJECTION_ENABLED !== 'false';
  if (!CORRECTIONS_INJECTION_ENABLED) {
    console.log('🚫 Corrections injection: DISABLED via env');
    return '';
  }
  console.log('📚 Corrections injection: ENABLED');
  const trimmedTeam = (teamName || '').trim();
  if (!trimmedTeam) {
    console.log('🆕 No team name set — skipping past corrections injection');
    return '';
  }
  try {
    const recentJobs = await Job.find(
      { 'corrections.0': { $exists: true }, 'input.teamName': trimmedTeam },
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
    console.log(`📚 Injecting ${last20.length} past corrections from ${recentJobs.length} recent "${trimmedTeam}" games into prompt`);
    return `\n\nCOACH CORRECTIONS — real examples from this team's games. Study these carefully and apply the same patterns:\n${last20.join('\n')}\n\nWhen you see a similar situation, use these corrections to identify the play correctly.`;
  } catch (err) {
    console.warn('⚠️ Could not load corrections:', err);
    return '';
  }
}

function formatKnowledgeContext(knowledge: any): string {
  const parts: string[] = [];
  if (knowledge.philosophy) parts.push(`Philosophy: ${knowledge.philosophy}`);
  if (knowledge.offenseSystem) parts.push(`Offense system: ${knowledge.offenseSystem}`);
  if (knowledge.defenseSystem) parts.push(`Defense system: ${knowledge.defenseSystem}`);
  if (knowledge.documents?.length) {
    const docText = knowledge.documents.map((d: any) => d.content).join('\n').substring(0, 1000);
    if (docText) parts.push(docText);
  }
  if (parts.length === 0) return '';
  return `\nCoaching context:\n${parts.join('\n')}\n`;
}

async function getKnowledgeContext(teamName: string): Promise<string> {
  try {
    const trimmedTeam = (teamName || '').trim();
    if (!trimmedTeam) {
      console.log('🧠 Knowledge context: no team name, using default');
      const knowledge = await TeamKnowledge.findOne({ teamId: 'default' });
      return knowledge ? formatKnowledgeContext(knowledge) : '';
    }
    // Try team-scoped first
    let knowledge = await TeamKnowledge.findOne({ teamId: trimmedTeam });
    if (knowledge) {
      console.log(`🧠 Knowledge context: loaded for "${trimmedTeam}"`);
      return formatKnowledgeContext(knowledge);
    }
    // Fallback to default
    knowledge = await TeamKnowledge.findOne({ teamId: 'default' });
    if (knowledge) {
      console.log(`🧠 Knowledge context: no "${trimmedTeam}" knowledge, falling back to default`);
      return formatKnowledgeContext(knowledge);
    }
    console.log('🧠 Knowledge context: none available');
    return '';
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

// Gemini model identifier. Default keeps current behavior; override via env to A/B test.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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
  plays: { startTime: string; endTime: string; time?: string; type: string; label: string; note: string; players: string[]; observations?: string[] }[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
  videoUrl?: string;
  coachNotes?: { _id?: string; timestamp: number; text: string; createdAt: string }[];
}

// Persistent storage for analyzed videos so the editor can stream them.
// Override with VIDEOS_DIR env var if the deploy uses a mounted volume.
export const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join('/app', 'videos');

export function ensureVideosDir(): void {
  try {
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      console.log(`📁 Created videos dir: ${VIDEOS_DIR}`);
    }
  } catch (err) {
    console.warn(`⚠️ Could not create videos dir at ${VIDEOS_DIR}:`, err);
  }
}

/** Delete videos in VIDEOS_DIR older than 7 days. Safe to call at startup. */
export function cleanupOldVideos(): void {
  if (!fs.existsSync(VIDEOS_DIR)) return;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;
  try {
    for (const f of fs.readdirSync(VIDEOS_DIR)) {
      const filePath = path.join(VIDEOS_DIR, f);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > SEVEN_DAYS) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Deleted old video: ${f}`);
          deleted++;
        }
      } catch (e) {
        console.warn(`⚠️ cleanupOldVideos: failed on ${f}:`, e);
      }
    }
  } catch (err) {
    console.warn('⚠️ cleanupOldVideos failed:', err);
  }
  if (deleted > 0) console.log(`🧹 Cleaned up ${deleted} old video(s)`);
}

function persistVideoFile(srcPath: string, persistPath: string): void {
  try {
    const dir = path.dirname(persistPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(srcPath, persistPath);
    const sz = fs.statSync(persistPath).size;
    console.log(`💾 Persisted video → ${persistPath} (${(sz / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    console.warn(`⚠️ Failed to persist video to ${persistPath}:`, err);
  }
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
  // --js-runtimes node: YouTube now requires a JS runtime to decode stream
  // signatures. Railway's container has Node available; deno is not installed.
  const args = [
    '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '--no-part',
    '--buffer-size', '16K',
    '--js-runtimes', 'node',
    '-o', outPath,
    cleanUrl,
  ];
  console.log(`   CMD: yt-dlp ${args.join(' ')}`);

  const result = spawnSync('yt-dlp', args, {
    stdio: ['ignore', 'inherit', 'pipe'],
    timeout: 300000,
    encoding: 'utf8',
  });

  const stderrStr = result.stderr ? String(result.stderr) : '';
  const stderrTail = stderrStr.slice(-500);
  if (stderrTail) console.error(`   yt-dlp stderr tail:\n${stderrTail}`);

  if (result.error) {
    throw new Error(`yt-dlp failed to spawn: ${result.error.message}\n--- stderr tail ---\n${stderrTail}`);
  }
  if (result.status !== 0) {
    throw new Error(`yt-dlp exited with status ${result.status}\n--- stderr tail ---\n${stderrTail}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`yt-dlp exit 0 but output file missing at ${outPath}\n--- stderr tail ---\n${stderrTail}`);
  }
  const stat = fs.statSync(outPath);
  if (stat.size === 0) {
    throw new Error(`yt-dlp exit 0 but output file is empty at ${outPath}\n--- stderr tail ---\n${stderrTail}`);
  }

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

/**
 * Strip one or more `--- Section Header ---` blocks from a Brain string at prompt-build time.
 * A section runs from its `--- Header ---` line up to the next `--- Header ---` or end-of-string.
 * Returns the stripped string plus the list of section headers that were actually found and removed.
 * Does NOT mutate the input.
 */
function stripBrainSections(
  brain: string,
  sectionHeaders: string[]
): { stripped: string; removed: string[] } {
  const allSectionRegex = /^--- [^\n]+ ---/gm;
  const allStarts: Array<{ header: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = allSectionRegex.exec(brain)) !== null) {
    allStarts.push({ header: m[0], start: m.index });
  }
  const removed: string[] = [];
  const ranges: Array<[number, number]> = [];
  for (const target of sectionHeaders) {
    const idx = allStarts.findIndex((s) => s.header === target);
    if (idx === -1) continue;
    const start = allStarts[idx].start;
    const end = idx + 1 < allStarts.length ? allStarts[idx + 1].start : brain.length;
    ranges.push([start, end]);
    removed.push(target);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let result = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    result += brain.slice(cursor, s);
    cursor = e;
  }
  result += brain.slice(cursor);
  return { stripped: result, removed };
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
  off_ball_action?: string; // optional, orthogonal to finish/shot_mechanic/playType — describes the off-ball cut or screen that freed the receiver (back_cut, pin_down, curl, fade_action, etc.); omit unless a cut or off-ball screen clearly created the scoring opportunity
  finish_location?: string;
  perspective?: string;
  // Per-field confidence from the CONFIDENCE PROTOCOL. Low → corresponding field coerced to an "unclear" value by Gemini.
  playType_confidence?: 'high' | 'medium' | 'low';
  perspective_confidence?: 'high' | 'medium' | 'low';
  players_confidence?: 'high' | 'medium' | 'low';
  shot_mechanic_confidence?: 'high' | 'medium' | 'low';
  // One Hebrew sentence describing literally what was visible in the frames, before interpretation. Grounding anchor.
  what_i_actually_saw?: string;
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
  opponentJerseyColor: string,
  teamName: string,
): Promise<string[]> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const prompt = `You are watching a basketball game video.
Your ONLY job is to find timestamps where important plays happened.

Important plays are ALL of these, equally important:
- Any basket made (by either team)
- Any shot attempt that MISSED, was blocked, or was contested into a bad shot
- Any turnover by either team (sloppy passes, travels, offensive fouls, palming, kicked balls — not just "clean" steals)
- Any defensive stop or block
- Any fast break or transition push, regardless of how it ended (made, missed, turned over)
- Any offensive rebound that led to another possession

CRITICAL: Misses and turnovers are AS IMPORTANT AS made baskets. Coaches study failures more than successes. Do not skew your selection toward highlight moments.

INCLUSION PHILOSOPHY: When in doubt, INCLUDE. A false-positive timestamp is harmless (the per-clip analyzer will inspect it). A false-negative loses a play permanently. Bias toward over-inclusion.

${BRAIN_HIGH_ATTENTION_PLAYS}

Use this priority framework when triaging timestamps. Priority 1 plays (possession-critical failures) should NEVER be missed. If the 25-timestamp limit is approaching, drop low-attention made baskets in flow before dropping any Priority 1 play.

Return ONLY a valid JSON array of timestamp strings in MM:SS format.
Example: ["02:34", "04:11", "07:22", "13:05"]

Rules:
- Return the array only. No text before or after. No markdown.
- Maximum 25 timestamps.
- If two events are within 15 seconds of each other, keep only one.
- The analyzing team wears ${jerseyColor}. Opponent wears ${opponentJerseyColor}.
- IMPORTANT: Only include timestamps where the shot clock is visible on screen. If the shot clock is not visible (celebration, timeout, close-up) — skip that moment.

FOCUS TEAM RELEVANCE:
Focus team name: ${teamName || 'the analyzing team'}
Focus team jersey color: ${jerseyColor || 'unknown'}

Only emit a timestamp when the focus team is a MEANINGFUL actor in the play:
  INCLUDE if the focus team:
    • scores OR misses a shot OR has a shot blocked
    • is scored on by the opponent (this IS a defensive moment, ALWAYS include)
    • forces a turnover (steal, block, charge, contested stop, deflection)
    • commits a turnover (bad pass, travel, offensive foul, palming, kicked ball, shot clock violation)
    • gets an offensive or defensive rebound that meaningfully changes possession dynamics
    • is involved in a fast break either way (running it or defending it)

The opponent-scoring case especially: when the opponent scores, it ALWAYS counts as a focus-team defensive moment. Do not require a "visible defender error" to include it.

  SKIP only if:
    • Administrative moments (timeouts, opponent free-throw routines, dead ball periods)
    • Pre-game or post-game footage with no actual play

DO NOT skip opponent scoring just because you cannot identify a specific focus-team defender error. The focus team was on defense - that IS a defensive moment worth analyzing. Opponent baskets ARE important plays from the focus team's perspective.

If the focus team is even partially involved (helping on defense, recovering, contesting), INCLUDE the play.
When unsure whether the focus team is involved, INCLUDE the play. A false include is easier to fix via coach corrections than a missed play.

REPLAY DETECTION — skip the timestamp ONLY IF you see one or more of these explicit visual clues:
  • Slow-motion playback (frame rate visibly reduced, motion is unnaturally smooth)
  • Game clock is frozen or not advancing during the moment
  • "REPLAY" text overlay anywhere on the broadcast
  • Unusual broadcast angle (skycam, baseline close-up, player-follow camera) combined with slow-motion

DO NOT skip a timestamp just because the play "looks similar" to a previous one — only skip with the explicit clues above.
When uncertain, INCLUDE the timestamp. Missing a real play is worse than emitting one extra timestamp that turns out to be a replay (the per-clip analyzer has its own replay check downstream).`;

  try {
    const rawResponse = await retryWithBackoff(async () => {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
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

  // 🎯 Shot mechanic disambiguation guide. Default ENABLED.
  // Set SHOT_MECHANIC_GUIDE_ENABLED=false in Railway env for instant rollback.
  const SHOT_MECHANIC_GUIDE_ENABLED = process.env.SHOT_MECHANIC_GUIDE_ENABLED !== 'false';
  console.log(`🎯 Shot mechanic guide: ${SHOT_MECHANIC_GUIDE_ENABLED ? 'ENABLED' : 'DISABLED'}`);

  const shotMechanicGuide = SHOT_MECHANIC_GUIDE_ENABLED ? `
═══ SHOT MECHANIC GUIDE ═══

When the play involves a shot, distinguish these mechanics carefully. Each has distinct visual signatures:

DUNK MECHANICS:
- two_hand_dunk: BOTH hands grip the ball at the rim. Watch for both arms extending up together.
- one_hand_dunk: Only the dominant hand finishes at the rim. The off-hand is below the rim or off the ball. Common in transition.
- alley_oop_dunk: Player catches a pass in mid-air and dunks. The catch and dunk happen as one motion without dribbling.

LAYUP / NEAR-RIM SHOTS (key distinctions):
- layup: Standard near-rim finish off the backboard or rim. Player drives in and releases close to the rim with one hand.
- floater: Soft, high-arcing shot released from 5-10 feet out, OVER a defender. The ball goes UP first, then drops. Player jumps and releases while still rising.
- gumper / runner: A jump shot taken on the move from mid-range (10-15 feet), often after a drive. Different from a floater - lower arc, more of a quick pull-up jumper while still moving forward. Some players (Shai, KD) use this often.
- scoop_layup: Underhanded finish, ball cradled below the player's chest level on release. Used to avoid blocks at the rim.

JUMP SHOT MECHANICS:
- catch_and_shoot: Player receives the ball already squared up to the rim, no dribbles before the shot.
- pull_up_jumper: Player dribbles, gathers, and pulls up for a jumper. There IS a dribble before the shot.
- step_back_jumper: Player creates space by stepping AWAY from the defender before shooting. Visible backward motion before the shot.
- fadeaway: Player leans BACKWARD during the release. Body angles away from the rim.

DECISION RULE: If you cannot clearly see the player's body motion and release in the frames provided, mark shot_mechanic_confidence=low. Do NOT default to "layup" or "jumper" when the mechanic is unclear - those are specific mechanics, not catch-all categories.

═══ END SHOT MECHANIC GUIDE ═══
` : '';

  return `You are watching an 18-second clip from a basketball game.
This clip was extracted around timestamp ${timestampStr} in the full game.
There is ONE play in this clip. Identify and describe ONLY that play.
Return a JSON array with exactly ONE play object.

═══ CONFIDENCE PROTOCOL ═══

For every clip you analyze, you MUST first answer this question internally:
"What did I literally see in the frames, separate from what I expect to see in basketball?"

Then for each field below, assign a confidence level using these EXACT criteria:

PERSPECTIVE confidence:
- HIGH: I clearly saw the ball-handler's full jersey color match either ${jerseyColor || 'analyzing team color'} or ${opponentJerseyColor || 'opponent color'} in at least 2 frames
- MEDIUM: I saw a partial jersey or the color was somewhat visible but not perfectly clear
- LOW: I could not clearly see the jersey color due to motion blur, distance, lighting, or partial view

If perspective_confidence is LOW, set perspective="unclear".

PLAY TYPE confidence:
- HIGH: I clearly saw the ENTIRE play from setup through finish (e.g., I saw the screen, the drive, the kick-out, AND the shot)
- MEDIUM: I saw the finish clearly but missed the setup, OR vice versa
- LOW: I saw only fragments, cannot identify the specific mechanic

If playType_confidence is LOW, set playType="unclear_action". If MEDIUM and you only saw the finish, set playType="unclear_finish_only".

PLAYERS confidence:
- HIGH: I clearly read the jersey number(s) in at least one frame
- MEDIUM: I think I saw a number but it was partially visible or could be confused with another
- LOW: I could not read any jersey number clearly

If players_confidence is LOW, set players=[].

SHOT MECHANIC confidence (for shooting plays):
- HIGH: I clearly saw the player's shooting motion (jump shot vs floater vs layup vs dunk vs fadeaway)
- MEDIUM: I saw a release but couldn't tell the exact mechanic
- LOW: I didn't see the shooting motion at all

═══ EXAMPLES OF CORRECT UNCERTAINTY ═══

GOOD example 1 — partial view:
{
  "playType": "unclear_finish_only",
  "playType_confidence": "medium",
  "perspective": "offense",
  "perspective_confidence": "high",
  "what_i_actually_saw": "שחקן בחולצה כחולה מקבל את הכדור בקרבת הסל ומבצע סיום, אבל לא ראיתי איך הגיע לשם"
}

GOOD example 2 — color unclear:
{
  "playType": "isolation_drive",
  "playType_confidence": "high",
  "perspective": "unclear",
  "perspective_confidence": "low",
  "what_i_actually_saw": "שחקן עם הכדור חודר לסל וקולע, אבל החולצה שלו כהה ולא הצלחתי להבחין אם כחול או שחור-צהוב"
}

BAD example — overconfident inference:
{
  "playType": "post_up_finish",
  "playType_confidence": "high",
  "what_i_actually_saw": "שחקן ליד הסל קולע"
}
This is BAD because the player being near the rim doesn't prove it was a post-up. Without seeing the back-down, this should be unclear_finish_only.

═══ REMEMBER ═══

Marking confidence as HIGH when you didn't actually see clearly is the WORST possible answer. It creates errors that look correct.
Marking confidence as LOW when uncertain is the BEST possible answer. It creates honest data.
The downstream system handles low-confidence and unclear values gracefully. Confident wrong answers cause cascading errors.
${shotMechanicGuide}
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

OFF-BALL ACTION IDENTIFICATION — emit one of these values in the off_ball_action field when a CUT or off-ball SCREEN clearly created the scoring opportunity (i.e. the receiver got free because of the action, not because of a pick-and-roll, isolation, post-up, or transition). This field is INDEPENDENT of playType, finish, and shot_mechanic — it describes HOW THE RECEIVER GOT FREE before the shot, not the shot itself.
- back_cut: cutter moves behind an overplaying defender toward the basket to receive
- face_cut: cutter moves in front of defender (between defender and ball) toward basket
- flex_cut: baseline cut from corner to opposite block around a screen
- ucla_cut: passer cuts around a high-post screen toward the basket after passing to the elbow
- v_cut: receiver jabs one direction then changes direction sharply to receive
- l_cut: receiver moves vertically along the lane then cuts sharply outward to perimeter
- pin_down: down-screen set high while receiver rises from low to perimeter through the screen
- flare_screen: screen set behind the receiver's defender, receiver fades sideways-and-out to perimeter
- curl: receiver runs tightly around a screen and continues into the paint toward the rim
- fade_action: receiver detaches sideways away from a screen to open perimeter space (DISTINCT from fadeaway shot — fade_action describes movement BEFORE the shot, fadeaway describes the shot motion itself; the same player can do both in sequence: fade_action → fadeaway)
- zipper: receiver cuts straight up the lane from baseline through a high screen toward the top

OMIT off_ball_action entirely unless the cut or off-ball screen CLEARLY created the scoring opportunity. Skip for plain pick-and-roll, isolation, post-up, transition, or putbacks. When unclear, omit.

Fade disambiguation: fade_action (off-ball movement before the shot) vs fadeaway (shot mechanic — body leaning back at release). These are different fields and can co-occur. fade_action goes in off_ball_action; fadeaway goes in shot_mechanic.

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

RULE — REPLAY (BROADCAST REPLAY DETECTION):
If this 18-second clip is a broadcast replay rather than live game action, return EXACTLY this JSON instead of a normal play object:
[{"skip": true, "reason": "replay"}]

Trigger replay-skip ONLY when explicit clues are present:
  • Slow-motion playback throughout the clip
  • Game clock frozen or not advancing
  • "REPLAY" text overlay visible
  • Unusual broadcast angle (skycam / baseline close-up / player-follow) WITH slow-motion

DO NOT skip based on "looks similar to previous clip" alone.
DO NOT skip based on a single slow-motion frame at the end of an otherwise live clip.
When uncertain, return the normal play object. Missing a real play is worse than including a replay.

RULE 6 — SETUP AND ACTION FIELDS:
setup = 1-2 sentences. For chain plays (pick and roll → defensive collapse → open cutter), describe ALL phases: what the first action was, how the defense reacted, what space was created. Jersey numbers only. No names.
action = ONE sentence only. The decisive moment.
description = ONE sentence in English. Full sequence from origin to finish. Jersey numbers only. No names.

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON array with exactly ONE play, no markdown:

[{
  "startTime": "${timestampStr}",
  "endTime": "...",
  "playType": "pick_and_roll_finish | pick_and_roll_kickout_3 | pick_and_pop | dribble_handoff | isolation_drive | isolation_fadeaway | post_up_finish | post_up_pass_out | high_low | drive_and_kick | backdoor_cut | skip_pass_corner_3 | elevator_screen | inbound_play | alley_oop_set | transition_steal_dunk | transition_leak_out | fast_break_2on1 | fast_break_3on2 | secondary_break | coast_to_coast | offensive_rebound_putback | offensive_rebound_tip_in | defensive_stop | defensive_block | charge_taken | shot_clock_violation | foul_drawn | unclear_finish_only | unclear_action",
  // "playType_confidence" — per CONFIDENCE PROTOCOL above. REQUIRED.
  "playType_confidence": "high | medium | low",
  "possession_origin": "live_ball | steal | deflection | defensive_rebound | offensive_rebound | inbound | after_timeout | after_foul | press_break | unknown",
  "setup": "1-2 sentences, jersey numbers only",
  "action": "one sentence, jersey numbers only",
  // "finish" describes the OUTCOME of the possession. Use ONE value. unknown_finish only if camera cut or occluded view.
  "finish": "made_2 | made_3 | missed_2 | missed_3 | and_one | block | steal | charge_taken | foul_drawn | out_of_bounds | shot_clock_violation | unknown_finish",
  // "shot_mechanic" describes the shooting MOTION (independent of made/missed). OMIT this field entirely if no shot was attempted.
  "shot_mechanic": "floater | scoop_layup | finger_roll | reverse_layup | euro_step | jump_hook | running_hook | up_and_under | tip_in | putback | putback_dunk | catch_and_shoot | pull_up | step_back | fadeaway | turnaround | pump_fake_shot | one_hand_dunk | two_hand_dunk | bank_shot | layup | jumper | dunk",
  // "shot_mechanic_confidence" — per CONFIDENCE PROTOCOL above. Include when shot_mechanic is present; OMIT when shot_mechanic is omitted.
  "shot_mechanic_confidence": "high | medium | low",
  // "off_ball_action" describes how the receiver got free — emit ONLY when a cut or off-ball screen created the scoring opportunity (skip for isolation, pick-and-roll, post-up, or transition). OMIT this field entirely when no off-ball action created the shot.
  "off_ball_action": "back_cut | face_cut | flex_cut | ucla_cut | v_cut | l_cut | pin_down | flare_screen | curl | fade_action | zipper",
  "finish_location": "paint | midrange_left | midrange_right | corner_3_left | corner_3_right | above_break_3 | free_throw_line",
  "players": ["#11", "#2"],
  // "players_confidence" — per CONFIDENCE PROTOCOL above. REQUIRED.
  "players_confidence": "high | medium | low",
  "type": "offense | defense | transition",
  "perspective": "offense | defense | defensive_failure | unclear",
  // "perspective_confidence" — per CONFIDENCE PROTOCOL above. REQUIRED.
  "perspective_confidence": "high | medium | low",
  // "what_i_actually_saw" — REQUIRED. ONE Hebrew sentence describing literally what is visible in the frames, BEFORE interpretation. This is your grounding check — if you cannot write this concretely, you are inferring rather than seeing.
  "what_i_actually_saw": "משפט אחד בעברית של מה שראית בפועל בפריימים",
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
        model: GEMINI_MODEL,
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
    const parsed: any[] = JSON.parse(jsonMatch[0]);
    const first = parsed[0];
    if (first?.skip === true) {
      console.log(`   ⏭️ Skipped clip at ${timestampStr} — ${first.reason || 'replay'} detected`);
      return null;
    }
    const play: GeminiPlay | null = first || null;
    if (play) {
      console.log(`   🏀 Clip ${timestampStr}: ${play.playType} → ${play.finish}`);

      // 🎽 Team ID — per-clip log (now includes per-field confidence + what_i_actually_saw)
      const perspective = play.perspective || 'missing';
      const playersArr = Array.isArray(play.players) && play.players.length > 0
        ? `[${play.players.join(',')}]`
        : 'empty';
      const perspConf = play.perspective_confidence || 'missing';
      const ptConf = play.playType_confidence || 'missing';
      const playersConf = play.players_confidence || 'missing';
      const sawRaw = typeof play.what_i_actually_saw === 'string' ? play.what_i_actually_saw : '';
      const sawTrunc = sawRaw.length > 100 ? sawRaw.slice(0, 97) + '...' : sawRaw;
      console.log(`🎽 Team ID: clip ${timestampStr} → Gemini perspective=${perspective} (confidence=${perspConf}) playType=${play.playType || '—'} (confidence=${ptConf}) players=${playersArr} (confidence=${playersConf}) saw="${sawTrunc}"`);

      // ⚠️ Ambiguity — fires on any attribution signal that couldn't resolve cleanly
      const ambiguityReasons: string[] = [];
      if (!jerseyColor || !opponentJerseyColor) ambiguityReasons.push('jersey_context_missing');
      if (!play.perspective) ambiguityReasons.push('perspective_missing');
      if (!Array.isArray(play.players) || play.players.length === 0) {
        ambiguityReasons.push('players_empty');
      } else {
        const rosterJerseys = new Set((roster.match(/#\d+/g) || []).map((s) => s));
        if (rosterJerseys.size > 0) {
          for (const p of play.players) {
            const tag = typeof p === 'string' ? p.trim() : '';
            if (tag && !rosterJerseys.has(tag)) {
              ambiguityReasons.push(`players_not_in_roster:${tag}`);
            }
          }
        }
      }
      if (ambiguityReasons.length > 0) {
        console.log(`⚠️ Team ID ambiguous: clip ${timestampStr} → reason=${ambiguityReasons.join('|')}`);
      }
    }
    return play;
  } catch (err) {
    console.error(`   ❌ Clip ${timestampStr} failed:`, err);
    return null;
  }
}

/**
 * STEP 2.5 (post-enrichment): Focused Haiku refinement of shot mechanic only.
 * Runs after enrichment + dedup, before insights. For each enriched play whose
 * underlying Gemini play represents a shot attempt, ask Haiku ONLY "what was
 * the shot mechanic?" using the play's `what_i_actually_saw` description as
 * grounding. Override Gemini's mechanic only if Haiku is high-confidence AND
 * disagrees. When overriding, swap the Hebrew phrase in the existing label.
 *
 * Strict scope: shot mechanic only. No other fields touched. Toggle via
 * SHOT_MECHANIC_REFINE_ENABLED env var (default true) for instant rollback.
 */
async function refineShotMechanicsWithHaiku(
  geminiPlays: GeminiPlay[],
  enrichedPlays: AnalysisResult['plays']
): Promise<AnalysisResult['plays']> {
  const SHOT_MECHANIC_REFINE_ENABLED = process.env.SHOT_MECHANIC_REFINE_ENABLED !== 'false';
  console.log(`🔬 Shot mechanic refinement: ${SHOT_MECHANIC_REFINE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  if (!SHOT_MECHANIC_REFINE_ENABLED) return enrichedPlays;

  // Mirrors the Hebrew translation map in enrichPlaysWithClaude. Used to
  // substitute the OLD mechanic's Hebrew phrase with the NEW one in the label.
  // Includes Haiku-only choice values (gumper, pull_up_jumper, step_back_jumper,
  // alley_oop_dunk) mapped to existing Hebrew where one exists.
  const MECHANIC_HEBREW: Record<string, string> = {
    floater: 'פלוטר',
    scoop_layup: 'לייאפ סקופ',
    finger_roll: 'פינגר רול',
    reverse_layup: 'לייאפ הפוך',
    euro_step: 'אירו סטפ',
    jump_hook: 'הוק בקפיצה',
    running_hook: 'הוק בריצה',
    up_and_under: 'אפ-אנד-אנדר',
    tip_in: 'טיפ-אין',
    putback: 'פוטבק',
    putback_dunk: 'פוטבק דאנק',
    catch_and_shoot: "קאץ' אנד שוט",
    pull_up: 'פול-אפ',
    pull_up_jumper: 'פול-אפ',
    step_back: 'סטפ-באק',
    step_back_jumper: 'סטפ-באק',
    fadeaway: 'פייד-אווי',
    turnaround: 'טרנ-אראונד',
    pump_fake_shot: 'הטעיית קליעה',
    one_hand_dunk: 'דאנק ביד אחת',
    two_hand_dunk: 'סלאם',
    alley_oop_dunk: 'אלי-אופ',
    bank_shot: 'זריקת לוח',
    layup: 'לייאפ',
    jumper: 'קפיצה',
    dunk: 'דאנק',
    gumper: 'גאמפר',
  };

  // Eligible finishes: anything that involved a shot attempt.
  const SHOT_FINISHES = new Set(['made_2', 'made_3', 'missed_2', 'missed_3', 'block', 'and_one']);

  const geminiByTs = new Map<string, GeminiPlay>(
    geminiPlays.map((p) => [p.startTime, p]),
  );

  const client = getClient();
  let totalShots = 0;
  let overridden = 0;
  let kept = 0;
  let haikuUnclear = 0;

  // Run refinements in parallel — each call is independent and small.
  const tasks = enrichedPlays.map(async (enriched, i) => {
    const gemini = geminiByTs.get(enriched.startTime);
    if (!gemini || !gemini.finish || !SHOT_FINISHES.has(gemini.finish)) return;
    if (!gemini.shot_mechanic) return;
    totalShots++;

    const description =
      (typeof gemini.what_i_actually_saw === 'string' && gemini.what_i_actually_saw) ||
      (typeof gemini.description === 'string' && gemini.description) ||
      '';

    let refined: { refined_mechanic: string; reason: string; confidence: 'high' | 'medium' | 'low' } | null = null;
    try {
      const haikuResp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Based on this description of a basketball play, what was the actual shot mechanic?

Description: ${description}
Gemini's initial answer: ${gemini.shot_mechanic}
Play type: ${gemini.playType || '(unknown)'}
Finish: ${gemini.finish}

Choose from this list: layup, scoop_layup, floater, gumper, pull_up_jumper, catch_and_shoot, step_back_jumper, fadeaway, one_hand_dunk, two_hand_dunk, alley_oop_dunk.

If the description does not contain enough detail to determine the mechanic with confidence, return "unclear".

Return ONLY a JSON object, no other text:
{"refined_mechanic": "<value>", "reason": "<one sentence>", "confidence": "high"|"medium"|"low"}`,
        }],
      });
      const text = haikuResp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const m = text.match(/\{[\s\S]*\}/);
      if (m) refined = JSON.parse(m[0]);
    } catch (err: any) {
      kept++;
      console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=ERROR confidence=missing → action=kept reason="haiku call failed: ${err?.message || err}"`);
      return;
    }

    if (!refined || typeof refined.refined_mechanic !== 'string') {
      kept++;
      console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=NO_JSON confidence=missing → action=kept reason="haiku returned no parseable JSON"`);
      return;
    }

    if (refined.refined_mechanic === 'unclear') {
      haikuUnclear++;
      console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=unclear confidence=${refined.confidence} → action=kept reason="${refined.reason}"`);
      return;
    }

    if (refined.refined_mechanic === gemini.shot_mechanic) {
      kept++;
      console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=${refined.refined_mechanic} confidence=${refined.confidence} → action=kept reason="${refined.reason}"`);
      return;
    }

    if (refined.confidence !== 'high') {
      kept++;
      console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=${refined.refined_mechanic} confidence=${refined.confidence} → action=kept reason="${refined.reason}"`);
      return;
    }

    // Override: confidence=high AND mechanic differs.
    const oldHe = MECHANIC_HEBREW[gemini.shot_mechanic] || '';
    const newHe = MECHANIC_HEBREW[refined.refined_mechanic] || refined.refined_mechanic;
    let labelStatus = 'overridden';
    if (oldHe && enriched.label && enriched.label.includes(oldHe) && oldHe !== newHe) {
      enrichedPlays[i] = { ...enriched, label: enriched.label.replace(oldHe, newHe) };
    } else if (oldHe === newHe) {
      labelStatus = 'overridden (label unchanged - same hebrew)';
    } else {
      labelStatus = 'overridden (label-phrase-not-found)';
    }
    overridden++;
    console.log(`🔬 Mechanic refine: clip ${enriched.startTime} → original=${gemini.shot_mechanic} haiku=${refined.refined_mechanic} confidence=${refined.confidence} → action=${labelStatus} reason="${refined.reason}"`);
  });

  await Promise.all(tasks);

  console.log(`🔬 Refinement summary: total_shots=${totalShots} overridden=${overridden} kept=${kept} haiku_unclear=${haikuUnclear}`);

  return enrichedPlays;
}

/** STEP 2: Enrich Gemini plays with Hebrew coaching analysis via Claude */
async function enrichPlaysWithClaude(
  geminiPlays: GeminiPlay[],
  roster: string,
  teamName: string,
  focus: string
): Promise<AnalysisResult['plays']> {
  console.log(`\n🤖 [2/3] Claude enrichment (${geminiPlays.length} plays)...`);

  // 🧪 A/B toggle for the Layer 1 IQ rubric directive. Default = enabled.
  // Set IQ_LAYER_1_ENABLED=false in Railway env to disable the injection.
  // When disabled, we ALSO strip the Brain's IQ sections at prompt-build time so
  // Arm B gets a clean "no-IQ" condition. The source BASKETBALL_BRAIN constant is
  // not mutated — the strip is local to this prompt assembly.
  const IQ_LAYER_1_ENABLED = process.env.IQ_LAYER_1_ENABLED !== 'false';
  console.log(`🧪 IQ Layer 1 injection: ${IQ_LAYER_1_ENABLED ? 'ENABLED' : 'DISABLED'}`);

  const IQ_BRAIN_SECTION_HEADERS = [
    '--- BASKETBALL IQ — LAYER 1: SHOT QUALITY PRINCIPLES ---',
    '--- IQ CONTEXTUAL ADJUSTMENTS ---',
  ];
  // Enrichment gets only the sections it needs: vocabulary + both sides' principles.
  // The IQ Layer 1 + IQ Contextual Adjustments sections live inside OFFENSIVE,
  // so the existing A/B strip-by-header logic still finds them.
  const enrichmentBrain = [BRAIN_VOCABULARY, BRAIN_OFFENSIVE_PRINCIPLES, BRAIN_DEFENSIVE_PRINCIPLES].join('\n');
  const { stripped: brainForPrompt, removed: strippedSections } = IQ_LAYER_1_ENABLED
    ? { stripped: enrichmentBrain, removed: [] as string[] }
    : stripBrainSections(enrichmentBrain, IQ_BRAIN_SECTION_HEADERS);
  console.log(`🧪 Brain sections stripped for A/B: ${strippedSections.join(', ') || 'none'}`);

  // 🎽 Team ID — batch tallies computed while we scan plays for IQ eligibility
  const perspectiveCounts: Record<string, number> = {
    offense: 0, transition: 0, defense: 0, defensive_failure: 0, missing: 0,
  };
  const rosterJerseySet = new Set((roster.match(/#\d+/g) || []).map((s) => s));
  let teamIdAmbiguousCount = 0;

  // 🎽 Confidence tallies — emitted separately as a confidence summary log
  const mkConfTally = () => ({ high: 0, medium: 0, low: 0, missing: 0 } as Record<string, number>);
  const confCounts = {
    perspective: mkConfTally(),
    playType: mkConfTally(),
    players: mkConfTally(),
  };

  // 🧠 IQ Layer 1 — pre-enrichment eligibility log (mirrors the skip rules in the prompt)
  const IQ_NON_SHOT_FINISHES = new Set([
    'steal', 'foul_drawn', 'charge_taken', 'out_of_bounds', 'shot_clock_violation', 'unknown_finish',
  ]);
  let iqEligibleCount = 0;
  for (const p of geminiPlays) {
    // Tally perspective bucket for the batch summary
    const persp = p.perspective || 'missing';
    if (persp in perspectiveCounts) perspectiveCounts[persp]++;
    else perspectiveCounts[persp] = 1;
    // Tally ambiguity (same predicate as in analyzeClipAtTimestamp)
    const playerList = Array.isArray(p.players) ? p.players : [];
    const hasRosterMiss = rosterJerseySet.size > 0 && playerList.some(
      (j) => typeof j === 'string' && j.trim() && !rosterJerseySet.has(j.trim()),
    );
    if (!p.perspective || playerList.length === 0 || hasRosterMiss) {
      teamIdAmbiguousCount++;
    }
    // Tally confidence buckets
    const bucket = (v: unknown) => (v === 'high' || v === 'medium' || v === 'low') ? v : 'missing';
    confCounts.perspective[bucket(p.perspective_confidence)]++;
    confCounts.playType[bucket(p.playType_confidence)]++;
    confCounts.players[bucket(p.players_confidence)]++;

    const playerTag = (p.players && p.players[0]) || '—';
    let reason: string;
    if (p.perspective === 'defensive_failure') {
      reason = 'defensive_failure';
    } else if (!p.finish || IQ_NON_SHOT_FINISHES.has(p.finish)) {
      reason = `non_shot_finish (${p.finish || 'missing'})`;
    } else {
      reason = 'eligible';
      iqEligibleCount++;
    }
    console.log(`🧠 IQ Layer 1 eligibility: ${p.startTime} ${playerTag} playType=${p.playType} finish=${p.finish || '—'} → ${reason}`);
  }

  const client = getClient();
  const knowledgeContext = await getKnowledgeContext(teamName);
  const correctionsBlock = await loadRecentCorrections(teamName);

  const iqLayer1Block = IQ_LAYER_1_ENABLED ? `
═══ SHOT QUALITY EVALUATION (IQ LAYER 1) ═══

After composing the label via the rules above, apply the "BASKETBALL IQ — LAYER 1: SHOT QUALITY PRINCIPLES" section from the Brain (below). This is a JUDGMENT overlay that appends a verdict marker (⚠️ or ❌) to the END of the already-composed label for problematic or bad shot selection. Good and neutral shots stay unmarked — there is no ✅ marker.

APPLICABILITY — IQ Layer 1 evaluates OFFENSIVE shot choice ONLY. Skip the 4-factor evaluation and do NOT apply any verdict marker when ANY of these are true:
- play.perspective === "defensive_failure" (opponent scored against us; their shot choice is not ours to judge)
- play.finish is a non-shot outcome: "steal", "foul_drawn", "charge_taken", "out_of_bounds", "shot_clock_violation", "unknown_finish"
- playType indicates a non-shot action (e.g. post_up_pass_out without a shot)

Apply IQ Layer 1 ONLY to plays where OUR offense attempted a shot — finish ∈ {made_2, made_3, missed_2, missed_3, and_one, block}. Blocked shots ARE included: they were still our shot attempts and the decision can be evaluated.

4-FACTOR SCORING — for each eligible shot, score each of the four factors from the Brain as + / ~ / −, using ONLY visible evidence in the clip. If the evidence is unclear or the angle blocks the view, the factor is neutral (~), not negative. Never speculate — a teammate must be VISIBLY open on-screen for factor 3 to go negative.

Factors (full definitions live in the Brain IQ Layer 1 section; abbreviated here):
1. Defender pressure on shooter at release
2. Shot clock remaining
3. Visible better alternatives (open teammate in superior position)
4. Shot fit to shooter's role

Apply CONTEXTUAL ADJUSTMENTS from the Brain's "IQ CONTEXTUAL ADJUSTMENTS" section: elite creators (factor 4 neutralizes with clear signal), late-game close-score (factor 2 relaxes), early transition < 7 sec into possession (factors 3 and 4 relax — BUT severe factor-4 violations like center step-back threes stay negative), end-of-quarter last 5 sec (factor 2 becomes +/neutral), foul-trouble backups (slight factor 4 latitude).

VERDICT THRESHOLDS:
- ⚠️ problematic: 2 negative factors, OR 1 severely negative factor (e.g. wide-open teammate clearly ignored)
- ❌ bad: 3+ negative factors, OR 2 severely negative factors
- No marker: 0-1 mild negatives (neutral band — the vast majority of shots) OR 3+ positives (quality shot — let phrasing show appreciation naturally)

Expected distribution: 10-20% of eligible shots flagged ⚠️ or ❌; 80-90% unmarked. If in doubt, do not mark.

MARKER PLACEMENT — the marker appends to the END of the already-composed label, after all existing composition (off_ball_action prefix, mechanic, distance, player name, outcome suffix like " — החטיא" or " — נחסם"). Single space separator, no em-dash between outcome suffix and marker:
- Good/neutral: "פין-דאון לקאץ' אנד שוט שלשה של בלייקני"   (no marker)
- Problematic: "סטפ-באק שלשה של בלייקני — החטיא ⚠️"
- Bad: "סטפ-באק שלשה של מוטלי — החטיא ❌"
- Bad on a make: "פלוטר של מוטלי ❌"

COACH NOTE WHEN MARKER IS APPLIED — the note must briefly explain WHY the marker appeared, in coach-friendly Hebrew. Name the specific negative factors (e.g. "19 שניות על השעון והשוטר בפינה היה פנוי לחלוטין"). When no marker is applied, the note describes the play normally per the NOTE STRUCTURE below. Quality shots may receive natural appreciative phrasing ("בחירה נכונה", "זריקה נקייה אחרי הנעת כדור") but never a ✅ marker.

STRICTNESS REMINDER — a factor counts as "negative" only with CLEAR visual evidence in the clip. Ambiguous → neutral. This is the single most important rule for keeping flag rate in the 10-20% band. Err toward no marker.
` : '';

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
- finish: how it ended (outcome)
- shot_mechanic: shooting motion (independent of outcome; may be absent)
- off_ball_action: off-ball cut or screen that freed the receiver (may be absent; orthogonal to playType/shot_mechanic)
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

OFF-BALL ACTION → HEBREW LABEL PREPEND:
When off_ball_action is present, PREPEND the Hebrew off-ball phrase to the existing outcome label. off_ball_action is orthogonal to finish and shot_mechanic — compose all three.

off_ball_action → Hebrew root term:
- back_cut → חיתוך אחורי
- face_cut → חיתוך קדמי
- flex_cut → חיתוך פלקס
- ucla_cut → חיתוך UCLA
- v_cut → חיתוך V
- l_cut → חיתוך L
- pin_down → פין-דאון
- flare_screen → פלייר
- curl → קרל
- fade_action → ניתוק מסקרין
- zipper → זיפר

Composition patterns (when off_ball_action is present AND a shot resulted):
- back_cut + made_2 + layup → "חיתוך אחורי ללייאפ של <player>"
- back_cut + made_2 + mechanic missing → "חיתוך אחורי לסל של <player>"
- pin_down + made_3 + catch_and_shoot → "פין-דאון לקאץ' אנד שוט שלשה של <player>"
- pin_down + made_3 + mechanic missing → "פין-דאון לשלשה של <player>"
- ucla_cut + made_2 + layup → "חיתוך UCLA ללייאפ של <player>"
- curl + made_2 + floater → "קרל לפלוטר של <player>"
- fade_action + made_3 + catch_and_shoot → "ניתוק מסקרין לשלשה של <player>"
- flare_screen + made_3 + catch_and_shoot → "פלייר לשלשה של <player>"
- zipper + made_3 → "זיפר לשלשה של <player>"
- v_cut + made_3 + catch_and_shoot → "חיתוך V לשלשה של <player>"
- l_cut + made_3 + catch_and_shoot → "חיתוך L לשלשה של <player>"
- flex_cut + made_2 + layup → "חיתוך פלקס ללייאפ של <player>"
- face_cut + made_2 + layup → "חיתוך קדמי ללייאפ של <player>"

When off_ball_action is present BUT shot missed/blocked:
- missed → "<off-ball Hebrew> של <player> — החטיא" (e.g. "פין-דאון של בלייקני — החטיא", "חיתוך אחורי של מוטלי — החטיא")
- block → "<off-ball Hebrew> של <player> — נחסם" (e.g. "קרל של בלייקני — נחסם")

When off_ball_action is present BUT no shot resulted (the action created advantage without a direct shot — e.g. drew a foul, forced a switch that led to a pass-out):
- foul_drawn → "<off-ball Hebrew> של <player> — סחב פאול"
- otherwise describe the advantage in the note field; keep label concise — "<off-ball Hebrew> של <player>"

When off_ball_action is ABSENT: existing label composition logic above is unchanged.

Fade disambiguation reminder: fade_action (off_ball_action) → "ניתוק מסקרין". fadeaway (shot_mechanic) → "פייד-אווי". Both can appear on the same play; compose both ("ניתוק מסקרין לפייד-אווי שלשה של <player>").
${iqLayer1Block}
${BRAIN_HIGH_ATTENTION_PLAYS}

For PRIORITY 1 plays, your note should be 3 sentences (not 2) to capture the breakdown chain. For PRIORITY 3 (correct read but missed) and PRIORITY 2 (clean made shots), 2 sentences is fine.

═══ NOTE WRITING STYLE - CRITICAL ═══

The 'note' field for each play should sound like a real assistant coach narrating film to the head coach. Not a description of what happened (the coach already watched it). NOT generic basketball commentary. Specific cause-and-effect storytelling.

EXAMPLE GOOD NOTE for a successful drive (offensive play):
"Williams froze the defender with a crossover and after the recovery attempt, used a small bump to create the space he needed for the pullup fadeaway. The defender lost his base on the bump and couldn't contest the shot in time."

WHY THIS IS GOOD:
- Names specific actions (crossover, recovery, bump, pullup fadeaway)
- Tells a CHAIN: action → reaction → space → finish
- Uses coach vocabulary (lost his base, contest in time)
- Past tense, observational, no advice

EXAMPLE BAD NOTE (DO NOT WRITE THIS WAY):
"Successful isolation drive that resulted in a made jumper. Effective scoring possession."
WHY: generic, no story, no cause-and-effect, useless to a coach.

REQUIREMENTS FOR ALL NOTES:

1. Length: 2-3 sentences. Skip filler words.
2. Use last names only for players (Williams, Hartenstein, Dort - not full names).
3. Mix Hebrew with English-transliterated basketball terms naturally - the way Israeli coaches actually speak. Examples of natural mix: "קרוסאובר", "פול-אפ פייידאוויי", "פיק אנד רול", "קלוז-אאוט", "ביג-מן".
4. Tell the CHAIN of cause-and-effect, not just the final result. What led to what.
5. Use specific action verbs: froze, jumped the screen, recovered late, lost his base, swallowed the screen, hedged hard, sagged off, closed out flat, etc.
6. Acknowledge uncertainty when present: "looked like he froze on the crossover" instead of "froze on the crossover" if not 100% clear.
7. Past tense only. Observational, never prescriptive ("should have", "needed to" - FORBIDDEN).

═══ NOTE STYLE BY PLAY TYPE ═══

For SUCCESSFUL OFFENSIVE PLAYS (made shots):
- Identify the moment that broke the defense (the trigger move)
- Describe the chain: trigger → defender response → space creation → finish
- 2 sentences usually enough

For MISSED OFFENSIVE PLAYS:
- Focus on the breakdown moment - what physically went wrong with the shot mechanics OR what defensive action prevented success
- Mention what was happening around the shooter (defender position, momentum, contest, available passing options if visible)
- 2-3 sentences

For DEFENSIVE FAILURES (opponent scored on us) - MOST DETAILED:
This is where coaches focus most. Get this RIGHT.
- Identify WHICH of OUR defenders had the primary responsibility
- Name the specific technique breakdown: late closeout, wrong angle, ball-watching, beat off the dribble, lost on the screen, miscommunication on switch
- Trace the chain: how did the opponent create the advantage that led to the score
- Mention if it was scheme-related (rotation broke down, help didn't come) vs individual (defender beaten 1v1)
- 3 sentences acceptable here for clarity

EXAMPLE GOOD DEFENSIVE BREAKDOWN NOTE:
"Dort got beat on the initial closeout - came in too flat and the shooter pump-faked him into the air. Once Dort flew by, the help defender (Hartenstein) was a step late rotating from the weak side, leaving an open lane to the rim for the finish."

For DEFENSIVE STOPS (we got the stop):
- Identify what worked - active hands, good closeout, scheme execution, individual effort
- 1-2 sentences usually enough

For TRANSITION PLAYS:
- Note the trigger (steal, defensive rebound, opponent miss)
- Note who got back and who didn't on the other team
- 2 sentences

═══ END NOTE STYLE GUIDANCE ═══

Apply this style to all 'note' fields in the enriched output JSON.

COACHING KNOWLEDGE:
${brainForPrompt}

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

  // 🧠 IQ Layer 1 — post-enrichment marker detection (parses ⚠️/❌ from the returned label)
  // 🎽 Team ID — post-enrichment final attribution log (combined loop with IQ verdict)
  let iqMarkedCount = 0;
  for (const p of enriched) {
    const label: string = (p && typeof p.label === 'string') ? p.label : '';
    const playerTag = (p && Array.isArray(p.players) && p.players[0]) || '—';
    let verdict: 'warn' | 'bad' | 'none';
    let marker: string;
    if (label.includes('❌')) {
      verdict = 'bad';
      marker = '❌';
      iqMarkedCount++;
    } else if (label.includes('⚠️')) {
      verdict = 'warn';
      marker = '⚠️';
      iqMarkedCount++;
    } else {
      verdict = 'none';
      marker = 'none';
    }
    console.log(`🧠 IQ Layer 1 verdict: ${p?.startTime || '—'} ${playerTag} verdict=${verdict} marker=${marker}`);

    // 🎽 Final team attribution — perspective + resolved label (contains Hebrew player name if matched)
    const finalPerspective = (p && typeof p.perspective === 'string' && p.perspective) || 'missing';
    const finalPlayersArr = (p && Array.isArray(p.players) && p.players.length > 0)
      ? `[${p.players.join(',')}]`
      : 'empty';
    console.log(`🎽 Final team: clip ${p?.startTime || '—'} → perspective=${finalPerspective} players=${finalPlayersArr} label="${label}"`);
  }

  // 🧠 IQ Layer 1 — batch summary (expected band: 10-20% of eligible shots marked)
  const iqMarkedPct = iqEligibleCount > 0 ? Math.round((iqMarkedCount / iqEligibleCount) * 100) : 0;
  console.log(`🧠 IQ Layer 1: eligible=${iqEligibleCount} marked=${iqMarkedCount} (${iqMarkedPct}%)`);

  // 🎽 Team ID — batch summary (perspective bucket counts tallied in the pre-enrichment loop)
  const perspSummary = Object.entries(perspectiveCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`🎽 Team ID summary: total=${geminiPlays.length} perspective_counts={${perspSummary}} ambiguous=${teamIdAmbiguousCount}`);

  // 🎽 Confidence summary — per-field high/medium/low/missing tallies
  const fmtConf = (t: Record<string, number>) =>
    `{high=${t.high}, medium=${t.medium}, low=${t.low}${t.missing ? `, missing=${t.missing}` : ''}}`;
  console.log(`🎽 Confidence summary: perspective=${fmtConf(confCounts.perspective)}, playType=${fmtConf(confCounts.playType)}, players=${fmtConf(confCounts.players)}`);

  return enriched;
}

/** STEP 3: Generate coaching insights from enriched plays */
async function generateInsightsFromPlays(
  plays: AnalysisResult['plays'],
  context: string,
  teamName: string
): Promise<AnalysisResult['insights']> {
  console.log(`\n💡 [3/3] Generating insights from ${plays.length} plays...`);
  const client = getClient();
  const knowledgeContext = await getKnowledgeContext(teamName);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Based on these basketball plays from a game, provide coaching insights in Hebrew.
Return ONLY a valid JSON array, maximum 4 insights, no explanation or markdown:
[{"type":"good|warn|bad","title":"Hebrew title","body":"Hebrew explanation"}]

${BRAIN_INSIGHT_FRAMEWORK}

${BRAIN_OFFENSIVE_PRINCIPLES}

${BRAIN_HIGH_ATTENTION_PLAYS}

When generating insights, weight your pattern detection toward Priority 1 events. A pattern in turnovers or rebounding failures is more important than a pattern in successful flow scoring.

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

/**
 * Generate 2-3 Hebrew OBSERVATIONS (factual, not prescriptive) for plays that
 * went badly for our team. Mutates `enrichedPlays` in place by adding an
 * `observations: string[]` field. Toggle via OBSERVATIONS_ENABLED env (default
 * true). Runs all calls in parallel — each one independent, failures swallowed
 * so a single bad clip can't drop the whole feature.
 *
 * "Negative" = finish in {missed_2, missed_3, block, turnover} OR
 * perspective === defensive_failure.
 */
const NEGATIVE_FINISHES = new Set(['missed_2', 'missed_3', 'block', 'turnover']);

async function generateObservationsForNegativePlays(
  enrichedPlays: AnalysisResult['plays'],
  geminiPlays: GeminiPlay[],
  roster: string,
  teamName: string,
): Promise<void> {
  const enabled = process.env.OBSERVATIONS_ENABLED !== 'false';
  if (!enabled) {
    console.log('🔍 Observations: DISABLED via OBSERVATIONS_ENABLED env');
    return;
  }

  type Target = { i: number; play: AnalysisResult['plays'][number]; gemini: GeminiPlay };
  const targets: Target[] = [];
  enrichedPlays.forEach((play, i) => {
    const gemini = geminiPlays.find(g => g.startTime === play.startTime);
    if (!gemini) {
      console.log(`🔍 Observations: clip ${play.startTime} → SKIP (no upstream gemini play)`);
      return;
    }
    const finish = (gemini.finish || '').toLowerCase();
    const perspective = ((play as any).perspective || gemini.perspective || '').toLowerCase();
    const isNegative = NEGATIVE_FINISHES.has(finish) || perspective === 'defensive_failure';
    if (!isNegative) {
      console.log(`🔍 Observations: clip ${play.startTime} finish=${finish || '—'} → SKIP (positive play)`);
      return;
    }
    targets.push({ i, play, gemini });
  });

  if (targets.length === 0) {
    console.log(`🔍 Observations summary: total_plays=${enrichedPlays.length} negative=0 observations_generated=0`);
    return;
  }

  const client = getClient();
  let observationsGenerated = 0;

  await Promise.all(targets.map(async ({ i, play, gemini }) => {
    const prompt = `You are an observant assistant coach analyzing a basketball play that did NOT work for the team. Your job is to surface 2-3 OBSERVATIONS about what was visible during the play. NEVER give advice or suggestions. NEVER say what the player SHOULD have done. Only describe what happened and what was available.

${BRAIN_OBSERVATION_FOCUS}

${BRAIN_DEFENSIVE_PRINCIPLES}

${BRAIN_HIGH_ATTENTION_PLAYS}

This play has been flagged as a negative outcome. Apply Priority 1 analytical depth - identify the originating mistake in the breakdown chain, not just the final visible error.

Play context:
- Team: ${teamName || 'unknown'}
- Roster: ${roster || '(empty)'}
- Time: ${play.startTime}
- Players involved: ${(play.players || []).join(', ') || '—'}
- What happened: ${play.label || ''}
- Detail: ${play.note || ''}
- Outcome: ${gemini.finish || '—'}
- Description from frames: ${gemini.what_i_actually_saw || 'N/A'}

Generate 2-3 observations in Hebrew. Each should be:
- A specific factual observation (player position, defender position, available options, timing)
- Written in past tense (what happened, what was visible)
- NEVER prescriptive ("should have," "needed to," "must")
- 1 sentence each, around 10-15 words

Return ONLY a JSON object, no other text:
{
  "observations": [
    "<observation 1>",
    "<observation 2>",
    "<observation 3>"
  ]
}

Examples of GOOD observations:
- "ההגנה היריבה החליפה על המסך, השחקן עם הכדור נשאר מול מגן גבוה יותר"
- "Hartenstein היה פנוי בצבע באותו רגע, ללא הגנה ב-1.5 שניות לפני הזריקה"
- "השחקן בחר זריקה מטווח ארוך כשנותרו 18 שניות בשעון השניות"

Examples of BAD observations (DO NOT generate these):
- "השחקן היה צריך למסור" - PRESCRIPTIVE
- "המהלך היה גרוע" - JUDGMENT
- "בעיה בהגנה" - VAGUE`;

    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        console.log(`🔍 Observations: clip ${play.startTime} finish=${gemini.finish || '—'} → no JSON in response`);
        return;
      }
      const parsed = JSON.parse(m[0]);
      const obs = Array.isArray(parsed.observations)
        ? parsed.observations.filter((s: any) => typeof s === 'string' && s.trim().length > 0).map((s: string) => s.trim())
        : [];
      if (obs.length > 0) {
        enrichedPlays[i].observations = obs;
        observationsGenerated += obs.length;
        console.log(`🔍 Observations: clip ${play.startTime} finish=${gemini.finish || '—'} → generated ${obs.length} observations`);
      } else {
        console.log(`🔍 Observations: clip ${play.startTime} finish=${gemini.finish || '—'} → empty observations array`);
      }
    } catch (err: any) {
      console.warn(`🔍 Observations: clip ${play.startTime} → failed: ${err?.message || err}`);
    }
  }));

  console.log(`🔍 Observations summary: total_plays=${enrichedPlays.length} negative=${targets.length} observations_generated=${observationsGenerated}`);
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

  console.log(`🤖 Gemini model: ${GEMINI_MODEL}`);

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
  if (teamName) {
    console.log(`🎯 Focus team filter: analyzing plays relevant to ${teamName}`);
  }
  onProgress?.(20, 'מזהה רגעי משחק...');
  const timestamps = await detectPlayTimestamps(fileUri, mimeType, jerseyColor || '', opponentJerseyColor || '', teamName || '');
  console.log(`⏱️ Found ${timestamps.length} timestamps`);
  onProgress?.(30, `נמצאו ${timestamps.length} מהלכים`);

  // Pass 2: analyze each clip with a worker pool. Sequential processing was the
  // dominant time cost on long videos — a 70-clip game took ~18-20 minutes here
  // alone and blew past the frontend abort. The CONCURRENCY cap of 5 protects
  // Gemini's rate limits without the per-call sleep, and each clip still goes
  // through retryWithBackoff inside analyzeClipAtTimestamp.
  console.log('🎬 [2/4] Analyzing individual clips...');
  const CLIP_CONCURRENCY = 5;
  const clipResults: (GeminiPlay | null)[] = new Array(timestamps.length).fill(null);
  let nextClipIndex = 0;
  let completedClips = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const myIndex = nextClipIndex++;
      if (myIndex >= timestamps.length) return;
      const ts = timestamps[myIndex];
      console.log(`   Clip ${myIndex + 1}/${timestamps.length} at ${ts}`);
      try {
        const play = await analyzeClipAtTimestamp(fileUri, mimeType, ts, jerseyColor || '', opponentJerseyColor || '', teamName, roster, context);
        clipResults[myIndex] = play;
      } catch (e: any) {
        console.error(`   ❌ Clip ${ts} failed:`, e?.message || e);
        clipResults[myIndex] = null;
      }
      completedClips++;
      const clipPct = timestamps.length > 0 ? 30 + Math.round((completedClips / timestamps.length) * 60) : 90;
      onProgress?.(clipPct, `מנתח קליפ ${completedClips} מתוך ${timestamps.length}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CLIP_CONCURRENCY, timestamps.length) }, () => worker()));
  const geminiPlays: GeminiPlay[] = clipResults.filter((p): p is GeminiPlay => p !== null);
  console.log(`✅ Got ${geminiPlays.length} plays from clips`);

  // Step 3: Claude enriches with Hebrew coaching analysis
  console.log('🤖 [3/4] Claude enrichment...');
  onProgress?.(92, 'Claude מעבד הערות אימון...');
  const rawEnriched = await enrichPlaysWithClaude(geminiPlays, roster, teamName, focus);

  // Safety net: Gemini sometimes emits two timestamps for the same possession.
  const dedupedPlays = dedupOverlappingPlays(rawEnriched);
  if (dedupedPlays.length < rawEnriched.length) {
    console.log(`🧹 Dedup removed ${rawEnriched.length - dedupedPlays.length} overlapping plays`);
  }

  // Step 3.5: Haiku post-enrichment refinement of shot mechanic only.
  onProgress?.(95, 'מדייק את מכניקת הזריקות...');
  const enrichedPlays = await refineShotMechanicsWithHaiku(geminiPlays, dedupedPlays);

  // Step 3.6: Haiku observations on negative plays only (factual, not prescriptive).
  onProgress?.(96, 'מבחין ברגעי לחץ...');
  await generateObservationsForNegativePlays(enrichedPlays, geminiPlays, roster, teamName);

  // Step 4: Claude generates coaching insights
  onProgress?.(97, 'מייצר תובנות...');
  const insights = await generateInsightsFromPlays(enrichedPlays, context, teamName);

  return {
    game: context || 'ניתוח משחק',
    plays: enrichedPlays,
    insights,
    shotChart: (() => {
      // Sonnet enrichment doesn't pass through finish_location / playType.
      // Match enriched plays back to their upstream Gemini play by startTime
      // and read the shot fields from there.
      const shotChart = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
      enrichedPlays.forEach((enriched: any) => {
        const gemini = geminiPlays.find(g => g.startTime === enriched.startTime);
        if (!gemini) return;
        const location = (gemini.finish_location || '').toLowerCase();
        const playType = (gemini.playType || '').toLowerCase();

        if (location.includes('paint') || location.includes('rim')) shotChart.paint++;
        else if (location.includes('mid')) shotChart.midRange++;
        else if (location.includes('corner') && location.includes('3')) shotChart.corner3++;
        else if (location.includes('3') || location.includes('above')) shotChart.aboveBreak3++;

        if (playType.includes('pull_up')) shotChart.pullUp++;
      });
      // Normalize the location buckets to percentages so the frontend's
      // `${val}%` rendering and `width: ${val}%` bar fill display correctly.
      // pullUp is counted independently (a mid-range pull-up counts in both
      // midRange and pullUp), so it's normalized against the same denominator
      // and remains its own dimension rather than part of the 100% sum.
      const total = shotChart.paint + shotChart.midRange + shotChart.corner3 + shotChart.aboveBreak3 + shotChart.pullUp;
      if (total > 0) {
        shotChart.paint = Math.round((shotChart.paint / total) * 100);
        shotChart.midRange = Math.round((shotChart.midRange / total) * 100);
        shotChart.corner3 = Math.round((shotChart.corner3 / total) * 100);
        shotChart.aboveBreak3 = Math.round((shotChart.aboveBreak3 / total) * 100);
        shotChart.pullUp = Math.round((shotChart.pullUp / total) * 100);
      }
      console.log(`📊 Shot chart percentages: paint=${shotChart.paint}% midRange=${shotChart.midRange}% corner3=${shotChart.corner3}% aboveBreak3=${shotChart.aboveBreak3}% pullUp=${shotChart.pullUp}%`);
      return shotChart;
    })(),
  };
}

// ============================================================
// PUBLIC API
// ============================================================

/** Analyze YouTube — download → Gemini → Claude */
export async function analyzeYouTube(url: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = '', onProgress?: ProgressCb, persistPath?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  onProgress?.(2, 'מוריד וידאו מ-YouTube...');
  const videoPath = downloadYouTube(url);

  try {
    const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor, onProgress);
    if (persistPath) persistVideoFile(videoPath, persistPath);
    console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
    return result;
  } finally {
    console.log('\n🧹 Cleaning up temp files...');
    try { fs.unlinkSync(videoPath); } catch {}
    console.log('   ✅ Cleanup done');
  }
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = '', onProgress?: ProgressCb, persistPath?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');

  const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor, onProgress);
  if (persistPath) persistVideoFile(videoPath, persistPath);
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
