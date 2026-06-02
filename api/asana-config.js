// /api/asana-config.js
// Lista workspaces / projects / sections de Asana y guarda la selección del user.
//
// GET  ?list=workspaces                              → workspaces accesibles
// GET  ?list=projects&workspace_id=X                 → proyectos de ese workspace
// GET  ?list=sections&project_id=X                   → secciones de ese proyecto
// POST body: { workspace_id, workspace_name, project_id, project_name, section_id, section_name }
//
// Todas las requests requieren header: Authorization: Bearer <user_jwt de Supabase>

const { createClient } = require('@supabase/supabase-js');

async function getUserAndIntegration(req) {
  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return { error: 'missing auth header', code: 401 };

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return { error: 'invalid session', code: 401 };

  const { data: integration } = await sb
    .from('user_integrations')
    .select('*')
    .eq('user_id', user.id)
    .eq('provider', 'asana')
    .single();
  if (!integration) return { error: 'asana not connected', code: 400 };

  return { user, integration, sb };
}

async function refreshAsanaTokenIfNeeded(integration, sb) {
  if (!integration.expires_at) return integration;
  if (new Date(integration.expires_at) > new Date(Date.now() + 60_000)) return integration;
  if (!integration.refresh_token) return integration;

  const r = await fetch('https://app.asana.com/-/oauth_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID,
      client_secret: process.env.ASANA_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) return integration;
  const expires_at = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : null;
  await sb
    .from('user_integrations')
    .update({ access_token: data.access_token, expires_at })
    .eq('id', integration.id);
  return { ...integration, access_token: data.access_token, expires_at };
}

module.exports = async (req, res) => {
  const ctx = await getUserAndIntegration(req);
  if (ctx.error) {
    res.status(ctx.code).json({ error: ctx.error });
    return;
  }
  let { integration, sb } = ctx;
  integration = await refreshAsanaTokenIfNeeded(integration, sb);
  const token = integration.access_token;

  if (req.method === 'GET') {
    const { list, workspace_id, project_id } = req.query || {};
    try {
      if (list === 'workspaces') {
        const r = await fetch('https://app.asana.com/api/1.0/workspaces?opt_fields=name', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.errors?.[0]?.message || 'fetch workspaces failed');
        res.status(200).json({ items: data.data || [] });
        return;
      }
      if (list === 'projects') {
        if (!workspace_id) { res.status(400).json({ error: 'missing workspace_id' }); return; }
        const r = await fetch(
          `https://app.asana.com/api/1.0/projects?workspace=${workspace_id}&archived=false&opt_fields=name&limit=100`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.errors?.[0]?.message || 'fetch projects failed');
        res.status(200).json({ items: data.data || [] });
        return;
      }
      if (list === 'sections') {
        if (!project_id) { res.status(400).json({ error: 'missing project_id' }); return; }
        const r = await fetch(
          `https://app.asana.com/api/1.0/projects/${project_id}/sections?opt_fields=name`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.errors?.[0]?.message || 'fetch sections failed');
        res.status(200).json({ items: data.data || [] });
        return;
      }
      res.status(400).json({ error: 'invalid list param' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    const {
      workspace_id, workspace_name,
      project_id,   project_name,
      section_id,   section_name,
    } = req.body || {};
    const { error } = await sb.from('user_integrations').update({
      asana_workspace_id:   workspace_id   || null,
      asana_workspace_name: workspace_name || null,
      asana_project_id:     project_id     || null,
      asana_project_name:   project_name   || null,
      asana_section_id:     section_id     || null,
      asana_section_name:   section_name   || null,
    }).eq('id', integration.id);
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).end();
};
