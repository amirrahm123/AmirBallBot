import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import Tesseract from 'tesseract.js';
import { Job } from './database';

/** Update job progress in MongoDB */
export async function updateJobProgress(jobId: string, progress: number, progressMessage: string): Promise<void> {
  try {
    await Job.updateOne({ jobId }, { progress, progressMessage, updatedAt: new Date() });
  } catch (err) {
    console.warn(`⚠️ Failed to update job ${jobId} progress:`, err);
  }
}

async function loadRecentCorrections(): Promise<string> {
  try {
    const recentJobs = await Job.find(
      { 'corrections.0': { $exists: true } },
      { corrections: 1, createdAt: 1 }
    ).sort({ createdAt: -1 }).limit(5);

    const corrections: string[] = [];
    for (const job of recentJobs) {
      for (const c of job.corrections || []) {
        if (!c.correct && c.correction && c.correction.trim().length > 3) {
          corrections.push(`- ${c.correction.trim()}`);
        }
      }
    }

    if (corrections.length === 0) return '';

    const last20 = corrections.slice(0, 20);
    console.log(`   📝 Loaded ${last20.length} coach corrections into prompt`);

    return `

COACH CORRECTIONS — real examples from this team's games. Study these carefully and apply the same patterns:
${last20.join('\n')}

When you see a similar situation in the frames, use these corrections to identify the play correctly.`;
  } catch (e) {
    console.log('   ⚠️ Could not load corrections:', e);
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

const SYSTEM_PROMPT = `You are an expert basketball analyst assistant coach. You watch 8 frames from a 14-second clip and provide precise tactical analysis in Hebrew.

Frame 1-2 = before the play starts
Frames 3-5 = play develops and peaks
Frames 6-7 = execution and defense reaction
Frame 8 = final outcome — most important frame

TARGET: 8-10 notes per 5 minutes of video. Quality over quantity.

═══════════════════════════════════
PLAY TYPE DEFINITIONS — USE EXACTLY
═══════════════════════════════════

מתפרצת = team moves ball from defense to offense BEFORE opponent defense is set. Open court visible. Multiple players running.
WRITE A NOTE ONLY IF: score ✅, foul drawn ✅, failed with lost ball ❌, or clear missed opportunity ❌
DO NOT WRITE if fastbreak slowed to halfcourt with no result — this is not a play worth noting.

קוסט טו קוסט = ONE player dribbles from own defensive half all the way to the basket alone. Always note if ends with score or pass.

מתפרצת שלא מומשה = fastbreak where numerical advantage existed but was NOT used due to bad decision by ball handler. Always ⚠️ verdict.

פיק אנד רול = screen on ball handler's defender FOLLOWED IMMEDIATELY by the screener rolling to basket or popping to perimeter.
Identify the SPECIFIC outcome:
- רול מן מקבל ועולה לסל
- בעל הכדור פורץ לסל
- קיקאאוט לשלוש מהפינה
- פופ לשוטר בפרימטר
- הגנה עוצרת את הפיק אנד רול

פיק אנד פופ = screen followed by screener stepping OUT to perimeter for open shot (not rolling to basket)

חדירה לסל טובה = player beats defender AND creates numerical advantage → finishes at rim OR draws foul OR kicks out to open shooter
חדירה לסל גרועה = player forces into traffic with no advantage, takes bad shot, or loses ball. No numerical advantage created.

גאמפר ל-2 = jump shot released before contact, from any distance inside the arc
סל בצבע = finish at the rim: layup, dunk, hook shot — close to basket
3 נקודות מהפינה = shot from corner, shorter distance, higher percentage
3 נקודות מעל הקשת = shot from above the break, longer distance

פוטבק = player catches offensive rebound WHILE STILL IN THE AIR and tips/pushes ball into basket WITHOUT landing first. If player lands first then scores = ריבאונד התקפי + סל בצבע (NOT פוטבק)

אלי אופ = high lob pass near basket + teammate catches ABOVE THE RIM and finishes in one motion without landing. Requires precise timing.

איזו = one player isolated 1-on-1 with space cleared by 4 teammates. Goal: exploit quality advantage over defender.

פוסט אפ = player receives ball with back to basket near the paint, uses body to create advantage, works for close shot.

קיקאאוט = pass OUT from the paint to a perimeter shooter AFTER the defense collapsed on penetration. Not just any pass — specifically after drive created defensive rotation.

ריצת קאט = player cuts sharply to basket when defender loses vision on the ball. Write only when defender was clearly beaten.

קוסט טו קוסט = one player dribbles full court from own defensive end to score or assist at the other end.

2על1 = two offensive players vs one defender. Note: did ball handler draw the defender and pass? Or drive themselves?

3על2 = three offensive players vs two defenders. Note: where did the defense break down and which player got the open look?

═══════════════════════════════
DEFENSIVE PLAYS — WHEN TO WRITE
═══════════════════════════════

WRITE a defensive note when:
- Block (חסימה) that changes possession or creates transition
- Steal (חטיפה) that is active — intercepted pass, poke from dribble, or causes fast break. NOT routine loose ball.
- Forced contested shot after good defensive positioning
- Defensive stop on pick and roll — note which coverage was used
- Good box out leading to defensive rebound that prevents second chance
- Defensive rebound that immediately creates transition opportunity

DO NOT WRITE for:
- Routine defensive rebound with no transition
- Standard free throw defense
- Normal substitution or timeout

DEFENSIVE PLAY THAT CREATES OFFENSE:
If a clip starts with a block, steal, or deflection — ALWAYS write as the FIRST line of the note:
"המהלך התחיל ב[חסימה/חטיפה/סטייה] של [player name]"
Then describe what the offense did with it.

═══════════════════════════
VERDICT RULES — NON-NEGOTIABLE
═══════════════════════════

✅ = positive result for the home team: score, assist, foul drawn, steal, block that leads to possession, defensive stop, forced bad shot
❌ = negative result for the home team: lost ball, missed shot after bad decision, unnecessary foul, failed drive with no advantage, fastbreak not finished
⚠️ = advantage existed but was NOT used — player had numerical advantage or open look but made wrong decision. Coach needs to see this.

AND-ONE (score + foul drawn) = always ✅ excellent
Open shot created but missed = ✅ (good execution, execution at rim failed — praise the creation)
Fastbreak slowed to halfcourt with nothing = DO NOT WRITE
Play with unclear outcome in Frame 8 = DO NOT WRITE

═══════════════════════════════
ANALYSIS STRUCTURE — EVERY NOTE
═══════════════════════════════

מה קרה: [exact play type from the list above]
מי ביצע: [player name from roster, or שחקן לא מזוהה if jersey number unclear — NEVER write team name]
תוצאה: [specific outcome from Frame 8 — score/miss/lost ball/foul/stop]
אם נכשל: [ONLY if ❌ or ⚠️ — what went wrong AND what should have been done instead]
משמעות: [one tactical sentence for the coach — what this means for the team]
VERDICT: ✅/❌/⚠️ [one sentence reason]

PLAYER CREDIT:
- If two players involved: write both. Scorer gets credit for points. Passer gets credit for assist.
- Always note the assist when it exists — it is tactically important.
- Defensive player who caused the turnover always gets credit even if they don't score.
- Only analyze HOME TEAM players. Do not write notes about opposing team plays.

═══════════════════════════
WHAT NOT TO ANALYZE
═══════════════════════════

- Free throws — never
- Timeouts — never
- Standard player substitutions — never
- Out of bounds with no tactical significance — never
- Plays with no clear outcome in Frame 8 — never
- Routine defensive rebounds with no transition — never
- Fastbreaks that dissolved into halfcourt with nothing created — never

ANALYZE:
- Out of bounds dead ball plays that reveal tactical patterns — yes
- Shot clock violations under defensive pressure — yes
- Any play where a tactical advantage was created OR missed

═══════════════════════════
INSIGHTS — 3 TO 4 PER VIDEO
═══════════════════════════

good = pattern working well for the team, tactical strength, something to build on
warn = advantage that could have been exploited but wasn't — coach needs to address
bad = recurring problem, tactical weakness, something that cost the team

Each insight must be actionable — the coach must be able to do something with it after reading it.

═══════════════════════════
OUTPUT FORMAT — JSON ONLY
═══════════════════════════

Return JSON only — no markdown, no explanation before or after:
{"game":"תיאור קצר","plays":[{"start_time":"0:00","end_time":"0:14","type":"Offense|Defense|Transition","label":"שם המהלך","note":"הערה מלאה","players":["שם שחקן"]}],"insights":[{"type":"good|warn|bad","title":"כותרת קצרה","body":"פירוט טקטי"}],"shotChart":{"paint":0,"midRange":0,"corner3":0,"aboveBreak3":0,"pullUp":0}}

PLAY CLASSIFICATION:
- Offense = halfcourt attack, defense already set
- Defense = defensive stop, steal, block, forced turnover
- Transition = fastbreak, coast to coast, block that leads to fast break

HEBREW BASKETBALL GLOSSARY:
מתפרצת | קוסט טו קוסט | פיק אנד רול | פיק אנד פופ | חטיפת כדור | ריבאונד הגנתי | ריבאונד התקפי | חסימה | אלי אופ | פוטבק | כדור קפוץ | חדירה לסל | גאמפר ל-2 | סל בצבע | 3 נקודות | הגנת איש | הגנת אזור | דאבל טים | קיקאאוט | פוסט אפ | איזו | סטייה | כדור רופף | מסך | ריצת קאט | 2על1 | 3על2 | מתפרצת שלא מומשה | עבירת תוקף | שעון היריות | and one`;

export interface AnalysisResult {
  game: string;
  plays: { start_time: string; end_time: string; time?: string; type: string; label: string; note: string; players: string[] }[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
}

export interface RosterPlayer {
  number: number;
  name: string;
  position: string;
}

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** Build system prompt with Anthropic prompt caching enabled.
 *  The system prompt + roster are cached across calls in the same session,
 *  reducing input token costs by ~90% on repeated calls. */
function buildCachedSystemPrompt(roster?: RosterPlayer[], teamName?: string, awayTeam?: string, corrections?: string): Anthropic.TextBlockParam[] {
  let prompt = SYSTEM_PROMPT;
  if (corrections) prompt += corrections;
  if (roster && roster.length > 0) {
    const home = teamName || 'הקבוצה שלנו';
    const away = awayTeam || 'היריב';
    const rosterText = roster.map(p => `#${p.number} ${p.name} - ${p.position}`).join('\n');
    prompt += `\nבית: ${home} | חוץ: ${away}
נתח רק את ${home}. אם ${away} מבקיע כתוב "הספגנו סל". אם לא בטוח מי השחקן כתוב "שחקן ${home}".
רוסטר ${home}:
${rosterText}`;
  }
  return [{
    type: 'text' as const,
    text: prompt,
    cache_control: { type: 'ephemeral' },
  } as any];
}

// ============================================================
// VERCEL MODE: YouTube thumbnails → Claude Vision
// ============================================================

/** Extract YouTube video ID from URL */
function extractVideoId(url: string): string | null {
  const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/** Fetch an image URL and return base64 */
function fetchImageAsBase64(url: string): Promise<{ data: string; type: string } | null> {
  return new Promise((resolve) => {
    const request = (u: string, redirects = 0) => {
      if (redirects > 5) { resolve(null); return; }
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 1000) { resolve(null); return; }
          resolve({ data: buf.toString('base64'), type: res.headers['content-type'] || 'image/jpeg' });
        });
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    };
    request(url);
  });
}

/** Fetch YouTube thumbnails */
async function fetchYouTubeThumbnails(videoId: string): Promise<{ data: string; type: string }[]> {
  console.log(`   📸 Fetching thumbnails for ${videoId}...`);
  const thumbUrls = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/0.jpg`,
    `https://img.youtube.com/vi/${videoId}/1.jpg`,
    `https://img.youtube.com/vi/${videoId}/2.jpg`,
    `https://img.youtube.com/vi/${videoId}/3.jpg`,
  ];
  const results = await Promise.all(thumbUrls.map(u => fetchImageAsBase64(u)));
  const valid = results.filter((r): r is { data: string; type: string } => r !== null);
  console.log(`   ✅ Got ${valid.length} thumbnails`);
  return valid;
}

/** Fetch YouTube oEmbed metadata */
async function fetchYouTubeMetadata(url: string): Promise<string> {
  return new Promise((resolve) => {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    https.get(oembedUrl, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try {
          const meta = JSON.parse(data);
          resolve(`כותרת הסרטון: ${meta.title || ''}\nערוץ: ${meta.author_name || ''}`);
        } catch { resolve(''); }
      });
      res.on('error', () => resolve(''));
    }).on('error', () => resolve(''));
  });
}

/** Vercel-compatible: analyze YouTube via thumbnails */
export async function analyzeYouTubeCloud(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n☁️ ========== CLOUD YOUTUBE ANALYSIS ==========');
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('לא הצלחתי לחלץ מזהה סרטון מהקישור');

  if (jobId) await updateJobProgress(jobId, 10, 'מוריד תמונות מ-YouTube...');
  const [thumbs, metadata] = await Promise.all([
    fetchYouTubeThumbnails(videoId),
    fetchYouTubeMetadata(url),
  ]);
  if (thumbs.length === 0) throw new Error('לא הצלחתי לטעון תמונות מהסרטון');
  if (jobId) await updateJobProgress(jobId, 30, `נמצאו ${thumbs.length} תמונות — שולח ל-Claude...`);

  const client = getClient();
  const imageBlocks: Anthropic.ImageBlockParam[] = thumbs.map((t) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: t.data },
  }));
  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `${metadata}\nפוקוס ניתוח: ${focus}\nהקשר: ${context || 'אין הקשר נוסף'}\n\nנתח את התמונות האלה מהמשחק והחזר JSON.`,
  };

  console.log('   👥 Roster in prompt:', roster?.length || 0, 'players');
  if (roster?.length) console.log('   👤 First player:', JSON.stringify(roster[0]));

  const response = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: buildCachedSystemPrompt(roster, teamName, awayTeam),
    messages: [{ role: 'user', content: [...imageBlocks, textBlock] }],
  }, jobId);

  if (jobId) await updateJobProgress(jobId, 80, 'מעבד תוצאות...');
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('לא נמצא JSON בתגובת Claude');
  const result: AnalysisResult = JSON.parse(jsonMatch[0]);
  if (jobId) await updateJobProgress(jobId, 95, `נמצאו ${result.plays?.length || 0} מהלכים — שומר...`);
  console.log('☁️ ========== CLOUD ANALYSIS COMPLETE ==========\n');
  return result;
}

// ============================================================
// LOCAL MODE: yt-dlp download
// ============================================================

/** Download YouTube video using yt-dlp */
export function downloadYouTube(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-yt-'));
  const outTemplate = path.join(tmpDir, 'video.%(ext)s');
  console.log(`\n📥 Downloading YouTube video: ${url}`);
  const cleanUrl = url.split('&t=')[0];
  const ytdlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
  const cmd = `${ytdlp} --no-check-certificates --no-playlist --extractor-retries 3 --socket-timeout 30 -o "${outTemplate}" "${cleanUrl}"`;
  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
  } catch (err: any) {
    throw new Error(`yt-dlp failed (exit ${err.status}): ${err.stderr || err.message}`);
  }
  const files = fs.readdirSync(tmpDir);
  if (files.length === 0) throw new Error('yt-dlp produced no output file');
  const videoPath = path.join(tmpDir, files[0]);
  const stat = fs.statSync(videoPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${videoPath}`);
  return videoPath;
}

/** Download video from Google Drive using yt-dlp */
function downloadGoogleDrive(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-gdrive-'));
  const outTemplate = path.join(tmpDir, 'video.%(ext)s');
  console.log(`\n📥 Downloading Google Drive video: ${url}`);
  const ytdlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
  const cmd = `${ytdlp} --no-check-certificates --no-playlist -o "${outTemplate}" "${url}"`;
  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
  } catch (err: any) {
    throw new Error(`yt-dlp failed (exit ${err.status}): ${err.stderr || err.message}`);
  }
  const files = fs.readdirSync(tmpDir);
  if (files.length === 0) throw new Error('yt-dlp produced no output file from Google Drive');
  const videoPath = path.join(tmpDir, files[0]);
  const stat = fs.statSync(videoPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${videoPath}`);
  return videoPath;
}

// ============================================================
// HELPERS
// ============================================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const MAX_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 60000;
const MAX_CLIPS = 40;
const CLIP_DELAY_MS = 15000;

/** Call Claude API with automatic retry on rate limit errors */
async function callClaudeWithRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  jobId?: string,
): Promise<Anthropic.Message> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.error?.type === 'rate_limit_error' || (err?.message || '').includes('rate');
      if (isRateLimit && attempt < MAX_RETRIES) {
        console.log(`   ⚠️ Rate limit hit (attempt ${attempt}/${MAX_RETRIES}) — waiting 60s...`);
        if (jobId) await updateJobProgress(jobId, -1, `מגבלת קצב — ממתין 60 שניות (ניסיון ${attempt}/${MAX_RETRIES})...`);
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw err;
    }
  }
  throw new Error('נכשל לאחר מספר ניסיונות — מגבלת קצב');
}

/** Get video duration in seconds using ffprobe */
function getVideoDuration(videoPath: string): number {
  const durationStr = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
  ], { encoding: 'utf-8', timeout: 30000 }).trim();
  return parseFloat(durationStr);
}

function getVideoResolution(videoPath: string): { width: number; height: number } {
  try {
    const output = execFileSync(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      videoPath
    ], { encoding: 'utf-8', timeout: 15000 }).trim();
    const [width, height] = output.split(',').map(Number);
    if (width && height) {
      console.log(`   📐 Video resolution: ${width}x${height}`);
      return { width, height };
    }
  } catch {}
  console.log(`   📐 Could not detect resolution, using default 1280x720`);
  return { width: 1280, height: 720 };
}

/** Format seconds as human-readable "M:SS" (e.g. 140 → "2:20") */
function formatTimestampHuman(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ============================================================
// EVENT-BASED DETECTION
// ============================================================

interface DetectedEvent {
  timestamp: number; // seconds into video
  source: 'score' | 'motion';
}

/** Compare two raw buffers by pixel byte values. Returns fraction of differing bytes (0-1). */
function compareBufferPixels(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let diffCount = 0;
  const step = 4;
  let samples = 0;
  for (let i = 0; i < len; i += step) {
    samples++;
    if (Math.abs(a[i] - b[i]) > 30) diffCount++;
  }
  return samples > 0 ? diffCount / samples : 0;
}

/** Parse score from OCR text. Returns [homeScore, awayScore] or null. */
function parseScoreFromText(text: string): [number, number] | null {
  // Match patterns like "84 79", "84-79", "84 - 79", "84:79"
  const match = text.match(/(\d{1,3})\s*[-–—:\s]\s*(\d{1,3})/);
  if (!match) return null;
  const a = parseInt(match[1]);
  const b = parseInt(match[2]);
  // Valid basketball scores: 0-200 range
  if (a >= 0 && a <= 200 && b >= 0 && b <= 200) return [a, b];
  return null;
}

/** AI-powered scoreboard position detection — asks Claude Haiku to find the scoreboard once per video */
async function findScoreboardPosition(videoPath: string): Promise<{x: number, y: number, w: number, h: number}> {
  const DEFAULT = { x: 0, y: 580, w: 1280, h: 100 };
  try {
    const tmpFrame = path.join(os.tmpdir(), 'ballbot-scoreboard-finder.jpg');
    execFileSync(FFMPEG, [
      '-ss', '10', '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', tmpFrame, '-y'
    ], { stdio: 'pipe', timeout: 15000 });

    const frameData = fs.readFileSync(tmpFrame).toString('base64');
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: frameData } },
          { type: 'text' as const, text: 'Find the scoreboard/score overlay in this basketball game frame. Return JSON only with no other text: {"x": leftPixel, "y": topPixel, "w": widthPixels, "h": heightPixels} — the bounding box of the scoreboard showing team scores. The image is 1280x720.' }
        ]
      }]
    });

    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { try { fs.unlinkSync(tmpFrame); } catch {} return DEFAULT; }
    const pos = JSON.parse(match[0]);
    if (pos.x >= 0 && pos.y >= 0 && pos.w > 50 && pos.h > 10) {
      console.log(`   🎯 Scoreboard found by AI at: x=${pos.x} y=${pos.y} w=${pos.w} h=${pos.h}`);
      try { fs.unlinkSync(tmpFrame); } catch {}
      return pos;
    }
    try { fs.unlinkSync(tmpFrame); } catch {}
    return DEFAULT;
  } catch (e) {
    console.log(`   ⚠️ Scoreboard finder failed, using default crop`);
    return DEFAULT;
  }
}

/** METHOD 1: Score change detection via OCR with AI-detected scoreboard position */
async function detectScoreChanges(videoPath: string, duration: number): Promise<DetectedEvent[]> {
  console.log('\n🔍 METHOD 1: Score change detection (OCR)...');

  const sb = await findScoreboardPosition(videoPath);
  const cropFilter = `crop=${sb.w}:${sb.h}:${sb.x}:${sb.y},fps=1,scale=640:-1,unsharp=5:5:2.0:5:5:0.0,eq=contrast=2.5:brightness=-0.05:saturation=0,format=gray`;
  console.log(`   🎯 Using crop: ${sb.w}x${sb.h} at ${sb.x},${sb.y}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-score-'));
  const outPattern = path.join(tmpDir, 'sb_%04d.png');

  try {
    execFileSync(FFMPEG, [
      '-i', videoPath,
      '-vf', cropFilter,
      '-q:v', '1', outPattern, '-y'
    ], { stdio: 'pipe', timeout: Math.max(duration * 2000, 120000) });
  } catch (err: any) {
    console.log(`   ⚠️ Scoreboard extraction failed: ${err.message}`);
    return [];
  }

  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
  console.log(`   📸 Extracted ${files.length} scoreboard frames`);

  try {
    const debugDir = '/tmp/ballbot-debug-scoreboard';
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
    const firstFrames = files.slice(0, 3);
    firstFrames.forEach((f, i) => {
      fs.copyFileSync(path.join(tmpDir, f), path.join(debugDir, `debug_frame_${i}.png`));
    });
    console.log(`   🔬 Debug scoreboard frames saved to ${debugDir} — crop: 550x60 at 730,600`);
  } catch (e) {}

  if (files.length < 2) {
    files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    return [];
  }

  // Pre-filter with pixel diff to find candidate frames (avoid OCR on every frame)
  const candidates: number[] = [];
  let prevBuf: Buffer | null = null;
  for (let i = 0; i < files.length; i++) {
    const curBuf = fs.readFileSync(path.join(tmpDir, files[i]));
    if (prevBuf) {
      const diff = compareBufferPixels(prevBuf, curBuf);
      console.log(`   📊 Pixel diff frame ${i}: ${diff.toFixed(3)}`);
      if (diff > 0.12) candidates.push(i);
    }
    prevBuf = curBuf;
  }
  console.log(`   🔎 ${candidates.length} candidate frames from pixel diff pre-filter`);

  if (candidates.length === 0) {
    // No pixel changes at all — nothing happened
    files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    try { fs.rmdirSync(tmpDir); } catch {}
    return [];
  }

  // OCR only the candidate frames and their predecessors
  const events: DetectedEvent[] = [];
  let ocrSuccessCount = 0;

  // Create a Tesseract worker for batch processing
  const worker = await Tesseract.createWorker('eng');

  try {
    const scoreCache = new Map<number, [number, number] | null>();

    // OCR a frame and cache the result
    async function getScore(frameIdx: number): Promise<[number, number] | null> {
      if (scoreCache.has(frameIdx)) return scoreCache.get(frameIdx)!;
      if (frameIdx < 0 || frameIdx >= files.length) return null;
      const filePath = path.join(tmpDir, files[frameIdx]);
      try {
        const { data: { text } } = await worker.recognize(filePath);
        const score = parseScoreFromText(text);
        scoreCache.set(frameIdx, score);
        if (score) ocrSuccessCount++;
        return score;
      } catch {
        scoreCache.set(frameIdx, null);
        return null;
      }
    }

    let lastConfirmedScore: [number, number] | null = null;
    let lastEventTimestamp = -999;

    for (const candidateIdx of candidates) {
      const prevScore = await getScore(candidateIdx - 1);
      const curScore = await getScore(candidateIdx);

      if (prevScore && curScore) {
        // Both frames have readable scores — validate the change
        const scoreChanged = prevScore[0] !== curScore[0] || prevScore[1] !== curScore[1];
        if (!scoreChanged) continue;

        // Scores can only increase, never decrease
        if (curScore[0] < prevScore[0] || curScore[1] < prevScore[1]) continue;

        // Max +3 points per score event (a 3-pointer is the max single play)
        const homeDiff = curScore[0] - prevScore[0];
        const awayDiff = curScore[1] - prevScore[1];
        if (homeDiff > 3 || awayDiff > 3) continue;

        // Also validate against last confirmed score if available
        if (lastConfirmedScore) {
          if (curScore[0] < lastConfirmedScore[0] || curScore[1] < lastConfirmedScore[1]) continue;
        }

        // Minimum 20 seconds between consecutive score change events
        if (candidateIdx - lastEventTimestamp < 20) continue;

        console.log(`   🏀 Score change at ${candidateIdx}s: ${prevScore.join('-')} → ${curScore.join('-')}`);
        events.push({ timestamp: candidateIdx, source: 'score' });
        lastConfirmedScore = curScore;
        lastEventTimestamp = candidateIdx;
      }
      // If OCR fails on either frame → skip (no more pixel-diff fallback, it's too noisy)
    }
  } finally {
    await worker.terminate();
  }

  // Cleanup
  files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
  try { fs.rmdirSync(tmpDir); } catch {}

  console.log(`   ✅ OCR: ${files.length} frames, ${candidates.length} candidates after diff filter, ${ocrSuccessCount} readable scores, ${events.length} score changes`);
  return events;
}

/** METHOD 2: Motion burst detection via ffmpeg scene detection */
function detectMotionBursts(videoPath: string): DetectedEvent[] {
  console.log('\n🔍 METHOD 2: Motion burst detection...');
  let stderr = '';
  try {
    execFileSync(FFMPEG, [
      '-i', videoPath,
      '-vf', "select='gt(scene,0.25)',showinfo",
      '-vsync', 'vfr',
      '-f', 'null', '-'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });
  } catch (err: any) {
    stderr = err.stderr || '';
  }
  const events: DetectedEvent[] = [];
  const ptsRegex = /pts_time:\s*([\d.]+)/g;
  let match;
  while ((match = ptsRegex.exec(stderr)) !== null) {
    events.push({ timestamp: Math.floor(parseFloat(match[1])), source: 'motion' });
  }
  console.log(`   🔍 Motion stderr length: ${stderr.length} chars, pts_time matches: ${events.length}`);
  console.log(`   ✅ Detected ${events.length} motion burst events`);
  return events;
}

function detectWhistles(videoPath: string): DetectedEvent[] {
  console.log('\n🔍 METHOD 3: Audio whistle detection...');
  try {
    let stderr = '';
    try {
      execFileSync(FFMPEG, [
        '-i', videoPath,
        '-af', 'bandpass=f=3000:width_type=h:w=1000,astats=metadata=1:reset=1:length=0.5',
        '-f', 'null', '-'
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });
    } catch (err: any) {
      stderr = err.stderr || '';
    }

    const events: DetectedEvent[] = [];
    const lines = stderr.split('\n');
    let currentTime = 0;

    for (const line of lines) {
      const timeMatch = line.match(/pts_time:([\d.]+)/);
      if (timeMatch) currentTime = parseFloat(timeMatch[1]);

      const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/);
      if (rmsMatch) {
        const rms = parseFloat(rmsMatch[1]);
        if (rms > -25) {
          events.push({ timestamp: Math.floor(currentTime), source: 'motion' });
        }
      }
    }

    console.log(`   ✅ Detected ${events.length} whistle/audio spike events`);
    return events;
  } catch (err: any) {
    console.log(`   ⚠️ Whistle detection failed: ${err.message?.substring(0, 100)}`);
    return [];
  }
}

/** Merge events from both methods, deduplicate within 10s, sort, and cap */
function mergeAndCapEvents(scoreEvents: DetectedEvent[], motionEvents: DetectedEvent[], duration: number): number[] {
  // Priority: score changes first, then motion bursts
  const allEvents = [...scoreEvents, ...motionEvents];
  allEvents.sort((a, b) => {
    if (a.source === 'score' && b.source === 'motion') return -1;
    if (a.source === 'motion' && b.source === 'score') return 1;
    return a.timestamp - b.timestamp;
  });

  // Deduplicate: remove events within 10s of an already-kept event
  const kept: number[] = [];
  for (const evt of allEvents) {
    const ts = evt.timestamp;
    if (ts < 2 || ts > duration - 5) continue; // skip very start/end
    const tooClose = kept.some(k => Math.abs(k - ts) < 10);
    if (!tooClose) kept.push(ts);
  }

  // Sort by time
  kept.sort((a, b) => a - b);

  // Dynamic cap: 20 for videos under 10min, MAX_CLIPS for longer
  const cap = duration < 600 ? 20 : MAX_CLIPS;
  if (kept.length > cap) {
    console.log(`   ⚠️ ${kept.length} events detected, capping to ${cap}`);
    return kept.slice(0, cap);
  }

  return kept;
}

// 16 second window: event-4 to event+12, 5 frames at 3s intervals
const CLIP_OFFSETS = [0, 2, 4, 6, 8, 10, 12, 14]; // seconds from startTime
const CLIP_PRE_EVENT = 4; // seconds before event
const FRAME_LABELS = ['לפני המהלך', 'תחילת פעולה', 'פיתוח', 'שיא', 'החלטה', 'ביצוע', 'תגובה', 'תוצאה'];

/** Extract 5 frames from a 16s clip around an event timestamp */
function extractClipFrames(videoPath: string, eventTime: number, clipDir: string, resolution?: { width: number; height: number }): string[] {
  const startTime = Math.max(0, eventTime - CLIP_PRE_EVENT);
  const frames: string[] = [];

  for (const offset of CLIP_OFFSETS) {
    const ts = startTime + offset;
    const outPath = path.join(clipDir, `event_${eventTime}_frame_${offset}.jpg`);
    try {
      const scaleFilter = resolution ? `scale=${resolution.width}:${resolution.height}` : 'scale=1280:720';
      execFileSync(FFMPEG, [
        '-ss', String(ts), '-i', videoPath,
        '-frames:v', '1', '-vf', scaleFilter, '-q:v', '1', outPath, '-y'
      ], { stdio: 'pipe', timeout: 15000 });
      if (fs.existsSync(outPath)) frames.push(outPath);
    } catch {}
  }

  return frames;
}

/** Post-process a frame for Claude Vision: crop court area + enhance contrast/saturation */
function processFrameForVision(framePath: string): string {
  const processedPath = framePath.replace('.jpg', '_processed.jpg');
  try {
    execFileSync(FFMPEG, [
      '-i', framePath,
      '-vf', 'crop=iw:ih*0.75:0:ih*0.12,eq=contrast=1.3:brightness=0.05:saturation=1.4',
      '-q:v', '2', processedPath, '-y'
    ], { stdio: 'pipe', timeout: 10000 });
    if (fs.existsSync(processedPath)) return processedPath;
  } catch {}
  return framePath; // fallback to original if processing fails
}

// ============================================================
// PER-CLIP ANALYSIS
// ============================================================

/** Analyze a single clip (5 frames around one event) */
async function analyzeClip(
  client: Anthropic,
  clipFrames: string[],
  eventTime: number,
  context: string,
  focus: string,
  roster?: RosterPlayer[],
  teamName?: string,
  awayTeam?: string,
  jobId?: string,
  corrections?: string,
): Promise<AnalysisResult> {
  const humanTime = formatTimestampHuman(eventTime);
  const startTime = Math.max(0, eventTime - CLIP_PRE_EVENT);

  const contentBlocks: (Anthropic.ImageBlockParam | Anthropic.TextBlockParam)[] = [];
  const processedPaths: string[] = [];
  clipFrames.forEach((framePath, i) => {
    const visionPath = processFrameForVision(framePath);
    if (visionPath !== framePath) processedPaths.push(visionPath);
    const data = fs.readFileSync(visionPath).toString('base64');
    const frameTime = formatTimestampHuman(startTime + CLIP_OFFSETS[i]);
    const label = FRAME_LABELS[i] || '';
    contentBlocks.push({ type: 'text' as const, text: `Frame ${i + 1} — ${frameTime} — ${label}` });
    contentBlocks.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });
  });

  const frameTimestamps = CLIP_OFFSETS.map(o => formatTimestampHuman(startTime + o));

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `Clip around ${humanTime}. Frame timestamps: ${frameTimestamps.join(', ')}

You have 8 frames covering 14 seconds.
Frames 1-2 = before the play. Frames 3-5 = action develops. Frames 6-7 = execution. Frame 8 = final outcome.
Use Frame 8 to determine if the play succeeded or failed.
Use Frame 2 timestamp as start_time, Frame 8 timestamp as end_time.

If no clear play with visible outcome → return {"game":"","plays":[],"insights":[],"shotChart":{}}

פוקוס: ${focus} | הקשר: ${context || 'אין'}
החזר JSON בלבד.`,
  };

  console.log(`   👥 Roster in clip prompt: ${roster?.length || 0} players`);
  if (roster?.length) console.log(`   👤 First player: ${JSON.stringify(roster[0])}`);

  const response = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: buildCachedSystemPrompt(roster, teamName, awayTeam, corrections),
    messages: [{ role: 'user', content: [...contentBlocks, textBlock] }],
  }, jobId);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log(`   📊 Clip ${humanTime}: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out tokens`);

  // Cleanup processed frames
  processedPaths.forEach(f => { try { fs.unlinkSync(f); } catch {} });

  const greedyMatch = text.match(/\{[\s\S]*\}/);
  if (!greedyMatch) {
    console.warn(`   ⚠️ No JSON found for clip at ${humanTime}, skipping`);
    return { game: '', plays: [], insights: [], shotChart: { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 } };
  }
  try {
    const parsed = JSON.parse(greedyMatch[0]);
    if (!parsed.plays) parsed.plays = [];
    if (!parsed.insights) parsed.insights = [];
    if (!parsed.shotChart) parsed.shotChart = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
    return parsed;
  } catch (e) {
    console.warn(`   ⚠️ JSON parse failed for clip at ${humanTime}: ${e}`);
    console.warn(`   Raw text sample: ${text.substring(0, 200)}`);
    return { game: '', plays: [], insights: [], shotChart: { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 } };
  }
}

// ============================================================
// MAIN EVENT-BASED PIPELINE
// ============================================================

/** Full event-based analysis: detect events → extract clips → analyze each */
async function analyzeVideoEvents(
  videoPath: string,
  context: string,
  focus: string,
  roster?: RosterPlayer[],
  teamName?: string,
  awayTeam?: string,
  jobId?: string,
): Promise<AnalysisResult> {
  const duration = getVideoDuration(videoPath);
  console.log(`\n🏀 Event-based analysis: ${(duration / 60).toFixed(1)} min video`);

  // Step 1: Detect events
  if (jobId) await updateJobProgress(jobId, 15, 'מזהה רגעים חשובים בסרטון...');

  const resolution = getVideoResolution(videoPath);
  const scoreEvents = await detectScoreChanges(videoPath, duration);
  const motionEvents = detectMotionBursts(videoPath);
  let whistleEvents: DetectedEvent[] = [];
  try {
    whistleEvents = detectWhistles(videoPath);
  } catch (e) {
    console.log('   ⚠️ Whistle detection skipped:', e);
  }
  const allMotionEvents = [...motionEvents, ...whistleEvents];
  const eventTimestamps = mergeAndCapEvents(scoreEvents, allMotionEvents, duration);

  if (eventTimestamps.length === 0) {
    console.log('   ⚠️ No events detected — falling back to equal interval sampling');
    if (jobId) await updateJobProgress(jobId, 20, 'לא זוהו רגעים — מחלץ פריימים בפיזור שווה...');
    // Fallback: 20 equal interval timestamps
    const step = duration / 21;
    for (let i = 1; i <= 20; i++) {
      eventTimestamps.push(Math.floor(step * i));
    }
  }

  console.log(`\n📋 ${eventTimestamps.length} events to analyze`);
  if (jobId) await updateJobProgress(jobId, 25, `נמצאו ${eventTimestamps.length} רגעים — מנתח...`);

  // Step 2: Extract clip frames and analyze each event
  const corrections = await loadRecentCorrections();
  const client = getClient();
  const clipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-clips-'));

  const allPlays: AnalysisResult['plays'] = [];
  const allInsights: AnalysisResult['insights'] = [];
  let lastShotChart: AnalysisResult['shotChart'] = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
  let gameSummary = '';

  for (let i = 0; i < eventTimestamps.length; i++) {
    const eventTime = eventTimestamps[i];
    const humanTime = formatTimestampHuman(eventTime);
    const clipNum = i + 1;

    const progressPct = Math.round(30 + (clipNum / eventTimestamps.length) * 60);
    if (jobId) await updateJobProgress(jobId, progressPct, `מנתח רגע ${clipNum} מתוך ${eventTimestamps.length} — ${humanTime}`);
    console.log(`   📡 Clip ${clipNum}/${eventTimestamps.length}: event at ${humanTime}`);

    // Extract 5 frames for this clip
    const clipFrames = extractClipFrames(videoPath, eventTime, clipDir, resolution);
    if (clipFrames.length === 0) {
      console.log(`   ⚠️ No frames extracted for event at ${humanTime}, skipping`);
      continue;
    }

    // Analyze the clip
    const clipResult = await analyzeClip(client, clipFrames, eventTime, context, focus, roster, teamName, awayTeam, jobId, corrections);

    if (clipResult.plays) allPlays.push(...clipResult.plays);
    if (clipResult.insights) allInsights.push(...clipResult.insights);
    if (clipResult.shotChart) lastShotChart = clipResult.shotChart;
    if (clipResult.game) gameSummary = clipResult.game;

    console.log(`   ✅ Clip ${clipNum}: ${clipResult.plays?.length || 0} plays`);

    // Cleanup clip frames
    clipFrames.forEach(f => { try { fs.unlinkSync(f); } catch {} });

    // Wait between clips to avoid rate limit
    if (i < eventTimestamps.length - 1) {
      console.log(`   ⏳ Waiting ${CLIP_DELAY_MS / 1000}s before next clip...`);
      await sleep(CLIP_DELAY_MS);
    }
  }

  // Cleanup
  try { fs.rmdirSync(clipDir); } catch {}

  const result: AnalysisResult = {
    game: gameSummary || 'ניתוח משחק כדורסל',
    plays: allPlays,
    insights: allInsights,
    shotChart: lastShotChart,
  };

  console.log(`   ✅ All clips done: ${result.plays.length} plays, ${result.insights.length} insights`);
  if (jobId) await updateJobProgress(jobId, 95, `נמצאו ${result.plays.length} מהלכים — שומר...`);
  return result;
}

// ============================================================
// PUBLIC API
// ============================================================

/** Analyze Google Drive video: download → detect events → analyze clips */
export async function analyzeGoogleDrive(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GOOGLE DRIVE ANALYSIS ==========');
  if (jobId) await updateJobProgress(jobId, 5, 'מוריד סרטון מ-Google Drive...');
  const videoPath = downloadGoogleDrive(url);
  if (jobId) await updateJobProgress(jobId, 10, 'הורדה הושלמה — מזהה רגעים...');

  const result = await analyzeVideoEvents(videoPath, context, focus, roster, teamName, awayTeam, jobId);

  try { fs.unlinkSync(videoPath); } catch {}
  console.log('🏀 ========== GOOGLE DRIVE COMPLETE ==========\n');
  return result;
}

/** Analyze YouTube — full pipeline: download → detect events → analyze clips */
export async function analyzeYouTube(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS ==========');
  if (jobId) await updateJobProgress(jobId, 5, 'מוריד סרטון מ-YouTube...');
  const videoPath = downloadYouTube(url);
  if (jobId) await updateJobProgress(jobId, 10, 'הורדה הושלמה — מזהה רגעים...');

  const result = await analyzeVideoEvents(videoPath, context, focus, roster, teamName, awayTeam, jobId);

  try { fs.unlinkSync(videoPath); } catch {}
  console.log('🏀 ========== YOUTUBE COMPLETE ==========\n');
  return result;
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS ==========');
  if (jobId) await updateJobProgress(jobId, 10, 'מזהה רגעים חשובים בסרטון...');

  const result = await analyzeVideoEvents(videoPath, context, focus, roster, teamName, awayTeam, jobId);

  console.log('🏀 ========== VIDEO COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file (no event detection — just send to Claude) */
export async function analyzeImage(imagePath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  console.log('   👥 Roster in prompt:', roster?.length || 0, 'players');
  if (roster?.length) console.log('   👤 First player:', JSON.stringify(roster[0]));
  const client = getClient();
  const data = fs.readFileSync(imagePath).toString('base64');

  const response = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: buildCachedSystemPrompt(roster, teamName, awayTeam),
    messages: [{
      role: 'user',
      content: [
        { type: 'text' as const, text: `Frame 1 — single image` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } },
        { type: 'text' as const, text: `פוקוס: ${focus}\nהקשר: ${context || 'אין'}\nנתח את התמונה והחזר JSON.` },
      ],
    }],
  }, jobId);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('לא נמצא JSON בתגובת Claude');
  return JSON.parse(jsonMatch[0]);
}
