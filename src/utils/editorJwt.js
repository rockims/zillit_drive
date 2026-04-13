import jwt from 'jsonwebtoken';

const WOPI_SECRET = process.env.COLLABORA_WOPI_SECRET || process.env.ONLYOFFICE_JWT_SECRET || 'fallback';

/**
 * Sign a WOPI access token containing user/file context.
 */
const signAccessToken = (payload, expiresIn = '8h') => {
  return jwt.sign(payload, WOPI_SECRET, { expiresIn });
};

/**
 * Verify and decode a WOPI access token.
 */
const verifyAccessToken = (token) => {
  return jwt.verify(token, WOPI_SECRET);
};

/**
 * Get the token expiry as a Unix timestamp in milliseconds.
 */
const getAccessTokenTTL = (expiresInMs = 8 * 60 * 60 * 1000) => {
  return Date.now() + expiresInMs;
};

export { signAccessToken, verifyAccessToken, getAccessTokenTTL, WOPI_SECRET };
