// Vineri Fotbal — server minimal, fara dependinte externe (doar Node.js standard).
// Ruleaza cu: node server.js
//
// Persistenta: daca UPSTASH_REDIS_REST_URL si UPSTASH_REDIS_REST_TOKEN sunt setate
// (vezi README), toate datele sunt sincronizate cu Upstash Redis (gratuit, persistent
// cu adevarat). Fara ele, aplicatia foloseste doar fisierul local data.json — suficient
// pentru dezvoltare locala, dar pe Render (plan gratuit) fisierele locale se pierd la
// fiecare repornire, deci Upstash e recomandat pentru productie.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'schimba-ma-te-rog';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'vineri-fotbal-data';
const upstashEnabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// Doar aceste fisiere sunt servite public (nu expunem server.js, package.json, data.json etc.)
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html',
};

const DEFAULT_CONFIG = {
  location: "O'Hanlon Park, Celbridge",
  time: '19:00',
  defaultCapacity: 15,
  price: 5,
  revtag: 'sbnn3',
};

// ---------- Persistenta ----------

let cachedData = null;

function ensureConfig(data) {
  data.config = Object.assign({}, DEFAULT_CONFIG, data.config || {});
}

async function upstashGet() {
  const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error('Upstash GET a esuat: ' + res.status);
  const json = await res.json();
  return json.result || null;
}

async function upstashSet(value) {
  const res = await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error('Upstash SET a esuat: ' + res.status);
}

async function initData() {
  if (upstashEnabled) {
    try {
      const raw = await upstashGet();
      if (raw) {
        cachedData = JSON.parse(raw);
        ensureConfig(cachedData);
        console.log('Date incarcate din Upstash Redis.');
        return;
      }
      console.log('Upstash gol inca — pornim cu date noi.');
    } catch (e) {
      console.error('Nu am putut incarca din Upstash, incerc fisierul local:', e.message);
    }
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      cachedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      ensureConfig(cachedData);
      return;
    } catch (e) {
      console.error('data.json local corupt, pornim cu date noi:', e.message);
    }
  }
  cachedData = { players: [], matches: [], rsvps: [], config: Object.assign({}, DEFAULT_CONFIG) };
}

function getData() {
  return cachedData;
}

async function persist(data) {
  cachedData = data;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('Salvare locala esuata (normal pe Render fara disc):', e.message);
  }
  if (upstashEnabled) {
    try {
      await upstashSet(JSON.stringify(data));
    } catch (e) {
      console.error('Salvare in Upstash esuata:', e.message);
    }
  }
}

// ---------- Utilitare dată (calculează "vinerea curentă" in fusul orar Europe/Dublin) ----------

function dublinTodayParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = fmt.format(new Date()).split('-').map(Number);
  return { y, m, d };
}

function nextFridayISO() {
  const { y, m, d } = dublinTodayParts();
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = base.getUTCDay(); // 0=Duminica ... 5=Vineri ... 6=Sambata
  const diff = (5 - dow + 7) % 7; // 0 daca azi e vineri
  const target = new Date(base.getTime() + diff * 86400000);
  return target.toISOString().slice(0, 10);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

// ---------- Logica de business ----------

async function getOrCreateCurrentMatch(data) {
  const date = nextFridayISO();
  let match = data.matches.find((m) => m.date === date);
  if (!match) {
    match = {
      id: crypto.randomUUID(),
      date,
      time: data.config.time,
      location: data.config.location,
      capacity: data.config.defaultCapacity,
      price: data.config.price,
      revtag: data.config.revtag,
      status: 'open', // open | cancelled
      createdAt: new Date().toISOString(),
    };
    data.matches.push(match);
    await persist(data);
  }
  // meciuri create inainte de a exista pret/revtag: completeaza cu valorile curente din config
  if (match.price === undefined) match.price = data.config.price;
  if (match.revtag === undefined) match.revtag = data.config.revtag;
  return match;
}

function matchView(data, match, token) {
  const rsvpsForMatch = data.rsvps.filter((r) => r.matchId === match.id && r.status !== 'cancelled');
  const confirmed = rsvpsForMatch
    .filter((r) => r.status === 'confirmed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ name: playerName(data, r.playerId), payment: r.payment || null }));
  const waitlist = rsvpsForMatch
    .filter((r) => r.status === 'waitlist')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ name: playerName(data, r.playerId), payment: r.payment || null }));

  let myStatus = 'none';
  let myPayment = null;
  if (token) {
    const mine = data.rsvps.find((r) => r.matchId === match.id && r.playerId === token && r.status !== 'cancelled');
    if (mine) {
      myStatus = mine.status;
      myPayment = mine.payment || null;
    }
  }

  return {
    match: {
      id: match.id,
      date: match.date,
      time: match.time,
      location: match.location,
      capacity: match.capacity,
      price: match.price,
      revtag: match.revtag,
      status: match.status,
    },
    myStatus,
    myPayment,
    confirmed,
    waitlist,
    confirmedCount: confirmed.length,
    spotsLeft: Math.max(0, match.capacity - confirmed.length),
  };
}

function playerName(data, playerId) {
  const p = data.players.find((pl) => pl.id === playerId);
  return p ? p.name : 'Jucator';
}

function findPlayerByPhone(data, phone) {
  const norm = normalizePhone(phone);
  return data.players.find((p) => normalizePhone(p.phone) === norm);
}

// ---------- Server HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('Body prea mare')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON invalid')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const fileName = STATIC_FILES[pathname];
  if (!fileName) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Nu am gasit pagina.'); return; }
  const fullPath = path.join(__dirname, fileName);
  fs.readFile(fullPath, (err, content) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Nu am gasit pagina.'); return; }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // ---- API: inregistrare / recuperare jucator dupa telefon ----
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      if (!name || !phone) return sendJSON(res, 400, { error: 'Numele si telefonul sunt obligatorii.' });

      const data = getData();
      let player = findPlayerByPhone(data, phone);
      if (player) {
        player.name = name; // permite actualizarea numelui daca s-a schimbat
      } else {
        player = { id: crypto.randomUUID(), name, phone, createdAt: new Date().toISOString() };
        data.players.push(player);
      }
      await persist(data);
      return sendJSON(res, 200, { token: player.id, name: player.name });
    }

    // ---- API: info despre jucator (dupa token) ----
    if (pathname === '/api/me' && req.method === 'GET') {
      const token = parsed.query.token;
      const data = getData();
      const player = data.players.find((p) => p.id === token);
      if (!player) return sendJSON(res, 404, { error: 'Jucator negasit' });
      return sendJSON(res, 200, { token: player.id, name: player.name });
    }

    // ---- API: meciul curent (vinerea urmatoare) ----
    if (pathname === '/api/match/current' && req.method === 'GET') {
      const token = parsed.query.token || null;
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: participare / retragere ----
    if (pathname === '/api/rsvp' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const action = body.action; // 'join' | 'leave'
      if (!token || !['join', 'leave'].includes(action)) {
        return sendJSON(res, 400, { error: 'Cerere invalida.' });
      }
      const data = getData();
      const player = data.players.find((p) => p.id === token);
      if (!player) return sendJSON(res, 404, { error: 'Jucator negasit. Inregistreaza-te din nou.' });

      const match = await getOrCreateCurrentMatch(data);
      if (match.status === 'cancelled') {
        return sendJSON(res, 409, { error: 'Meciul de vinerea aceasta a fost anulat.' });
      }

      let entry = data.rsvps.find((r) => r.matchId === match.id && r.playerId === token);

      if (action === 'join') {
        if (entry && entry.status === 'confirmed') {
          // deja confirmat, nimic de facut
        } else {
          const confirmedCount = data.rsvps.filter(
            (r) => r.matchId === match.id && r.status === 'confirmed'
          ).length;
          const newStatus = confirmedCount < match.capacity ? 'confirmed' : 'waitlist';
          if (entry) {
            entry.status = newStatus;
            entry.createdAt = new Date().toISOString();
            entry.payment = null; // participare noua — alege din nou metoda de plata
          } else {
            entry = {
              id: crypto.randomUUID(),
              matchId: match.id,
              playerId: token,
              status: newStatus,
              payment: null,
              createdAt: new Date().toISOString(),
            };
            data.rsvps.push(entry);
          }
        }
      } else if (action === 'leave') {
        if (entry && entry.status !== 'cancelled') {
          const wasConfirmed = entry.status === 'confirmed';
          entry.status = 'cancelled';
          if (wasConfirmed) {
            const nextInLine = data.rsvps
              .filter((r) => r.matchId === match.id && r.status === 'waitlist')
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (nextInLine) nextInLine.status = 'confirmed';
          }
        }
      }

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: alegere/schimbare metoda de plata pentru participarea curenta ----
    if (pathname === '/api/payment' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const method = body.method === undefined ? null : body.method; // 'revolut' | 'cash' | null
      if (!token) return sendJSON(res, 400, { error: 'Cerere invalida.' });
      if (method !== null && !['revolut', 'cash'].includes(method)) {
        return sendJSON(res, 400, { error: 'Metoda de plata invalida.' });
      }
      const data = getData();
      const player = data.players.find((p) => p.id === token);
      if (!player) return sendJSON(res, 404, { error: 'Jucator negasit. Inregistreaza-te din nou.' });

      const match = await getOrCreateCurrentMatch(data);
      const entry = data.rsvps.find((r) => r.matchId === match.id && r.playerId === token && r.status !== 'cancelled');
      if (!entry) return sendJSON(res, 409, { error: 'Trebuie sa participi mai intai.' });
      entry.payment = method;

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API ADMIN: reseteaza lista de participanti a meciului curent (necesita cheie) ----
    if (pathname === '/api/admin/reset' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      data.rsvps = data.rsvps.filter((r) => r.matchId !== match.id);
      await persist(data);
      return sendJSON(res, 200, matchView(data, match, null));
    }

    // ---- API ADMIN: vezi/editeaza meciul curent (necesita cheie) ----
    if (pathname === '/api/admin/match' && req.method === 'GET') {
      if (parsed.query.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      return sendJSON(res, 200, matchView(data, match, null));
    }

    if (pathname === '/api/admin/match' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      if (body.capacity !== undefined) match.capacity = Math.max(0, parseInt(body.capacity, 10) || 0);
      if (body.time) match.time = String(body.time);
      if (body.location) match.location = String(body.location);
      if (body.price !== undefined) match.price = Math.max(0, Number(body.price) || 0);
      if (body.revtag) match.revtag = String(body.revtag).trim().replace(/^@/, '');
      if (body.status && ['open', 'cancelled'].includes(body.status)) match.status = body.status;

      // promoveaza din lista de rezerva daca s-a marit capacitatea
      const confirmedCount = data.rsvps.filter((r) => r.matchId === match.id && r.status === 'confirmed').length;
      let freeSpots = match.capacity - confirmedCount;
      if (freeSpots > 0) {
        const waiting = data.rsvps
          .filter((r) => r.matchId === match.id && r.status === 'waitlist')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const r of waiting) {
          if (freeSpots <= 0) break;
          r.status = 'confirmed';
          freeSpots--;
        }
      }

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, null));
    }

    // ---- Fisiere statice (frontend) ----
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Eroare server: ' + err.message });
  }
});

initData().then(() => {
  server.listen(PORT, () => {
    console.log(`Vineri Fotbal ruleaza pe portul ${PORT}`);
    console.log(`Deschide http://localhost:${PORT}`);
    console.log(upstashEnabled ? 'Persistenta: Upstash Redis (activa).' : 'Persistenta: doar fisier local (Upstash NEactiv — vezi README).');
  });
});
