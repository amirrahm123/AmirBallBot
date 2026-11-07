/**
 * HoopAssist analysis pipeline v2.
 *
 *   1. SURVEY   — the video is cut locally into short overlapping chunks and
 *                 Gemini logs EVERY possession in each chunk as an ordered
 *                 event chain (miss → deflection → rebound → drive → lob…).
 *   2. SELECT   — Claude reads the whole possession log and picks the 10–15
 *                 most instructive possessions (good, bad, could be better).
 *   3. DEEP DIVE— each selected possession is re-cut tightly and re-watched by
 *                 Gemini at a higher frame rate: positions, spacing, decisions.
 *   4. COACH    — Claude writes the Hebrew coaching analysis + insights,
 *                 grounded only in what the deep dive actually saw.
 *
 * Every Gemini request carries a small inline clip (no Files API), so it works
 * with the new AQ. auth keys and never resends a whole game per request.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
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
  extraContext?: string; // team knowledge + past coach corrections
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
}

export interface V2Result {
  game: string;
  plays: V2Play[];
  insights: { type: 'good' | 'warn' | 'bad'; title: string; body: string }[];
  shotChart: { paint: number; midRange: number; corner3: number; aboveBreak3: number; pullUp: number };
}

// ---------- config ----------
const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const CHUNK_SEC = 75;          // survey window
const CHUNK_STEP = 60;         // 15s overlap so no possession is cut in half
const SURVEY_FPS = 2;
const DEEP_FPS = 6;
const CONCURRENCY = Number(process.env.GEMINI_CONCURRENCY || 3);

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const FFMPEG = fs.existsSync(path.join(BIN_DIR, 'ffmpeg.exe')) ? path.join(BIN_DIR, 'ffmpeg.exe') : 'ffmpeg';
const FFPROBE = fs.existsSync(path.join(BIN_DIR, 'ffprobe.exe')) ? path.join(BIN_DIR, 'ffprobe.exe') : 'ffprobe';

// ---------- small utils ----------
const mmss = (s: number) => {
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

function cutClip(src: string, start: number, len: number, fps: number, kbps: number, dir: string): string {
  const out = path.join(dir, `c_${Math.round(start * 10)}_${fps}.mp4`);
  execFileSync(FFMPEG, ['-loglevel', 'error', '-ss', String(start), '-t', String(len), '-i', src,
    '-vf', `scale=-2:720,fps=${fps}`, '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    '-c:a', 'aac', '-ac', '1', '-b:a', '32k', '-movflags', '+faststart', out, '-y'],
    { timeout: 300000 });
  return out;
}

function parseJson(text: string): any {
  const t = (text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const first = Math.min(...['{', '['].map(c => t.indexOf(c)).filter(i => i >= 0));
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (Number.isFinite(first) && last > first) return JSON.parse(t.slice(first, last + 1));
  throw new Error('JSON parse failed');
}

async function retry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const delays = [5, 15, 30, 60, 90];
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err: any) {
      const msg = String(err?.message || err);
      const transient = [429, 500, 503, 529].includes(err?.status) || /429|500|503|529|overloaded|high demand|RESOURCE_EXHAUSTED|UNAVAILABLE|JSON parse/i.test(msg);
      if (!transient || /GEMINI_DAILY_QUOTA/.test(msg) || i >= delays.length) throw err;
      const hinted = Number((msg.match(/retry in ([\d.]+)s/i) || [])[1]);
      const ms = Number.isFinite(hinted) && hinted > 0 ? (hinted + 2) * 1000 : delays[i] * 1000 * (0.8 + Math.random() * 0.4);
      console.log(`   ↻ ${label}: ${msg.slice(0, 80)} — retry in ${(ms / 1000).toFixed(0)}s`);
      await new Promise(r => setTimeout(r, ms));
    }
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Free-tier Gemini allows ~5 requests/minute per model. Space every call out
// (GEMINI_RPM in .env raises it on a paid plan) instead of hitting 429s.
let nextSlot = 0;
async function rateLimit(): Promise<void> {
  const gap = 60000 / Math.max(1, Number(process.env.GEMINI_RPM || 5));
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}

// Free-tier quotas are per model (e.g. 20 requests/day each), so when one
// model is used up for the day we move on to the next instead of failing.
// GEMINI_FALLBACK_MODELS (comma list) overrides the chain.
const exhaustedAt = new Map<string, number>();
const exhausted = {
  has: (m: string) => (exhaustedAt.get(m) || 0) > Date.now() - 6 * 3600 * 1000, // re-try a model after 6h
  add: (m: string) => { exhaustedAt.set(m, Date.now()); },
  get size() { return [...exhaustedAt.keys()].filter(m => exhausted.has(m)).length; },
};
function modelChain(): string[] {
  const extra = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-3-flash-preview')
    .split(',').map(x => x.trim()).filter(Boolean);
  return [...new Set([GEMINI_MODEL(), ...extra])];
}

async function gemini(clipPath: string, fps: number, prompt: string, maxTokens: number): Promise<any> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: (process.env.GEMINI_API_KEY || '').trim() });
  const data = fs.readFileSync(clipPath).toString('base64');
  for (const model of modelChain()) {
    if (exhausted.has(model)) continue;
    await rateLimit();
    try {
      const res = await ai.models.generateContent({
        model,
        config: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: 'application/json' } as any,
        contents: [{ role: 'user', parts: [
          { inlineData: { data, mimeType: 'video/mp4' }, videoMetadata: { fps } } as any,
          { text: prompt },
        ] }],
      });
      return parseJson(typeof res.text === 'string' ? res.text : '');
    } catch (err: any) {
      const msg = String(err?.message || err);
      const daily = /per day|PerDay/i.test(msg);
      const unusable = [401, 403, 404].includes(err?.status) || /not found|not supported|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(msg);
      if (daily || unusable) {
        exhausted.add(model);
        console.log(`   ⚠️ ${model} ${daily ? 'used up its daily free quota' : 'is not available for this key'} — switching model`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('GEMINI_DAILY_QUOTA: נגמרה המכסה היומית החינמית של Gemini לכל המודלים. נסה שוב מחר, או הוסף חיוב ב-AI Studio.');
}

async function claude(system: string, user: string, maxTokens: number): Promise<any> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: CLAUDE_MODEL(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: user }],
  });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  return parseJson(text);
}

// ---------- 1. SURVEY ----------
interface Possession {
  id: number;
  start: number;            // absolute seconds
  end: number;
  offense: string;          // team description (name / jersey color)
  chain: { t: number; who: string; what: string; where?: string }[];
  outcome: string;
  points: number;
  transition: boolean;
  shot_location?: string;
  confidence: string;
}

function teamsLine(i: V2Input): string {
  const a = i.teamName ? `Focus team: "${i.teamName}"${i.jerseyColor ? ` (jerseys: ${i.jerseyColor})` : ''}.` : 'No focus team given.';
  const b = i.opponentJerseyColor ? ` Opponent jerseys: ${i.opponentJerseyColor}.` : '';
  return a + b;
}

function surveyPrompt(i: V2Input, chunkLen: number): string {
  return `You are a professional basketball video analyst logging a broadcast clip (${Math.round(chunkLen)}s long).
${teamsLine(i)}
${i.roster ? `Focus-team roster (number – name):\n${i.roster}\n` : ''}
Log EVERY possession that is live game action in this clip — made shots, misses, turnovers, fouls, offensive rebounds. Do not pick favourites; completeness matters.

For each possession, write the event chain in the exact order it happened, the way a coach would rewind it frame by frame. Be literal: a missed shot that is tipped/deflected and lands with another player is three separate events (miss, deflection, recovery), NOT a pick-and-roll. Only name an action (pick and roll, handoff, post-up…) if you actually see the screen / handoff / post entry.

Identify players by jersey number and, when visible or said by the commentators, by name. Commentary audio is a valid source for names and for what happened.

Skip: replays (slow motion, replay graphics, different camera angle of a moment already shown), timeouts, crowd/bench shots, free throws only if nothing else happens.

Timestamps are seconds from the start of THIS clip (decimals allowed).

Return JSON only:
{"possessions":[{
  "start": 12.0, "end": 27.5,
  "offense": "team name or jersey colour of the team with the ball",
  "transition": false,
  "chain": [{"t": 14.0, "who": "#7 Shai", "what": "pull-up jumper from right elbow — miss", "where": "right elbow"}],
  "outcome": "short result, e.g. 'alley-oop dunk by #55 Hartenstein, 2 pts'",
  "points": 2,
  "shot_location": "paint | mid | corner3 | above_break3 | none",
  "confidence": "high | medium | low"
}]}`;
}

async function survey(i: V2Input, duration: number, dir: string): Promise<Possession[]> {
  const starts: number[] = [];
  for (let s = 0; s < duration - 5; s += CHUNK_STEP) starts.push(s);
  let done = 0;
  const results = await pool(starts, CONCURRENCY, async (s) => {
    const len = Math.min(CHUNK_SEC, duration - s);
    const clip = cutClip(i.videoPath, s, len, SURVEY_FPS, 900, dir);
    try {
      const json = await retry(() => gemini(clip, SURVEY_FPS, surveyPrompt(i, len), 8192), `survey ${mmss(s)}`);
      const list = Array.isArray(json?.possessions) ? json.possessions : [];
      console.log(`   📋 ${mmss(s)}–${mmss(s + len)}: ${list.length} possessions`);
      return list.map((p: any) => ({
        start: s + Number(p.start || 0), end: s + Number(p.end || p.start || 0),
        offense: String(p.offense || '?'), transition: !!p.transition,
        chain: (Array.isArray(p.chain) ? p.chain : []).map((e: any) => ({ t: s + Number(e.t || 0), who: String(e.who || ''), what: String(e.what || ''), where: e.where ? String(e.where) : undefined })),
        outcome: String(p.outcome || ''), points: Number(p.points || 0),
        shot_location: p.shot_location, confidence: String(p.confidence || 'medium'),
        // possessions starting in the overlap tail are owned by the next chunk
        _core: Number(p.start || 0) < CHUNK_STEP || s + CHUNK_STEP >= duration - 5,
      }));
    } catch (e: any) {
      console.error(`   ❌ survey ${mmss(s)} failed: ${e?.message || e}`);
      return [];
    } finally {
      fs.rmSync(clip, { force: true });
      done++;
      i.onProgress?.(10 + Math.round((done / starts.length) * 45), `סורק את המשחק… ${done}/${starts.length}`);
    }
  });

  // merge: keep each chunk's core possessions, then drop near-duplicates
  const all = results.flat().filter((p: any) => p._core).sort((a: any, b: any) => a.start - b.start);
  const merged: Possession[] = [];
  for (const p of all) {
    const prev = merged[merged.length - 1];
    if (prev && (Math.abs(prev.start - p.start) < 3 || (Math.abs(prev.start - p.start) < 6 && prev.offense === p.offense))) {
      if (p.chain.length > prev.chain.length) Object.assign(prev, { ...p, id: prev.id });
      continue;
    }
    const { _core, ...clean } = p;
    merged.push({ ...clean, id: merged.length + 1 });
  }
  return merged;
}

// ---------- 2. SELECT ----------
const COACH_SYSTEM = `You are an elite basketball coach and video coordinator (Euroleague / NBA level) working for a coaching staff.
You think in cause and effect: every possession is a chain of decisions, and you explain which link decided it.
You never invent events. If the log does not show something, you do not claim it.`;

async function select(i: V2Input, log: Possession[]): Promise<number[]> {
  if (log.length <= 10) return log.map(p => p.id);
  const min = 10, max = Math.min(15, log.length);
  const json = await retry(() => claude(COACH_SYSTEM, `${teamsLine(i)}
${i.focus ? `Coach's focus for this analysis: ${i.focus}\n` : ''}${i.context ? `Game context: ${i.context}\n` : ''}
Below is the complete possession log of the video (${log.length} possessions).
Pick between ${min} and ${max} possessions that are most worth showing a coaching staff: clear good execution, clear mistakes, and possessions that worked but could have been run better. Prefer a mix of offense and defense, spread across the video, and possessions with a readable cause-and-effect chain. Skip low-confidence or trivial ones.

${JSON.stringify(log.map(p => ({ id: p.id, time: `${mmss(p.start)}-${mmss(p.end)}`, offense: p.offense, transition: p.transition, chain: p.chain.map(e => `${mmss(e.t)} ${e.who}: ${e.what}`), outcome: p.outcome, confidence: p.confidence })))}

Return JSON only: {"ids":[3,7,...]}`, 2000), 'select');
  const ids = (Array.isArray(json?.ids) ? json.ids : []).map(Number).filter((id: number) => log.some(p => p.id === id));
  return ids.length >= Math.min(min, log.length) ? ids.slice(0, max) : log.slice(0, max).map(p => p.id);
}

// ---------- 3. DEEP DIVE ----------
function deepPrompt(i: V2Input, p: Possession, offset: number): string {
  return `You are a basketball video coordinator breaking down ONE possession for a coaching staff.
${teamsLine(i)}
${i.roster ? `Focus-team roster:\n${i.roster}\n` : ''}
A first pass logged this possession as (times are seconds in THIS clip):
${p.chain.map(e => `- ${(e.t - offset).toFixed(1)}s ${e.who}: ${e.what}`).join('\n')}
Outcome: ${p.outcome}

Watch the clip carefully and CORRECT the first pass wherever it is wrong. Then describe:
1. what_i_saw: the literal sequence, in order, before any interpretation.
2. key_moments: 2–4 frozen moments that decided the possession. For each: time, where every visible player is (offense and defense — corner, wing, slot, elbow, short corner, dunker spot, top, paint; who is guarding whom, who is helping), and the decision being made.
3. cause_chain: how each event led to the next (e.g. miss → long rebound off a deflection → defense not set → driver collapses two defenders → lob to the big left alone).
4. what_worked and what_could_be_better: for BOTH teams where relevant — spacing, help defense, rotations, box-outs, shot selection, passing reads.
5. players: everyone directly involved, as "#number name" when known.

Return JSON only:
{"what_i_saw":"...","corrected":true,"key_moments":[{"t":3.5,"positions":"...","decision":"..."}],"cause_chain":"...","what_worked":"...","what_could_be_better":"...","players":["#55 Hartenstein"],"shot_location":"paint|mid|corner3|above_break3|none","pull_up":false}`;
}

async function deepDive(i: V2Input, picks: Possession[], dir: string, duration: number): Promise<any[]> {
  let done = 0;
  return pool(picks, CONCURRENCY, async (p) => {
    const start = Math.max(0, p.start - 3);
    const len = Math.min(duration - start, Math.max(8, p.end - p.start + 5));
    const clip = cutClip(i.videoPath, start, len, DEEP_FPS, 1600, dir);
    try {
      return await retry(() => gemini(clip, DEEP_FPS, deepPrompt(i, p, start), 4096), `deep ${mmss(p.start)}`);
    } catch (e: any) {
      console.error(`   ❌ deep dive ${mmss(p.start)} failed: ${e?.message || e}`);
      return null;
    } finally {
      fs.rmSync(clip, { force: true });
      done++;
      i.onProgress?.(60 + Math.round((done / picks.length) * 25), `מנתח לעומק מהלך ${done} מתוך ${picks.length}`);
    }
  });
}

// ---------- 4. COACH WRITE-UP ----------
async function writeUp(i: V2Input, picks: Possession[], deep: any[]): Promise<{ plays: any[]; insights: any[]; game: string }> {
  const items = picks.map((p, k) => ({
    id: p.id, time: `${mmss(p.start)}-${mmss(p.end)}`, offense: p.offense, transition: p.transition,
    outcome: p.outcome, survey_chain: p.chain.map(e => `${mmss(e.t)} ${e.who}: ${e.what}`),
    deep_dive: deep[k] || null,
  }));
  return retry(() => claude(COACH_SYSTEM, `${teamsLine(i)}
${i.focus ? `Coach's focus: ${i.focus}\n` : ''}${i.context ? `Game context: ${i.context}\n` : ''}${i.extraContext ? `\nTeam knowledge and past coach corrections (respect them):\n${i.extraContext}\n` : ''}
Here are the selected possessions with a frame-by-frame deep dive for each. The deep dive overrides the survey chain when they disagree.

${JSON.stringify(items)}

Write the analysis for the coaching staff, in natural professional Hebrew (basketball terms may stay in English where coaches use them, e.g. pick and roll, help side, closeout).
For each possession:
- label: short name of what actually happened (not a guessed set).
- what_happened: the cause-and-effect story in 2–4 sentences, in the order it happened.
- positions: where the key players were and how that created or killed the advantage (1–3 sentences).
- verdict: "good" | "bad" | "improve".
- lesson: why it worked, or what exactly should be done better and by whom (1–2 sentences).
- type: from the focus team's point of view — "offense" if they had the ball, "defense" if the opponent did, "transition" for fast breaks either way. If no focus team, use the team with the ball.
- players: as given, "#number name".
Then 3–5 insights across all possessions (patterns, not repeats of single plays): type "good" | "warn" | "bad".

Return JSON only:
{"game":"one-line Hebrew description of the video","plays":[{"id":1,"label":"","what_happened":"","positions":"","verdict":"good","lesson":"","type":"offense","players":[]}],"insights":[{"type":"good","title":"","body":""}]}`, 12000), 'write-up');
}

// ---------- entry ----------
export async function runPipelineV2(i: V2Input): Promise<V2Result> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoopassist-v2-'));
  try {
    const duration = probeDuration(i.videoPath);
    console.log(`🏀 v2 pipeline: ${mmss(duration)} video, model ${GEMINI_MODEL()} + ${CLAUDE_MODEL()}`);

    i.onProgress?.(10, 'סורק את המשחק…');
    const log = await survey(i, duration, dir);
    console.log(`📋 Survey: ${log.length} possessions`);
    if (!log.length) throw new Error(exhausted.size >= modelChain().length ? 'נגמרה המכסה היומית החינמית של Gemini. נסה שוב מחר.' : 'לא זוהו פוזשנים בסרטון. בדוק שזה סרטון משחק ושהמפתח של Gemini תקין.');

    i.onProgress?.(56, 'בוחר את המהלכים החשובים…');
    const ids = await select(i, log);
    const picks = ids.map(id => log.find(p => p.id === id)!).sort((a, b) => a.start - b.start);
    console.log(`🎯 Selected ${picks.length}: ${picks.map(p => mmss(p.start)).join(', ')}`);

    const deep = await deepDive(i, picks, dir, duration);

    i.onProgress?.(88, 'כותב ניתוח אימון…');
    const out = await writeUp(i, picks, deep);

    const plays: V2Play[] = picks.map((p, k) => {
      const w = (out.plays || []).find((x: any) => Number(x.id) === p.id) || {};
      const d = deep[k] || {};
      const verdictTxt = w.verdict === 'good' ? 'למה זה עבד' : w.verdict === 'bad' ? 'מה השתבש' : 'מה אפשר לשפר';
      const note = [
        esc(w.what_happened || p.outcome),
        w.positions ? `<br><b>עמדות:</b> ${esc(w.positions)}` : '',
        w.lesson ? `<br><b>${verdictTxt}:</b> ${esc(w.lesson)}` : '',
      ].join('');
      const type = ['offense', 'defense', 'transition'].includes(w.type) ? w.type : (p.transition ? 'transition' : 'offense');
      return {
        startTime: mmss(p.start), endTime: mmss(p.end), type,
        label: String(w.label || p.outcome).slice(0, 80), note,
        players: Array.isArray(w.players) && w.players.length ? w.players : (d.players || []),
        verdict: w.verdict, finish_location: d.shot_location || p.shot_location,
        observations: [w.positions, w.lesson].filter(Boolean),
        _pullUp: !!d.pull_up,
      } as any;
    });

    const chart = { paint: 0, midRange: 0, corner3: 0, aboveBreak3: 0, pullUp: 0 };
    for (const pl of plays as any[]) {
      const loc = String(pl.finish_location || '');
      if (loc === 'paint') chart.paint++; else if (loc === 'mid') chart.midRange++;
      else if (loc === 'corner3') chart.corner3++; else if (loc === 'above_break3') chart.aboveBreak3++;
      if (pl._pullUp) chart.pullUp++;
      delete pl._pullUp;
    }
    const tot = chart.paint + chart.midRange + chart.corner3 + chart.aboveBreak3;
    if (tot) (Object.keys(chart) as (keyof typeof chart)[]).forEach(k => { chart[k] = Math.round((chart[k] / tot) * 100); });

    return {
      game: out.game || i.context || 'ניתוח משחק',
      plays,
      insights: (out.insights || []).filter((x: any) => x?.title).map((x: any) => ({
        type: ['good', 'warn', 'bad'].includes(x.type) ? x.type : 'warn', title: String(x.title), body: String(x.body || ''),
      })),
      shotChart: chart,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
