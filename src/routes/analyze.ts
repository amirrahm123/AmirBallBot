import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { analyzeVideo, analyzeYouTubeCloud, analyzeGoogleDrive, analyzeImage, RosterPlayer } from '../analyzer';
import { Game, Roster } from '../database';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

// POST with multipart form data (file upload + youtube URL)
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const youtubeUrl = req.body?.youtube_url;
    const context = req.body?.context || '';
    const focus = req.body?.focus || 'all';

    // Load roster from DB
    let roster: RosterPlayer[] = [];
    try {
      const rosterDoc = await Roster.findOne({ teamId: 'default' });
      if (rosterDoc && rosterDoc.players.length > 0) {
        roster = rosterDoc.players.map(p => ({ number: p.number, name: p.name, position: p.position }));
        console.log(`👥 Roster loaded: ${roster.length} players`);
      }
    } catch {}

    console.log(`📊 Analysis request — focus: ${focus}, youtube: ${!!youtubeUrl}, file: ${!!req.file}, roster: ${roster.length}`);

    let result;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      console.log(`📁 Uploaded file: ${req.file.originalname} (${ext})`);

      if (IMAGE_EXTS.includes(ext)) {
        result = await analyzeImage(req.file.path, context, focus, roster);
      } else {
        result = await analyzeVideo(req.file.path, context, focus, roster);
      }

      try { fs.unlinkSync(req.file.path); } catch {}

    } else if (youtubeUrl && youtubeUrl.includes('drive.google.com')) {
      console.log('📂 Detected Google Drive URL');
      result = await analyzeGoogleDrive(youtubeUrl, context, focus, roster);
    } else if (youtubeUrl) {
      console.log('📺 Detected YouTube URL');
      result = await analyzeYouTubeCloud(youtubeUrl, context, focus, roster);
    } else {
      res.status(400).json({ error: 'נדרש קובץ וידאו או קישור YouTube / Google Drive' });
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
