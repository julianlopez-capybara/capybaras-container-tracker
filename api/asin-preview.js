/**
 * Container Tracker — Amazon ASIN Preview Proxy (Vercel)
 *
 * GET /api/asin-preview?asin=B01N6CCUD1
 */

const CACHE = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function pickUA(){ return USER_AGENTS[Math.floor(Math.random()*USER_AGENTS.length)]; }

const DOMAINS = {
  com:      'www.amazon.com',
  'com.mx': 'www.amazon.com.mx',
  'com.br': 'www.amazon.com.br',
  es:       'www.amazon.es',
  uk:       'www.amazon.co.uk',
  de:       'www.amazon.de',
};

function getCached(key){
  const v = CACHE.get(key);
  if(!v) return null;
  if(Date.now() > v.expiresAt){ CACHE.delete(key); return null; }
  return v.data;
}
function setCached(key, data){
  if(CACHE.size >= MAX_CACHE_ENTRIES){
    const first = CACHE.keys().next().value;
    if(first) CACHE.delete(first);
  }
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function decodeEntities(s){
  if(!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_,n) => String.fromCharCode(parseInt(n,10)));
}

function extractMeta(html, property){
  const re = new RegExp(`<meta[^>]*?(?:property|name)=["']${property}["'][^>]*?content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  if(m) return decodeEntities(m[1]);
  const re2 = new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${property}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : null;
}

function extractTitle(html){
  let t = extractMeta(html, 'og:title');
  if(t) return t;
  const m = html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if(m) return decodeEntities(m[1].replace(/\s+/g, ' ').trim());
  const tt = html.match(/<title>([\s\S]*?)<\/title>/i);
  if(tt) return decodeEntities(tt[1].replace(/\s+/g, ' ').trim().replace(/^Amazon\.com:\s*/i, ''));
  return null;
}

function extractImage(html){
  const og = extractMeta(html, 'og:image');
  if(og && og.includes('http')) return og;
  const m = html.match(/<img[^>]*id=["']landingImage["'][^>]*src=["']([^"']+)["']/i);
  if(m) return m[1];
  const m2 = html.match(/<img[^>]*id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i);
  if(m2) return m2[1];
  const jsm = html.match(/"hiRes":"([^"]+\.jpg)"/);
  if(jsm) return jsm[1].replace(/\\u002F/g, '/').replace(/\\/g, '');
  return null;
}

function extractPrice(html){
  const whole = html.match(/<span[^>]*class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\d.,]+)\s*<\/span>/);
  const frac  = html.match(/<span[^>]*class=["'][^"']*a-price-fraction[^"']*["'][^>]*>(\d+)\s*<\/span>/);
  if(whole && frac){
    const clean = whole[1].replace(/[.,]$/, '');
    return `${clean}.${frac[1]}`;
  }
  const off = html.match(/<span[^>]*class=["']a-offscreen["'][^>]*>([^<]+)<\/span>/);
  if(off) return off[1].trim();
  const legacy = html.match(/id=["'](?:priceblock_ourprice|priceblock_dealprice|priceblock_saleprice)["'][^>]*>([^<]+)</);
  if(legacy) return decodeEntities(legacy[1].trim());
  return null;
}

function extractCurrency(html, priceStr){
  const m = html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/);
  if(m) return m[1];
  if(!priceStr) return null;
  if(priceStr.includes('$')) return 'USD';
  if(priceStr.includes('€')) return 'EUR';
  if(priceStr.includes('£')) return 'GBP';
  if(priceStr.includes('¥')) return 'JPY';
  return null;
}

function extractAvailability(html){
  const m = html.match(/id=["']availability["'][^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
  if(m) return decodeEntities(m[1].trim());
  return null;
}

function validateAsin(asin){
  return /^[A-Z0-9]{10}$/.test((asin || '').toUpperCase());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if(req.method === 'OPTIONS'){ res.status(204).end(); return; }
  if(req.method !== 'GET'){ res.status(405).json({ error: 'Method not allowed' }); return; }

  const asin = ((req.query.asin || '') + '').trim().toUpperCase();
  const locale = ((req.query.locale || 'com') + '').toLowerCase();

  if(!validateAsin(asin)){
    res.status(400).json({ error: 'ASIN inválido. Debe ser 10 caracteres alfanuméricos.', asin });
    return;
  }

  const domain = DOMAINS[locale] || DOMAINS.com;
  const cacheKey = `${locale}:${asin}`;

  const cached = getCached(cacheKey);
  if(cached){
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=43200');
    res.status(200).json({ ...cached, cached: true });
    return;
  }

  const url = `https://${domain}/dp/${asin}`;

  try{
    const r = await fetch(url, {
      headers: {
        'User-Agent': pickUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': locale === 'es' ? 'es-ES,es;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    if(!r.ok){
      res.status(200).json({
        asin, locale, url,
        error: r.status === 503
          ? 'Amazon nos pidió completar un captcha. Probá de nuevo en unos minutos.'
          : r.status === 404
            ? 'ASIN no encontrado en Amazon'
            : `Amazon devolvió HTTP ${r.status}`,
        statusCode: r.status,
      });
      return;
    }

    const html = await r.text();

    if(
      /Type the characters you see in this image/i.test(html) ||
      /Enter the characters you see below/i.test(html) ||
      /api-services-support@amazon\.com/i.test(html.slice(0, 5000))
    ){
      res.status(200).json({
        asin, locale, url,
        error: 'Amazon detectó tráfico automatizado. Probá de nuevo en unos minutos.',
      });
      return;
    }

    const title = extractTitle(html);
    const image = extractImage(html);
    const price = extractPrice(html);
    const currency = extractCurrency(html, price);
    const available = extractAvailability(html);

    if(!title && !image){
      res.status(200).json({
        asin, locale, url,
        error: 'No se pudo extraer info del producto. El ASIN puede no existir o la página tiene un layout distinto.',
      });
      return;
    }

    const data = {
      asin, locale, url,
      title: title || null,
      image: image || null,
      price: price || null,
      currency: currency || null,
      available: available || null,
      fetchedAt: new Date().toISOString(),
    };

    setCached(cacheKey, data);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=43200');
    res.status(200).json({ ...data, cached: false });
  }catch(err){
    res.status(500).json({ error: 'Error al consultar Amazon: ' + (err.message || String(err)), asin });
  }
};
