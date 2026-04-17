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
    });

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

FINISH TYPES — pick the most precise:
"dunk" = hands at/above rim, ball slammed. Must CLEARLY see this or use "layup".
"putback_dunk" = offensive rebound finished with dunk.
"layup" = continuous drive to rim, no jump stop.
"reverse_layup" = layup on opposite side of basket from approach direction.
"euro_step_layup" = two-step gather changing direction before finishing at rim.
"finger_roll" = soft one-finger release at rim.
"pull_up_mid" = stops off dribble, shoots 2-pointer. Includes spin moves ending in jumper. Even if close to basket — if player stopped and jumped = pull_up_mid not layup.
"runner" = running one-hand shot released in stride past the paint at higher velocity.
"floater" = one-handed high arc shot released at edge of paint, deliberate high arc.
"hook_shot" = sweeping one-arm shot, body fully sideways to basket.
"catch_and_shoot" = player catches pass and shoots immediately without dribbling.
"made_3" = 3-point shot goes in.
"missed_3" = 3-point shot misses. Step-back 3-pointers miss more often than they go in — do NOT assume a step-back shot was made. Only write made_3 if you clearly see the ball pass through the net from the standard broadcast angle.
"made_2" = catch-and-shoot mid-range that scores, or shot type unclear but 2-pointer scores.
"missed_2" = catch-and-shoot mid-range misses, or shot type unclear but 2-pointer misses.
"tip_in" = offensive rebound tapped in softly.
"and_one" = basket scored while being fouled.
"block" = shot deflected by defender.
"steal" = ball taken by defender.
"charge_taken" = offensive foul called.
"foul_drawn" = foul called, no basket.
"out_of_bounds" = ball out before finish. Note in setup: did offense step out (turnover) or defense knock it out (defensive play).
"shot_clock_violation" = clock expires.
"unknown_finish" = camera cut or unclear.

WHEN IN DOUBT → "unknown_finish"
NEVER assume basket scored unless you CLEARLY see ball go through hoop.

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

RULE 3 — FINISH ACCURACY:
Only "layup" if continuous momentum, no stop.
Only "dunk" if you CLEARLY see hands above rim.
Player stops and jumps near basket = "pull_up_mid".
When unsure = "unknown_finish".
NEVER assume a shot was made unless you clearly see the ball pass through the net. If the shot misses, write missed_3 or missed_2. After a missed shot — check: did anyone get the offensive rebound and score? If yes, that is a SEPARATE play entry with playType offensive_rebound_putback.

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
  "finish": "dunk | putback_dunk | layup | reverse_layup | euro_step_layup | finger_roll | pull_up_mid | runner | floater | hook_shot | catch_and_shoot | made_3 | missed_3 | made_2 | missed_2 | tip_in | and_one | block | steal | charge_taken | foul_drawn | out_of_bounds | shot_clock_violation | unknown_finish",
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
    });

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

SHOT TYPE ACCURACY:
- finish "fadeaway" or "isolation_fadeaway" = write פייד-אווי
- finish "floater" = write פלואטר or טיפה
- finish "hook_shot" = write הוק שוט
- finish "pull_up_mid" = write זריקת עצירה or פול-אפ — never call it לייאפ
- finish "runner" = write ראנר
- finish "euro_step_layup" = write יורו סטפ
- finish "reverse_layup" = write לייאפ הפוך
- finish "finger_roll" = write פינגר רול
- finish "dunk" or "putback_dunk" = write דאנק
- finish "catch_and_shoot" = write קאץ' אנד שוט
- finish "unknown_finish" = do not mention the finish type — describe the action instead

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

/** Shared pipeline: Gemini video → Claude enrichment → insights */
async function runVideoPipeline(videoPath: string, context: string, focus: string, teamName: string, roster: string, geminiFileUri?: string, jerseyColor?: string, opponentJerseyColor?: string): Promise<AnalysisResult> {
  // Determine fileUri — upload if needed
  let fileUri = geminiFileUri || '';
  const mimeType = 'video/mp4';

  if (!fileUri && videoPath) {
    const uploaded = await uploadVideoToGemini(videoPath);
    fileUri = uploaded.fileUri;
  }

  if (!fileUri) {
    throw new Error('No video file URI available for analysis');
  }

  // Pass 1: detect timestamps
  console.log('🔍 [1/4] Detecting play timestamps...');
  const timestamps = await detectPlayTimestamps(fileUri, mimeType, jerseyColor || '', opponentJerseyColor || '');
  console.log(`⏱️ Found ${timestamps.length} timestamps`);

  // Pass 2: analyze each clip
  console.log('🎬 [2/4] Analyzing individual clips...');
  const geminiPlays: GeminiPlay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    console.log(`   Clip ${i + 1}/${timestamps.length} at ${ts}`);
    const play = await analyzeClipAtTimestamp(fileUri, mimeType, ts, jerseyColor || '', opponentJerseyColor || '', teamName, roster, context);
    if (play) geminiPlays.push(play);
    if (i < timestamps.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`✅ Got ${geminiPlays.length} plays from clips`);

  // Step 3: Claude enriches with Hebrew coaching analysis
  console.log('🤖 [3/4] Claude enrichment...');
  const enrichedPlays = await enrichPlaysWithClaude(geminiPlays, roster, teamName, focus);

  // Step 4: Claude generates coaching insights
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
export async function analyzeYouTube(url: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== YOUTUBE ANALYSIS PIPELINE ==========');
  console.log(`   URL: ${url}`);
  console.log(`   Focus: ${focus}`);
  console.log(`   Context: ${context || '(none)'}`);

  const videoPath = downloadYouTube(url);

  try {
    const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor);
    console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
    return result;
  } finally {
    console.log('\n🧹 Cleaning up temp files...');
    try { fs.unlinkSync(videoPath); } catch {}
    console.log('   ✅ Cleanup done');
  }
}

/** Analyze uploaded video file */
export async function analyzeVideo(videoPath: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== VIDEO ANALYSIS PIPELINE ==========');

  const result = await runVideoPipeline(videoPath, context, focus, teamName, roster, undefined, jerseyColor, opponentJerseyColor);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}

/** Analyze a single image file */
export async function analyzeImage(imagePath: string, context: string, focus: string, _teamName = '', _roster = ''): Promise<AnalysisResult> {
  console.log('\n🖼️ Analyzing single image...');
  return analyzeFrames([{ path: imagePath, seconds: 0, timestamp: '0:00' }], context, focus);
}

/** Analyze a video already uploaded to Gemini Files API */
export async function analyzeGeminiFile(geminiFileUri: string, context: string, focus: string, teamName = '', roster = '', jerseyColor = '', opponentJerseyColor = ''): Promise<AnalysisResult> {
  console.log('\n🏀 ========== GEMINI FILE ANALYSIS PIPELINE ==========');
  console.log(`   File URI: ${geminiFileUri}`);

  const result = await runVideoPipeline('', context, focus, teamName, roster, geminiFileUri, jerseyColor, opponentJerseyColor);
  console.log('🏀 ========== PIPELINE COMPLETE ==========\n');
  return result;
}
