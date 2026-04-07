import { Router, Request, Response } from 'express';
import { Analysis } from '../database';

const router = Router();

// GET /api/analyses — list all analyses (summary only)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const analyses = await Analysis.find()
      .sort({ createdAt: -1 })
      .select('_id teamName focus playCount createdAt');
    res.json(analyses);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת ניתוחים:', err);
    res.status(500).json({ error: 'שגיאה בטעינת ניתוחים' });
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
