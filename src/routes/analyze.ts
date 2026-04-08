import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { analyzeVideo, analyzeYouTube, analyzeImage, analyzeGeminiFile } from '../analyzer';
import { Player, Analysis } from '../database';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

// POST with multipart form data (file upload + youtube URL)
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const youtubeUrl = req.body?.youtube_url;
    const context = req.body?.context || '';
    const focus = req.body?.focus || 'all';
    const teamName = req.body?.teamName || '';

    // Fetch roster from MongoDB
    let roster = '';
    try {
      const players = await Player.find().sort({ number: 1 });
      roster = players.map(p => `#${p.number} ${p.name}`).join(', ');
      console.log(`📋 Roster: ${roster || '(empty)'}`);
    } catch { console.warn('⚠️ Could not fetch roster'); }

    console.log(`📊 Analysis request — focus: ${focus}, youtube: ${!!youtubeUrl}, file: ${!!req.file}`);

    let result;

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      console.log(`📁 Uploaded file: ${req.file.originalname} (${ext})`);

      if (IMAGE_EXTS.includes(ext)) {
        result = await analyzeImage(req.file.path, context, focus, teamName, roster);
      } else {
        result = await analyzeVideo(req.file.path, context, focus, teamName, roster);
      }

      try { fs.unlinkSync(req.file.path); } catch {}

    } else if (req.body?.geminiFileUri) {
      console.log('📡 Using pre-uploaded Gemini file');
      result = await analyzeGeminiFile(req.body.geminiFileUri, context, focus, teamName, roster);
    } else if (youtubeUrl) {
      result = await analyzeYouTube(youtubeUrl, context, focus, teamName, roster);
    } else {
      res.status(400).json({ error: 'נדרש קובץ וידאו או קישור YouTube' });
      return;
    }

    // Save analysis record
    try {
      await Analysis.create({
        teamName: teamName || 'לא ידוע',
        focus,
        plays: result.plays,
        insights: result.insights,
        playCount: result.plays?.length || 0,
      });
      console.log('💾 Analysis saved');
    } catch (dbErr) {
      console.warn('⚠️ Analysis save failed (continuing):', dbErr);
    }

    console.log(`✅ Analysis complete — ${result.plays.length} plays`);
    res.json(result);

  } catch (err: any) {
    console.error('❌ שגיאה בניתוח:', err);
    res.status(500).json({ error: err.message || 'שגיאה בניתוח' });
  }
});

// Upload video to Gemini Files API via server
router.post('/upload-video', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file' });
    }
    const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);
    const result = await fileManager.uploadFile(req.file.path, {
      mimeType: req.file.mimetype || 'video/mp4',
      displayName: req.file.originalname,
    });
    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}
    console.log(`📤 Uploaded to Gemini: ${result.file.name}`);
    res.json({ fileUri: result.file.uri, fileName: result.file.name });
  } catch (err: any) {
    console.error('❌ Upload error:', err);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: err.message });
  }
});

export default router;
