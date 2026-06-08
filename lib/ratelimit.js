'use strict';

// Limitador de tasa in-memory (ventana fija por IP+prefijo). Suficiente para una
// sola instancia detrás de pm2 (las sesiones también son in-memory). Requiere
// app.set('trust proxy', 1) para que req.ip refleje la IP real detrás de nginx.
const buckets = new Map();

function rateLimit({ windowMs, max, keyPrefix = 'rl' }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Demasiados intentos, esperá unos minutos.' });
    }
    next();
  };
}

// Limpieza periódica de buckets vencidos para no crecer sin límite.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = rateLimit;
