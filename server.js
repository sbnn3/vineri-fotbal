// Vineri Fotbal — server minimal, fara dependinte externe (doar Node.js standard).
// Ruleaza cu: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'schimba-ma-te-rog';

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
};

// ---------- Persistenta (fisier JSON, simplu si suficient pentru un grup mic) ----------

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { players: [], matches: [], rsvps: [], config: DEFAULT_CONFIG };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try {
    const data = JSON.parse(raw);
    if (!data.config) data.config = DEFAULT_CONFIG;
    return data;
  } catch (e) {
    throw new Error('data.json este corupt: ' + e.message);
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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

function getOrCreateCurrentMatch(data) {
  const date = nextFridayISO();
  let match = data.matches.find((m) => m.date === date);
  if (!match) {
    match = {
      id: crypto.randomUUID(),
      date,
      time: data.config.time,
      location: data.config.location,
      capacity: data.config.defaultCapacity,
      status: 'open', // open | cancelled
      createdAt: new Date().toISOString(),
    };
    data.matches.push(match);
    saveData(data);
  }
  return match;
}

function matchView(data, match, token) {
  const rsvpsForMatch = data.rsvps.filter((r) => r.matchId === match.id && r.status !== 'cancelled');
  const confirmed = rsvpsForMatch
    .filter((r) => r.status === 'confirmed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ name: playerName(data, r.playerId) }));
  const waitlist = rsvpsForMatch
    .filter((r) => r.status === 'waitlist')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => ({ name: playerName(data, r.playerId) }));

  let myStatus = 'none';
  if (token) {
    const mine = data.rsvps.find((r) => r.matchId === match.id && r.playerId === token && r.status !== 'cancelled');
    if (mine) myStatus = mine.status;
  }

  return {
    match: {
      id: match.id,
      date: match.date,
      time: match.time,
      location: match.location,
      capacity: match.capacity,
      status: match.status,
    },
    myStatus,
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

      const data = loadData();
      let player = findPlayerByPhone(data, phone);
      if (player) {
        player.name = name; // permite actualizarea numelui daca s-a schimbat
      } else {
        player = { id: crypto.randomUUID(), name, phone, createdAt: new Date().toISOString() };
        data.players.push(player);
      }
      saveData(data);
      return sendJSON(res, 200, { token: player.id, name: player.name });
    }

    // ---- API: info despre jucator (dupa token) ----
    if (pathname === '/api/me' && req.method === 'GET') {
      const token = parsed.query.token;
      const data = loadData();
      const player = data.players.find((p) => p.id === token);
      if (!player) return sendJSON(res, 404, { error: 'Jucator negasit' });
      return sendJSON(res, 200, { token: player.id, name: player.name });
    }

    // ---- API: meciul curent (vinerea urmatoare) ----
    if (pathname === '/api/match/current' && req.method === 'GET') {
      const token = parsed.query.token || null;
      const data = loadData();
      const match = getOrCreateCurrentMatch(data);
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
      const data = loadData();
      const player = data.players.find((p) => p.id === token);
      if (!player) return sendJSON(res, 404, { error: 'Jucator negasit. Inregistreaza-te din nou.' });

      const match = getOrCreateCurrentMatch(data);
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
          } else {
            entry = {
              id: crypto.randomUUID(),
              matchId: match.id,
              playerId: token,
              status: newStatus,
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

      saveData(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API ADMIN: vezi/editeaza meciul curent (necesita cheie) ----
    if (pathname === '/api/admin/match' && req.method === 'GET') {
      if (parsed.query.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = loadData();
      const match = getOrCreateCurrentMatch(data);
      return sendJSON(res, 200, matchView(data, match, null));
    }

    if (pathname === '/api/admin/match' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = loadData();
      const match = getOrCreateCurrentMatch(data);
      if (body.capacity !== undefined) match.capacity = Math.max(0, parseInt(body.capacity, 10) || 0);
      if (body.time) match.time = String(body.time);
      if (body.location) match.location = String(body.location);
      if (body.status && ['open', 'cancelled'].includes(body.status)) match.status = body.status;
      saveData(data);

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
        saveData(data);
      }

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

server.listen(PORT, () => {
  console.log(`Vineri Fotbal ruleaza pe portul ${PORT}`);
  console.log(`Deschide http://localhost:${PORT}`);
});
