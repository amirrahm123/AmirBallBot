import { Router, Request, Response } from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { TeamKnowledge } from '../database';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

const DEFAULT_TEAM_ID = 'default';

// GET /api/knowledge — return all saved knowledge
router.get('/', async (_req: Request, res: Response) => {
  try {
    let knowledge = await TeamKnowledge.findOne({ teamId: DEFAULT_TEAM_ID });
    if (!knowledge) {
      knowledge = new TeamKnowledge({ teamId: DEFAULT_TEAM_ID });
      await knowledge.save();
      console.log('📚 Created empty knowledge base');
    }
    console.log(`📚 Knowledge loaded — ${knowledge.documents.length} documents`);
    res.json(knowledge);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת מאגר ידע:', err);
    res.status(500).json({ error: 'שגיאה בטעינת מאגר ידע' });
  }
});

// POST /api/knowledge/settings — save philosophy and systems
router.post('/settings', async (req: Request, res: Response) => {
  try {
    const { philosophy, offenseSystem, defenseSystem } = req.body;
    console.log('💾 Saving team knowledge settings...');

    const knowledge = await TeamKnowledge.findOneAndUpdate(
      { teamId: DEFAULT_TEAM_ID },
      {
        teamId: DEFAULT_TEAM_ID,
        philosophy: philosophy || '',
        offenseSystem: offenseSystem || '',
        defenseSystem: defenseSystem || '',
      },
      { upsert: true, new: true }
    );

    console.log('✅ Knowledge settings saved');
    res.json({ success: true, knowledge });
  } catch (err: any) {
    console.error('❌ שגיאה בשמירת הגדרות:', err);
    res.status(500).json({ error: 'שגיאה בשמירת הגדרות' });
  }
});

// POST /api/knowledge/upload — upload PDF documents
router.post('/upload', upload.array('files', 10), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'לא נבחרו קבצים' });
      return;
    }

    console.log(`📄 Uploading ${files.length} documents...`);

    // Dynamic import for pdf-parse (CommonJS module)
    const pdfParse = require('pdf-parse');

    const newDocs: { name: string; content: string; uploadedAt: Date }[] = [];

    for (const file of files) {
      try {
        const buffer = fs.readFileSync(file.path);
        const pdf = await pdfParse(buffer);
        const content = pdf.text.trim();
        console.log(`📄 Parsed "${file.originalname}" — ${content.length} chars`);

        newDocs.push({
          name: file.originalname,
          content: content.substring(0, 50000), // limit stored text
          uploadedAt: new Date(),
        });
      } catch (parseErr) {
        console.error(`❌ שגיאה בפירוש ${file.originalname}:`, parseErr);
        newDocs.push({
          name: file.originalname,
          content: `[שגיאה בפירוש הקובץ]`,
          uploadedAt: new Date(),
        });
      }

      // Cleanup temp file
      try { fs.unlinkSync(file.path); } catch {}
    }

    const knowledge = await TeamKnowledge.findOneAndUpdate(
      { teamId: DEFAULT_TEAM_ID },
      { $push: { documents: { $each: newDocs } } },
      { upsert: true, new: true }
    );

    console.log(`✅ ${newDocs.length} documents saved to knowledge base`);
    res.json({ success: true, added: newDocs.length, knowledge });
  } catch (err: any) {
    console.error('❌ שגיאה בהעלאת מסמכים:', err);
    res.status(500).json({ error: 'שגיאה בהעלאת מסמכים' });
  }
});

// DELETE /api/knowledge/document/:index — remove a document
router.delete('/document/:index', async (req: Request, res: Response) => {
  try {
    const index = parseInt(String(req.params.index));
    const knowledge = await TeamKnowledge.findOne({ teamId: DEFAULT_TEAM_ID });
    if (!knowledge || index < 0 || index >= knowledge.documents.length) {
      res.status(404).json({ error: 'מסמך לא נמצא' });
      return;
    }

    const docName = knowledge.documents[index].name;
    knowledge.documents.splice(index, 1);
    await knowledge.save();

    console.log(`🗑️ Removed document: ${docName}`);
    res.json({ success: true, removed: docName });
  } catch (err: any) {
    console.error('❌ שגיאה במחיקת מסמך:', err);
    res.status(500).json({ error: 'שגיאה במחיקת מסמך' });
  }
});

export default router;
