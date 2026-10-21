// Bill photos and receipts on Book entries and documents. Files live on disk (UPLOAD_DIR, a Docker volume),
// never in the database. Images and PDFs only, max 8 MB.
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { query } = require('../lib/db');
const { ah, parse, HttpError } = require('../lib/http');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');

const DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
const OK_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };
const MAX = 8 * 1024 * 1024;

router.use(requireRole('admin', 'accounts'));

async function assertEntity(entity, id) {
  const t = entity === 'entry' ? 'entries' : 'documents';
  const r = (await query(`SELECT id FROM ${t} WHERE id=$1`, [id])).rows[0];
  if (!r) throw new HttpError(404, `${entity} not found`);
}

router.get('/:entity/:id', ah(async (req, res) => {
  const { entity, id } = parse(z.object({ entity: z.enum(['entry', 'document']), id: z.coerce.number().int() }), req.params);
  const { rows } = await query(`SELECT a.id, a.filename, a.mime, a.size, a.created_at, u.name AS uploaded_by FROM attachments a
    LEFT JOIN users u ON u.id=a.created_by WHERE a.entity=$1 AND a.entity_id=$2 ORDER BY a.id`, [entity, id]);
  res.json(rows);
}));

// Body: { filename, mime, data } with data = base64 (the browser reads the file and sends it as JSON)
router.post('/:entity/:id', ah(async (req, res) => {
  const { entity, id } = parse(z.object({ entity: z.enum(['entry', 'document']), id: z.coerce.number().int() }), req.params);
  const f = parse(z.object({ filename: z.string().min(1).max(200), mime: z.string(), data: z.string().min(10) }), req.body);
  if (!OK_TYPES[f.mime]) throw new HttpError(400, 'Only photos (JPG, PNG, WEBP, HEIC) or PDF');
  const buf = Buffer.from(f.data.replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length > MAX) throw new HttpError(400, 'File is bigger than 8 MB');
  // check the file really is what it says (first bytes), so nobody can upload a script named .jpg
  const sig = buf.subarray(0, 12).toString('hex');
  const real = sig.startsWith('ffd8ff') ? 'image/jpeg' : sig.startsWith('89504e47') ? 'image/png' : sig.startsWith('25504446') ? 'application/pdf'
    : (sig.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') ? 'image/webp' : buf.subarray(4, 12).toString().includes('ftyp') ? 'image/heic' : null;
  if (!real) throw new HttpError(400, "That file doesn't look like a photo or PDF");
  await assertEntity(entity, id);
  const month = new Date().toISOString().slice(0, 7);
  fs.mkdirSync(path.join(DIR, month), { recursive: true });
  const rel = path.join(month, `${crypto.randomBytes(12).toString('hex')}${OK_TYPES[real]}`);
  fs.writeFileSync(path.join(DIR, rel), buf);
  const safeName = f.filename.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const { rows } = await query(`INSERT INTO attachments (entity,entity_id,filename,mime,size,path,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, filename, mime, size, created_at`, [entity, id, safeName, real, buf.length, rel, req.user.id]);
  await audit(req.user.id, 'attach', entity, id, { file: safeName });
  res.status(201).json(rows[0]);
}));

router.get('/file/:fileId', ah(async (req, res) => {
  const a = (await query('SELECT * FROM attachments WHERE id=$1', [req.params.fileId])).rows[0];
  if (!a) throw new HttpError(404, 'File not found');
  const full = path.join(DIR, a.path);
  if (!full.startsWith(DIR) || !fs.existsSync(full)) throw new HttpError(404, 'File is missing on the server');
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Disposition', `inline; filename="${a.filename.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(full).pipe(res);
}));

router.delete('/file/:fileId', requireRole('admin'), ah(async (req, res) => {
  const a = (await query('DELETE FROM attachments WHERE id=$1 RETURNING *', [req.params.fileId])).rows[0];
  if (a) { try { fs.unlinkSync(path.join(DIR, a.path)); } catch { /* already gone */ } await audit(req.user.id, 'detach', a.entity, a.entity_id, { file: a.filename }); }
  res.json({ ok: true });
}));

module.exports = router;
