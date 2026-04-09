import Anthropic from '@anthropic-ai/sdk';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TeamKnowledge } from './database';
import BASKETBALL_BRAIN from './knowledge/basketballBrain';

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

function getClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function retryWithBackoff(fn: () => Promise<any>, retries = 4): Promise<any> {
  for (let i = 0; i < retries; i++) {
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
      if (is503 && i < retries - 1) {
        const delay = Math.pow(2, i) * 5000;
        console.log(`Gemini 503 — retry ${i + 1}/${retries} in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
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
  finish?: string;
  finish_location?: string;
}

/** STEP 1: Send full video to Gemini for play detection */
async function analyzeFullVideoWithGemini(videoPath: string, geminiFileUri?: string, jerseyColor?: string): Promise<GeminiPlay[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const { GoogleAIFileManager, FileState } = await import('@google/generative-ai/server');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);
  const fileSizeMB = geminiFileUri ? 0 : fs.statSync(videoPath).size / (1024 * 1024);
  console.log(`\n🔮 [1/3] Gemini full video analysis${geminiFileUri ? ' (pre-uploaded file)' : ` (${fileSizeMB.toFixed(1)}MB)`}...`);

  const prompt = `You are a professional basketball analyst. Watch this video carefully.
${jerseyColor ? `\nצבע חולצה של הקבוצה: ${jerseyColor}\n` : ''}
Your job is to identify the most significant plays and decompose each one into a full sequence — from how possession was gained to how the play finished.

Number of plays to identify: detect 11-13 most significant plays.

SIGNIFICANCE THRESHOLD — only include a play if it meets at least one of these criteria:
- Score change (basket made)
- Turnover that led directly to a fast break
- Defensive stop on a significant possession
- Block or steal that changed momentum
- Skip free throws, timeouts, non-scoring plays, regular half court possessions that ended without a score or turnover

Return ONLY a valid JSON array with no explanation or markdown:

[{
  "startTime": "0:41",
  "endTime": "0:51",
  "playType": "alley_oop_set",
  "possession_origin": "live_ball | steal | defensive_rebound | offensive_rebound | inbound | turnover_forced",
  "setup": "exact description of what happened BEFORE the finish — screens, passes, cuts, defensive breakdown",
  "action": "exact description of the decisive moment — the pass, the drive, the shot",
  "finish": "how it ended — dunk, layup, 3pointer, fadeaway, tip_in, block, steal",
  "finish_location": "paint | midrange_left | midrange_right | corner_3_left | corner_3_right | above_break_3 | free_throw_line",
  "players": ["#23", "#5"],
  "type": "offense | defense | transition",
  "description": "one sentence combining the full sequence from origin to finish"
}]

ARCHETYPE OPTIONS for playType — you MUST pick the closest one:
- pick_and_roll_finish
- pick_and_roll_kickout_3
- isolation_drive
- isolation_fadeaway
- transition_steal_dunk
- transition_leak_out
- alley_oop_set
- alley_oop_broken_play
- post_up_finish
- backdoor_cut
- skip_pass_corner_3
- offensive_rebound_putback
- offensive_rebound_tip_in
- fast_break_2on1
- fast_break_3on2
- half_court_set_play
- zone_attack_skip
- press_break_layup
- coast_to_coast
- defensive_stop
- defensive_block
- defensive_steal

SEQUENCE RULES — critical:
- For EVERY play, describe setup before you label the playType
- ALLEY_OOP: must have a lob pass AND a mid-air catch near the basket. Trace back — who threw the lob and why? Include both passer and finisher in players array.
- TRANSITION_STEAL_DUNK: possession_origin must be "steal". Describe the steal first, then the drive, then the finish.
- COAST_TO_COAST: player must receive ball in OWN half and carry it the full length personally. If pass received past halfcourt → use fast_break instead.
- ISOLATION_FADEAWAY: player shoots jumping away from defender. Do NOT label as isolation_drive.
- OFFENSIVE_REBOUND_TIP_IN: soft one or two hand push into basket. Do NOT label as putback dunk unless player visibly grabs rim.
- PLAYER ACCURACY: only use jersey numbers you can clearly read in this specific moment. Never guess a number you cannot clearly see.
- POSSESSION ORIGIN: only label possession_origin if you can clearly see how the team got the ball in the video. If the play starts after a stoppage (foul call, out of bounds, timeout), use "set_play". If you cannot clearly see how possession was gained, use "unknown". NEVER invent a turnover, steal, or pass that you did not clearly see.
- STEAL ATTRIBUTION: the player listed as making a steal in possession_origin must be the player you can clearly see intercepting or taking the ball. Never assume the nearest defender made the steal.
- SETUP FIELD: only describe what you can actually see in the video. If the play starts from a set offense with no clear transition origin, write "set offense" in setup. Never invent context from before the clip starts.
- PHYSICAL DESCRIPTION ONLY: in the setup, action, and finish fields — describe only what physically happens. Do not interpret tactics or judge if a shot was open or guarded. Write what you see: "player crosses over left, drives baseline, finishes with right hand." Tactical interpretation is handled separately.
- UNKNOWN FINISH: if the camera cuts away before the play finishes, or if you cannot clearly see how the play ended, write "finish": "unknown" and "playType": use the most conservative option. NEVER invent a dunk, coast-to-coast, or dramatic finish you did not clearly see. A layup you are not sure about is "layup_attempt". A dunk you are not sure about is "layup". Only write "dunk" if you clearly see the player's hands on or above the rim.
- CAMERA CUT = NEW PLAY: if you see a camera cut or jump in time between two actions, these are TWO SEPARATE PLAYS. Never combine plays from different possessions into one note. If a foul leads to a cut and then a new possession starts, the new possession is a separate play entirely.
- PULL UP JUMPER: if a player stops off the dribble and shoots a jump shot — whether inside or outside the paint — this is isolation_fadeaway or pull_up_mid. Never label it a layup.
- LAYUP DEFINITION: a layup is ONLY when a player drives with continuous momentum all the way to the basket and finishes directly at the rim — either off the glass or straight up underneath. The key signal is no jump stop, no gather pause, no separation from defender before shooting. A player who stops inside the paint and jumps to shoot is NOT doing a layup — label it pull_up_mid even if they are close to the basket.
- PAINT JUMPER vs LAYUP: when a player is in the paint near the basket, look at their feet and body. LAYUP = feet moving toward basket, body leaning forward, one-foot or two-foot gather going UP to the rim. PAINT JUMPER = feet planted or jump-stopped, body upright or slightly back, ball released AWAY from the rim with an arc. If there is any separation between the player and the basket before the shot — it is a pull_up_mid, not a layup. Contact from a defender does not change the shot type.
- TWO HANDS RULE: if a player releases the ball with TWO HANDS, check the release direction. Two hands rising TOWARD the rim with no arc = layup or power finish. Two hands releasing AWAY from the body with upward arc = jump shot, even inside the paint. One hand finish near the rim = almost always a layup or finger roll. One hand release with arc and separation from basket = floater or pull_up_mid.
- WHISTLE/FOUL RULE: if a whistle sounds and play stops, the possession ends there. Do NOT continue analyzing movement after a whistle. If a foul is called, label the play as "foul_drawn" with the player who was fouled. Never describe post-whistle movement as part of the play.
- COAST TO COAST: only label a play coast_to_coast if you see the player receive the ball clearly in their own half AND carry it the full length personally with no cuts in the footage. If there is any camera cut during the play, label it fast_break instead.
- Skip free throws, timeouts, dead ball.
- Timestamps must match the exact moment in the video.
- MINIMUM PLAY DURATION: every play must have a minimum of 4 seconds between startTime and endTime. A play that is 2 seconds or less is not a valid play — extend the window to include the full sequence from setup to finish.`;

  let result;
  const model25 = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  if (geminiFileUri) {
    // File already uploaded by browser — use directly
    console.log('   ✅ Using pre-uploaded Gemini file');
    result = await retryWithBackoff(async () => {
      const res = await model25.generateContent([
        { fileData: { mimeType: 'video/mp4', fileUri: geminiFileUri } },
        { text: prompt },
      ]);
      const text = res.response.text();
      if (!text || text.trim().length === 0) {
        const emptyErr = new Error('Gemini returned empty response');
        (emptyErr as any).status = 503;
        throw emptyErr;
      }
      return res;
    });
  } else if (fileSizeMB > 15) {
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

    result = await retryWithBackoff(async () => {
      const res = await model25.generateContent([
        { fileData: { mimeType: 'video/mp4', fileUri: file.uri } },
        { text: prompt },
      ]);
      const text = res.response.text();
      if (!text || text.trim().length === 0) {
        const emptyErr = new Error('Gemini returned empty response');
        (emptyErr as any).status = 503;
        throw emptyErr;
      }
      return res;
    });

    // Cleanup uploaded file
    try { await fileManager.deleteFile(file.name); } catch {}
  } else {
    // Use inline base64 for small files
    console.log('   📦 Using inline base64...');
    const videoData = fs.readFileSync(videoPath).toString('base64');
    result = await retryWithBackoff(async () => {
      const res = await model25.generateContent([
        { inlineData: { mimeType: 'video/mp4', data: videoData } },
        { text: prompt },
      ]);
      const text = res.response.text();
      if (!text || text.trim().length === 0) {
        const emptyErr = new Error('Gemini returned empty response');
        (emptyErr as any).status = 503;
        throw emptyErr;
      }
      return res;
    });
  }

  const rawText = result.response.text();
  const cleaned = rawText
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log('Gemini raw (first 500):', rawText.substring(0, 500));
    throw new Error('No JSON array found in Gemini response');
  }
  let parsedPlays: GeminiPlay[];
  try {
    parsedPlays = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('JSON parse failed, attempting repair...');
    // Attempt to fix truncated JSON by finding the last complete object
    const raw = jsonMatch[0];
    const lastComplete = raw.lastIndexOf('},');
    if (lastComplete > 0) {
      const repaired = raw.substring(0, lastComplete + 1) + ']';
      try {
        parsedPlays = JSON.parse(repaired);
        console.log(`✅ JSON repaired — recovered ${parsedPlays.length} plays`);
      } catch (e2) {
        console.log('JSON repair failed. Raw (first 1000):', jsonMatch[0].substring(0, 1000));
        throw new Error('Failed to parse Gemini JSON: ' + (e as Error).message);
      }
    } else {
      throw new Error('Failed to parse Gemini JSON: ' + (e as Error).message);
    }
  }
  console.log('GEMINI RAW OUTPUT:', JSON.stringify(parsedPlays, null, 2));
  console.log(`   ✅ Detected ${parsedPlays.length} plays`);
  parsedPlays.forEach((p, i) => console.log(`      ${i+1}. ${p.startTime}-${p.endTime} ${p.playType}: ${p.description.substring(0, 60)}`));
  return parsedPlays;
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a professional Israeli basketball coaching analyst.
Convert these basketball plays into Hebrew coaching notes.
Return ONLY a valid JSON array with no explanation or markdown:

[{
  "startTime": "...",
  "endTime": "...",
  "type": "offense | defense | transition",
  "label": "short Hebrew title (max 5 words)",
  "note": "2-3 sentence Hebrew coaching insight",
  "players": ["#23"]
}]

Each play you receive has this structure:
- playType: the archetype (e.g. alley_oop_set, transition_steal_dunk)
- possession_origin: how the team got the ball
- setup: what happened before the finish
- action: the decisive moment
- finish: how it ended
- finish_location: where on the court
- players: who was involved
- description: one-line summary

RULES for writing the Hebrew note:
- Always start from possession_origin — how did this play begin?
- Describe the setup — what created the opportunity?
- Name the players by roster name if available, number if not
- End with a coaching observation — what made this play work or fail?
- For transition_steal_dunk: mention the steal first, then the finish
- For alley_oop_set: mention who threw the lob AND who finished
- For pick_and_roll_kickout_3: mention the screener, the ball handler, and the shooter
- For isolation_fadeaway: do NOT call it a drive or layup
- For offensive_rebound_tip_in: do NOT call it a dunk
- For coast_to_coast: only use this term if possession_origin was in own half
- Keep language natural for an Israeli basketball coach — not robotic
- PLAYER NAMES: use the exact name as it appears in the roster provided. If the roster has the name in Hebrew (e.g. "דני כהן") use Hebrew. If the roster has the name in English (e.g. "Holmgren") use English. Never transliterate English names into Hebrew letters. Never transliterate Hebrew names into English. The roster is the source of truth for every name. If a player number has no roster match, use only the number e.g. "#7".
- OPPONENT PLAYS — HOME TEAM PERSPECTIVE ONLY: always write from the analyzing team's perspective. NEVER mention opponent player names by name. Refer to opponents only as "היריב", "שחקן היריב", or by jersey number only (e.g. "#23 של היריב"). Never write LeBron, Reaves, Davis, or any opponent player name. Describe what the home team did well or failed to do defensively.
- SHOT TYPE ACCURACY: if Gemini labels the shot as fadeaway write פייד-אווי. If Gemini labels it floater write פלואטר או טיפה. Never swap these. They are different shots.
- THREE POINTER: always write שלשה — never שלושה. This is non-negotiable.

Roster: ${roster}
Team: ${teamName}
Coach focus: ${focus}

Coaching Knowledge:
${BASKETBALL_BRAIN}

${knowledgeContext}

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

/** Shared pipeline: Gemini video → Claude enrichment → insights */
async function runVideoPipeline(videoPath: string, context: string, focus: string, teamName: string, roster: string, geminiFileUri?: string, jerseyColor?: string): Promise<AnalysisResult> {
  // Step 1: Gemini detects plays from full video
  const geminiPlays = await analyzeFullVideoWithGemini(videoPath, geminiFileUri, jerseyColor);

  // Step 2: Claude enriches with Hebrew coaching analysis
  const enrichedPlays = await enrichPlaysWithClaude(geminiPlays, roster, teamName, focus);

  // Step 3: Claude generates coaching insights
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
export async function analyzeYouTube(url: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  const videoPath = downloadYouTube(url);

  try {
    const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor);
    console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
    return result;
  } finally {
    console.log('\n🧹 Cleaning up temp files...');
    try { fs.unlinkSync(videoPath); } catch {}
    console.log('   ✅ Cleanup done');
  }
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');

  const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, _teamName = '', _roster = ''): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([{ path: imagePath, seconds: 0, timestamp: '0:00' }], context, focus);
}

/** Analyze a video already uploaded to Gemini Files API */
export async function analyzeGeminiFile(geminiFileUri: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GEMINI FILE ANALYSIS PIPELINE ==========');
  console.log(`   File URI: ${geminiFileUri}`);

  const result = await runVideoPipeline('', context, focus, teamName, roster, geminiFileUri, jerseyColor);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}
