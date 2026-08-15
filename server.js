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
  '/social-card.jpg': 'social-card.jpg',
};

const DEFAULT_CONFIG = {
  location: "O'Hanlon Park, Celbridge",
  time: '19:00',
  defaultCapacity: 15,
  revtag: 'sbnn3',
  lat: 53.3399,
  lon: -6.5406,
  // Pretul per jucator e FIX (nu se recalculeaza in functie de cati sunt confirmati acum in
  // saptamana curenta — altfel ar arata sume ciudate cat timp lista se umple, ex. 17€ la 3
  // confirmati). Doar durata meciului (si costul total, informativ) difera dupa cate praguri
  // de jucatori se ating pana vineri.
  pricePerPlayer: 5,
  priceTiers: [
    { minPlayers: 15, totalCost: 70, hours: 2 },   // 3 echipe x 5, 2 ore
    { minPlayers: 10, totalCost: 50, hours: 1.5 }, // 2 echipe x 5, 1.5 ore
  ],
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

// ---------- Admini recunoscuti dupa numarul de telefon (nu au nevoie de ADMIN_KEY) ----------
// Cei 3 organizatori din grup: cand se inregistreaza/recupereaza contul cu unul din aceste
// numere, primesc controale suplimentare direct pe ecranul principal (scoate jucator, suna,
// marcheaza cash incasat). Poate fi schimbat fara redeploy prin variabila de mediu ADMIN_PHONES
// (numere separate prin virgula).
const DEFAULT_ADMIN_PHONES = ['0894394691', '0873876602', '0874681735'];
const ADMIN_PHONES = new Set(
  (process.env.ADMIN_PHONES ? process.env.ADMIN_PHONES.split(',') : DEFAULT_ADMIN_PHONES)
    .map(normalizePhone)
    .filter(Boolean)
);

function isAdminPhone(phone) {
  return ADMIN_PHONES.has(normalizePhone(phone));
}

// ---------- Vremea (Open-Meteo, fara cheie API) ----------

const WEATHER_CODES = {
  0: { emoji: '☀️', text: 'Cer senin' },
  1: { emoji: '🌤️', text: 'Predominant senin' },
  2: { emoji: '⛅', text: 'Parțial noros' },
  3: { emoji: '☁️', text: 'Înnorat' },
  45: { emoji: '🌫️', text: 'Ceață' },
  48: { emoji: '🌫️', text: 'Ceață' },
  51: { emoji: '🌦️', text: 'Burniță ușoară' },
  53: { emoji: '🌦️', text: 'Burniță' },
  55: { emoji: '🌧️', text: 'Burniță densă' },
  61: { emoji: '🌦️', text: 'Ploaie ușoară' },
  63: { emoji: '🌧️', text: 'Ploaie' },
  65: { emoji: '🌧️', text: 'Ploaie puternică' },
  71: { emoji: '🌨️', text: 'Ninsoare ușoară' },
  73: { emoji: '🌨️', text: 'Ninsoare' },
  75: { emoji: '❄️', text: 'Ninsoare puternică' },
  80: { emoji: '🌦️', text: 'Averse ușoare' },
  81: { emoji: '🌧️', text: 'Averse' },
  82: { emoji: '⛈️', text: 'Averse puternice' },
  95: { emoji: '⛈️', text: 'Furtună' },
  96: { emoji: '⛈️', text: 'Furtună cu grindină' },
  99: { emoji: '⛈️', text: 'Furtună puternică' },
};

const weatherCache = new Map(); // "lat,lon,data" -> { at, json }
const WEATHER_CACHE_TTL = 30 * 60 * 1000;

async function fetchWeatherJSON(lat, lon, dateISO) {
  const cacheKey = `${lat},${lon},${dateISO}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WEATHER_CACHE_TTL) return cached.json;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=Europe%2FDublin&start_date=${dateISO}&end_date=${dateISO}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Vremea indisponibila: ' + res.status);
  const json = await res.json();
  weatherCache.set(cacheKey, { at: Date.now(), json });
  return json;
}

function pickHourlyWeather(json, dateISO, time) {
  if (!json || !json.hourly || !Array.isArray(json.hourly.time)) return null;
  const hour = (time || '19:00').slice(0, 2).padStart(2, '0');
  const targetKey = `${dateISO}T${hour}:00`;
  let idx = json.hourly.time.indexOf(targetKey);
  if (idx === -1) idx = json.hourly.time.findIndex((t) => t.startsWith(dateISO));
  if (idx === -1) return null;
  const code = json.hourly.weathercode ? json.hourly.weathercode[idx] : undefined;
  const info = WEATHER_CODES[code] || { emoji: '🌡️', text: '—' };
  const rainArr = json.hourly.precipitation_probability;
  return {
    temp: Math.round(json.hourly.temperature_2m[idx]),
    rain: rainArr ? rainArr[idx] : null,
    emoji: info.emoji,
    text: info.text,
  };
}

// ---------- Pretul terenului (per jucator e FIX; doar ora/costul total difera pe praguri) ----------

function computePricing(tiers, confirmedCount, pricePerPlayer) {
  const list = (Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_CONFIG.priceTiers)
    .slice()
    .sort((a, b) => b.minPlayers - a.minPlayers);
  if (!list.length) return null;
  const tier = list.find((t) => confirmedCount >= t.minPlayers) || list[list.length - 1];
  const perPlayer = pricePerPlayer != null ? pricePerPlayer : DEFAULT_CONFIG.pricePerPlayer;
  return { totalCost: tier.totalCost, hours: tier.hours, minPlayers: tier.minPlayers, perPlayer };
}

// ---------- Calendar (.ics) ----------

function pad2(n) { return String(n).padStart(2, '0'); }

// Irlanda: ora de vara (UTC+1) din ultima duminica din martie pana in ultima duminica din octombrie (UTC+0 iarna).
function irishDstOffsetHours(dateUTC) {
  const year = dateUTC.getUTCFullYear();
  function lastSundayAt1UTC(monthIndex) {
    const d = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0, 0)); // ultima zi a lunii, 01:00 UTC
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d;
  }
  const dstStart = lastSundayAt1UTC(2); // martie
  const dstEnd = lastSundayAt1UTC(9); // octombrie
  return (dateUTC >= dstStart && dateUTC < dstEnd) ? 1 : 0;
}

function matchStartUTC(match) {
  const [y, m, d] = match.date.split('-').map(Number);
  const [hh, mm] = String(match.time || '19:00').split(':').map(Number);
  const naiveUTC = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0));
  const offset = irishDstOffsetHours(naiveUTC);
  return new Date(naiveUTC.getTime() - offset * 3600000);
}

function icsDate(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00Z`;
}

function escapeICS(s) {
  return String(s || '').replace(/([,;])/g, '\\$1');
}

function buildICS(match, pricing) {
  const start = matchStartUTC(match);
  const hours = (pricing && pricing.hours) || 1.5;
  const end = new Date(start.getTime() + hours * 3600000);

  // Reminder de dimineata (09:00 ora Irlandei) in ziua meciului.
  const morningNaiveUTC = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 9, 0, 0));
  const morningOffset = irishDstOffsetHours(morningNaiveUTC);
  const morningUTC = new Date(morningNaiveUTC.getTime() - morningOffset * 3600000);

  const uid = `match-${match.id}@vineri-fotbal.onrender.com`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vineri Fotbal//RO',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    'SUMMARY:⚽ Fotbal Vineri',
    `LOCATION:${escapeICS(match.location)}`,
    `GEO:${match.lat};${match.lon}`,
    `X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=${escapeICS(match.location)};X-APPLE-RADIUS=100;X-TITLE=${escapeICS(match.location)}:geo:${match.lat},${match.lon}`,
    'DESCRIPTION:Fotbal de vineri seara! Confirma prezenta pe https://vineri-fotbal.onrender.com',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Fotbal in 2 ore!',
    'TRIGGER:-PT2H',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Fotbal deseara — nu uita sa confirmi prezenta!',
    `TRIGGER;VALUE=DATE-TIME:${icsDate(morningUTC)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];
  return lines.join('\r\n');
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
      revtag: data.config.revtag,
      lat: data.config.lat,
      lon: data.config.lon,
      priceTiers: (data.config.priceTiers || DEFAULT_CONFIG.priceTiers).map((t) => Object.assign({}, t)),
      pricePerPlayer: data.config.pricePerPlayer != null ? data.config.pricePerPlayer : DEFAULT_CONFIG.pricePerPlayer,
      status: 'open', // open | cancelled
      createdAt: new Date().toISOString(),
    };
    data.matches.push(match);
    await persist(data);
  }
  // meciuri create inainte de a exista aceste campuri: completeaza cu valorile curente din config
  if (match.revtag === undefined) match.revtag = data.config.revtag;
  if (match.lat === undefined) match.lat = data.config.lat !== undefined ? data.config.lat : DEFAULT_CONFIG.lat;
  if (match.lon === undefined) match.lon = data.config.lon !== undefined ? data.config.lon : DEFAULT_CONFIG.lon;
  if (!match.priceTiers || !match.priceTiers.length) {
    match.priceTiers = (data.config.priceTiers || DEFAULT_CONFIG.priceTiers).map((t) => Object.assign({}, t));
  }
  if (match.pricePerPlayer == null) {
    match.pricePerPlayer = data.config.pricePerPlayer != null ? data.config.pricePerPlayer : DEFAULT_CONFIG.pricePerPlayer;
  }
  delete match.price; // camp vechi, inlocuit de priceTiers/pricePerPlayer
  return match;
}

function matchView(data, match, token) {
  const rsvpsForMatch = data.rsvps.filter((r) => r.matchId === match.id && r.status !== 'cancelled');

  const requester = token ? data.players.find((p) => p.id === token) : null;
  const isAdmin = Boolean(requester && isAdminPhone(requester.phone));

  const mapEntry = (r) => {
    const p = data.players.find((pl) => pl.id === r.playerId);
    const base = { name: p ? p.name : 'Jucator', payment: r.payment || null };
    // numarul de telefon, id-ul jucatorului si statusul platii apar doar pentru cei 3 admini
    if (isAdmin) {
      base.playerId = r.playerId;
      base.phone = p ? p.phone : null;
      base.paid = Boolean(r.paid);
    }
    return base;
  };

  const confirmed = rsvpsForMatch
    .filter((r) => r.status === 'confirmed')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(mapEntry);
  const waitlist = rsvpsForMatch
    .filter((r) => r.status === 'waitlist')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(mapEntry);

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
      revtag: match.revtag,
      priceTiers: match.priceTiers,
      pricePerPlayer: match.pricePerPlayer,
      lat: match.lat,
      lon: match.lon,
      status: match.status,
    },
    pricing: computePricing(match.priceTiers, confirmed.length, match.pricePerPlayer),
    isAdmin,
    myStatus,
    myPayment,
    confirmed,
    waitlist,
    confirmedCount: confirmed.length,
    spotsLeft: Math.max(0, match.capacity - confirmed.length),
  };
}

// scoate un jucator din meciul curent si promoveaza primul de pe rezerva daca era confirmat
// (folosit atat cand pleaca singur "Nu mai particip", cat si cand il scoate un admin)
function cancelParticipant(data, match, playerId) {
  const entry = data.rsvps.find((r) => r.matchId === match.id && r.playerId === playerId && r.status !== 'cancelled');
  if (!entry) return false;
  const wasConfirmed = entry.status === 'confirmed';
  entry.status = 'cancelled';
  if (wasConfirmed) {
    const nextInLine = data.rsvps
      .filter((r) => r.matchId === match.id && r.status === 'waitlist')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (nextInLine) nextInLine.status = 'confirmed';
  }
  return true;
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
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
            entry.paid = false;
          } else {
            entry = {
              id: crypto.randomUUID(),
              matchId: match.id,
              playerId: token,
              status: newStatus,
              payment: null,
              paid: false,
              createdAt: new Date().toISOString(),
            };
            data.rsvps.push(entry);
          }
        }
      } else if (action === 'leave') {
        cancelParticipant(data, match, token);
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
      entry.paid = false; // metoda de plata s-a schimbat, resetam si starea de incasare

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: scoate un participant din meciul curent (doar cei 3 admini recunoscuti dupa telefon) ----
    if (pathname === '/api/admin/kick' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const targetId = body.playerId;
      if (!token || !targetId) return sendJSON(res, 400, { error: 'Cerere invalida.' });
      const data = getData();
      const requester = data.players.find((p) => p.id === token);
      if (!requester || !isAdminPhone(requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      const match = await getOrCreateCurrentMatch(data);
      cancelParticipant(data, match, targetId);
      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: marcheaza plata cash ca incasata / neincasata (doar cei 3 admini recunoscuti dupa telefon) ----
    if (pathname === '/api/admin/mark-paid' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const targetId = body.playerId;
      if (!token || !targetId) return sendJSON(res, 400, { error: 'Cerere invalida.' });
      const data = getData();
      const requester = data.players.find((p) => p.id === token);
      if (!requester || !isAdminPhone(requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      const match = await getOrCreateCurrentMatch(data);
      const entry = data.rsvps.find((r) => r.matchId === match.id && r.playerId === targetId && r.status !== 'cancelled');
      if (!entry) return sendJSON(res, 404, { error: 'Jucator negasit in meciul curent.' });
      entry.paid = body.paid === true;

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
      if (body.revtag) match.revtag = String(body.revtag).trim().replace(/^@/, '');
      if (body.status && ['open', 'cancelled'].includes(body.status)) match.status = body.status;
      if (body.lat !== undefined && body.lat !== '' && !Number.isNaN(Number(body.lat))) match.lat = Number(body.lat);
      if (body.lon !== undefined && body.lon !== '' && !Number.isNaN(Number(body.lon))) match.lon = Number(body.lon);
      if (body.pricePerPlayer !== undefined && body.pricePerPlayer !== '' && !Number.isNaN(Number(body.pricePerPlayer))) {
        match.pricePerPlayer = Math.max(0, Number(body.pricePerPlayer));
      }
      if (body.priceTiers !== undefined) {
        if (!Array.isArray(body.priceTiers)) return sendJSON(res, 400, { error: 'Praguri de pret invalide.' });
        const cleaned = body.priceTiers
          .map((t) => ({
            minPlayers: Math.max(0, parseInt(t.minPlayers, 10) || 0),
            totalCost: Math.max(0, Number(t.totalCost) || 0),
            hours: Math.max(0, Number(t.hours) || 0),
          }))
          .filter((t) => t.minPlayers > 0 && t.totalCost > 0)
          .sort((a, b) => b.minPlayers - a.minPlayers);
        if (cleaned.length) match.priceTiers = cleaned;
      }

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

    // ---- API: vremea pentru meciul curent (Open-Meteo, fara cheie) ----
    if (pathname === '/api/weather' && req.method === 'GET') {
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      try {
        const json = await fetchWeatherJSON(match.lat, match.lon, match.date);
        const weather = pickHourlyWeather(json, match.date, match.time);
        return sendJSON(res, 200, { weather });
      } catch (e) {
        console.error('Vremea indisponibila:', e.message);
        return sendJSON(res, 200, { weather: null });
      }
    }

    // ---- Fisier .ics pentru "Adauga in calendar" (cu reminder dimineata + cu 2 ore inainte) ----
    if (pathname === '/calendar.ics' && req.method === 'GET') {
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      const confirmedCount = data.rsvps.filter((r) => r.matchId === match.id && r.status === 'confirmed').length;
      const pricing = computePricing(match.priceTiers, confirmedCount, match.pricePerPlayer);
      const ics = buildICS(match, pricing);
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fotbal-vineri.ics"',
      });
      return res.end(ics);
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
