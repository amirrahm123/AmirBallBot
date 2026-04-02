import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Local ffmpeg/ffprobe binaries
const BIN_DIR = path.join(__dirname, '..', 'bin');
const FFMPEG = path.join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE = path.join(BIN_DIR, 'ffprobe.exe');

const SYSTEM_PROMPT = `אתה אנליסט כדורסל מקצועי ישראלי. נתח את התמונות האלה ממשחק כדורסל והחזר JSON בלבד:
{
  "game": "תיאור קצר של המשחק",
  "plays": [{ "time": "00:00", "type": "Offense|Defense|Transition", "label": "שם המהלך", "note": "הערה", "players": ["#5", "#10"] }],
  "insights": [{ "type": "good|warn|bad", "title": "כותרת", "body": "פירוט" }],
  "shotChart": { "paint": 45, "midRange": 30, "corner3": 35, "aboveBreak3": 28, "pullUp": 20 }
}
כל הטקסט בעברית.`;

export interface AnalysisResult {
  game: string;
  plays: { time: string; type: string; label: string; note: string; players: string[] }[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
}

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** Download YouTube video (video-only, no audio) using yt-dlp */
export function downloadYouTube(url: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-yt-'));
  const outPath = path.join(tmpDir, 'video.mp4');
  console.log(`\n📥 [1/4] Downloading YouTube video: ${url}`);

  const cmd = `yt-dlp -f "bv[height<=720][ext=mp4]/bv[height<=720]/best[height<=720]" --no-audio -o "${outPath}" "${url}"`;
  console.log(`   CMD: ${cmd}`);

  execSync(cmd, { stdio: 'inherit', timeout: 300000 });

  const stat = fs.statSync(outPath);
  console.log(`   ✅ Downloaded: ${(stat.size / 1024 / 1024).toFixed(1)}MB → ${outPath}`);
  return outPath;
}

/** Extract 1 frame every 30 seconds using local ffmpeg */
export function extractFrames(videoPath: string): string[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballbot-frames-'));
  console.log(`\n📸 [2/4] Extracting frames (1 every 30s)...`);

  // Get video duration
  console.log(`   ffprobe: getting duration...`);
  const durationStr = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
  ], { encoding: 'utf-8', timeout: 30000 }).trim();
  const duration = parseFloat(durationStr);
  console.log(`   📹 Video duration: ${duration.toFixed(1)}s`);

  // Extract 1 frame every 30 seconds (10 min timeout for long videos)
  const pattern = path.join(tmpDir, 'frame_%04d.jpg');
  console.log(`   ffmpeg: extracting frames fps=1/30 ...`);
  execFileSync(FFMPEG, [
    '-i', videoPath, '-vf', 'fps=1/30', '-q:v', '2', pattern, '-y'
  ], { stdio: 'inherit', timeout: 600000 });

  // Collect generated frames
  const frames = fs.readdirSync(tmpDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(tmpDir, f));

  console.log(`   ✅ Extracted ${frames.length} frames from ${duration.toFixed(0)}s video`);

  // Cap at 20 frames to stay within Claude's limits
  if (frames.length > 20) {
    console.log(`   ⚠️ Too many frames (${frames.length}), keeping every Nth to get ~20`);
    const step = Math.ceil(frames.length / 20);
    const selected = frames.filter((_, i) => i % step === 0).slice(0, 20);
    // Delete unselected frames
    frames.filter(f => !selected.includes(f)).forEach(f => { try { fs.unlinkSync(f); } catch {} });
    console.log(`   ✅ Kept ${selected.length} frames`);
    return selected;
  }

  return frames;
}

/** Send frames to Claude Vision API */
export async function analyzeFrames(frames: string[], context: string, focus: string): Promise<AnalysisResult> {
  console.log(`\n🤖 [3/4] Sending ${frames.length} frames to Claude Vision...`);
  const client = getClient();

  // Build image blocks
  const imageBlocks: Anthropic.ImageBlockParam[] = frames.map((framePath, i) => {
    const data = fs.readFileSync(framePath).toString('base64');
    const sizeKB = (Buffer.byteLength(data, 'base64') / 1024).toFixed(0);
    console.log(`   📷 Frame ${i + 1}/${frames.length}: ${path.basename(framePath)} (${sizeKB}KB)`);
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    };
  });

  const textBlock: Anthropic.TextBlockParam = {
    type: 'text',
    text: `פוקוס ניתוח: ${focus}\nהקשר: ${context || 'אין הקשר נוסף'}\n\nנתח את הפריימים האלה מהמשחק והחזר JSON.`,
  };

  console.log(`   📡 Calling Claude claude-sonnet-4-20250514 with ${imageBlocks.length} images...`);

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

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('   ❌ Raw response:', text.substring(0, 500));
    throw new Error('לא נמצא JSON בתגובת Claude');
  }

  const result: AnalysisResult = JSON.parse(jsonMatch[0]);
  console.log(`   ✅ Parsed: ${result.plays?.length || 0} plays, ${result.insights?.length || 0} insights`);
  return result;
}

/** Full pipeline: YouTube URL → download → frames → Claude → result */
export async function analyzeYouTube(url: string, context: string, focus: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  // Step 1: Download
  const videoPath = downloadYouTube(url);

  // Step 2: Extract frames
  const frames = extractFrames(videoPath);
  if (frames.length === 0) {
    throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  }

  // Step 3: Analyze with Claude
  const result = await analyzeFrames(frames, context, focus);

  // Step 4: Cleanup
  console.log('\n🧹 [4/4] Cleaning up temp files...');
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  try { fs.unlinkSync(videoPath); } catch {}
  console.log('   ✅ Cleanup done');
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');

  return result;
}

/** Full pipeline: uploaded video file → frames → Claude → result */
export async function analyzeVideo(videoPath: string, context: string, focus: string): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');
  const frames = extractFrames(videoPath);
  if (frames.length === 0) {
    throw new Error('לא הצלחתי לחלץ פריימים מהסרטון');
  }
  const result = await analyzeFrames(frames, context, focus);
  frames.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([imagePath], context, focus);
}
