const { Pool, types } = require('pg');

// Return NUMERIC as JS numbers and DATE as 'YYYY-MM-DD' strings (no timezone shifts).
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(1082, (v) => v);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

async function query(text, params) {
  return pool.query(text, params);
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
