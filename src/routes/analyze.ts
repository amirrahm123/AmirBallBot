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

// GET upload URL for direct browser-to-Gemini upload
router.get('/upload-url', async (_req: Request, res: Response) => {
  try {
    const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY!);

    // Create a resumable upload session
    const response = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Type': 'video/mp4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { displayName: `upload-${Date.now()}.mp4` } }),
      }
    );

    const uploadUrl = response.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('Failed to get upload URL from Gemini');
    }

    console.log('📤 Created Gemini upload session');
    res.json({ uploadUrl });
  } catch (err: any) {
    console.error('❌ Upload URL error:', err);
    res.status(500).json({ error: err.message || 'Failed to create upload session' });
  }
});

export default router;
