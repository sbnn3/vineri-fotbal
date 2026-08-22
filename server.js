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
  // Favicon + logo-uri "Adauga pe ecranul principal" (vezi index.html / admin.html <head>)
  '/manifest.json': 'manifest.json',
  '/manifest-admin.json': 'manifest-admin.json',
  '/icon-main.svg': 'icon-main.svg',
  '/icon-main-32.png': 'icon-main-32.png',
  '/icon-main-48.png': 'icon-main-48.png',
  '/icon-main-180.png': 'icon-main-180.png',
  '/icon-main-192.png': 'icon-main-192.png',
  '/icon-main-512.png': 'icon-main-512.png',
  '/icon-admin.svg': 'icon-admin.svg',
  '/icon-admin-32.png': 'icon-admin-32.png',
  '/icon-admin-48.png': 'icon-admin-48.png',
  '/icon-admin-180.png': 'icon-admin-180.png',
  '/icon-admin-192.png': 'icon-admin-192.png',
  '/icon-admin-512.png': 'icon-admin-512.png',
};

const DEFAULT_CONFIG = {
  location: 'Celbridge Golf Range, Celbridge, Co. Kildare',
  time: '19:00',
  defaultCapacity: 15,
  revtag: 'sbnn3',
  lat: 53.33907,
  lon: -6.50912,
  // Pretul per jucator NU e un camp separat — se calculeaza automat din pragul de pret (cost
  // total / nr. de jucatori al pragului respectiv), NU din cati sunt confirmati acum in
  // saptamana curenta (altfel ar arata sume ciudate cat timp lista se umple, ex. 17€ la 3
  // confirmati). Pragul se alege dupa capacitatea saptamanii (vezi computePricing).
  priceTiers: [
    { minPlayers: 15, totalCost: 70, hours: 2 },   // 3 echipe x 5, 2 ore
    { minPlayers: 10, totalCost: 50, hours: 1.5 }, // 2 echipe x 5, 1.5 ore
  ],
};

// ---------- Persistenta ----------

let cachedData = null;

function ensureConfig(data) {
  data.config = Object.assign({}, DEFAULT_CONFIG, data.config || {});
  if (!Array.isArray(data.blocked)) data.blocked = []; // migrare: lista de jucatori blocati, adaugata ulterior
  if (!Array.isArray(data.admins)) {
    // migrare: admini gestionati dinamic din panoul admin (adauga.php/scoate), nu mai sunt fixati in cod.
    // La prima rulare dupa upgrade, pastram Dima si Catalin ca admini (erau hardcodati inainte) — dar NU
    // si Fondatorul, care e mereu admin separat, prin PROTECTED_ADMIN_PHONE (vezi mai jos), indiferent
    // de aceasta lista.
    data.admins = ADMIN_PHONES_ORDERED
      .filter((phone) => phone !== PROTECTED_ADMIN_PHONE)
      .map((phone) => ({ phone, addedAt: new Date().toISOString() }));
  }
  // migrare: config-ul a fost salvat initial cu vechea denumire a locatiei ("O'Hanlon Park"),
  // inainte sa fie redenumita "Celbridge Golf Range". DEFAULT_CONFIG de mai sus a fost actualizat
  // de atunci, dar valoarea deja salvata are mereu prioritate (vezi Object.assign de mai sus), deci
  // ramanea "inghetata" la numele vechi — inclusiv in meciurile deja create cu acel nume (de-asta
  // aparea o denumire diferita pe ecrane diferite). O corectam automat aici, o singura data — si
  // doar daca gasim exact vechea valoare, ca sa nu suprascriem vreo locatie aleasa manual de admin.
  const OLD_LOCATION = "O'Hanlon Park, Celbridge";
  if (data.config.location === OLD_LOCATION) data.config.location = DEFAULT_CONFIG.location;
  if (Array.isArray(data.matches)) {
    for (const m of data.matches) {
      if (m.location === OLD_LOCATION) m.location = DEFAULT_CONFIG.location;
    }
  }
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
  cachedData = { players: [], matches: [], rsvps: [], blocked: [], config: Object.assign({}, DEFAULT_CONFIG) };
  ensureConfig(cachedData); // instalare 100% noua — initializeaza si data.admins (vezi ensureConfig)
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

// aduna (sau scade, cu numar negativ) zile la o data ISO "YYYY-MM-DD"
function addDaysISO(dateISO, days) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Fereastra de inscrieri: deschisa Miercuri-Vineri (pentru meciul de vineri care tocmai vine),
// inchisa Sambata-Marti (dupa ce meciul saptamanii s-a jucat si pana se deschide urmatorul).
// Se recalculeaza automat din ziua curenta (fus orar Europe/Dublin), fara nicio interventie
// manuala saptamanala — nextFridayISO() gaseste mereu vinerea corecta, indiferent de zi.
function isRegistrationOpen() {
  const { y, m, d } = dublinTodayParts();
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Duminica ... 6=Sambata
  return dow === 3 || dow === 4 || dow === 5; // Miercuri, Joi, Vineri
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  // numerele irlandeze pot fi scrise ca 08xxxxxxxx sau +3538xxxxxxxx / 003538xxxxxxxx —
  // le aducem la aceeasi forma (0xxxxxxxx) ca sa fie recunoscute drept acelasi numar
  // (ex: 0891234567 si +353891234567 trebuie sa se potriveasca la blocare / recunoastere admin)
  if (p.startsWith('+353')) p = '0' + p.slice(4);
  else if (p.startsWith('00353')) p = '0' + p.slice(5);
  else if (/^353\d{7,9}$/.test(p)) p = '0' + p.slice(3);
  return p;
}

// ---------- Admini recunoscuti dupa numarul de telefon (nu au nevoie de ADMIN_KEY) ----------
// Fondatorul (contul proprietarului) e fixat prin variabila de mediu ADMIN_PHONES / valoarea
// implicita de mai jos — primul numar din lista e mereu Fondator si e protejat integral (nimeni
// nu poate sa-l scoata, sa-l blocheze sau sa-i ia rolul). Restul adminilor (Administratori) NU mai
// sunt fixati in cod: se gestioneaza dinamic din Panoul admin (sectiunea "Administratori"), salvati
// in data.admins — cand ii adaugi acolo primesc pe loc toate drepturile (scoate/blocheaza/vede
// telefoane/marcheaza cash) si eticheta corespunzatoare, iar cand ii scoti le pierd automat, fara
// nicio modificare de cod sau redeploy.
const DEFAULT_ADMIN_PHONES = ['0894394691', '0873876602', '0874681735'];
const ADMIN_PHONES_ORDERED = (process.env.ADMIN_PHONES ? process.env.ADMIN_PHONES.split(',') : DEFAULT_ADMIN_PHONES)
  .map(normalizePhone)
  .filter(Boolean);
const PROTECTED_ADMIN_PHONE = ADMIN_PHONES_ORDERED[0] || null;

function isAdminPhone(data, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return false;
  if (PROTECTED_ADMIN_PHONE && norm === PROTECTED_ADMIN_PHONE) return true;
  return (data.admins || []).some((a) => a.phone === norm);
}

// 'founder' pentru Fondator (contul proprietarului, fix, protejat integral), 'admin' pentru
// Administratorii adaugati/scosi dinamic din Panoul admin, null = jucator normal. Protectia
// impotriva blocarii/eliminarii nu tine de eticheta, ci strict de PROTECTED_ADMIN_PHONE
// (vezi isProtectedAdmin) — deci Administratorii nu au niciun drept asupra Fondatorului.
function getAdminRole(data, phone) {
  const norm = normalizePhone(phone);
  if (PROTECTED_ADMIN_PHONE && norm === PROTECTED_ADMIN_PHONE) return 'founder';
  return isAdminPhone(data, phone) ? 'admin' : null;
}

// contul Administratorului: nimeni (nici ceilalti admini) nu are voie sa-l scoata din lista sau sa-l blocheze
function isProtectedAdmin(phone) {
  return Boolean(PROTECTED_ADMIN_PHONE) && normalizePhone(phone) === PROTECTED_ADMIN_PHONE;
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
// marita de la 30 min la 3 ore: prognoza pentru un meci aflat la cateva zile distanta nu se
// schimba semnificativ de la o jumatate de ora la alta, iar cereri mai rare inseamna sanse mult
// mai mici sa lovim limita de rate a Open-Meteo (vezi si fallback-ul din catch de mai jos)
const WEATHER_CACHE_TTL = 3 * 60 * 60 * 1000;

async function fetchWeatherJSON(lat, lon, dateISO) {
  const cacheKey = `${lat},${lon},${dateISO}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WEATHER_CACHE_TTL) return cached.json;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=Europe%2FDublin&start_date=${dateISO}&end_date=${dateISO}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Vremea indisponibila: ' + res.status);
    const json = await res.json();
    weatherCache.set(cacheKey, { at: Date.now(), json });
    return json;
  } catch (e) {
    // Open-Meteo poate fi temporar indisponibil (ex. 429 — limita de cereri depasita, posibil
    // din cauza IP-ului comun de pe planul gratuit Render, folosit si de alte proiecte). Daca
    // avem deja un raspuns anterior in cache — chiar mai vechi decat TTL-ul normal — il folosim
    // in continuare, ca sa nu dispara complet widget-ul de vreme din pagina. Mai bine o vreme
    // usor invechita decat deloc.
    if (cached) {
      console.error('Vremea indisponibila, folosesc valoarea din cache (posibil invechita):', e.message);
      return cached.json;
    }
    throw e;
  }
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

// ---------- Pretul terenului (impartire automata: cost total / nr. jucatori al pragului) ----------
// Pragul (10 sau 15 jucatori) se alege dupa CAPACITATEA meciului setata din admin pentru
// saptamana respectiva (cati jucatori s-a decis ca se joaca), NU dupa cati s-au confirmat pana
// acum — altfel ar arata info gresita cat timp lista se umple (ex. sondaj deschis pentru 15,
// dar cu doar 3 confirmati ar aparea starea "10 jucatori").
// Pretul per jucator NU e un camp separat, se calculeaza automat: totalCost / minPlayers al
// pragului ales (ex: 50€ / 10 jucatori = 5€; 70€ / 15 jucatori = 4,67€ -> rotunjit in sus la
// 0,5€, ca suma stransa de la toti jucatorii sa acopere mereu tot costul terenului).
function computePricing(tiers, capacity) {
  const list = (Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_CONFIG.priceTiers)
    .slice()
    .sort((a, b) => b.minPlayers - a.minPlayers);
  if (!list.length) return null;
  const tier = list.find((t) => capacity >= t.minPlayers) || list[list.length - 1];
  const rawPerPlayer = tier.totalCost / tier.minPlayers;
  const perPlayer = Math.ceil(rawPerPlayer / 0.5) * 0.5;
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
    'SUMMARY:Vineri - Seară de Fotbal ⚽',
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
  delete match.price; // camp vechi, inlocuit de priceTiers (pretul per jucator se calculeaza automat)
  delete match.pricePerPlayer; // camp vechi — pretul per jucator nu mai e setat manual, se calculeaza automat
  return match;
}

function matchView(data, match, token) {
  const rsvpsForMatch = data.rsvps.filter((r) => r.matchId === match.id && r.status !== 'cancelled');

  const requester = token ? data.players.find((p) => p.id === token) : null;
  const isAdmin = Boolean(requester && isAdminPhone(data, requester.phone));

  const mapEntry = (r) => {
    const p = data.players.find((pl) => pl.id === r.playerId);
    const base = { name: p ? p.name : 'Jucator', payment: r.payment || null };
    // eticheta "Administrator"/"Fondator" e vizibila pentru toata lumea (nu doar pentru admini), ca
    // oricine sa stie cine e admin in lista
    base.role = getAdminRole(data, p ? p.phone : null);
    // id-ul jucatorului, statusul platii si flagul de protectie raman doar pentru admini (folosite
    // la moderare); telefonul insa apare fie pentru admini (pot suna pe oricine), fie pentru oricine
    // altcineva doar daca randul e al unui admin (ca sa poata fi sunat de un jucator obisnuit)
    if (isAdmin) {
      base.playerId = r.playerId;
      base.phone = p ? p.phone : null;
      base.paid = Boolean(r.paid);
      // separat de eticheta afisata (toti cei 3 admini arata "Administrator"), doar contul
      // proprietarului e marcat protejat — clientul foloseste asta ca sa ascunda butoanele de
      // scos/blocat pe randul lui, indiferent cine se uita la listă
      base.protected = isProtectedAdmin(p ? p.phone : null);
    } else if (base.role === 'admin' || base.role === 'founder') {
      // Fondatorul e tot un admin din punctul asta de vedere — jucatorii obisnuiti trebuie
      // sa-i poata vedea/suna telefonul la fel ca la ceilalti admini (vezi si index.html publicCallBtn)
      base.phone = p ? p.phone : null;
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
      lat: match.lat,
      lon: match.lon,
      status: match.status,
    },
    pricing: computePricing(match.priceTiers, match.capacity),
    isAdmin,
    myStatus,
    myPayment,
    confirmed,
    waitlist,
    confirmedCount: confirmed.length,
    spotsLeft: Math.max(0, match.capacity - confirmed.length),
    blocked: isAdmin ? data.blocked : undefined, // lista de blocati, vizibila doar celor 3 admini recunoscuti dupa telefon
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

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

// verifica daca un numar de telefon si/sau un nume au fost blocate de organizatori —
// blocarea tine cont de ambele variante de scriere ale numarului (0891234567 si +353891234567)
function isBlocked(data, phone, name) {
  const normPhone = normalizePhone(phone);
  const normNm = normalizeName(name);
  return (data.blocked || []).some((b) =>
    (normPhone && b.phone === normPhone) || (normNm && normalizeName(b.name) === normNm)
  );
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
      if (isBlocked(data, phone, name)) {
        return sendJSON(res, 403, { error: 'Acest număr sau nume a fost blocat de organizatori. Dacă e o greșeală, contactează-i direct.' });
      }
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
        // un jucator blocat de organizatori nu se mai poate inscrie, chiar daca mai are sesiunea salvata in telefon
        if (isBlocked(data, player.phone, player.name)) {
          return sendJSON(res, 403, { error: 'Ai fost blocat de organizatori și nu te mai poți înscrie. Dacă e o greșeală, contactează-i direct.' });
        }
        // metoda de plata se alege in modalul afisat la apasarea "Particip", inainte sa fie pus in lista
        const chosenPayment = ['revolut', 'cash'].includes(body.payment) ? body.payment : null;
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
            entry.payment = chosenPayment;
            entry.paid = false;
          } else {
            entry = {
              id: crypto.randomUUID(),
              matchId: match.id,
              playerId: token,
              status: newStatus,
              payment: chosenPayment,
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
      if (!requester || !isAdminPhone(data, requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      // contul Administratorului e protejat integral — nimeni, nici ceilalti admini, nu il poate scoate din lista
      const kickTarget = data.players.find((p) => p.id === targetId);
      if (kickTarget && isProtectedAdmin(kickTarget.phone)) {
        return sendJSON(res, 403, { error: 'Acest cont este protejat — nu poate fi scos din listă de nimeni.' });
      }

      const match = await getOrCreateCurrentMatch(data);
      cancelParticipant(data, match, targetId);
      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: blocheaza un jucator dupa telefon+nume, sa nu se mai poata inregistra ulterior
    // (doar cei 3 admini recunoscuti dupa telefon) — il si scoate automat din meciul curent ----
    if (pathname === '/api/admin/block' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const targetId = body.playerId;
      if (!token || !targetId) return sendJSON(res, 400, { error: 'Cerere invalida.' });
      const data = getData();
      const requester = data.players.find((p) => p.id === token);
      if (!requester || !isAdminPhone(data, requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      const target = data.players.find((p) => p.id === targetId);
      if (!target) return sendJSON(res, 404, { error: 'Jucator negasit.' });

      // contul Administratorului e protejat integral — nimeni, nici ceilalti admini, nu il poate bloca
      if (isProtectedAdmin(target.phone)) {
        return sendJSON(res, 403, { error: 'Acest cont este protejat — nu poate fi blocat de nimeni.' });
      }

      const normPhone = normalizePhone(target.phone);
      if (!isBlocked(data, target.phone, target.name)) {
        data.blocked.push({
          id: crypto.randomUUID(),
          phone: normPhone,
          name: target.name,
          blockedAt: new Date().toISOString(),
        });
      }

      const match = await getOrCreateCurrentMatch(data);
      cancelParticipant(data, match, targetId); // il exclude automat din lista curenta

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API: deblocheaza un jucator blocat anterior (doar cei 3 admini recunoscuti dupa telefon) ----
    if (pathname === '/api/admin/unblock' && req.method === 'POST') {
      const body = await readBody(req);
      const token = body.token;
      const blockedId = body.blockedId;
      if (!token || !blockedId) return sendJSON(res, 400, { error: 'Cerere invalida.' });
      const data = getData();
      const requester = data.players.find((p) => p.id === token);
      if (!requester || !isAdminPhone(data, requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      data.blocked = (data.blocked || []).filter((b) => b.id !== blockedId);

      const match = await getOrCreateCurrentMatch(data);
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
      if (!requester || !isAdminPhone(data, requester.phone)) return sendJSON(res, 403, { error: 'Nu ai voie sa faci asta.' });

      const match = await getOrCreateCurrentMatch(data);
      const entry = data.rsvps.find((r) => r.matchId === match.id && r.playerId === targetId && r.status !== 'cancelled');
      if (!entry) return sendJSON(res, 404, { error: 'Jucator negasit in meciul curent.' });
      entry.paid = body.paid === true;

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, token));
    }

    // ---- API ADMIN: lista tuturor jucatorilor inregistrati + rolul fiecaruia (necesita cheie) ----
    // Folosita de sectiunea "Administratori" din Panoul admin, ca sa poata fi ales oricine a jucat
    // vreodata (nu doar cei din meciul curent) pentru a-i face/scoate admin.
    if (pathname === '/api/admin/admins' && req.method === 'GET') {
      if (parsed.query.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const data = getData();
      const players = data.players
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'ro'))
        .map((p) => ({ id: p.id, name: p.name, phone: p.phone, role: getAdminRole(data, p.phone) }));
      return sendJSON(res, 200, { players, founderPhone: PROTECTED_ADMIN_PHONE });
    }

    // ---- API ADMIN: fa admin un jucator deja inregistrat, dupa telefon (necesita cheie) ----
    // Primeste pe loc toate drepturile de Administrator (scoate/blocheaza/vede telefoane/marcheaza
    // cash) si eticheta corespunzatoare — fara nicio modificare de cod sau redeploy.
    if (pathname === '/api/admin/add-admin' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const phone = normalizePhone(body.phone);
      if (!phone) return sendJSON(res, 400, { error: 'Numar de telefon invalid.' });
      const data = getData();
      const player = findPlayerByPhone(data, phone);
      if (!player) return sendJSON(res, 404, { error: 'Nu exista niciun jucator inregistrat cu acest numar.' });
      if (phone === PROTECTED_ADMIN_PHONE) return sendJSON(res, 400, { error: 'Acest cont este deja Fondator.' });
      if (!Array.isArray(data.admins)) data.admins = [];
      if (!data.admins.some((a) => a.phone === phone)) {
        data.admins.push({ phone, addedAt: new Date().toISOString() });
        await persist(data);
      }
      return sendJSON(res, 200, { ok: true });
    }

    // ---- API ADMIN: scoate un admin (isi pierde pe loc toate drepturile) — necesita cheie ----
    // Fondatorul nu poate fi scos de aici, e fixat prin PROTECTED_ADMIN_PHONE.
    if (pathname === '/api/admin/remove-admin' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const phone = normalizePhone(body.phone);
      if (!phone) return sendJSON(res, 400, { error: 'Numar de telefon invalid.' });
      if (phone === PROTECTED_ADMIN_PHONE) return sendJSON(res, 400, { error: 'Contul de Fondator nu poate fi eliminat.' });
      const data = getData();
      data.admins = (data.admins || []).filter((a) => a.phone !== phone);
      await persist(data);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- API ADMIN: sterge definitiv un jucator inregistrat (profil de test, duplicat etc.) —
    // necesita cheie. Il scoate complet din baza (data.players), din lista de admini daca era acolo,
    // si din toate participarile lui (data.rsvps, inclusiv meciul curent daca era inscris) — dispare
    // de peste tot, nu doar din meciul saptamanii asta. Fondatorul nu poate fi sters de aici, e fixat
    // prin PROTECTED_ADMIN_PHONE (aceeasi protectie ca la kick/block/remove-admin).
    if (pathname === '/api/admin/delete-player' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.key !== ADMIN_KEY) return sendJSON(res, 401, { error: 'Cheie admin invalida.' });
      const phone = normalizePhone(body.phone);
      if (!phone) return sendJSON(res, 400, { error: 'Numar de telefon invalid.' });
      if (phone === PROTECTED_ADMIN_PHONE) return sendJSON(res, 400, { error: 'Contul de Fondator nu poate fi șters.' });
      const data = getData();
      const player = findPlayerByPhone(data, phone);
      if (!player) return sendJSON(res, 404, { error: 'Nu exista niciun jucator inregistrat cu acest numar.' });
      data.players = data.players.filter((p) => p.id !== player.id);
      data.admins = (data.admins || []).filter((a) => a.phone !== phone);
      data.rsvps = data.rsvps.filter((r) => r.playerId !== player.id);
      await persist(data);
      return sendJSON(res, 200, { ok: true });
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

      // promoveaza din lista de rezerva daca s-a marit capacitatea, sau muta pe rezerva daca s-a
      // micsorat sub numarul de confirmati curent (ex: eram 13, se schimba la 12 pentru 6vs6 —
      // ultimul intrat (cel mai recent confirmat, FIFO) trece automat pe rezerva, ca sa ramana
      // exact 12 confirmati, la fel ca la kick/leave)
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
      } else if (freeSpots < 0) {
        const toDemote = data.rsvps
          .filter((r) => r.matchId === match.id && r.status === 'confirmed')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // cei mai recenti primii
        let overflow = -freeSpots;
        for (const r of toDemote) {
          if (overflow <= 0) break;
          r.status = 'waitlist';
          overflow--;
        }
      }

      await persist(data);
      return sendJSON(res, 200, matchView(data, match, null));
    }

    // ---- API: starea ferestrei de inscrieri (fara cheie, publica) — folosita de ecranul de
    // inregistrare, ca sa arate mesajul elegant "revenim miercuri" in loc de formular, cand
    // inscrierile sunt inchise (Sambata-Marti). Se recalculeaza automat in fiecare saptamana.
    if (pathname === '/api/registration-status' && req.method === 'GET') {
      const data = getData();
      const match = await getOrCreateCurrentMatch(data);
      const open = isRegistrationOpen();
      return sendJSON(res, 200, {
        open,
        matchDate: match.date,
        opensAt: open ? null : addDaysISO(match.date, -2), // miercurea dinaintea acelui vineri
        time: match.time,
        location: match.location,
      });
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
      const pricing = computePricing(match.priceTiers, match.capacity);
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
