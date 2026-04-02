import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { analyzeVideo, analyzeYouTube, analyzeImage } from '../analyzer';
import { Game } from '../database';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const youtubeUrl = req.body?.youtube_url;
    const context = req.body?.context || '';
    const focus = req.body?.focus || 'all';

    console.log(`📊 Analysis request — focus: ${focus}, youtube: ${!!youtubeUrl}, file: ${!!req.file}`);

    let result;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      console.log(`📁 Uploaded file: ${req.file.originalname} (${ext})`);

      if (IMAGE_EXTS.includes(ext)) {
        result = await analyzeImage(req.file.path, context, focus);
      } else {
        result = await analyzeVideo(req.file.path, context, focus);
      }

      // Cleanup uploaded file
      try { fs.unlinkSync(req.file.path); } catch {}

    } else if (youtubeUrl) {
      result = await analyzeYouTube(youtubeUrl, context, focus);
    } else {
      res.status(400).json({ error: 'נדרש קובץ וידאו או קישור YouTube' });
      return;
    }

    // Save to MongoDB
    try {
      const game = new Game({
        title: result.game,
        opponent: context,
        context,
        focus,
        plays: result.plays,
        insights: result.insights,
        shotChart: result.shotChart,
      });
      const saved = await game.save();
      console.log(`💾 Game saved to DB: ${saved._id}`);
      (result as any).game_id = saved._id;
    } catch (dbErr) {
      console.warn('⚠️ DB save failed (continuing):', dbErr);
    }

    console.log(`✅ Analysis complete — ${result.plays.length} plays`);
    res.json(result);

  } catch (err: any) {
    console.error('❌ שגיאה בניתוח:', err);
    res.status(500).json({ error: err.message || 'שגיאה בניתוח' });
  }
});

export default router;
