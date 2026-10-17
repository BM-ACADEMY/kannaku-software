const { query } = require('./db');
async function audit(userId, action, entity, entityId, detail, client) {
  const q = client ? client.query.bind(client) : query;
  await q('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [userId || null, action, entity, entityId || null, detail ? JSON.stringify(detail) : null]);
}
module.exports = { audit };
