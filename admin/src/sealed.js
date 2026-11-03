import crypto from 'node:crypto';

// Encrypts tax ID numbers and bank account numbers before they are stored (AES-256-GCM). The key
// comes from the DATA_ENCRYPTION_KEY environment variable, never the database, so a copy of the
// database file alone can't be read. Each value is bound to what it is (its context), so a sealed
// value can't be moved into another field. Sealed values look like "v1.<base64url>".
export const MIN_KEY_LENGTH = 32;
const VERSION = 'v1';

export function sealer(secret) {
  if (!secret || String(secret).length < MIN_KEY_LENGTH) return null;
  const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('hitchpoint'), Buffer.from(label), 32));
  const key = derive('sealed-v1');
  const macKey = derive('fingerprint-v1'); // a separate key for fingerprints
  return {
    // A keyed fingerprint (HMAC-SHA256). Unlike a plain hash, it can't be used to guess the values
    // it covers (a 9-digit number has only a billion possibilities) without the key.
    fingerprint(text) { return crypto.createHmac('sha256', macKey).update(String(text)).digest('hex'); },
    seal(text, context) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(String(context)));
      const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return `${VERSION}.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
    },
    // Throws if the value was changed, sealed for another context, or sealed with another key.
    open(sealed, context) {
      const [v, data] = String(sealed || '').split('.');
      if (v !== VERSION || !data) throw new Error('Unreadable sealed value.');
      const raw = Buffer.from(data, 'base64url');
      if (raw.length < 28) throw new Error('Unreadable sealed value.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
      d.setAAD(Buffer.from(String(context)));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
