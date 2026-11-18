// US stock heatmap server — zero dependencies, Node 18+. Data: Yahoo Finance (unofficial, no key).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIN_CAP = Number(process.env.MIN_CAP || 1e9); // ignore companies under $1B
const TTL = 60 * 1000;
const UA = 'Mozilla/5.0'; // long browser UAs get 429'd by Yahoo's crumb endpoint
const SECTORS = ['Technology', 'Financial Services', 'Healthcare', 'Consumer Cyclical', 'Communication Services',
  'Industrials', 'Consumer Defensive', 'Energy', 'Real Estate', 'Utilities', 'Basic Materials'];

const LISTED = new Set(['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS']); // Nasdaq, NYSE, NYSE American, etc.
let session = null; // {cookie, crumb}
let sessionP = null;
let cache = { t: 0, data: null, pending: null };

function getSession() {
  if (session) return Promise.resolve(session);
  return (sessionP ||= (async () => {
    for (let i = 0; ; i++) {
      try { return (session = await makeSession()); }
      catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
    }
  })().finally(() => (sessionP = null)));
}
async function makeSession() {
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  const c = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = await c.text();
  if (!c.ok || !crumb || crumb.includes('<')) throw new Error('crumb failed: ' + c.status + ' ' + crumb.slice(0, 80) + ' cookie=' + !!cookie);
  return { cookie, crumb };
}

async function screen(sector, offset) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession();
    const body = {
      size: 250, offset, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY',
      query: { operator: 'AND', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'eq', operands: ['sector', sector] },
        { operator: 'gt', operands: ['intradaymarketcap', MIN_CAP] }] },
      userId: '', userIdType: 'guid',
    };
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(s.crumb)}&lang=en-US&region=US&formatted=false`, {
      method: 'POST', headers: { 'User-Agent': UA, Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401 || r.status === 403) { session = null; continue; }
    if (r.status === 429) { await new Promise(r => setTimeout(r, 2500)); attempt--; continue; }
    if (!r.ok) throw new Error('screener ' + r.status);
    const j = await r.json();
    return j.finance.result[0];
  }
  throw new Error('auth failed');
}

async function loadSector(sector) {
  const out = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset < 1500) {
    const res = await screen(sector, offset);
    total = res.total;
    if (!res.quotes.length) break;
    for (const q of res.quotes) {
      if (!q.marketCap || q.regularMarketChangePercent == null || !LISTED.has(q.exchange)) continue; // skip OTC/pink-sheet ADRs
      out.push({ s: q.symbol, n: q.shortName || q.longName || q.symbol, c: q.marketCap, p: q.regularMarketPrice,
        ch: q.regularMarketChangePercent, sec: sector, v: q.regularMarketVolume });
    }
    offset += res.quotes.length;
  }
  return out;
}

async function refresh() {
  await getSession();
  const lists = [];
  for (let i = 0; i < SECTORS.length; i += 3) lists.push(...await Promise.all(SECTORS.slice(i, i + 3).map(loadSector)));
  const stocks = lists.flat().sort((a, b) => b.c - a.c);
  cache.data = { updated: Date.now(), stocks };
  cache.t = Date.now();
  console.log(`[${new Date().toLocaleTimeString()}] loaded ${stocks.length} stocks`);
  return cache.data;
}

async function getData() {
  if (cache.data && Date.now() - cache.t < TTL) return cache.data;
  if (!cache.pending) cache.pending = refresh().finally(() => (cache.pending = null));
  try { return await cache.pending; } catch (e) { if (cache.data) return cache.data; throw e; }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/stocks')) {
    try {
      const d = await getData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => { console.log(`Heatmap at http://localhost:${PORT}`); getData().catch(e => console.error(e.message)); });
