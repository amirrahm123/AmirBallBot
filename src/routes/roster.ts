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

// POST /api/roster/parse — parse free text roster using Claude
router.post('/parse', async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'נדרש טקסט לייבוא' });
      return;
    }

    console.log(`🔍 Parsing roster from free text (${text.length} chars)`);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Extract basketball roster from this text.
Return ONLY a JSON array, no other text:
[{"name": "Player Name", "number": 0, "position": "PG"}]

Position must be one of: PG, SG, SF, PF, C. If unclear, guess based on context or leave empty string.
Number must be an integer jersey number. If not found, use 0.
Keep player names exactly as written.

Text:
${text}`,
      }],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON array from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      res.status(400).json({ error: 'לא הצלחתי לחלץ רוסטר מהטקסט' });
      return;
    }

    const players = JSON.parse(jsonMatch[0]);
    const cleaned = players
      .map((p: any) => ({
        number: parseInt(p.number) || 0,
        name: String(p.name || '').trim(),
        position: String(p.position || ''),
      }))
      .filter((p: any) => p.name);

    console.log(`   ✅ Parsed ${cleaned.length} players from free text`);
    res.json({ players: cleaned });
  } catch (err: any) {
    console.error('❌ שגיאה בפרסור רוסטר:', err);
    res.status(500).json({ error: err.message || 'שגיאה בפרסור רוסטר' });
  }
});

export default router;
