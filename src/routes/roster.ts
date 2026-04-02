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

// POST /api/roster/fetch — auto-fetch roster using Claude API
router.post('/fetch', async (req: Request, res: Response) => {
  try {
    const { teamName } = req.body;
    if (!teamName || !teamName.trim()) {
      res.status(400).json({ error: 'נדרש שם קבוצה' });
      return;
    }

    console.log(`🔍 Fetching roster for: ${teamName}`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
      } as any],
      messages: [{
        role: 'user',
        content: `Search the web for the current 2024-2025 roster of ${teamName} basketball team.
After searching, return JSON only, no other text: { "players": [{"number": 0, "name": "שם השחקן", "position": "עמדה"}] }
Use Hebrew for position names only from this list: פוינט גארד, שוטינג גארד, סמול פורוורד, פאואר פורוורד, סנטר
Player names should be in Hebrew if it's an Israeli team, otherwise in the original language.
number must be an integer (jersey number).
Return 10-15 players.`
      }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    console.log(`   ✅ Claude responded (${text.length} chars)`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(500).json({ error: 'לא הצלחתי למצוא רוסטר' });
      return;
    }

    const data = JSON.parse(jsonMatch[0]);
    const players = (data.players || []).map((p: any) => ({
      number: parseInt(p.number) || 0,
      name: String(p.name || ''),
      position: String(p.position || ''),
    }));

    console.log(`   ✅ Found ${players.length} players for ${teamName}`);
    res.json({ teamName, players });
  } catch (err: any) {
    console.error('❌ שגיאה באחזור רוסטר:', err);
    res.status(500).json({ error: err.message || 'שגיאה באחזור רוסטר' });
  }
});

export default router;
