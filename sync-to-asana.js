// /api/sync-to-asana.js
// Sincroniza ETA(s) de un container con Asana.
//
// POST JSON body:
//   { container_id: string,
//     type: 'puerto' | 'warehouse' | 'both',   // default 'both'
//     action: 'create' | 'update' | 'delete' } // default 'create'
// Header: Authorization: Bearer <user_jwt de Supabase>

const { createClient } = require('@supabase/supabase-js');

async function getCtx(req) {
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
    .from('user_integrations').select('*')
    .eq('user_id', user.id).eq('provider', 'asana').single();
  if (!integration) return { error: 'asana not connected', code: 400 };
  if (!integration.asana_project_id) {
    return { error: 'elegí proyecto de Asana en Ajustes', code: 400 };
  }
  return { user, integration, sb };
}

async function refreshAsanaTokenIfNeeded(integration, sb) {
  if (!integration.expires_at) return integration;
  if (new Date(integration.expires_at) > new Date(Date.now() + 60_000)) return integration;
  if (!integration.refresh_token) {
    throw new Error('Asana token expired and no refresh_token. Reconnect in Ajustes.');
  }
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
  if (!data.access_token) throw new Error(data.error_description || 'refresh failed');
  const expires_at = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : null;
  await sb.from('user_integrations')
    .update({ access_token: data.access_token, expires_at })
    .eq('id', integration.id);
  return { ...integration, access_token: data.access_token, expires_at };
}

function buildTask(container, eta_type) {
  const date = eta_type === 'puerto' ? container.eta : container.eta_warehouse;
  if (!date) return null;
  const label = eta_type === 'puerto' ? 'ETA Puerto Destino' : 'ETA Amazon Warehouse';
  return {
    name: `📦 ${container.container || 'Container'} — ${label}`,
    due_on: date,  // YYYY-MM-DD
    notes: [
      `Container: ${container.container || '-'}`,
      `Cuenta:    ${container.cuenta || '-'}`,
      `ID Envío:  ${container.shipment || '-'}`,
      `Tipo:      ${container.tipo || '-'}`,
      `SKU:       ${container.sku || '-'}`,
      `ASIN:      ${container.asin || '-'}`,
      `Cajas / Unidades: ${container.cajas || 0} / ${container.unidades || 0}`,
      `Estado:    ${container.estado || '-'}`,
      `Ubicación: ${container.ubicacion || '-'}`,
      '',
      '↗ Container Tracker — Capybaras Agency',
    ].join('\n'),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const ctx = await getCtx(req);
  if (ctx.error) { res.status(ctx.code).json({ error: ctx.error }); return; }
  let { integration, sb } = ctx;

  const { container_id, type = 'both', action = 'create' } = req.body || {};
  if (!container_id) { res.status(400).json({ error: 'missing container_id' }); return; }

  try {
    integration = await refreshAsanaTokenIfNeeded(integration, sb);
  } catch (e) {
    res.status(401).json({ error: e.message });
    return;
  }

  const { data: container, error: cErr } = await sb
    .from('containers').select('*').eq('id', container_id).single();
  if (cErr || !container) { res.status(404).json({ error: 'container not found' }); return; }

  const targets = type === 'both' ? ['puerto', 'warehouse'] : [type];
  const results = {};
  const token = integration.access_token;

  for (const t of targets) {
    const existingId = t === 'puerto'
      ? container.asana_task_id_puerto
      : container.asana_task_id_warehouse;

    try {
      // DELETE
      if (action === 'delete') {
        if (existingId) {
          await fetch(`https://app.asana.com/api/1.0/tasks/${existingId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        }
        await sb.from('containers').update({
          [`asana_task_id_${t}`]: null,
        }).eq('id', container_id);
        results[t] = { ok: true, deleted: true };
        continue;
      }

      // CREATE / UPDATE
      const taskBody = buildTask(container, t);
      if (!taskBody) { results[t] = { ok: false, error: 'sin fecha de ETA' }; continue; }

      if (existingId) {
        const resp = await fetch(`https://app.asana.com/api/1.0/tasks/${existingId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: taskBody }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          // Tarea borrada en Asana → recrear
          if (resp.status === 404) {
            const createBody = {
              data: {
                ...taskBody,
                projects: [integration.asana_project_id],
                ...(integration.asana_section_id
                  ? { memberships: [{ project: integration.asana_project_id, section: integration.asana_section_id }] }
                  : {}),
              },
            };
            const r2 = await fetch('https://app.asana.com/api/1.0/tasks', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(createBody),
            });
            const d2 = await r2.json();
            if (!r2.ok) { results[t] = { ok: false, error: d2.errors?.[0]?.message || 'recreate failed' }; continue; }
            const newId = d2.data?.gid;
            await sb.from('containers').update({
              [`asana_task_id_${t}`]: newId,
            }).eq('id', container_id);
            results[t] = { ok: true, created: true, id: newId, permalink: d2.data?.permalink_url };
          } else {
            results[t] = { ok: false, error: data.errors?.[0]?.message || 'update failed' };
          }
        } else {
          results[t] = { ok: true, updated: true, id: existingId, permalink: data.data?.permalink_url };
        }
      } else {
        const createBody = {
          data: {
            ...taskBody,
            projects: [integration.asana_project_id],
            ...(integration.asana_section_id
              ? { memberships: [{ project: integration.asana_project_id, section: integration.asana_section_id }] }
              : {}),
          },
        };
        const resp = await fetch('https://app.asana.com/api/1.0/tasks', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createBody),
        });
        const data = await resp.json();
        if (!resp.ok) { results[t] = { ok: false, error: data.errors?.[0]?.message || 'create failed' }; continue; }
        const newId = data.data?.gid;
        await sb.from('containers').update({
          [`asana_task_id_${t}`]: newId,
        }).eq('id', container_id);
        results[t] = { ok: true, created: true, id: newId, permalink: data.data?.permalink_url };
      }
    } catch (e) {
      results[t] = { ok: false, error: e.message };
    }
  }

  res.status(200).json({ ok: true, results });
};
