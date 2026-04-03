import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';

// ffmpeg/ffprobe: use local Windows binaries if available, otherwise system-installed (Linux/Railway)
const BIN_DIR = path.join(__dirname, '..', 'bin');
const FFMPEG = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe'))
  ? path.join(BIN_DIR, 'ffmpeg.exe')
  : 'ffmpeg';
const FFPROBE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe'))
  ? path.join(BIN_DIR, 'ffprobe.exe')
  : 'ffprobe';

const SYSTEM_PROMPT = `אתה אנליסט כדורסל מקצועי ישראלי ברמה הגבוהה ביותר. נתח את התמונות האלה ממשחק כדורסל והחזר JSON בלבד:
{
  "game": "תיאור קצר של המשחק",
  "plays": [{ "time": "00:00", "type": "Offense|Defense|Transition", "label": "שם המהלך", "note": "הערה מפורטת למאמן", "players": ["#5", "#10"] }],
  "insights": [{ "type": "good|warn|bad", "title": "כותרת", "body": "פירוט" }],
  "shotChart": { "paint": 45, "midRange": 30, "corner3": 35, "aboveBreak3": 28, "pullUp": 20 }
}

===== כמות מהלכים — חובה =====
חובה להחזיר מינימום 25-35 מהלכים בודדים.
עבור משחק של 90 דקות עם 20+ פריימים, כל פריים צריך להניב 1-3 מהלכים.
אל תדלג על אף פריים! נתח כל פריים לעומק.
חפש את כל אלה בכל פריים:
- פיק אנד רול (שתי הקבוצות)
- משחקי פוסט-אפ
- משחקי אחד על אחד (Isolation)
- רוטציות הגנתיות וכשלים
- מעברים מהירים (Fast break / Transition)
- משחקי קו צד וקו קצה
- מצבי עצירת משחק (טיימאוט, זריקות חופשיות)
- חטיפות כדור ואיבודים
- מסכים וחתכים
- שינויי הגנת אזור
- טעויות הגנתיות אישיות
- שינויי מומנטום בין רבעים
אם יש לך פחות מ-25 מהלכים, אתה לא מנתח מספיק לעומק!

===== דיוק בפאולים וחסימות =====
היה מדויק מאוד במצבי מגע:
- בלוק (חסימה) = המגן חוסם את הכדור בצורה חוקית בלי לפגוע בזרוע
- עבירה (פאול) = המגן פוגע בזרוע או בגוף של הזורק
- הסתכל על מיקום יד המגן — אם פוגע בזרוע = פאול, אם פוגע בכדור = בלוק
אל תבלבל בין השניים!

===== התעלם משידורים חוזרים =====
דלג על כל פריים שמראה:
- שידור חוזר בהילוך איטי (Slow motion replay) — ניתן לזהות לפי גרפיקת replay
- התכנסות טיימאוט (שחקנים עומדים במעגל)
- מסך תוצאות בלבד (Scoreboard only)
- צילומי קהל
- קלוז-אפ על מאמן ללא פעולת משחק
- הפסקות פרסומת
נתח רק פריימים שמציגים פעולת משחק חיה מזווית המצלמה הראשית!

===== התאם את תיאור המהלך לפריים בפועל =====
חשוב: תאר אך ורק את מה שאתה רואה ממש בפריים הספציפי הזה.
אל תתאר מה לדעתך קרה לפני או אחרי הפריים.
אל תמציא מהלכים על סמך הקשר כללי של המשחק.
אם אתה רואה שחקן מחזיק את הכדור — תאר את זה.
אם אתה רואה עמדה הגנתית — תאר את זה.
אם הפריים לא ברור — דלג עליו, אל תנחש.

===== זיהוי קבוצות לפי צבע חולצות =====
השתמש בשמות הקבוצות כדי לזהות צבעי חולצות. קבוצות ישראליות מוכרות:
- הפועל תל אביב = חולצות אדומות
- מכבי תל אביב = חולצות צהובות
- הפועל ירושלים = חולצות שחורות
- מכבי חיפה = חולצות ירוקות
- הפועל גלים = חולצות כחולות
- הפועל חיפה = חולצות אדומות
- מכבי רעננה = חולצות כחולות
- הפועל באר שבע = חולצות אדומות

לקבוצות לא מוכרות: המאמן יציין צבע בסוגריים, לדוגמה: "קבוצה X (אדום)".
אם לא צוין צבע לקבוצה לא מוכרת, נסה לזהות את צבע החולצה מהפריימים.

בכל מהלך, ציין בבירור: שחקן ביתי או שחקן אורח עבור כל שחקן שמוזכר.

אל תסכם! תן הערה נפרדת ומפורטת לכל מהלך בודד.
כל הטקסט בעברית.`;

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
    prompt += `\n\n===== מיקוד בקבוצה — חובה מוחלטת =====
קבוצת בית: ${home}
קבוצת חוץ: ${away}

יש לך את הרוסטר המלא של ${home}.
התפקיד שלך הוא להיות האנליסט האישי של ${home}.
נתח אך ורק את שחקני ${home}.
לעולם אל תכתוב מהלך על שחקן של ${away}.
כש-${away} מבקיע: כתוב "הספגנו סל" — לא מי הבקיע.
כש-${away} חוטף כדור: כתוב "איבדנו כדור" — לא מי חטף.
כל הערת מהלך חייבת להיות על מה ש-${home} עשתה — טוב או רע.
אם פריים מראה רק שחקני ${away} ללא מעורבות ${home} — דלג על הפריים.

===== שימוש ברוסטר =====
הרוסטר שלהלן הוא של ${home}.
השתמש אך ורק ברוסטר שסופק כדי לזהות שחקנים — אל תנסה לקרוא מספרי גופיות מהפריימים.
אם אינך בטוח מי השחקן — כתוב "שחקן ${home}".

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
export async function analyzeYouTubeCloud(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log('\n☁️ ========== CLOUD YOUTUBE ANALYSIS ==========');
  console.log(`   URL: ${url}`);

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('לא הצלחתי לחלץ מזהה סרטון מהקישור');

  // Fetch thumbnails + metadata in parallel
  const [thumbs, metadata] = await Promise.all([
    fetchYouTubeThumbnails(videoId),
    fetchYouTubeMetadata(url),
  ]);

  if (thumbs.length === 0) throw new Error('לא הצלחתי לטעון תמונות מהסרטון');

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
  const FRAMES_PER_QUARTER = 6;
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
  console.log(`\n📸 Fallback: extracting 24 frames at equal intervals...`);
  const TOTAL_FRAMES = 24;
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
  console.log(`\n📸 Simple extraction (1 frame every 5s)...`);

  const interval = 5;
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

/** Send frame files to Claude Vision API */
export async function analyzeFrames(frames: string[], context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log(`\n🤖 [3/4] Sending ${frames.length} frames to Claude Vision...`);
  const client = getClient();

  // Build interleaved image + label blocks so Claude knows each frame's exact timestamp
  const contentBlocks: (Anthropic.ImageBlockParam | Anthropic.TextBlockParam)[] = [];
  frames.forEach((framePath, i) => {
    const data = fs.readFileSync(framePath).toString('base64');
    const sizeKB = (Buffer.byteLength(data, 'base64') / 1024).toFixed(0);
    const basename = path.basename(framePath, '.jpg');
    console.log(`   📷 Frame ${i + 1}/${frames.length}: ${basename} (${sizeKB}KB)`);

    // Label before each image so Claude knows the exact timestamp
    contentBlocks.push({
      type: 'text' as const,
      text: `Frame filename: ${basename}`,
    });
    contentBlocks.push({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });
  });

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `פוקוס ניתוח: ${focus}\nהקשר: ${context || 'אין הקשר נוסף'}\n\nשם הקובץ של כל פריים הוא חותמת הזמן המדויקת שלו בסרטון (לדוגמה frame_00h04m46s = דקה 4:46).\nהשתמש אך ורק בחותמת הזמן משם הקובץ בשדה "time" של כל מהלך — אל תנחש או תעריך זמנים.\n\nנתח את הפריימים האלה מהמשחק והחזר JSON.`,
  };

  console.log(`   📡 Calling Claude claude-sonnet-4-20250514 with ${frames.length} images...`);

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
export async function analyzeGoogleDrive(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GOOGLE DRIVE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  const videoPath = downloadGoogleDrive(url);
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');

  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam);

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
export async function analyzeYouTube(url: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  const videoPath = downloadYouTube(url);
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');

  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam);

  console.log('\n🧹 Cleaning up temp files...');
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(videoPath); } catch {}
  console.log('   ✅ Cleanup done');
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');

  return result;
}

/** Analyze uploaded video file (local only) */
export async function analyzeVideo(videoPath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');
  const frames = await extractFramesSmart(videoPath);
  if (frames.length === 0) throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  const result = await analyzeFrames(frames, context, focus, roster, teamName, awayTeam);
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, roster?: RosterPlayer[], teamName?: string, awayTeam?: string): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([imagePath], context, focus, roster, teamName, awayTeam);
}
