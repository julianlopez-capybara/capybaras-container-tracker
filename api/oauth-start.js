// /api/oauth-start.js
// Inicia el flujo OAuth: redirige al provider con los params correctos.
// Usage: GET /api/oauth-start?provider=google|asana&user_jwt=...
// El user_jwt va embebido (firmado por Supabase) en el state, se valida en el callback.

const crypto = require('crypto');

module.exports = (req, res) => {
  const { provider, user_jwt } = req.query || {};

  if (!provider || !['google', 'asana'].includes(provider)) {
    res.status(400).send('Invalid provider');
    return;
  }
  if (!user_jwt) {
    res.status(400).send('Missing user_jwt');
    return;
  }

  // State: provider + nonce + user_jwt (el JWT ya es self-validating, se chequea en callback)
  const nonce = crypto.randomBytes(12).toString('hex');
  const state = Buffer.from(JSON.stringify({ provider, nonce, user_jwt })).toString('base64url');

  const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
  const redirect_uri = `${base}/api/oauth-callback`;

  let authUrl;
  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/userinfo.email',
      ].join(' '),
      access_type: 'offline',   // pide refresh_token
      prompt: 'consent',        // fuerza pantalla de consent (sino no devuelve refresh_token en 2da vez)
      state,
    });
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  } else {
    // Asana
    const params = new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID,
      redirect_uri,
      response_type: 'code',
      state,
    });
    authUrl = `https://app.asana.com/-/oauth_authorize?${params}`;
  }

  res.writeHead(302, { Location: authUrl });
  res.end();
};
