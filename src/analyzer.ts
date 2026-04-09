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

/** STEP 1: Send full video to Gemini for play detection */
async function analyzeFullVideoWithGemini(videoPath: string, geminiFileUri?: string, jerseyColor?: string, opponentJerseyColor?: string, teamName?: string, roster?: string, context?: string): Promise<GeminiPlay[]> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const { GoogleAIFileManager, FileState } = await import('@google/generative-ai/server');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);
  const fileSizeMB = geminiFileUri ? 0 : fs.statSync(videoPath).size / (1024 * 1024);
  console.log(`\n🔮 [1/3] Gemini full video analysis${geminiFileUri ? ' (pre-uploaded file)' : ` (${fileSizeMB.toFixed(1)}MB)`}...`);

  const rosterText = roster || '(no roster provided)';

  const prompt = `You are a professional basketball video analyst.

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

═══ YOUR TASK ═══
Watch this video and identify 8-13 significant plays. For every missed shot, actively check what happened next — did the ball go out, was there a rebound, did the offense score a second chance? Each of these is a separate entry. Return them as a JSON array.

A significant play is ONE of:
1. Analyzing team (${jerseyColor || 'unknown'}) scores
2. Analyzing team turns the ball over AND opponent converts it to a fast break or score
3. Analyzing team forces a defensive stop (steal, block, charge, shot clock violation)
4. Opponent scores against analyzing team (write from defensive perspective)

SKIP: free throws, timeouts, dead ball situations, inbounds with no action, jump balls that lead to nothing, turnovers that go nowhere.
QUALITY OVER QUANTITY: 8 accurate plays is better than 13 invented plays. Never pad to reach 13.
MINIMUM DURATION: 4 seconds minimum per play.

═══ DEFINITIONS ═══

PLAY TYPES — pick the most accurate:
Offensive half court:
- pick_and_roll_finish = screen action, roller or ball handler finishes at basket
- pick_and_roll_kickout_3 = screen action, kick out to corner or wing 3-pointer
- pick_and_pop = screener pops to perimeter for jump shot instead of rolling
- dribble_handoff = ball handler dribbles toward teammate and hands off while moving
- isolation_drive = one on one, player drives to basket
- isolation_fadeaway = one on one, player shoots jumping away from defender
- post_up_finish = player received ball IN the paint or low post, finishes from there
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
"missed_3" = 3-point shot misses.
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

═══ 9 RULES ═══

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

RULE 4 — WHISTLE/FOUL:
Whistle = play ends immediately.
Write what happened BEFORE whistle only.
finish: "foul_drawn" or "charge_taken".

RULE 5 — CAMERA CUTS:
Cut during play = play ends there.
Never combine two possessions.
New possession = new play entry.
A deflection off a missed shot that causes the ball to go out of bounds is NOT a defensive play. Write it as: perspective: offense, finish: out_of_bounds, possession_origin: deflection. Do NOT write it as opponent scoring.

RULE 5B — REPLAY/CLOSE-UP CAMERA:
If the camera zooms in on a player's face, a celebration, a slow-motion replay, or a close-up of the basket AFTER a play already ended — IGNORE. This is not a new play. A new play only starts when the ball is live from a standard broadcast wide-angle view.

RULE 6 — ALLEY OOP:
Requires: lob pass + mid-air catch near basket.
Both passer AND finisher in players array.
Cannot identify passer = use finisher only, still label alley_oop_set.

RULE 7 — COAST TO COAST:
Player must personally gain ball in OWN half AND carry full court with no camera cuts.
Any cut = fast_break.
Received past halfcourt = fast_break.

RULE 8 — INCOMPLETE PLAYS:
shot_clock_violation = perspective "defense"
charge_taken = perspective "defense"
out_of_bounds by offense = perspective "offense", type "transition" (turnover)
Jump balls = skip unless immediate score follows.

RULE 9 — SETUP AND ACTION FIELDS:
setup = 1-2 sentences. For chain plays (pick and roll → defensive collapse → open cutter), describe ALL phases: what the first action was, how the defense reacted, what space was created. Jersey numbers only. No names. Example: "#11 receives ball on left wing, drives middle past #21 of opponent."
action = ONE sentence only. The decisive moment. Example: "#11 pulls up at free throw line and releases jump shot."
description = ONE sentence in English. Full sequence from origin to finish. Jersey numbers only. No names.

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON array, no markdown:

[{
  "startTime": "0:41",
  "endTime": "0:51",
  "playType": "pick_and_roll_finish | pick_and_roll_kickout_3 | pick_and_pop | dribble_handoff | isolation_drive | isolation_fadeaway | post_up_finish | post_up_pass_out | high_low | drive_and_kick | backdoor_cut | skip_pass_corner_3 | elevator_screen | inbound_play | alley_oop_set | transition_steal_dunk | transition_leak_out | fast_break_2on1 | fast_break_3on2 | secondary_break | coast_to_coast | offensive_rebound_putback | offensive_rebound_tip_in | defensive_stop | defensive_block | charge_taken | shot_clock_violation | foul_drawn",
  "possession_origin": "live_ball | steal | deflection | defensive_rebound | offensive_rebound | inbound | after_timeout | after_foul | press_break | unknown",
  "setup": "one sentence, jersey numbers only",
  "action": "one sentence, jersey numbers only",
  "finish": "dunk | putback_dunk | layup | reverse_layup | euro_step_layup | finger_roll | pull_up_mid | runner | floater | hook_shot | catch_and_shoot | made_3 | missed_3 | made_2 | missed_2 | tip_in | and_one | block | steal | charge_taken | foul_drawn | out_of_bounds | shot_clock_violation | unknown_finish",
  "finish_location": "paint | midrange_left | midrange_right | corner_3_left | corner_3_right | above_break_3 | free_throw_line",
  "players": ["#11", "#2"],
  "type": "offense | defense | transition",
  "perspective": "offense | defense | defensive_failure",
  "description": "one sentence in English, jersey numbers only"
}]`;

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
  // Step 1: Gemini detects plays from full video
  const geminiPlays = await analyzeFullVideoWithGemini(videoPath, geminiFileUri, jerseyColor, opponentJerseyColor, teamName, roster, context);

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
