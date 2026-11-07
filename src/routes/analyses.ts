import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import fs from 'fs';
import { Analysis } from '../database';
import { deepDivePlay } from '../pipeline/v2';

const router = Router();

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
}

function paramStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] || '';
  return v || '';
}

// GET /api/analyses — list all analyses (summary only)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const analyses = await Analysis.find()
      .sort({ createdAt: -1 })
      .select('_id teamName focus playCount createdAt coachNotes');
    res.json(analyses);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת ניתוחים:', err);
    res.status(500).json({ error: 'שגיאה בטעינת ניתוחים' });
  }
});

// POST /api/analyses/:id/plays/:idx/deep — re-watch one possession closely and rewrite its card
router.post('/:id/plays/:idx/deep', async (req: Request, res: Response) => {
  try {
    const id = paramStr(req.params.id);
    const idx = Number(paramStr(req.params.idx));
    if (!isValidObjectId(id)) { res.status(400).json({ error: 'מזהה לא תקין' }); return; }
    const a: any = await Analysis.findById(id);
    if (!a) { res.status(404).json({ error: 'ניתוח לא נמצא' }); return; }
    const play = a.plays?.[idx];
    if (!play) { res.status(404).json({ error: 'מהלך לא נמצא' }); return; }
    if (!a.videoPath || !fs.existsSync(a.videoPath)) { res.status(409).json({ error: 'הסרטון של הניתוח הזה כבר לא שמור בשרת' }); return; }
    const poss = (a.possessionLog || []).find((p: any) => p.id === play.possessionId);
    if (!poss) { res.status(409).json({ error: 'הניתוח הזה נוצר במנוע ישן, אין לו יומן פוזשנים' }); return; }
    console.log(`🔬 Deep dive: analysis ${id} play ${idx} (${play.startTime})`);
    const updated = await deepDivePlay(a.videoPath, poss, a.meta || {});
    a.plays[idx] = { ...play, ...updated, deepDived: true };
    a.markModified('plays');
    await a.save();
    res.json({ play: a.plays[idx] });
  } catch (err: any) {
    console.error('❌ deep dive failed:', err);
    res.status(500).json({ error: err?.message || 'שגיאה בניתוח לעומק' });
  }
});

// GET /api/analyses/:id — full analysis
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const analysis = await Analysis.findById(req.params.id);
    if (!analysis) {
      res.status(404).json({ error: 'ניתוח לא נמצא' });
      return;
    }
    res.json(analysis);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת ניתוח:', err);
    res.status(500).json({ error: 'שגיאה בטעינת ניתוח' });
  }
});

// POST /api/analyses/:id/notes — append a coach note to the analysis
router.post('/:id/notes', async (req: Request, res: Response) => {
  try {
    const id = paramStr(req.params.id);
    if (!isValidObjectId(id)) {
      res.status(400).json({ error: 'Bad analysis id' });
      return;
    }
    const { timestamp, text } = req.body || {};
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      res.status(400).json({ error: 'timestamp חייב להיות מספר' });
      return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'text חובה' });
      return;
    }
    const analysis: any = await Analysis.findById(id);
    if (!analysis) {
      res.status(404).json({ error: 'ניתוח לא נמצא' });
      return;
    }
    if (!Array.isArray(analysis.coachNotes)) analysis.coachNotes = [];
    analysis.coachNotes.push({ timestamp: Math.max(0, timestamp), text: trimmed });
    await analysis.save();
    const created = analysis.coachNotes[analysis.coachNotes.length - 1];
    res.status(201).json({
      _id: String(created._id),
      timestamp: created.timestamp,
      text: created.text,
      createdAt: created.createdAt,
    });
  } catch (err: any) {
    console.error('❌ POST note failed:', err);
    res.status(500).json({ error: err?.message || 'שגיאה בשמירת הערה' });
  }
});

// PUT /api/analyses/:id/notes/:noteId — update note text
router.put('/:id/notes/:noteId', async (req: Request, res: Response) => {
  try {
    const id = paramStr(req.params.id);
    const noteId = paramStr(req.params.noteId);
    if (!isValidObjectId(id) || !isValidObjectId(noteId)) {
      res.status(400).json({ error: 'Bad id' });
      return;
    }
    const trimmed = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'text חובה' });
      return;
    }
    const analysis: any = await Analysis.findById(id);
    if (!analysis) {
      res.status(404).json({ error: 'ניתוח לא נמצא' });
      return;
    }
    const note = analysis.coachNotes?.id?.(noteId);
    if (!note) {
      res.status(404).json({ error: 'הערה לא נמצאה' });
      return;
    }
    note.text = trimmed;
    await analysis.save();
    res.json({
      _id: String(note._id),
      timestamp: note.timestamp,
      text: note.text,
      createdAt: note.createdAt,
    });
  } catch (err: any) {
    console.error('❌ PUT note failed:', err);
    res.status(500).json({ error: err?.message || 'שגיאה בעדכון הערה' });
  }
});

// DELETE /api/analyses/:id/notes/:noteId — remove a note
router.delete('/:id/notes/:noteId', async (req: Request, res: Response) => {
  try {
    const id = paramStr(req.params.id);
    const noteId = paramStr(req.params.noteId);
    if (!isValidObjectId(id) || !isValidObjectId(noteId)) {
      res.status(400).json({ error: 'Bad id' });
      return;
    }
    const result = await Analysis.updateOne(
      { _id: id },
      { $pull: { coachNotes: { _id: new mongoose.Types.ObjectId(noteId) } } },
    );
    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'ניתוח לא נמצא' });
      return;
    }
    if (result.modifiedCount === 0) {
      res.status(404).json({ error: 'הערה לא נמצאה' });
      return;
    }
    res.json({ deleted: true });
  } catch (err: any) {
    console.error('❌ DELETE note failed:', err);
    res.status(500).json({ error: err?.message || 'שגיאה במחיקת הערה' });
  }
});

// DELETE /api/analyses/:id — delete analysis
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const analysis = await Analysis.findByIdAndDelete(req.params.id);
    if (!analysis) {
      res.status(404).json({ error: 'ניתוח לא נמצא' });
      return;
    }
    console.log(`🗑️ Deleted analysis: ${analysis._id}`);
    res.json({ deleted: true });
  } catch (err: any) {
    console.error('❌ שגיאה במחיקת ניתוח:', err);
    res.status(500).json({ error: 'שגיאה במחיקת ניתוח' });
  }
});

export default router;
