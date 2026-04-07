import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync, spawn } from 'child_process';
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

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ============================================================
// GEMINI VIDEO UNDERSTANDING LAYER
// ============================================================

async function extractClipVideo(videoPath: string, eventTime: number): Promise<string | null> {
  const outputPath = videoPath.replace(/\.[^.]+$/, `_clip_${eventTime}.mp4`);
  try {
    console.log('🎬 Extracting video segment for Gemini...');
    const startTime = Math.max(0, eventTime - 4);
    return await new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG, [
        '-ss', String(startTime),
        '-i', videoPath,
        '-t', '14',
        '-c', 'copy',
        '-y',
        outputPath
      ]);
      proc.on('close', (code) => code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg exited ${code}`)));
      proc.on('error', (err) => reject(err));
    });
  } catch (err) {
    console.error('❌ Gemini clip extraction failed:', err);
    return null;
  }
}

async function analyzeClipWithGemini(videoPath: string, eventTime: number): Promise<string | null> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const clipPath = await extractClipVideo(videoPath, eventTime);
    if (!clipPath) return null;

    const videoData = fs.readFileSync(clipPath);
    const base64Video = videoData.toString('base64');

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'video/mp4',
          data: base64Video
        }
      },
      {
        text: `You are analyzing a basketball game clip.
Describe in 2-3 sentences: what play occurred, which jersey colors were involved, and what was the outcome.
Be factual and specific. Focus on the key action.`
      }
    ]);

    const description = result.response.text();
    console.log('🤖 Gemini description:', description.substring(0, 120));

    // cleanup
    fs.unlinkSync(clipPath);

    return description;
  } catch (err) {
    console.error('❌ Gemini analysis failed:', err);
    return null;
  }
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
export async function analyzeYouTubeCloud(url: string, context: string, focus: string): Promise<AnalysisResult> {
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
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
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
  const outPath = path.join(tmpDir, 'video.mp4');
  console.log(`\n📥 [1/4] Downloading YouTube video: ${url}`);

  const cleanUrl = url.split('&t=')[0];
  const cmd = `yt-dlp -f "best[height<=720]" -o "${outPath}" "${cleanUrl}"`;
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

interface GeminiPlay {
  startTime: string;
  endTime: string;
  type: string;
  players: string[];
  description: string;
  playType: string;
}

/** STEP 1: Send full video to Gemini for play detection */
async function analyzeFullVideoWithGemini(videoPath: string): Promise<GeminiPlay[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const { GoogleAIFileManager, FileState } = await import('@google/generative-ai/server');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const fileSizeMB = fs.statSync(videoPath).size / (1024 * 1024);
  console.log(`\n🔮 [1/3] Gemini full video analysis (${fileSizeMB.toFixed(1)}MB)...`);

  const prompt = `You are a basketball analyst. Watch this video carefully.
Identify maximum 8 significant plays.
Return ONLY a valid JSON array with no explanation or markdown:
[{"startTime":"0:20","endTime":"0:35","type":"offense","players":["#23","#5"],"description":"exact description of what happened including who passed and who finished","playType":"alley-oop|dunk|3pointer|layup|steal|block|rebound|pick-and-roll|fast-break|turnover"}]

Rules:
- Maximum 8 plays
- For alley-oops: MUST include both passer and finisher
- Skip free throws, timeouts, dead ball
- Timestamps must match what you actually see in the video`;

  let result;

  if (fileSizeMB > 15) {
    // Use Gemini Files API for large files
    console.log('   📤 Uploading to Gemini Files API...');
    const uploadResult = await fileManager.uploadFile(videoPath, {
      mimeType: 'video/mp4',
      displayName: path.basename(videoPath),
    });
    console.log(`   ✅ Uploaded: ${uploadResult.file.name} (state: ${uploadResult.file.state})`);

    // Wait for file to become ACTIVE
    let file = uploadResult.file;
    while (file.state === FileState.PROCESSING) {
      console.log('   ⏳ Waiting for file processing...');
      await new Promise(r => setTimeout(r, 3000));
      file = await fileManager.getFile(file.name);
    }
    if (file.state !== FileState.ACTIVE) {
      throw new Error(`Gemini file processing failed: ${file.state}`);
    }
    console.log('   ✅ File ready');

    result = await model.generateContent([
      { fileData: { mimeType: 'video/mp4', fileUri: file.uri } },
      { text: prompt },
    ]);

    // Cleanup uploaded file
    try { await fileManager.deleteFile(file.name); } catch {}
  } else {
    // Use inline base64 for small files
    console.log('   📦 Using inline base64...');
    const videoData = fs.readFileSync(videoPath).toString('base64');
    result = await model.generateContent([
      { inlineData: { mimeType: 'video/mp4', data: videoData } },
      { text: prompt },
    ]);
  }

  const responseText = result.response.text();
  console.log(`   ✅ Gemini responded (${responseText.length} chars)`);

  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('   ❌ Raw Gemini response:', responseText.substring(0, 500));
    throw new Error('Gemini did not return valid JSON');
  }

  const plays: GeminiPlay[] = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Detected ${plays.length} plays`);
  plays.forEach((p, i) => console.log(`      ${i+1}. ${p.startTime}-${p.endTime} ${p.playType}: ${p.description.substring(0, 60)}`));
  return plays;
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Convert these basketball plays to Hebrew coaching analysis.
Return ONLY a valid JSON array with no explanation or markdown:
[{"startTime":"...","endTime":"...","type":"offense|defense|transition","label":"short Hebrew title","note":"1-2 sentence Hebrew coaching insight","players":["#23"]}]

Roster: ${roster}
Team: ${teamName}
Coach focus: ${focus}

Plays to convert:
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `Based on these basketball plays from a game, provide coaching insights in Hebrew.
Return ONLY a valid JSON array, maximum 4 insights, no explanation or markdown:
[{"type":"good|warn|bad","title":"Hebrew title","body":"Hebrew explanation"}]

Context: ${context || 'אין הקשר נוסף'}

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

/** Shared pipeline: Gemini video → Claude enrichment → insights */
async function runVideoPipeline(videoPath: string, context: string, focus: string, teamName: string, roster: string): Promise<AnalysisResult> {
  // Step 1: Gemini detects plays from full video
  const geminiPlays = await analyzeFullVideoWithGemini(videoPath);

  // Step 2: Claude enriches with Hebrew coaching analysis
  const enrichedPlays = await enrichPlaysWithClaude(geminiPlays, roster, teamName, focus);

  // Step 3: Claude generates coaching insights
  const insights = await generateInsightsFromPlays(enrichedPlays, context);

  return {
    game: context || 'ניתוח משחק',
    plays: enrichedPlays,
    insights,
    shotChart: { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 },
  };
}

// ============================================================
// PUBLIC API
// ============================================================

/** Analyze YouTube — download → Gemini → Claude */
export async function analyzeYouTube(url: string, context: string, focus: string, teamName = '', roster = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  const videoPath = downloadYouTube(url);

  try {
    const result = await runVideoPipeline(videoPath, context, focus, teamName, roster);
    console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
    return result;
  } finally {
    console.log('\n🧹 Cleaning up temp files...');
    try { fs.unlinkSync(videoPath); } catch {}
    console.log('   ✅ Cleanup done');
  }
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, teamName = '', roster = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');

  const result = await runVideoPipeline(videoPath, context, focus, teamName, roster);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, _teamName = '', _roster = ''): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([{ path: imagePath, seconds: 0, timestamp: '0:00' }], context, focus);
}
