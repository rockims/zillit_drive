import jwt from 'jsonwebtoken';

const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET;

/**
 * Sign a payload for OnlyOffice Document Server.
 * The entire editor config is signed so OnlyOffice can verify its authenticity.
 *
 * @param {Object} payload - The config object to sign
 * @returns {string} JWT token
 */
const signOnlyOfficeToken = (payload) => {
  if (!ONLYOFFICE_JWT_SECRET) {
    throw new Error('ONLYOFFICE_JWT_SECRET is not configured');
  }
  return jwt.sign(payload, ONLYOFFICE_JWT_SECRET, { expiresIn: '1h' });
};

/**
 * Verify a JWT from OnlyOffice callback requests.
 * OnlyOffice signs its callback POSTs with the same shared secret.
 *
 * @param {string} token - The JWT to verify
 * @returns {Object} Decoded payload
 */
const verifyOnlyOfficeToken = (token) => {
  if (!ONLYOFFICE_JWT_SECRET) {
    throw new Error('ONLYOFFICE_JWT_SECRET is not configured');
  }
  return jwt.verify(token, ONLYOFFICE_JWT_SECRET);
};

export { signOnlyOfficeToken, verifyOnlyOfficeToken };
