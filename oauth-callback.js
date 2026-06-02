// /api/oauth-callback.js
// Recibe el code del provider, lo cambia por tokens, persiste en Supabase
// y redirige al usuario de vuelta a la app con un flag de éxito.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  const { code, state, error } = req.query || {};
  const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;

  if (error) {
    res.writeHead(302, { Location: `${base}/?integration=error&reason=${encodeURIComponent(error)}` });
    res.end();
    return;
  }
  if (!code || !state) {
    res.status(400).send('Missing code/state');
    return;
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    res.status(400).send('Invalid state');
    return;
  }
  const { user_jwt, provider } = decoded;

  // 1) Validar el JWT contra Supabase para sacar user_id
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  const { data: { user }, error: userErr } = await sb.auth.getUser(user_jwt);
  if (userErr || !user) {
    res.status(401).send('Invalid user session');
    return;
  }

  const redirect_uri = `${base}/api/oauth-callback`;

  // 2) Intercambiar code por tokens
  let tokenData, email;
  try {
    if (provider === 'google') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri,
          grant_type: 'authorization_code',
        }),
      });
      tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || 'token exchange failed');
      }
      // Email del user de Google
      const meRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const me = await meRes.json();
      email = me.email || null;
    } else {
      // Asana
      const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.ASANA_CLIENT_ID,
          client_secret: process.env.ASANA_CLIENT_SECRET,
          redirect_uri,
          grant_type: 'authorization_code',
        }),
      });
      tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        throw new Error(tokenData.error_description || tokenData.error || 'token exchange failed');
      }
      // Asana devuelve `data: { email, name, gid }` junto con los tokens
      email = tokenData.data?.email || null;
    }
  } catch (e) {
    res.writeHead(302, {
      Location: `${base}/?integration=error&reason=${encodeURIComponent(e.message)}`,
    });
    res.end();
    return;
  }

  const expires_at = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  // 3) Upsert en user_integrations (preserva config previa si re-conecta)
  const { error: upsertErr } = await sb
    .from('user_integrations')
    .upsert(
      {
        user_id: user.id,
        provider,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        expires_at,
        account_email: email,
        scope: tokenData.scope || null,
      },
      { onConflict: 'user_id,provider' }
    );

  if (upsertErr) {
    res.writeHead(302, {
      Location: `${base}/?integration=error&reason=${encodeURIComponent(upsertErr.message)}`,
    });
    res.end();
    return;
  }

  // 4) Redirigir al app con flag de éxito
  res.writeHead(302, { Location: `${base}/?integration=${provider}_ok` });
  res.end();
};
