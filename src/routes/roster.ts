import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Roster } from '../database';

const router = Router();
const DEFAULT_TEAM_ID = 'default';

// GET /api/roster — get saved roster
router.get('/', async (_req: Request, res: Response) => {
  try {
    const roster = await Roster.findOne({ teamId: DEFAULT_TEAM_ID });
    res.json(roster || { teamId: DEFAULT_TEAM_ID, teamName: '', players: [] });
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת רוסטר:', err);
    res.status(500).json({ error: 'שגיאה בטעינת רוסטר' });
  }
});

// POST /api/roster — save team roster
router.post('/', async (req: Request, res: Response) => {
  try {
    const { teamName, players } = req.body;
    console.log(`💾 Saving roster: ${teamName} — ${(players || []).length} players`);

    const roster = await Roster.findOneAndUpdate(
      { teamId: DEFAULT_TEAM_ID },
      {
        teamId: DEFAULT_TEAM_ID,
        teamName: teamName || '',
        players: players || [],
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log('✅ Roster saved');
    res.json({ success: true, roster });
  } catch (err: any) {
    console.error('❌ שגיאה בשמירת רוסטר:', err);
    res.status(500).json({ error: 'שגיאה בשמירת רוסטר' });
  }
});

// Extract players JSON from Claude response content blocks
function extractPlayersFromResponse(content: Anthropic.ContentBlock[]): any[] | null {
  console.log(`   📦 Response has ${content.length} content blocks: [${content.map(b => b.type).join(', ')}]`);

  // Log each block for debugging
  for (const block of content) {
    if (block.type === 'text') {
      console.log(`   📝 Text block (${block.text.length} chars): ${block.text.substring(0, 200)}...`);
    } else {
      console.log(`   📦 ${block.type} block:`, JSON.stringify(block).substring(0, 200));
    }
  }

  // Collect all text from text blocks
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  if (!text.trim()) {
    console.log('   ⚠️ No text content in response');
    return null;
  }

  // Try to find JSON with players array
  const jsonMatch = text.match(/\{[\s\S]*"players"[\s\S]*\}/);
  if (!jsonMatch) {
    console.log('   ⚠️ No JSON with "players" found in text');
    // Try to find any JSON array that looks like players
    const arrayMatch = text.match(/\[[\s\S]*\{[\s\S]*"name"[\s\S]*\}[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const arr = JSON.parse(arrayMatch[0]);
        console.log(`   ✅ Parsed players array directly: ${arr.length} items`);
        return arr;
      } catch {}
    }
    return null;
  }

  try {
    const data = JSON.parse(jsonMatch[0]);
    const players = data.players || [];
    console.log(`   ✅ Parsed JSON: ${players.length} players`);
    return players;
  } catch (e: any) {
    console.log(`   ⚠️ JSON parse error: ${e.message}`);
    return null;
  }
}

const ROSTER_PROMPT = (teamName: string) =>
`Find the current 2024-2025 roster of "${teamName}" basketball team.
Search in English: "${teamName} basketball team roster 2024-2025 players jersey numbers".
If it's an Israeli team, also try the English transliteration (e.g. הפועל תל אביב = Hapoel Tel Aviv).

Return ONLY valid JSON, no markdown, no explanation:
{ "players": [{"number": 0, "name": "Player Name", "position": "עמדה"}] }

Rules:
- Use Hebrew position names ONLY from: פוינט גארד, שוטינג גארד, סמול פורוורד, פאואר פורוורד, סנטר
- Player names: Hebrew for Israeli teams, original language otherwise
- number = integer jersey number
- Return 10-15 players`;

// POST /api/roster/fetch — auto-fetch roster using Claude API
router.post('/fetch', async (req: Request, res: Response) => {
  try {
    const { teamName } = req.body;
    if (!teamName || !teamName.trim()) {
      res.status(400).json({ error: 'נדרש שם קבוצה' });
      return;
    }

    console.log(`🔍 Fetching roster for: "${teamName}"`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Step 1: Try with web search
    let players: any[] | null = null;
    try {
      console.log('   🌐 Attempting web search...');
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
        } as any],
        messages: [{
          role: 'user',
          content: ROSTER_PROMPT(teamName),
        }],
      });

      console.log(`   🌐 Web search response — stop_reason: ${response.stop_reason}`);
      players = extractPlayersFromResponse(response.content);
    } catch (searchErr: any) {
      console.log(`   ⚠️ Web search failed: ${searchErr.message}`);
    }

    // Step 2: Fallback to training data if web search returned nothing
    if (!players || players.length === 0) {
      console.log('   🧠 Falling back to Claude training data...');
      const fallbackResponse = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `From your training data, provide the most recent roster you know for "${teamName}" basketball team.
Return ONLY valid JSON, no markdown fences, no explanation:
{ "players": [{"number": 0, "name": "Player Name", "position": "עמדה"}] }

Rules:
- Use Hebrew position names ONLY from: פוינט גארד, שוטינג גארד, סמול פורוורד, פאואר פורוורד, סנטר
- Player names: Hebrew for Israeli teams, original language otherwise
- number = integer jersey number
- Return 10-15 players
- It's OK if the roster is not the very latest — approximate is fine`,
        }],
      });

      console.log(`   🧠 Fallback response — stop_reason: ${fallbackResponse.stop_reason}`);
      players = extractPlayersFromResponse(fallbackResponse.content);
    }

    if (!players || players.length === 0) {
      console.log(`   ❌ No players found for "${teamName}" (both web search and fallback failed)`);
      res.status(500).json({ error: 'לא הצלחתי למצוא רוסטר — נסה שם קבוצה באנגלית' });
      return;
    }

    const cleaned = players.map((p: any) => ({
      number: parseInt(p.number) || 0,
      name: String(p.name || ''),
      position: String(p.position || ''),
    })).filter((p: any) => p.name);

    console.log(`   ✅ Found ${cleaned.length} players for "${teamName}"`);
    res.json({ teamName, players: cleaned });
  } catch (err: any) {
    console.error('❌ שגיאה באחזור רוסטר:', err);
    res.status(500).json({ error: err.message || 'שגיאה באחזור רוסטר' });
  }
});

export default router;
