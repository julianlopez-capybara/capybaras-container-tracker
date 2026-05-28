// ============================================================
// /api/notify-team.js  —  Vercel Function (formato module.exports)
// Envía un mail al equipo con el detalle de UN embarque, vía Resend.
//
// Requiere variable de entorno en Vercel:
//   RESEND_API_KEY   → tu API key de resend.com (Settings → API Keys)
// Opcional:
//   NOTIFY_FROM      → remitente verificado, ej: "Container Tracker <tracker@capybaras.agency>"
//                      Si no la seteás, usa onboarding@resend.dev (sólo entrega
//                      al email dueño de la cuenta Resend — útil para probar).
// ============================================================

const ESTADO_COLOR = {
  'Pendiente': '#A3A3A3',
  'En tránsito': '#F59E0B',
  'En puerto': '#FF3300',
  'En aduana': '#E85B03',
  'Entregado': '#22C55E'
};

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function row(label, value){
  if(value == null || value === '') return '';
  return `<tr>
    <td style="padding:8px 14px;border-bottom:1px solid #1f1f1f;color:#9a9a9a;font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-family:monospace;white-space:nowrap">${esc(label)}</td>
    <td style="padding:8px 14px;border-bottom:1px solid #1f1f1f;color:#f5f5f5;font-size:14px;font-weight:600">${esc(value)}</td>
  </tr>`;
}

function buildHtml(payload){
  const c = payload.container || {};
  const reason = payload.reason === 'nuevo' ? 'Nuevo embarque' : 'Actualización de estado';
  const team = payload.teamName ? esc(payload.teamName) : 'tu equipo';
  const actor = payload.actor ? esc(payload.actor) : '';
  const estadoColor = ESTADO_COLOR[c.estado] || '#FF3300';
  const linkRow = c.link
    ? `<tr><td style="padding:8px 14px;border-bottom:1px solid #1f1f1f;color:#9a9a9a;font-size:12px;text-transform:uppercase;font-family:monospace">Link</td>
        <td style="padding:8px 14px;border-bottom:1px solid #1f1f1f;font-size:14px"><a href="${esc(c.link)}" style="color:#FF3300">Abrir envío</a></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html><body style="margin:0;background:#000;padding:24px;font-family:'DM Sans',Arial,sans-serif">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#0E0E0E;border:1px solid #262626;border-radius:14px;overflow:hidden">
    <tr><td style="padding:22px 24px;border-bottom:1px solid #262626">
      <div style="display:inline-block;width:34px;height:34px;border-radius:50%;background:#FF3300;text-align:center;line-height:34px;color:#000;font-weight:700;font-size:18px;vertical-align:middle">↗</div>
      <span style="color:#fff;font-size:18px;font-weight:700;margin-left:10px;vertical-align:middle">Container Tracker</span>
      <div style="color:#9a9a9a;font-size:12px;font-family:monospace;margin-top:8px;letter-spacing:.06em;text-transform:uppercase">Capybaras Agency · ${team}</div>
    </td></tr>
    <tr><td style="padding:20px 24px 6px">
      <div style="display:inline-block;background:${estadoColor};color:#000;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:5px 12px;border-radius:999px">${esc(reason)}</div>
      <h1 style="color:#fff;font-size:22px;margin:14px 0 2px;font-family:monospace">${esc(c.container || '(sin número)')}</h1>
      <div style="color:#9a9a9a;font-size:13px">Estado actual: <b style="color:${estadoColor}">${esc(c.estado || '-')}</b></div>
    </td></tr>
    <tr><td style="padding:16px 10px 8px">
      <table role="presentation" width="100%" style="border-collapse:collapse">
        ${row('Cuenta', c.cuenta)}
        ${row('ID Envío', c.shipment)}
        ${row('E-commerce', c.ecommerce)}
        ${row('Tipo', c.tipo)}
        ${row('SKU', c.sku)}
        ${row('ASIN', c.asin)}
        ${row('Cajas', c.cajas)}
        ${row('Unidades', c.unidades)}
        ${row('Ubicación', c.ubicacion)}
        ${row('ETA Puerto Destino', c.eta)}
        ${row('ETA Amz Warehouse', c.eta_warehouse)}
        ${linkRow}
      </table>
    </td></tr>
    <tr><td style="padding:14px 24px 22px;border-top:1px solid #262626">
      <div style="color:#6b6b6b;font-size:12px">${actor ? 'Actualizado por ' + actor + ' · ' : ''}Notificación automática del Container Tracker.</div>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = async (req, res) => {
  if(req.method !== 'POST'){
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if(!apiKey){
    res.status(500).json({ error: 'Falta RESEND_API_KEY en las variables de entorno de Vercel.' });
    return;
  }

  try{
    // Body puede venir ya parseado (Vercel) o como string
    let body = req.body;
    if(typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};

    const to = Array.isArray(body.to) ? body.to.filter(Boolean) : [];
    if(to.length === 0){
      res.status(400).json({ error: 'No hay destinatarios (to vacío).' });
      return;
    }
    if(!body.container){
      res.status(400).json({ error: 'Falta el objeto container.' });
      return;
    }

    const from = process.env.NOTIFY_FROM || 'Container Tracker <onboarding@resend.dev>';
    const c = body.container;
    const reason = body.reason === 'nuevo' ? 'Nuevo embarque' : 'Actualización';
    const subject = `[${body.teamName || 'Container Tracker'}] ${reason}: ${c.container || 'embarque'} · ${c.estado || ''}`.trim();

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html: buildHtml(body)
      })
    });

    const data = await resp.json().catch(() => ({}));
    if(!resp.ok){
      res.status(resp.status).json({ error: 'Resend: ' + (data && (data.message || data.name) || resp.statusText) });
      return;
    }
    res.status(200).json({ ok: true, id: data.id || null, sent: to.length });
  }catch(err){
    res.status(500).json({ error: String(err && err.message || err) });
  }
};
