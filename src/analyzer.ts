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

const SYSTEM_PROMPT = `אתה אנליסט כדורסל. נתח פריימים ממשחק והחזר JSON בלבד:
{"game":"תיאור","plays":[{"time":"00:00","type":"Offense|Defense|Transition","label":"שם","note":"הערה","players":["#5"]}],"insights":[{"type":"good|warn|bad","title":"כותרת","body":"פירוט"}],"shotChart":{"paint":45,"midRange":30,"corner3":35,"aboveBreak3":28,"pullUp":20}}

כללים:
- חלץ 1-3 מהלכים מכל פריים. תאר רק מה שנראה בפריים, אל תנחש.
- דלג על: שידורים חוזרים, טיימאאוטים, קהל, פרסומת, קלוז-אפ על מאמן.
- בלוק=חסימת כדור חוקית. פאול=פגיעה בזרוע/גוף. אל תבלבל.
- אין לציין או לנסות לזהות מספרי גופיות.
- זיהוי קבוצות לפי צבע: הפועל ת"א=אדום, מכבי ת"א=צהוב, הפועל י-ם=שחור, מכבי חיפה=ירוק, הפועל חיפה=אדום, מכבי רעננה=כחול.
- תאריך הזמן בשדה time חייב להיות MM:SS (למשל 03:00), לא 00h03m00s.
- כל טקסט בעברית. הערה נפרדת לכל מהלך.`;

export interface AnalysisResult {
  game: string;
  plays: { time: string; type: string; label: string; note: string; players: string[] }[];
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

function buildSystemPrompt(roster?: RosterPlayer[], teamName?: string, awayTeam?: string): string {
  let prompt = SYSTEM_PROMPT;
  if (roster && roster.length > 0) {
    const home = teamName || 'הקבוצה שלנו';
    const away = awayTeam || 'היריב';
    const rosterText = roster.map(p => `#${p.number} ${p.name} - ${p.position}`).join('\n');
    prompt += `\nבית: ${home} | חוץ: ${away}
נתח רק את ${home}. אם ${away} מבקיע כתוב "הספגנו סל". אם לא בטוח מי השחקן כתוב "שחקן ${home}".
אין לציין מספרי גופיות.
בכל מהלך, time חייב להיות בפורמט MM:SS (למשל 03:00).
רוסטר ${home}:
${rosterText}`;
  }
  return prompt;
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
          if (buf.length < 1000) { resolve(null); return; } // too small = placeholder
          resolve({ data: buf.toString('base64'), type: res.headers['content-type'] || 'image/jpeg' });
        });
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    };
    request(url);
  });
}

/** Fetch YouTube thumbnails at multiple timestamps via storyboard */
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
  console.log(`   URL: ${url}`);

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('לא הצלחתי לחלץ מזהה סרטון מהקישור');

  if (jobId) await updateJobProgress(jobId, 10, 'מוריד תמונות מ-YouTube...');

  // Fetch thumbnails + metadata in parallel
  const [thumbs, metadata] = await Promise.all([
    fetchYouTubeThumbnails(videoId),
    fetchYouTubeMetadata(url),
  ]);

  if (thumbs.length === 0) throw new Error('לא הצלחתי לטעון תמונות מהסרטון');

  if (jobId) await updateJobProgress(jobId, 30, `נמצאו ${thumbs.length} תמונות — שולח ל-Claude...`);

  console.log(`\n🤖 Sending ${thumbs.length} thumbnails to Claude Vision...`);
  const client = getClient();

  const imageBlocks: Anthropic.ImageBlockParam[] = thumbs.map((t) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: t.data },
  }));

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `${metadata}\nפוקוס ניתוח: ${focus}\nהקשר: ${context || 'אין הקשר נוסף'}\n\nנתח את התמונות האלה מהמשחק והחזר JSON.`,
  };

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8192,
    system: buildSystemPrompt(roster, teamName, awayTeam),
    messages: [{ role: 'user', content: [...imageBlocks, textBlock] }],
  });

  if (jobId) await updateJobProgress(jobId, 80, 'מעבד תוצאות...');

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  console.log(`   ✅ Claude responded (${text.length} chars)`);
  console.log(`   📊 Usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('לא נמצא JSON בתגובת Claude');

  const result: AnalysisResult = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Parsed: ${result.plays?.length || 0} plays, ${result.insights?.length || 0} insights`);
  if (jobId) await updateJobProgress(jobId, 95, `נמצאו ${result.plays?.length || 0} מהלכים — שומר...`);
  console.log('☁️ ========== CLOUD ANALYSIS COMPLETE ==========\n');
  return result;
}

// ============================================================
// LOCAL MODE: yt-dlp + ffmpeg + Claude Vision (full pipeline)
// ============================================================

/** Download YouTube video using yt-dlp */
export function downloadYouTube(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-yt-'));
  const outTemplate = path.join(tmpDir, 'video.%(ext)s');
  console.log(`\n📥 [1/4] Downloading YouTube video: ${url}`);

  const cleanUrl = url.split('&t=')[0];
  const ytdlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
  const cmd = `${ytdlp} --no-check-certificates --no-playlist --extractor-retries 3 --socket-timeout 30 -o "${outTemplate}" "${cleanUrl}"`;
  console.log(`   CMD: ${cmd}`);

  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
    console.log(`   yt-dlp stdout:\n${output}`);
  } catch (err: any) {
    console.error(`   ❌ yt-dlp FAILED`);
    console.error(`   CMD: ${cmd}`);
    console.error(`   EXIT CODE: ${err.status}`);
    console.error(`   STDOUT: ${err.stdout || '(empty)'}`);
    console.error(`   STDERR: ${err.stderr || '(empty)'}`);
    throw new Error(`yt-dlp failed (exit ${err.status}): ${err.stderr || err.message}`);
  }

  const files = fs.readdirSync(tmpDir);
  console.log(`   📂 Files in tmpDir: ${files.join(', ')}`);
  if (files.length === 0) throw new Error('yt-dlp produced no output file');
  const videoFile = files[0];
  const videoPath = path.join(tmpDir, videoFile);

  const stat = fs.statSync(videoPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${videoPath}`);
  return videoPath;
}

// ============================================================
// FRAME EXTRACTION HELPERS
// ============================================================

const LONG_VIDEO_THRESHOLD = 30 * 60; // 30 minutes in seconds

/** Get video duration in seconds using ffprobe */
function getVideoDuration(videoPath: string): number {
  const durationStr = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
  ], { encoding: 'utf-8', timeout: 30000 }).trim();
  return parseFloat(durationStr);
}

/** Extract frames at specific timestamps (in seconds) */
function extractFramesAtSeconds(videoPath: string, timestamps: number[]): string[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-ts-frames-'));
  const frames: string[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = path.join(tmpDir, `frame_${formatTimestampFilename(ts)}.jpg`);
    try {
      execFileSync(FFMPEG, [
        '-ss', String(ts), '-i', videoPath,
        '-frames:v', '1', '-q:v', '2', outPath, '-y'
      ], { stdio: 'pipe', timeout: 30000 });
      if (fs.existsSync(outPath)) frames.push(outPath);
    } catch {
      console.log(`   ⚠️ Failed to extract frame at ${ts}s`);
    }
  }

  return frames;
}

/** Parse "MM:SS" or "HH:MM:SS" to seconds */
function timestampToSeconds(ts: string): number | null {
  const parts = ts.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** Format seconds as "MM:SS" */
function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format seconds as "00h04m46s" for embedding in frame filenames */
function formatTimestampFilename(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
}

interface QuarterInfo {
  quarter: number;
  videoTimestamp: string;
  seconds: number;
}

/** Step 1: Quick scan — detect quarter start times using Claude Vision */
async function detectQuarters(videoPath: string, duration: number): Promise<QuarterInfo[] | null> {
  console.log(`\n🔍 Quarter detection: scanning ${formatTimestamp(duration)} video...`);

  // For videos >60 min, scan every 3 minutes; otherwise every 1 minute
  const scanInterval = duration > 60 * 60 ? 180 : 60;
  const scanTimestamps: number[] = [];
  for (let t = 0; t < duration; t += scanInterval) {
    scanTimestamps.push(t);
  }
  console.log(`   📸 Extracting ${scanTimestamps.length} scan frames (1 every ${scanInterval}s)...`);

  const scanFrames = extractFramesAtSeconds(videoPath, scanTimestamps);
  if (scanFrames.length === 0) {
    console.log('   ❌ No scan frames extracted');
    return null;
  }
  console.log(`   ✅ Got ${scanFrames.length} scan frames`);

  // Send to Claude for quarter detection
  const client = getClient();
  const imageBlocks: Anthropic.ImageBlockParam[] = scanFrames.map((framePath, i) => {
    const data = fs.readFileSync(framePath).toString('base64');
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    };
  });

  // Build timestamp labels so Claude knows which frame is which
  const frameLabels = scanTimestamps.slice(0, scanFrames.length)
    .map((ts, i) => `Frame ${i + 1}: ${formatTimestamp(ts)}`).join('\n');

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `Look at these frames from a basketball game broadcast.
Each frame is taken at the following video timestamps:
${frameLabels}

Find the timestamps in the video where each quarter starts (Q1, Q2, Q3, Q4).
Look for the scoreboard which shows quarter number and game clock.
A new quarter starts when the game clock resets to the beginning (10:00 or 12:00).
Q1 typically starts near the beginning of the video.

Return JSON only, no other text:
{ "quarters": [{"quarter": 1, "videoTimestamp": "00:08:30"}, {"quarter": 2, "videoTimestamp": "00:22:15"}, {"quarter": 3, "videoTimestamp": "00:45:00"}, {"quarter": 4, "videoTimestamp": "01:05:30"}] }

videoTimestamp must be in MM:SS or HH:MM:SS format referring to the video time, not the game clock.
Return all quarters you can identify. If you can't find a quarter, skip it.`,
  };

  console.log(`   🤖 Sending ${scanFrames.length} frames to Claude for quarter detection...`);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [...imageBlocks, textBlock] }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    console.log(`   📊 Quarter detection usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);
    console.log(`   📝 Raw response: ${text.substring(0, 300)}`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('   ⚠️ No JSON found in quarter detection response');
      return null;
    }

    const data = JSON.parse(jsonMatch[0]);
    const quarters: QuarterInfo[] = (data.quarters || [])
      .map((q: any) => {
        const secs = timestampToSeconds(q.videoTimestamp);
        if (secs == null) return null;
        return { quarter: q.quarter, videoTimestamp: q.videoTimestamp, seconds: secs };
      })
      .filter((q: QuarterInfo | null): q is QuarterInfo => q !== null)
      .sort((a: QuarterInfo, b: QuarterInfo) => a.quarter - b.quarter);

    if (quarters.length === 0) {
      console.log('   ⚠️ No valid quarters detected');
      return null;
    }

    console.log(`   ✅ Detected ${quarters.length} quarters:`);
    quarters.forEach(q => console.log(`      Q${q.quarter}: ${q.videoTimestamp} (${q.seconds}s)`));

    // Cleanup scan frames
    scanFrames.forEach(f => { try { fs.unlinkSync(f); } catch {} });

    return quarters;
  } catch (err: any) {
    console.log(`   ⚠️ Quarter detection failed: ${err.message}`);
    scanFrames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return null;
  }
}

/** Step 2: Smart extraction — 5 frames per quarter using detected boundaries */
function extractSmartFrames(videoPath: string, quarters: QuarterInfo[], duration: number): string[] {
  console.log(`\n📸 Smart frame extraction: 6 frames per quarter...`);
  const FRAMES_PER_QUARTER = 5;
  const timestamps: number[] = [];

  for (let i = 0; i < quarters.length; i++) {
    const start = quarters[i].seconds;
    const end = (i + 1 < quarters.length) ? quarters[i + 1].seconds : duration;
    const quarterDuration = end - start;
    const step = quarterDuration / (FRAMES_PER_QUARTER + 1);

    for (let j = 1; j <= FRAMES_PER_QUARTER; j++) {
      const ts = Math.floor(start + step * j);
      timestamps.push(Math.min(ts, duration - 1));
    }
    console.log(`   Q${quarters[i].quarter}: ${formatTimestamp(start)} → ${formatTimestamp(end)} (${FRAMES_PER_QUARTER} frames, every ${formatTimestamp(step)})`);
  }

  console.log(`   📸 Extracting ${timestamps.length} frames at smart positions...`);
  return extractFramesAtSeconds(videoPath, timestamps);
}

/** Fallback: equal time splits for 20 frames */
function extractEqualSplitFrames(videoPath: string, duration: number): string[] {
  console.log(`\n📸 Fallback: extracting 20 frames at equal intervals...`);
  const TOTAL_FRAMES = 20;
  const step = duration / (TOTAL_FRAMES + 1);
  const timestamps: number[] = [];
  for (let i = 1; i <= TOTAL_FRAMES; i++) {
    timestamps.push(Math.floor(step * i));
  }
  return extractFramesAtSeconds(videoPath, timestamps);
}

/** Extract frames — smart quarter-based for long videos, simple for short */
async function extractFramesSmart(videoPath: string): Promise<string[]> {
  const duration = getVideoDuration(videoPath);
  console.log(`   📹 Video duration: ${formatTimestamp(duration)} (${duration.toFixed(1)}s)`);

  if (duration > LONG_VIDEO_THRESHOLD) {
    console.log(`   📹 Long video detected (>${LONG_VIDEO_THRESHOLD / 60}min) — using quarter detection`);

    const quarters = await detectQuarters(videoPath, duration);
    if (quarters && quarters.length >= 2) {
      const frames = extractSmartFrames(videoPath, quarters, duration);
      if (frames.length > 0) {
        console.log(`   ✅ Smart extraction: ${frames.length} frames across ${quarters.length} quarters`);
        return frames;
      }
    }

    // Fallback to equal splits
    console.log('   ⚠️ Quarter detection failed or insufficient — falling back to equal splits');
    const frames = extractEqualSplitFrames(videoPath, duration);
    if (frames.length > 0) return frames;
  }

  // Short video: original logic — 1 frame every 5 seconds, cap at 20
  return extractFramesSimple(videoPath, duration);
}

/** Original simple extraction for short videos */
function extractFramesSimple(videoPath: string, duration: number): string[] {
  console.log(`\n📸 Simple extraction (1 frame every 3 minutes)...`);

  const interval = 180; // 3 minutes
  const timestamps: number[] = [];
  for (let t = interval; t < duration; t += interval) {
    timestamps.push(t);
  }

  // Cap at 20 frames
  if (timestamps.length > 20) {
    console.log(`   ⚠️ Too many frames (${timestamps.length}), keeping every Nth to get ~20`);
    const step = Math.ceil(timestamps.length / 20);
    const selected = timestamps.filter((_, i) => i % step === 0).slice(0, 20);
    timestamps.length = 0;
    timestamps.push(...selected);
  }

  const frames = extractFramesAtSeconds(videoPath, timestamps);
  console.log(`   ✅ Extracted ${frames.length} frames from ${duration.toFixed(0)}s video`);
  return frames;
}

/** Legacy wrapper — kept for backward compat */
export function extractFrames(videoPath: string): string[] {
  const duration = getVideoDuration(videoPath);
  console.log(`   📹 Video duration: ${duration.toFixed(1)}s`);
  return extractFramesSimple(videoPath, duration);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 15000;

const MAX_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 60000;

/** Send a single batch of frames to Claude Vision API with retry on rate limit */
async function analyzeBatch(
  client: Anthropic,
  batchFrames: string[],
  context: string,
  focus: string,
  roster?: RosterPlayer[],
  teamName?: string,
  awayTeam?: string,
  jobId?: string,
): Promise<AnalysisResult> {
  const contentBlocks: (Anthropic.ImageBlockParam | Anthropic.TextBlockParam)[] = [];
  batchFrames.forEach((framePath) => {
    const data = fs.readFileSync(framePath).toString('base64');
    const basename = path.basename(framePath, '.jpg');
    contentBlocks.push({ type: 'text' as const, text: `Frame filename: ${basename}` });
    contentBlocks.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });
  });

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `פוקוס: ${focus}\nהקשר: ${context || 'אין'}\n\nשם הקובץ = חותמת זמן (frame_00h04m46s = 4:46). השתמש בו לשדה "time" בפורמט MM:SS (למשל 04:46). החזר JSON בגוף בלבד.`,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: buildSystemPrompt(roster, teamName, awayTeam),
        messages: [{ role: 'user', content: [...contentBlocks, textBlock] }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      console.log(`   ✅ Batch responded (${text.length} chars)`);
      console.log(`   📊 Usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('   ❌ Raw response:', text.substring(0, 500));
        throw new Error('לא נמצא JSON בתגובת Claude');
      }

      return JSON.parse(jsonMatch[0]);
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.error?.type === 'rate_limit_error' || (err?.message || '').includes('rate');
      if (isRateLimit && attempt < MAX_RETRIES) {
        console.log(`   ⚠️ Rate limit hit (attempt ${attempt}/${MAX_RETRIES}) — waiting ${RATE_LIMIT_WAIT_MS / 1000}s...`);
        if (jobId) await updateJobProgress(jobId, -1, `מגבלת קצב — ממתין 60 שניות (ניסיון ${attempt}/${MAX_RETRIES})...`);
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw err;
    }
  }
  throw new Error('נכשל לאחר מספר ניסיונות — מגבלת קצב');
}

/** Send frame files to Claude Vision API in batches of 3 to avoid rate limits */
export async function analyzeFrames(frames: string[], context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log(`\n🤖 [3/4] Sending ${frames.length} frames to Claude Vision in batches of ${BATCH_SIZE}...`);
  const client = getClient();

  // Split frames into batches
  const batches: string[][] = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    batches.push(frames.slice(i, i + BATCH_SIZE));
  }

  console.log(`   📦 ${batches.length} batches total`);

  const allPlays: AnalysisResult['plays'] = [];
  const allInsights: AnalysisResult['insights'] = [];
  let lastShotChart: AnalysisResult['shotChart'] = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
  let gameSummary = '';

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchNum = b + 1;

    // Progress: scale from 50% to 90% across batches
    const progressPct = Math.round(50 + (batchNum / batches.length) * 40);
    const progressMsg = `מעבד קבוצת פריימים ${batchNum} מתוך ${batches.length}...`;
    console.log(`   📡 Batch ${batchNum}/${batches.length}: ${batch.length} frames`);
    if (jobId) await updateJobProgress(jobId, progressPct, progressMsg);

    const batchResult = await analyzeBatch(client, batch, context, focus, roster, teamName, awayTeam, jobId);

    if (batchResult.plays) allPlays.push(...batchResult.plays);
    if (batchResult.insights) allInsights.push(...batchResult.insights);
    if (batchResult.shotChart) lastShotChart = batchResult.shotChart;
    if (batchResult.game) gameSummary = batchResult.game;

    console.log(`   ✅ Batch ${batchNum}: ${batchResult.plays?.length || 0} plays`);

    // Wait between batches to stay under rate limit
    if (b < batches.length - 1) {
      const waitMsg = `מעבד קבוצת פריימים ${batchNum} מתוך ${batches.length} — ממתין...`;
      if (jobId) await updateJobProgress(jobId, progressPct, waitMsg);
      console.log(`   ⏳ Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  const result: AnalysisResult = {
    game: gameSummary,
    plays: allPlays,
    insights: allInsights,
    shotChart: lastShotChart,
  };

  console.log(`   ✅ All batches done: ${result.plays.length} plays, ${result.insights.length} insights`);
  if (jobId) await updateJobProgress(jobId, 95, `נמצאו ${result.plays.length} מהלכים — שומר...`);
  return result;
}

// ============================================================
// GOOGLE DRIVE MODE: yt-dlp download → ffmpeg → Claude Vision
// ============================================================

/** Download video from Google Drive using yt-dlp */
function downloadGoogleDrive(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-gdrive-'));
  const outTemplate = path.join(tmpDir, 'video.%(ext)s');
  console.log(`\n📥 [1/4] Downloading Google Drive video: ${url}`);

  const ytdlp = fs.existsSync('/usr/local/bin/yt-dlp') ? '/usr/local/bin/yt-dlp' : 'yt-dlp';
  const cmd = `${ytdlp} --no-check-certificates --no-playlist -o "${outTemplate}" "${url}"`;
  console.log(`   CMD: ${cmd}`);

  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
    console.log(`   yt-dlp stdout:\n${output}`);
  } catch (err: any) {
    console.error(`   ❌ yt-dlp FAILED`);
    console.error(`   CMD: ${cmd}`);
    console.error(`   EXIT CODE: ${err.status}`);
    console.error(`   STDOUT: ${err.stdout || '(empty)'}`);
    console.error(`   STDERR: ${err.stderr || '(empty)'}`);
    throw new Error(`yt-dlp failed (exit ${err.status}): ${err.stderr || err.message}`);
  }

  const files = fs.readdirSync(tmpDir);
  console.log(`   📂 Files in tmpDir: ${files.join(', ')}`);
  if (files.length === 0) throw new Error('yt-dlp produced no output file from Google Drive');
  const videoFile = files[0];
  const videoPath = path.join(tmpDir, videoFile);

  const stat = fs.statSync(videoPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${videoPath}`);
  return videoPath;
}

/** Analyze Google Drive video: yt-dlp → ffmpeg → Claude Vision */
export async function analyzeGoogleDrive(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GOOGLE DRIVE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  if (jobId) await updateJobProgress(jobId, 5, 'מוריד סרטון מ-Google Drive...');
  const videoPath = downloadGoogleDrive(url);
  if (jobId) await updateJobProgress(jobId, 20, 'הורדה הושלמה — מחלץ פריימים...');
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  if (jobId) await updateJobProgress(jobId, 40, `חולצו ${frames.length} פריימים — שולח ל-Claude...`);

  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam, jobId);

  console.log('\n🧹 Cleaning up temp files...');
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(videoPath); } catch {}
  console.log('   ✅ Cleanup done');
  console.log('🏀 ========== GOOGLE DRIVE PIPELINE COMPLETE ==========\n');

  return result;
}

// ============================================================
// PUBLIC API: auto-selects local or cloud mode
// ============================================================

/** Analyze YouTube — full pipeline: yt-dlp → ffmpeg → Claude Vision */
export async function analyzeYouTube(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  if (jobId) await updateJobProgress(jobId, 5, 'מוריד סרטון מ-YouTube...');
  const videoPath = downloadYouTube(url);
  if (jobId) await updateJobProgress(jobId, 20, 'הורדה הושלמה — מחלץ פריימים...');
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  if (jobId) await updateJobProgress(jobId, 40, `חולצו ${frames.length} פריימים — שולח ל-Claude...`);

  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam, jobId);

  console.log('\n🧹 Cleaning up temp files...');
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(videoPath); } catch {}
  console.log('   ✅ Cleanup done');
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');

  return result;
}

/** Analyze uploaded video file (local only) */
export async function analyzeVideo(videoPath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');
  if (jobId) await updateJobProgress(jobId, 10, 'מחלץ פריימים מהסרטון...');
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  if (jobId) await updateJobProgress(jobId, 40, `חולצו ${frames.length} פריימים — שולח ל-Claude...`);
  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam, jobId);
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string, jobId?: string): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([imagePath], context, focus, roster, teamName, awayTeam, jobId);
}
