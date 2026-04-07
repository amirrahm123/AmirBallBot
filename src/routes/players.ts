import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Player } from '../database';

const router = Router();

// GET /api/players
router.get('/', async (_req: Request, res: Response) => {
  try {
    const players = await Player.find().sort({ number: 1 });
    console.log(`👥 Returning ${players.length} players`);
    res.json(players);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת שחקנים:', err);
    res.status(500).json({ error: 'שגיאה בטעינת שחקנים' });
  }
});

// POST /api/players — add a single player
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, jersey, position } = req.body;
    if (!name) {
      res.status(400).json({ error: 'שם שחקן חובה' });
      return;
    }
    const player = await Player.create({
      name,
      number: parseInt(jersey) || 0,
      position: position || '',
      seasonStats: { points: 0, rebounds: 0, assists: 0, gamesPlayed: 0 },
    });
    console.log(`➕ Added player: ${name} #${jersey}`);
    res.json(player);
  } catch (err: any) {
    console.error('❌ שגיאה בהוספת שחקן:', err);
    res.status(500).json({ error: 'שגיאה בהוספת שחקן' });
  }
});

// POST /api/players/parse-roster — Claude parses free text into player list
router.post('/parse-roster', async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: 'טקסט חובה' });
      return;
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Extract player names and jersey numbers from this text.
Return ONLY a valid JSON array, no explanation:
[{"name": "שם שחקן", "number": "23"}]
Handle any format: name first, number first, with #, with dash, comma separated, newlines.
If no number found for a player, use "".
Text: ${text}`,
      }],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      res.status(500).json({ error: 'לא הצלחתי לפענח את הטקסט' });
      return;
    }

    const players = JSON.parse(jsonMatch[0]);
    console.log(`📋 Parsed ${players.length} players from text`);
    res.json({ players });
  } catch (err: any) {
    console.error('❌ שגיאה בפענוח סגל:', err);
    res.status(500).json({ error: 'שגיאה בפענוח הטקסט' });
  }
});

// GET /api/players/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) {
      res.status(404).json({ error: 'שחקן לא נמצא' });
      return;
    }

    console.log(`👤 Player profile: ${player.name}`);

    // Generate AI insights for the player
    let aiInsights = '';
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const stats = player.seasonStats;
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: 'אתה אנליסט כדורסל ישראלי. תן תובנות קצרות על השחקן בעברית.',
        messages: [{
          role: 'user',
          content: `שחקן: ${player.name}, עמדה: ${player.position}, מספר: ${player.number}\n`
            + `סטטיסטיקות עונתיות: ${stats.points} נק׳, ${stats.rebounds} ריב׳, ${stats.assists} אס׳ `
            + `ב-${stats.gamesPlayed} משחקים.\nתן 2-3 תובנות קצרות.`,
        }],
      });
      aiInsights = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch {
      aiInsights = 'לא ניתן לייצר תובנות כרגע';
    }

    res.json({ ...player.toObject(), aiInsights });

  } catch (err: any) {
    console.error('❌ שגיאה בטעינת שחקן:', err);
    res.status(500).json({ error: 'שגיאה בטעינת שחקן' });
  }
});

// DELETE /api/players/all — delete all players
router.delete('/all', async (_req: Request, res: Response) => {
  try {
    const result = await Player.deleteMany({});
    console.log(`🗑️ Deleted all players (${result.deletedCount})`);
    res.json({ deleted: result.deletedCount });
  } catch (err: any) {
    console.error('❌ שגיאה במחיקת כל השחקנים:', err);
    res.status(500).json({ error: 'שגיאה במחיקת שחקנים' });
  }
});

// DELETE /api/players/:id — delete single player
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const player = await Player.findByIdAndDelete(req.params.id);
    if (!player) {
      res.status(404).json({ error: 'שחקן לא נמצא' });
      return;
    }
    console.log(`🗑️ Deleted player: ${player.name}`);
    res.json({ deleted: true });
  } catch (err: any) {
    console.error('❌ שגיאה במחיקת שחקן:', err);
    res.status(500).json({ error: 'שגיאה במחיקת שחקן' });
  }
});

export default router;
