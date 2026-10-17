class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate req.body / req.query with a zod schema.
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'Invalid input', r.error.flatten());
  return r.data;
}

module.exports = { HttpError, ah, parse };
