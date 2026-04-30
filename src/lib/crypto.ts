import crypto from 'crypto';

// Use a 32-byte key from env, or a fallback for local development testing
const ENCRYPTION_KEY = process.env.POLLAR_MASTER_ENCRYPTION_KEY
    ? Buffer.from(process.env.POLLAR_MASTER_ENCRYPTION_KEY, 'hex')
    : crypto.scryptSync('development-secret', 'salt', 32);

const ALGORITHM = 'aes-256-gcm';

export function encryptKey(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptKey(text: string): string {
    const parts = text.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted text format');

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
