/**
 * HoopAssist analysis pipeline v2.
 *
 *   SURVEY   Gemini watches the game in 2-minute chunks at 2 fps / low media
 *            resolution and logs EVERY possession as a literal event chain
 *            with timestamps (one call per chunk, strict JSON schema).
 *            Chunks that come back implausibly empty are re-scanned once.
 *   COACH    Claude gets the full possession log plus key frames (cut
 *            locally with ffmpeg at the exact moments Gemini named), picks
 *            the 10–15 most instructive possessions and writes the Hebrew
 *            coaching analysis in ONE call.
 *   DEEP     On demand only (button per play): Gemini re-watches one
 *            possession at 6 fps and Claude rewrites that card.
 *
 * Gemini's survey is cached by file hash, so re-running the same video only
 * costs Claude. All Gemini requests are small inline clips (works with AQ.
 * auth keys; nothing is uploaded).
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

type ProgressCb = (pct: number, msg: string) => void;

export interface V2Input {
  videoPath: string;
  context: string;
  focus: string;
  teamName: string;
  roster: string;
  jerseyColor?: string;
  opponentJerseyColor?: string;
  extraContext?: string;
  onProgress?: ProgressCb;
}

export interface V2Play {
  startTime: string;
  endTime: string;
  type: 'offense' | 'defense' | 'transition';
  label: string;
  note: string;
  players: string[];
  observations?: string[];
  verdict?: 'good' | 'bad' | 'improve';
  finish_location?: string;
  possessionId?: number;
  gameClock?: string;
}

export interface V2Result {
  game: string;
  warnings?: string[];
  plays: V2Play[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
  possessionLog?: Possession[];
  videoHash?: string;
}

export interface Possession {
  id: number;
  start: number;
  end: number;
  offense: string;
  transition: boolean;
  chain: { t: number; who: string; what: string; where?: string }[];
  positions_at_key_moment?: string;
  game_clock?: string;
  outcome: string;
  points: number;
  shot_location?: string;
  confidence: string;
}

// ---------- config ----------
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const CHUNK_SEC = 120;
const CHUNK_OVERLAP = 12;
const SURVEY_FPS = 2;
const DEEP_FPS = 6;
const MIN_PLAYS = 10;
const MAX_PLAYS = 15;
const CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY || 3);
const CACHE_DIR = process.env.SURVEY_CACHE_DIR || path.join(os.tmpdir(), 'hoopassist-survey-cache');
const SURVEY_VERSION = 'v2.3'; // bump when the survey prompt/schema changes

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const FFMPEG = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe')) ? path.join(BIN_DIR, 'ffmpeg.exe') : 'ffmpeg';
const FFPROBE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe')) ? path.join(BIN_DIR, 'ffprobe.exe') : 'ffprobe';

// ---------- utils ----------
export const mmss = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function probeDuration(p: string): number {
  const d = parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', p], { encoding: 'utf-8', timeout: 30000 }).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('לא הצלחתי לקרוא את אורך הסרטון (ffprobe)');
  return d;
}

function fileHash(p: string): string {
  // fast fingerprint: size + first/last 4MB (full-file hash of a 1GB game is slow)
  const st = fs.statSync(p);
  const h = crypto.createHash('sha1').update(String(st.size));
  const fd = fs.openSync(p, 'r');
  try {
    const n = Math.min(4 * 1024 * 1024, st.size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0); h.update(buf);
    fs.readSync(fd, buf, 0, n, Math.max(0, st.size - n)); h.update(buf);
  } finally { fs.closeSync(fd); }
  return h.digest('hex').slice(0, 16);
}

function cutClip(src: string, start: number, len: number, fps: number, height: number, kbps: number, dir: string): string {
  const out = path.join(dir, `c_${Math.round(start * 10)}_${fps}_${height}.mp4`);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-ss', String(start), '-t', String(len), '-i', src,
    '-vf', `scale=-2:${height},fps=${fps}`, '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-ac', '1', '-b:a', '32k', '-movflags', '+faststart', out, '-y'],
    { timeout: 300000 });
  return out;
}

function grabFrame(src: string, at: number, dir: string, height = 540): string | null {
  const out = path.join(dir, `f_${Math.round(at * 10)}.jpg`);
  try {
    execFileSync(FFMPEG, ['-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', src,
      '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '4', out, '-y'], { timeout: 60000 });
    return fs.existsSync(out) ? out : null;
  } catch { return null; }
}

function parseJson(text: string): any {
  const t = (text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const first = Math.min(...['{', '['].map(c => t.indexOf(c)).filter(i => i >= 0));
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (Number.isFinite(first) && last > first) return JSON.parse(t.slice(first, last + 1));
  throw new Error('JSON parse failed');
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- rate limiting: fast until the API says otherwise ----------
let gapMs = 0;            // 0 = no pacing; set after the first 429
let nextSlot = 0;
async function pace(): Promise<void> {
  if (!gapMs) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}
function onRateLimited() {
  const rpm = Number(process.env.GEMINI_RPM || 0);
  gapMs = rpm > 0 ? 60000 / rpm : Math.max(gapMs * 1.5, 13000); // default: ~5 RPM free tier
}

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err: any) {
      const msg = String(err?.message || err);
      if (/GEMINI_DAILY_QUOTA/.test(msg)) throw err;
      const is429 = err?.status === 429 || /429|RESOURCE_EXHAUSTED/.test(msg);
      const transient = is429 || [500, 503, 529].includes(err?.status) || /500|503|529|overloaded|high demand|UNAVAILABLE|JSON parse/i.test(msg);
      if (!transient || i >= attempts) throw err;
      if (is429) onRateLimited();
      const hinted = Number((msg.match(/retry in ([\d.]+)s/i) || [])[1]);
      const ms = Number.isFinite(hinted) && hinted > 0 ? (hinted + 1) * 1000 : [4, 10, 25, 60][i] * 1000;
      console.log(`   ↻ ${label}: ${msg.slice(0, 70)} — retry in ${(ms / 1000).toFixed(0)}s`);
      await new Promise(r => setTimeout(r, ms));
    }
  }
}

// ---------- Gemini (with per-model daily-quota fallback) ----------
const exhaustedAt = new Map<string, number>();
const isExhausted = (m: string) => (exhaustedAt.get(m) || 0) > Date.now() - 6 * 3600 * 1000;
function modelChain(): string[] {
  const extra = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3-flash-preview')
    .split(',').map(x => x.trim()).filter(Boolean);
  return [...new Set([GEMINI_MODEL(), ...extra])];
}

const SURVEY_SCHEMA = {
  type: 'object',
  properties: {
    possessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' }, end: { type: 'number' },
          offense: { type: 'string' }, transition: { type: 'boolean' },
          chain: { type: 'array', items: { type: 'object', properties: {
            t: { type: 'number' }, who: { type: 'string' }, what: { type: 'string' }, where: { type: 'string' },
          }, required: ['t', 'who', 'what'] } },
          positions_at_key_moment: { type: 'string' },
          game_clock: { type: 'string' },
          outcome: { type: 'string' }, points: { type: 'integer' },
          shot_location: { type: 'string', enum: ['paint', 'mid', 'corner3', 'above_break3', 'none'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['start', 'end', 'offense', 'transition', 'chain', 'outcome', 'points', 'shot_location', 'confidence'],
      },
    },
  },
  required: ['possessions'],
};

/** SDK loaders — swappable in tests via __setSdkLoaders */
let loadGenAI = async () => import('@google/genai');
let loadAnthropic = async (): Promise<typeof Anthropic> => Anthropic;
export function __setSdkLoaders(g?: typeof loadGenAI, a?: typeof loadAnthropic) { if (g) loadGenAI = g; if (a) loadAnthropic = a; }

function mediaRes(MR: any, mode: 'survey' | 'deep') {
  const want = (process.env.GEMINI_MEDIA_RES || (mode === 'survey' ? 'medium' : 'high')).toLowerCase();
  return want === 'low' ? MR.MEDIA_RESOLUTION_LOW : want === 'high' ? MR.MEDIA_RESOLUTION_HIGH : want === 'default' ? undefined : MR.MEDIA_RESOLUTION_MEDIUM;
}

async function gemini(clipPath: string, fps: number, prompt: string, maxTokens: number, schema?: object, mode: 'survey' | 'deep' = 'survey'): Promise<any> {
  const { GoogleGenAI, MediaResolution } = await loadGenAI();
  const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || '').trim() });
  const data = fs.readFileSync(clipPath).toString('base64');
  for (const model of modelChain()) {
    if (isExhausted(model)) continue;
    await pace();
    try {
      const res = await ai.models.generateContent({
        model,
        config: {
          temperature: 0.15, maxOutputTokens: maxTokens, responseMimeType: 'application/json',
          ...(schema ? { responseJsonSchema: schema } : {}),
          ...(mediaRes(MediaResolution, mode) ? { mediaResolution: mediaRes(MediaResolution, mode) } : {}),
        } as any,
        contents: [{ role: 'user', parts: [
          { inlineData: { data, mimeType: 'video/mp4' }, videoMetadata: { fps } } as any,
          { text: prompt },
        ] }],
      });
      const u: any = (res as any).usageMetadata;
      if (u) console.log(`   · ${model}: ${u.promptTokenCount ?? '?'} in / ${u.candidatesTokenCount ?? '?'} out tokens`);
      return parseJson(typeof res.text === 'string' ? res.text : '');
    } catch (err: any) {
      const msg = String(err?.message || err);
      const daily = /per day|PerDay/i.test(msg);
      const unusable = [401, 403, 404].includes(err?.status) || /not found|not supported|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(msg);
      if (daily || unusable) {
        exhaustedAt.set(model, Date.now());
        console.log(`   ⚠️ ${model} ${daily ? 'used up its daily free quota' : 'is not available for this key'} — switching model`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('GEMINI_DAILY_QUOTA: נגמרה המכסה היומית החינמית של Gemini לכל המודלים. נסה שוב מחר, או הפעל חיוב ב-AI Studio.');
}

// ---------- Claude ----------
type ImgPart = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };
async function claude(system: string, content: (string | ImgPart)[], maxTokens: number): Promise<any> {
  const A = await loadAnthropic();
  const client = new A({ apiKey: process.env.ANTHROPIC_API_KEY });
  const blocks: Anthropic.ContentBlockParam[] = content.map(c => typeof c === 'string' ? { type: 'text', text: c } : c);
  const msg = await client.messages.create({
    model: CLAUDE_MODEL(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: blocks }],
  });
  console.log(`   · ${CLAUDE_MODEL()}: ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out tokens`);
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  return parseJson(text);
}

// ---------- 1. SURVEY ----------
function teamsLine(i: V2Input): string {
  const a = i.teamName ? `Focus team: "${i.teamName}"${i.jerseyColor ? ` (jerseys: ${i.jerseyColor})` : ''}.` : 'No focus team given.';
  const b = i.opponentJerseyColor ? ` Opponent jerseys: ${i.opponentJerseyColor}.` : '';
  return a + b;
}

function surveyPrompt(i: V2Input, chunkLen: number): string {
  return `You are a professional basketball video coordinator logging a broadcast clip (${Math.round(chunkLen)}s long).
${teamsLine(i)}
${i.roster ? `Focus-team roster (number – name):\n${i.roster}\n` : ''}
Log EVERY possession of live game action in this clip: made shots, misses, turnovers, fouls, offensive rebounds that extend a possession. Completeness matters more than detail — an NBA clip this long normally contains ${Math.round(chunkLen / 15)}–${Math.round(chunkLen / 9)} possessions. Do not skip any.

POSSESSION BOUNDARIES — follow strictly:
- A possession ENDS and a new one STARTS at: a turnover (lost ball, steal, bad pass, offensive foul), a defensive rebound, a made basket, or a dead ball that changes possession. Even if the same team gets the ball right back, that is a NEW possession.
- An offensive rebound (incl. a tip/deflection that stays with the offense) does NOT end the possession — log it as an event inside the same possession.
- A possession is normally 4–24 seconds. If yours is longer than ~28s you have almost certainly merged two — split it.
Example of the right split: "A grabs an offensive rebound, passes to B, B loses the ball while dribbling" = possession 1 (ends at the turnover). "Opponent misses, A deflects the rebound to C, C passes to B, B drives, big helps, B lobs to D for the dunk" = possession 2, starting at the opponent's shot.

For each possession write the event chain in the exact order it happened, as a coach would rewind it. Be literal: a missed shot that is deflected on the rebound and lands with another player is three separate events (miss, deflection, recovery) — NOT a set play. Only name an action (pick and roll, handoff, post-up, off-ball screen…) if you actually see the screen / handoff / post entry.

positions_at_key_moment: one sentence on where the players were at the moment that decided the possession (e.g. "driver at the left elbow, two defenders collapse, big alone in the dunker spot, weak-side corner empty").

game_clock: the game clock shown on the broadcast graphic when the possession starts, e.g. "Q1 8:42" (empty if not visible). Read it from the score bug — it is the coach's reference.

Identify players by jersey number and, when visible or said by the commentators, by name. Commentary audio is a valid source. Jersey numbers matter: look at the back/front of the jersey at the moment of the action, not at a guess from position.

Skip replays (slow motion, replay graphics, a second angle of a moment already shown), timeouts, bench/crowd shots, and free throws unless something else happens.

Timestamps are seconds from the start of THIS clip, decimals allowed. "offense" = the team with the ball (name or jersey colour).`;
}

function cachePath(hash: string, chunkStart: number) {
  return path.join(CACHE_DIR, `${hash}_${SURVEY_VERSION}_${chunkStart}.json`);
}

interface RawPossession extends Omit<Possession, 'id'> { _core: boolean }

async function surveyChunk(i: V2Input, s: number, len: number, duration: number, dir: string, hash: string, offsetTag = ''): Promise<RawPossession[]> {
  const cp = cachePath(hash, s) + offsetTag;
  if (fs.existsSync(cp)) {
    const list = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    console.log(`   📋 ${mmss(s)}–${mmss(s + len)}: ${list.length} possessions (cached)`);
    return list;
  }
  let clip = cutClip(i.videoPath, s, len, SURVEY_FPS, 480, 700, dir);
  if (fs.statSync(clip).size > 13 * 1024 * 1024) { fs.rmSync(clip, { force: true }); clip = cutClip(i.videoPath, s, len, SURVEY_FPS, 480, 450, dir); }
  try {
    const json = await retry(() => gemini(clip, SURVEY_FPS, surveyPrompt(i, len), 16384, SURVEY_SCHEMA), `survey ${mmss(s)}`);
    const raw = Array.isArray(json?.possessions) ? json.possessions : [];
    const list: RawPossession[] = raw.map((p: any) => ({
      start: s + Number(p.start || 0), end: s + Number(p.end || p.start || 0),
      offense: String(p.offense || '?'), transition: !!p.transition,
      chain: (Array.isArray(p.chain) ? p.chain : []).map((e: any) => ({ t: s + Number(e.t || 0), who: String(e.who || ''), what: String(e.what || ''), where: e.where ? String(e.where) : undefined })),
      positions_at_key_moment: p.positions_at_key_moment ? String(p.positions_at_key_moment) : undefined,
      game_clock: p.game_clock ? String(p.game_clock) : undefined,
      outcome: String(p.outcome || ''), points: Number(p.points || 0),
      shot_location: p.shot_location, confidence: String(p.confidence || 'medium'),
      // a possession that starts inside the overlap tail belongs to the next chunk
      _core: Number(p.start || 0) < CHUNK_SEC - CHUNK_OVERLAP || s + CHUNK_SEC >= duration - 5,
    }));
    console.log(`   📋 ${mmss(s)}–${mmss(s + len)}: ${list.length} possessions`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cp, JSON.stringify(list));
    return list;
  } finally {
    fs.rmSync(clip, { force: true });
  }
}

let surveyWarnings: string[] = [];
async function survey(i: V2Input, duration: number, dir: string, hash: string): Promise<Possession[]> {
  surveyWarnings = [];
  const starts: number[] = [];
  for (let s = 0; s < duration - 5; s += CHUNK_SEC - CHUNK_OVERLAP) starts.push(s);
  let done = 0;
  const results = await pool(starts, CONCURRENCY, async (s) => {
    const len = Math.min(CHUNK_SEC, duration - s);
    let list: RawPossession[] = [];
    try {
      list = await surveyChunk(i, s, len, duration, dir, hash);
      // Plausibility: a minute+ of broadcast with 0–1 possessions is almost
      // always a bad read, not an empty minute. Re-scan once, shifted.
      if (len >= 60 && list.length <= 1) {
        console.log(`   🔁 ${mmss(s)}: only ${list.length} possession(s) in ${Math.round(len)}s — re-scanning`);
        const shift = s >= 20 ? 20 : 0;              // start 20s earlier when possible
        const again = await surveyChunk(i, s - shift, Math.min(len + shift, duration - (s - shift)), duration, dir, hash, `.r${shift}`);
        if (again.length > list.length) list = again.filter(p => p.start >= s - 1 && p.start < s + len);
      }
    } catch (e: any) {
      console.error(`   ❌ survey ${mmss(s)} failed: ${e?.message || e}`);
      if (/GEMINI_DAILY_QUOTA/.test(String(e?.message))) throw e;
      surveyWarnings.push(`הקטע ${mmss(s)}–${mmss(s + len)} לא נסרק (${String(e?.message || e).slice(0, 60)})`);
    } finally {
      done++;
      i.onProgress?.(10 + Math.round((done / starts.length) * 55), `סורק את המשחק… ${done}/${starts.length}`);
    }
    return list;
  });

  const all = results.flat().filter(p => p._core).sort((a, b) => a.start - b.start);
  const merged: Possession[] = [];
  for (const p of all) {
    const prev = merged[merged.length - 1];
    if (prev && (Math.abs(prev.start - p.start) < 3 || (Math.abs(prev.start - p.start) < 6 && prev.offense === p.offense))) {
      if (p.chain.length > prev.chain.length) Object.assign(prev, { ...p, id: prev.id, _core: undefined });
      continue;
    }
    const { _core, ...clean } = p;
    merged.push({ ...clean, id: merged.length + 1 });
  }
  return merged;
}

// ---------- 2. COACH (select + write, one call, with frames) ----------
const GLOSSARY = `TERMINOLOGY — use exactly these forms, every time, so all cards read as one voice:
Players: write the name exactly as it appears in the roster (Latin letters), surname only — "Dort", "Hartenstein", "Holmgren". When two roster players share a surname (e.g. Jalen Williams / Jaylin Williams / Kenrich Williams) ALWAYS use the full roster name. Add the jersey number on first mention in each card: "Dort (#5)". Opponents: Latin surname as the broadcast shows it — "LeBron", "Dončić", "Reaves", "Ayton". Never transliterate names into Hebrew letters.
Actions (one spelling each): pick and roll · pick and pop · handoff · post-up · isolation · drive · kick-out · cut · backdoor · off-ball screen · drop coverage · switch · hedge · closeout · help side · rotation · box-out · ריבאונד התקפי / ריבאונד הגנתי · איבוד כדור · סטיל · בלוק · עבירה · מעבר (fast break) · secondary break.
Shots: לייאפ · דאנק · alley-oop · floater · pull-up · fadeaway · step-back · catch-and-shoot · שלשה · זריקה מהבינוני · זריקה מהצבע.
Court spots: הצבע · dunker spot · הפינה (corner) · הכנף (wing) · ה-slot · המרפק (elbow) · למעלה (top) · short corner · weak side / strong side.
Never alternate between synonyms (not "חסימה" one time and "סקרין" the next, not "פדאווי" and "fadeaway"). Hebrew for everything else.`;

const COACH_SYSTEM = `You are an elite basketball coach and video coordinator (Euroleague / NBA level) preparing film for a coaching staff.
You think in cause and effect: every possession is a chain of decisions, and you name the link that decided it.
You never invent events. The possession log is a first pass by a video model; the frames are ground truth. When they disagree, trust the frames and say what you corrected.
You write in natural professional Hebrew.

${GLOSSARY}`;

function keyMoments(p: Possession): number[] {
  const ts = p.chain.map(e => e.t).filter(t => t >= p.start - 1 && t <= p.end + 1);
  if (ts.length === 0) return [p.start + (p.end - p.start) / 2];
  if (ts.length <= 3) return ts;
  // first, middle, last event
  return [ts[0], ts[Math.floor(ts.length / 2)], ts[ts.length - 1]];
}

async function coach(i: V2Input, log: Possession[], dir: string): Promise<any> {
  // Frames: up to 2 per possession, capped at ~60 images total (cheap with Haiku/Sonnet at 540p)
  const perPoss = log.length > 20 ? 1 : 2;
  const content: (string | ImgPart)[] = [];
  content.push(`${teamsLine(i)}
${i.roster ? `Focus-team roster: ${i.roster}\n` : ''}${i.focus && i.focus !== 'all' ? `Coach's focus for this film session: ${i.focus}\n` : ''}${i.context ? `Game context: ${i.context}\n` : ''}${i.extraContext ? `\nTeam knowledge and past coach corrections (respect them):\n${i.extraContext}\n` : ''}
Below is the complete possession log of the video (${log.length} possessions), each followed by frames taken at its key moments (labelled with the possession id and the video time).

YOUR TASK
1. Choose between ${Math.min(MIN_PLAYS, log.length)} and ${Math.min(MAX_PLAYS, log.length)} possessions worth showing the staff: clear good execution, clear mistakes, and possessions that scored but could have been run better. Mix offense and defense, prefer readable cause-and-effect chains, skip low-confidence or trivial ones.
   COVERAGE RULE: the picks must span the whole video — include at least one possession from each ${CHUNK_SEC / 60}-minute segment that has possessions in the log (the log is grouped by segment below). Do not cluster everything in one stretch.
2. For each chosen possession, using the log AND the frames, write:
   - label: short name of what actually happened (not a guessed set name).
   - what_happened: the cause-and-effect story in 2–4 sentences, in order.
   - positions: where the key players were and how that created or killed the advantage, including who was guarding whom and where the help was (1–3 sentences). Verify jersey numbers against the frames.
   - verdict: "good" | "bad" | "improve".
   - lesson: why it worked, or exactly what to do better and who should do it (1–2 sentences).
   - type: from the focus team's point of view — "offense" if they had the ball, "defense" if the opponent did, "transition" for fast breaks either way. Without a focus team, use the team with the ball.
   - players: directly involved, as "#number name" when known.
   - corrected: true if the frames contradicted the log and you fixed it.
   - start / end (optional, "mm:ss"): narrow the window when the logged possession is really two merged possessions or includes dead time — the clip the coach watches should contain exactly the sequence you describe.
3. Write 3–5 insights across the whole video — patterns, not repeats of single plays. type "good" | "warn" | "bad".

Return JSON only:
{"game":"one-line Hebrew description of the video","plays":[{"id":3,"start":"00:39","end":"00:53","label":"","what_happened":"","positions":"","verdict":"good","lesson":"","type":"offense","players":["#55 Hartenstein"],"corrected":false}],"insights":[{"type":"good","title":"","body":""}]}

POSSESSION LOG:`);

  let frames = 0;
  let seg = -1;
  for (const p of log) {
    const thisSeg = Math.floor(p.start / CHUNK_SEC);
    if (thisSeg !== seg) { seg = thisSeg; content.push(`\n===== segment ${mmss(seg * CHUNK_SEC)}–${mmss((seg + 1) * CHUNK_SEC)} =====`); }
    const dur = p.end - p.start;
    content.push(`\n[#${p.id}] ${mmss(p.start)}–${mmss(p.end)}${p.game_clock ? ` (${p.game_clock})` : ''} | offense: ${p.offense}${p.transition ? ' | transition' : ''} | ${p.points} pts | confidence ${p.confidence}${dur > 28 ? ` | ⚠ ${Math.round(dur)}s — probably two possessions merged; describe ONE and narrow start/end` : ''}
chain: ${p.chain.map(e => `${e.t.toFixed(1)}s ${e.who}: ${e.what}${e.where ? ` (${e.where})` : ''}`).join(' → ')}
outcome: ${p.outcome}${p.positions_at_key_moment ? `\npositions: ${p.positions_at_key_moment}` : ''}`);
    const moments = keyMoments(p).slice(-perPoss);
    for (const t of moments) {
      if (frames >= 40) break;
      const f = grabFrame(i.videoPath, t, dir);
      if (!f) continue;
      content.push(`frame #${p.id} @ ${t.toFixed(1)}s:`);
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
      frames++;
    }
  }
  console.log(`🖼️ Sending ${frames} key frames to Claude`);
  return retry(() => claude(COACH_SYSTEM, content, 16000), 'coach', 2);
}

// ---------- 3. DEEP DIVE (on demand) ----------
export async function deepDivePlay(videoPath: string, p: Possession, meta: Pick<V2Input, 'teamName' | 'roster' | 'jerseyColor' | 'opponentJerseyColor'>): Promise<Partial<V2Play>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoopassist-deep-'));
  try {
    const duration = probeDuration(videoPath);
    const start = Math.max(0, p.start - 3);
    const len = Math.min(duration - start, Math.max(8, p.end - p.start + 5));
    const clip = cutClip(videoPath, start, len, DEEP_FPS, 720, 1800, dir);
    const i = { ...meta, videoPath, context: '', focus: '' } as V2Input;
    const seen = await retry(() => gemini(clip, DEEP_FPS, `You are a basketball video coordinator breaking down ONE possession for a coaching staff.
${teamsLine(i)}
${i.roster ? `Focus-team roster:\n${i.roster}\n` : ''}
A first pass logged it as (seconds in THIS clip):
${p.chain.map(e => `- ${(e.t - start).toFixed(1)}s ${e.who}: ${e.what}`).join('\n')}
Outcome: ${p.outcome}

Watch carefully and CORRECT the first pass wherever it is wrong. Return JSON only:
{"what_i_saw":"literal sequence in order","key_moments":[{"t":3.5,"positions":"where every visible player is, who guards whom, who helps","decision":"..."}],"cause_chain":"how each event led to the next","what_worked":"...","what_could_be_better":"for both teams where relevant","players":["#55 Hartenstein"]}`, 4096, undefined, 'deep'), `deep ${mmss(p.start)}`);

    const w = await retry(() => claude(COACH_SYSTEM, [`${teamsLine(i)}
Frame-by-frame breakdown of one possession (${mmss(p.start)}–${mmss(p.end)}):
${JSON.stringify(seen)}

Write the card for the coaching staff in Hebrew. Return JSON only:
{"label":"","what_happened":"2–4 sentences, in order","positions":"1–3 sentences","verdict":"good|bad|improve","lesson":"1–2 sentences","type":"offense|defense|transition","players":["#55 Hartenstein"]}`], 3000), 'deep write', 2);
    return toPlay(p, w, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- assemble ----------
function toPlay(p: Possession, w: any, _d: any): V2Play {
  const verdictTxt = w.verdict === 'good' ? 'למה זה עבד' : w.verdict === 'bad' ? 'מה השתבש' : 'מה אפשר לשפר';
  const note = [
    esc(w.what_happened || p.outcome),
    w.positions ? `<br><b>עמדות:</b> ${esc(w.positions)}` : '',
    w.lesson ? `<br><b>${verdictTxt}:</b> ${esc(w.lesson)}` : '',
  ].join('');
  const type = ['offense', 'defense', 'transition'].includes(w.type) ? w.type : (p.transition ? 'transition' : 'offense');
  const toSec = (v: any) => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  let st = toSec(w.start), en = toSec(w.end);
  if (!(Number.isFinite(st) && st >= p.start - 2 && st <= p.end)) st = p.start;
  if (!(Number.isFinite(en) && en > st && en <= p.end + 2)) en = p.end;
  return {
    startTime: mmss(st), endTime: mmss(en), type,
    gameClock: p.game_clock,
    label: String(w.label || p.outcome).slice(0, 80), note,
    players: Array.isArray(w.players) ? w.players : [],
    verdict: ['good', 'bad', 'improve'].includes(w.verdict) ? w.verdict : undefined,
    finish_location: p.shot_location,
    observations: [w.positions, w.lesson].filter(Boolean),
    possessionId: p.id,
  };
}

export async function runPipelineV2(i: V2Input): Promise<V2Result> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoopassist-v2-'));
  const t0 = Date.now();
  try {
    const duration = probeDuration(i.videoPath);
    const hash = fileHash(i.videoPath);
    console.log(`🏀 v2 pipeline: ${mmss(duration)} video, hash ${hash}, ${GEMINI_MODEL()} + ${CLAUDE_MODEL()}`);

    i.onProgress?.(10, 'סורק את המשחק…');
    const log = await survey(i, duration, dir, hash);
    console.log(`📋 Survey: ${log.length} possessions in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const first = log[0]?.start ?? 0;
    if (first > 60) { surveyWarnings.push(`לא זוהו פוזשנים לפני ${mmss(first)}`); console.warn(`⚠️ first possession only at ${mmss(first)}`); }
    for (const w of surveyWarnings) console.warn(`⚠️ ${w}`);
    if (!log.length) throw new Error('לא זוהו פוזשנים בסרטון. בדוק שזה סרטון משחק ושהמפתח של Gemini תקין.');

    i.onProgress?.(70, 'המאמן צופה ברגעי המפתח וכותב ניתוח…');
    const out = await coach(i, log, dir);

    const chosen = (Array.isArray(out.plays) ? out.plays : [])
      .map((w: any) => ({ w, p: log.find(p => p.id === Number(w.id)) }))
      .filter((x: any) => x.p)
      .sort((a: any, b: any) => a.p.start - b.p.start)
      .slice(0, MAX_PLAYS);
    const plays = chosen.map(({ w, p }: any) => toPlay(p, w, {}));
    const corrected = chosen.filter((x: any) => x.w.corrected).length;
    console.log(`🎯 ${plays.length} plays written (${corrected} corrected from frames) — total ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    const chart = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
    for (const pl of plays) {
      const loc = String(pl.finish_location || '');
      if (loc === 'paint') chart.paint++; else if (loc === 'mid') chart.midRange++;
      else if (loc === 'corner3') chart.corner3++; else if (loc === 'above_break3') chart.aboveBreak3++;
    }
    const tot = chart.paint + chart.midRange + chart.corner3 + chart.aboveBreak3;
    if (tot) (['paint', 'midRange', 'corner3', 'aboveBreak3'] as const).forEach(k => { chart[k] = Math.round((chart[k] / tot) * 100); });

    return {
      game: out.game || i.context || 'ניתוח משחק',
      plays,
      insights: (Array.isArray(out.insights) ? out.insights : []).filter((x: any) => x?.title).map((x: any) => ({
        type: ['good', 'warn', 'bad'].includes(x.type) ? x.type : 'warn', title: String(x.title), body: String(x.body || ''),
      })),
      shotChart: chart,
      warnings: surveyWarnings.length ? [...surveyWarnings] : undefined,
      possessionLog: log,
      videoHash: hash,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
