import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { Job } from './database';

/** Update job progress in MongoDB */
export async function updateJobProgress(jobId: string, progress: number, progressMessage: string): Promise<void> {
  try {
    await Job.updateOne({ jobId }, { progress, progressMessage, updatedAt: new Date() });
  } catch (err) {
    console.warn(`⚠️ Failed to update job ${jobId} progress:`, err);
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

const SYSTEM_PROMPT = `You are an expert basketball analyst and assistant coach.
You are watching 5 frames from a 16 second clip around a detected event.
Frame 1 = before the play. Frame 2 = play starts. Frame 3 = peak action. Frame 4 = decision moment. Frame 5 = outcome.

STRICT FILTER — only write a note if ALL of these are true:
1. You can identify a specific play type (חדירה לסל, פיק אנד רול, מתפרצת, חטיפת כדור, איבוד כדור, זריקה, הגנה, etc.)
2. You can see the outcome in Frame 5
3. The play involves the home team
If any of these is false → return empty plays array.

ONE note per clip maximum.
Target: 6-10 notes for a 5 minute video.

Return JSON only:
{"game":"תיאור","plays":[{"start_time":"0:00","end_time":"0:12","type":"Offense|Defense|Transition","label":"שם","note":"הערה","players":["שחקן"]}],"insights":[{"type":"good|warn|bad","title":"כותרת","body":"פירוט"}],"shotChart":{"paint":45,"midRange":30,"corner3":35,"aboveBreak3":28,"pullUp":20}}

For each note follow this exact structure in the "note" field:
מה קרה: [play type in Hebrew basketball terms]
מי ביצע: [player name from roster or description]
תוצאה: [what happened in Frame 5 — score/turnover/stop/miss]
משמעות: [one sentence tactical meaning for the coach]

VERDICT — every note must end with one of:
✅ ביצוע טוב — [why]
❌ שגיאה טקטית — [what should have been done instead]
⚠️ לתשומת לב — [pattern to watch]

RULES:
- Only analyze HOME team players. If a player is in the roster, use their name.
- Never invent moments you did not see
- Never write a timestamp you were not given
- Use Frame 2 timestamp as start_time, Frame 5 timestamp as end_time
- All output must be in Hebrew

HEBREW BASKETBALL TERMS:
coast to coast = קוסט טו קוסט | pull-up jumper = ג'אמפשוט בעצירה | pick and roll = פיק אנד רול
fast break = מתפרצת | steal = חטיפת כדור | jump ball = כדור חופשי | turnover = איבוד כדור
transition defense = הגנת מעבר | help defense = הגנת סיוע | drive = חדירה לסל
kick out = פאס החוצה | post up = גב לסל | iso = אחד על אחד | double team = דאבל טים
screen = פיק / חסימה | rebound = ריבאונד | block = בלוק | charge = פאול תוקף`;

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
function buildCachedSystemPrompt(roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Anthropic.TextBlockParam[] {
  let prompt = SYSTEM_PROMPT;
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
  // Sample every 4th byte for speed (still accurate enough)
  const step = 4;
  let samples = 0;
  for (let i = 0; i < len; i += step) {
    samples++;
    if (Math.abs(a[i] - b[i]) > 30) diffCount++; // pixel value changed by >30/255
  }
  return samples > 0 ? diffCount / samples : 0;
}

/** METHOD 1: Score change detection via scoreboard pixel diff */
function detectScoreChanges(videoPath: string, duration: number): DetectedEvent[] {
  console.log('\n🔍 METHOD 1: Score change detection...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-score-'));
  const outPattern = path.join(tmpDir, 'sb_%04d.bmp');

  try {
    // Extract 1fps scoreboard crops — top-right 30% width, top 12% height (score numbers area)
    // Output as BMP for raw pixel comparison (no JPEG compression artifacts)
    execFileSync(FFMPEG, [
      '-i', videoPath,
      '-vf', 'crop=iw*0.3:ih*0.12:iw*0.7:0,fps=1,scale=120:20',
      '-q:v', '2', outPattern, '-y'
    ], { stdio: 'pipe', timeout: Math.max(duration * 2000, 120000) });
  } catch (err: any) {
    console.log(`   ⚠️ Scoreboard extraction failed: ${err.message}`);
    return [];
  }

  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.bmp')).sort();
  console.log(`   📸 Extracted ${files.length} scoreboard frames`);

  if (files.length < 2) {
    files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    return [];
  }

  const events: DetectedEvent[] = [];
  let prevBuf: Buffer | null = null;

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(tmpDir, files[i]);
    const curBuf = fs.readFileSync(filePath);

    if (prevBuf) {
      const diffPct = compareBufferPixels(prevBuf, curBuf);
      if (diffPct > 0.15) { // >15% pixel difference = likely score change
        events.push({ timestamp: i, source: 'score' });
      }
    }
    prevBuf = curBuf;
  }

  // Cleanup
  files.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
  try { fs.rmdirSync(tmpDir); } catch {}

  console.log(`   ✅ Detected ${events.length} score change events`);
  return events;
}

/** METHOD 2: Motion burst detection via ffmpeg scene detection */
function detectMotionBursts(videoPath: string): DetectedEvent[] {
  console.log('\n🔍 METHOD 2: Motion burst detection...');

  try {
    const output = execFileSync(FFMPEG, [
      '-i', videoPath,
      '-vf', "select='gt(scene,0.4)',showinfo",
      '-vsync', 'vfr',
      '-f', 'null', '-'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });

    // Parse pts_time from stderr (ffmpeg writes showinfo to stderr)
    // But execFileSync merges or may not capture stderr well, so try stdout too
    const allOutput = output || '';
    const events: DetectedEvent[] = [];
    const ptsRegex = /pts_time:\s*([\d.]+)/g;
    let match;
    while ((match = ptsRegex.exec(allOutput)) !== null) {
      events.push({ timestamp: Math.floor(parseFloat(match[1])), source: 'motion' });
    }

    console.log(`   ✅ Detected ${events.length} motion burst events`);
    return events;
  } catch (err: any) {
    // ffmpeg scene detection writes to stderr; capture it from the error
    const stderr = err.stderr || '';
    const events: DetectedEvent[] = [];
    const ptsRegex = /pts_time:\s*([\d.]+)/g;
    let match;
    while ((match = ptsRegex.exec(stderr)) !== null) {
      events.push({ timestamp: Math.floor(parseFloat(match[1])), source: 'motion' });
    }

    if (events.length > 0) {
      console.log(`   ✅ Detected ${events.length} motion burst events (from stderr)`);
      return events;
    }

    console.log(`   ⚠️ Motion detection failed: ${err.message}`);
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

  // Cap at MAX_CLIPS
  if (kept.length > MAX_CLIPS) {
    console.log(`   ⚠️ ${kept.length} events detected, capping to ${MAX_CLIPS}`);
    // Keep score-priority order: the first MAX_CLIPS were already priority-sorted
    return kept.slice(0, MAX_CLIPS);
  }

  return kept;
}

// 16 second window: event-4 to event+12, 5 frames at 3s intervals
const CLIP_OFFSETS = [0, 3, 6, 9, 12]; // seconds from startTime
const CLIP_PRE_EVENT = 4; // seconds before event
const FRAME_LABELS = ['לפני המהלך', 'תחילת המהלך', 'שיא הפעולה', 'רגע ההחלטה', 'תוצאה'];

/** Extract 5 frames from a 16s clip around an event timestamp */
function extractClipFrames(videoPath: string, eventTime: number, clipDir: string): string[] {
  const startTime = Math.max(0, eventTime - CLIP_PRE_EVENT);
  const frames: string[] = [];

  for (const offset of CLIP_OFFSETS) {
    const ts = startTime + offset;
    const outPath = path.join(clipDir, `event_${eventTime}_frame_${offset}.jpg`);
    try {
      execFileSync(FFMPEG, [
        '-ss', String(ts), '-i', videoPath,
        '-frames:v', '1', '-q:v', '2', outPath, '-y'
      ], { stdio: 'pipe', timeout: 15000 });
      if (fs.existsSync(outPath)) frames.push(outPath);
    } catch {}
  }

  return frames;
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
): Promise<AnalysisResult> {
  const humanTime = formatTimestampHuman(eventTime);
  const startTime = Math.max(0, eventTime - CLIP_PRE_EVENT);

  const contentBlocks: (Anthropic.ImageBlockParam | Anthropic.TextBlockParam)[] = [];
  clipFrames.forEach((framePath, i) => {
    const data = fs.readFileSync(framePath).toString('base64');
    const frameTime = formatTimestampHuman(startTime + CLIP_OFFSETS[i]);
    const label = FRAME_LABELS[i] || '';
    contentBlocks.push({ type: 'text' as const, text: `Frame ${i + 1} — ${frameTime} — ${label}` });
    contentBlocks.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });
  });

  const frameTimestamps = CLIP_OFFSETS.map(o => formatTimestampHuman(startTime + o));
  const frame2Time = frameTimestamps[1]; // play start
  const frame5Time = frameTimestamps[4]; // outcome

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `Clip around ${humanTime}. Frame timestamps: ${frameTimestamps.join(', ')}

Frame 5 shows the OUTCOME of the play.
Use Frame 5 to determine if the play succeeded or failed.
Use Frame 2 timestamp (${frame2Time}) as start_time, Frame 5 timestamp (${frame5Time}) as end_time.

If no clear play with visible outcome → return {"game":"","plays":[],"insights":[],"shotChart":{}}

פוקוס: ${focus} | הקשר: ${context || 'אין'}
החזר JSON בלבד.`,
  };

  console.log(`   👥 Roster in clip prompt: ${roster?.length || 0} players`);
  if (roster?.length) console.log(`   👤 First player: ${JSON.stringify(roster[0])}`);

  const response = await callClaudeWithRetry(client, {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: buildCachedSystemPrompt(roster, teamName, awayTeam),
    messages: [{ role: 'user', content: [...contentBlocks, textBlock] }],
  }, jobId);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log(`   📊 Clip ${humanTime}: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out tokens`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(`   ⚠️ No JSON for clip at ${humanTime}, skipping`);
    return { game: '', plays: [], insights: [], shotChart: { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 } };
  }

  return JSON.parse(jsonMatch[0]);
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

  const scoreEvents = detectScoreChanges(videoPath, duration);
  const motionEvents = detectMotionBursts(videoPath);
  const eventTimestamps = mergeAndCapEvents(scoreEvents, motionEvents, duration);

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
    const clipFrames = extractClipFrames(videoPath, eventTime, clipDir);
    if (clipFrames.length === 0) {
      console.log(`   ⚠️ No frames extracted for event at ${humanTime}, skipping`);
      continue;
    }

    // Analyze the clip
    const clipResult = await analyzeClip(client, clipFrames, eventTime, context, focus, roster, teamName, awayTeam, jobId);

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
