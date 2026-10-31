import crypto from 'node:crypto';

// Passwords: scrypt with a per-user salt.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

// Session cookie: userId.expiry.viewAsTenantId.signature
export function sessions(secret, days = 30) {
  const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');
  return {
    create(userId, viewAs = 0) {
      const exp = Date.now() + days * 864e5;
      const v = `${userId}.${exp}.${viewAs || 0}`;
      return `${v}.${sign(v)}`;
    },
    read(cookieHeader) {
      const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookieHeader || '');
      if (!m) return null;
      const parts = m[1].split('.');
      if (parts.length !== 4) return null;
      const v = parts.slice(0, 3).join('.');
      const good = sign(v);
      if (parts[3].length !== good.length || !crypto.timingSafeEqual(Buffer.from(parts[3]), Buffer.from(good))) return null;
      if (Number(parts[1]) < Date.now()) return null;
      return { userId: Number(parts[0]), viewAs: Number(parts[2]) || 0 };
    },
    maxAge: days * 86400,
  };
}

export const randomToken = (n = 18) => crypto.randomBytes(n).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
