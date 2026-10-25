/**
 * StudyPath • Cryptographic Authentication & Security Module
 * Uses Node.js native crypto for OWASP-compliant salted scrypt password hashing
 * and timing-safe comparison. Zero external dependencies required.
 */

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

/**
 * Generates a cryptographically random salt.
 */
function generateSalt(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hashes a plaintext password with a salt using scrypt.
 */
function hashPassword(password, salt) {
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return derivedKey.toString('hex');
}

/**
 * Verifies a password against stored salt and hash using timing-safe comparison.
 */
function verifyPassword(password, salt, storedHash) {
  try {
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const storedKey = Buffer.from(storedHash, 'hex');
    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch (err) {
    return false;
  }
}

/**
 * Generates a secure random session token.
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates a secure password reset token.
 */
function generateResetToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  generateResetToken
};
