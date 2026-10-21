// Creates tables, loads seed data and the first admin user. Safe to re-run.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../lib/db');

(async () => {
  for (let i = 1; ; i++) {
    try { await pool.query('SELECT 1'); break; } catch (e) {
      if (i >= 30) throw new Error('Database not reachable: ' + e.message);
      console.log('…waiting for database'); await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const dir = path.resolve(__dirname, '../../db');
  await pool.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
  console.log('✓ schema');
  await pool.query(fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8'));
  console.log('✓ seed (brands, categories, accounts, company settings)');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.startsWith('CHANGE_ME')) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env');
    await pool.query("INSERT INTO users (name,email,role,password_hash) VALUES ($1,$2,'admin',$3)",
      [ADMIN_NAME || 'Admin', ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 10)]);
    console.log(`✓ admin user ${ADMIN_EMAIL}`);
  } else console.log('• users exist, admin not created');
  // Fill the bank details on older databases where they were left blank (never overwrites an edit)
  await pool.query(`UPDATE settings SET value = jsonb_set(value, '{bank_details}', to_jsonb($1::text))
    WHERE key='company' AND COALESCE(value->>'bank_details','') = ''`,
  ['RBL Bank Ltd, Pondicherry Branch\nCurrent A/c: 408220969669\nName: AFRA VENTURES PRIVATE LIMITED\nIFSC: RATN0000307 · MICR: 605176003 · SWIFT: RATNINBB']);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
