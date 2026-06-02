// /api/sync-to-calendar.js
// Sincroniza ETA(s) de un container con Google Calendar.
//
// POST JSON body:
//   { container_id: string,
//     type: 'puerto' | 'warehouse' | 'both',   // default 'both'
//     action: 'create' | 'update' | 'delete' } // default 'create' (sirve también para update)
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
    .from('user_integrations')
    .select('*')
    .eq('user_id', user.id)
    .eq('provider', 'google')
    .single();
  if (!integration) return { error: 'google not connected', code: 400 };

  return { user, integration, sb };
}

async function refreshGoogleTokenIfNeeded(integration, sb) {
  if (!integration.expires_at) return integration;
  if (new Date(integration.expires_at) > new Date(Date.now() + 60_000)) return integration;
  if (!integration.refresh_token) {
    throw new Error('Google token expired and no refresh_token. Reconnect in Ajustes.');
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(data.error_description || 'refresh failed');
  const expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await sb.from('user_integrations')
    .update({ access_token: data.access_token, expires_at })
    .eq('id', integration.id);
  return { ...integration, access_token: data.access_token, expires_at };
}

function buildEvent(container, eta_type) {
  const date = eta_type === 'puerto' ? container.eta : container.eta_warehouse;
  if (!date) return null;
  const label = eta_type === 'puerto' ? 'ETA Puerto Destino' : 'ETA Amazon Warehouse';
  return {
    summary: `📦 ${container.container || 'Container'} — ${label}`,
    description: [
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
    start: { date },  // all-day; date en formato YYYY-MM-DD
    end:   { date },
    reminders: { useDefault: true },
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
    integration = await refreshGoogleTokenIfNeeded(integration, sb);
  } catch (e) {
    res.status(401).json({ error: e.message });
    return;
  }

  const { data: container, error: cErr } = await sb
    .from('containers').select('*').eq('id', container_id).single();
  if (cErr || !container) { res.status(404).json({ error: 'container not found' }); return; }

  const calId = encodeURIComponent(integration.gcal_calendar_id || 'primary');
  const targets = type === 'both' ? ['puerto', 'warehouse'] : [type];
  const results = {};

  for (const t of targets) {
    const existingId = t === 'puerto'
      ? container.gcal_event_id_puerto
      : container.gcal_event_id_warehouse;

    try {
      // DELETE
      if (action === 'delete') {
        if (existingId) {
          await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${existingId}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${integration.access_token}` } }
          );
        }
        await sb.from('containers').update({
          [`gcal_event_id_${t}`]: null,
        }).eq('id', container_id);
        results[t] = { ok: true, deleted: true };
        continue;
      }

      // CREATE / UPDATE
      const eventBody = buildEvent(container, t);
      if (!eventBody) { results[t] = { ok: false, error: 'sin fecha de ETA' }; continue; }

      let resp, data;
      if (existingId) {
        resp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${existingId}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${integration.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(eventBody),
          }
        );
        data = await resp.json();
        if (!resp.ok) {
          // Si el evento fue borrado del calendar, lo recreamos
          if (resp.status === 404 || resp.status === 410) {
            const r2 = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${integration.access_token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(eventBody),
              }
            );
            const d2 = await r2.json();
            if (!r2.ok) { results[t] = { ok: false, error: d2.error?.message || 'recreate failed' }; continue; }
            await sb.from('containers').update({
              [`gcal_event_id_${t}`]: d2.id,
            }).eq('id', container_id);
            results[t] = { ok: true, created: true, id: d2.id, htmlLink: d2.htmlLink };
          } else {
            results[t] = { ok: false, error: data.error?.message || 'patch failed' };
          }
        } else {
          results[t] = { ok: true, updated: true, id: data.id, htmlLink: data.htmlLink };
        }
      } else {
        resp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${integration.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(eventBody),
          }
        );
        data = await resp.json();
        if (!resp.ok) { results[t] = { ok: false, error: data.error?.message || 'create failed' }; continue; }
        await sb.from('containers').update({
          [`gcal_event_id_${t}`]: data.id,
        }).eq('id', container_id);
        results[t] = { ok: true, created: true, id: data.id, htmlLink: data.htmlLink };
      }
    } catch (e) {
      results[t] = { ok: false, error: e.message };
    }
  }

  res.status(200).json({ ok: true, results });
};
