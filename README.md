# ⚽ Fotbal Vineri — O'Hanlon Park, Celbridge

Aplicație simplă pentru gestionarea prezenței la meciurile de fotbal de vineri seara. Jucătorii se înregistrează o singură dată (nume + telefon) și apoi confirmă prezența în fiecare săptămână cu un singur click, direct de pe telefon.

## Ce face aplicația

- Fiecare persoană se înregistrează o dată (nume + telefon), fără parolă.
- În fiecare săptămână apare automat meciul de vineri viitoare (fără să faci tu ceva).
- Jucătorii apasă „Particip” — dacă sunt locuri libere, sunt confirmați direct; dacă locurile s-au ocupat, intră automat pe lista de rezervă.
- Dacă cineva se retrage, primul de pe lista de rezervă este promovat automat la „confirmat”.
- Tu, ca organizator, ai o pagină de admin (`/admin`) unde poți schimba numărul de locuri, ora, locația, sau poți anula meciul unei săptămâni.

Capacitatea implicită este 15 locuri (o poți schimba oricând din pagina de admin).

## Cum rulezi aplicația local (pe orice calculator cu Node.js instalat)

Nu are nicio dependință externă — folosește doar Node.js standard, deci nu trebuie să rulezi `npm install`.

```
node server.js
```

Apoi deschizi în browser `http://localhost:3000`.

Datele (jucători, meciuri, prezențe) se salvează automat în fișierul `data.json` din același folder. Nu șterge acest fișier — e „baza de date” a aplicației.

### Cheia de admin

Pagina de admin (`/admin`) e protejată de o cheie simplă. Implicit este `schimba-ma-te-rog` — **schimb-o** înainte să dai acces oricui la link-ul aplicației, altfel oricine poate modifica meciul. O schimbi setând o variabilă de mediu la pornire:

```
ADMIN_KEY="cheia-mea-secreta" node server.js
```

## Cum o pui online, ca toată lumea din grup să o poată folosi

Ca să funcționeze din WhatsApp pentru toți cei 15-20 de oameni, aplicația trebuie găzduită undeva cu o adresă publică (un link). Cea mai simplă variantă, gratuită, fără cunoștințe tehnice avansate:

### Opțiunea recomandată: Render.com

1. Creează un cont gratuit pe [render.com](https://render.com).
2. Încarcă acest folder într-un repository nou pe GitHub (poți folosi [github.com](https://github.com) → „New repository” → încarci fișierele direct din browser, fără linia de comandă).
3. În Render: „New +” → „Web Service” → conectezi repository-ul de GitHub.
4. Setări:
   - **Build Command**: (lasă gol, nu e nevoie)
   - **Start Command**: `node server.js`
   - **Environment Variable**: adaugă `ADMIN_KEY` cu o valoare secretă a ta.
5. Apeși „Create Web Service”. În câteva minute primești un link de tipul `https://fotbal-vineri.onrender.com` — acela e linkul pe care îl trimiți în grupul de WhatsApp.

**Notă importantă despre Render (plan gratuit):** discul se resetează la fiecare redeploy/repornire, ceea ce ar șterge `data.json` (istoricul și jucătorii înregistrați) dacă aplicația s-ar baza doar pe fișierul local.

### Persistență reală (Upstash Redis, gratuit)

Ca datele (jucători, meciuri, prezențe) să rămână salvate garantat, aplicația poate folosi [Upstash](https://upstash.com) — o bază de date Redis gratuită, accesată prin REST API (fără nicio dependință npm).

1. Creează un cont gratuit pe [upstash.com](https://upstash.com) (poți intra direct cu GitHub).
2. „Create Database” → alege un nume și o regiune (ideal cât mai aproape de regiunea serviciului Render), planul „Free”.
3. Din pagina bazei de date, secțiunea „Connect” → tab „REST”, copiezi cele două valori: `UPSTASH_REDIS_REST_URL` și `UPSTASH_REDIS_REST_TOKEN`.
4. Le adaugi ca variabile de mediu în Render (Environment → Add Environment Variable), exact cu aceste două nume.
5. La următorul deploy, aplicația detectează automat variabilele și salvează toate datele în Upstash — persistență garantată, indiferent de reporniri.

Dacă aceste variabile nu sunt setate, aplicația funcționează în continuare, dar salvează doar local (risc de pierdere a datelor la redeploy pe Render).

### Alternativă: un mic server acasă / VPS

Dacă ai deja (sau vrei) un server mic (Raspberry Pi, VPS de câțiva euro), aplicația rulează identic cu `node server.js`, eventual pornită automat cu `pm2` sau un serviciu `systemd`, în spatele unui domeniu propriu.

## Cum arată fluxul pentru jucători

1. Cineva primește link-ul aplicației (îl pui fixat în grupul de WhatsApp).
2. Prima dată completează numele și telefonul — durează 10 secunde.
3. De atunci încolo, dacă deschide același link (sau îl salvează pe ecranul principal al telefonului ca o „aplicație”), vede direct meciul de vinerea curentă și poate apăsa „Particip”.
4. Dacă cineva schimbă telefonul sau șterge datele browserului, poate „recupera” contul introducând din nou același număr de telefon — nu se creează un jucător duplicat.

## Funcționalități adăugate

- **Vremea pentru ziua meciului** — afișată automat lângă oră/locație (temperatură + șansă de ploaie), preluată gratuit de la [Open-Meteo](https://open-meteo.com), fără cheie API. Coordonatele terenului se pot ajusta din `/admin` dacă se schimbă vreodată locația.
- **Cost teren pe praguri** — nu mai e un preț fix per jucător, ci praguri configurabile din `/admin` (implicit: 15 jucători → 70€ total / 2 ore; 10 jucători → 50€ total / 1,5 ore). Aplicația alege automat pragul potrivit numărului de confirmați și împarte costul, rotunjit în sus la 0,5€, ca suma strânsă să acopere tot terenul.
- **Adaugă în calendar** — buton pe ecranul principal care descarcă un fișier `.ics` cu meciul curent, cu două alarme incluse: una cu 2 ore înainte de meci și una dimineața zilei meciului (09:00).

## Idei pentru pași următori (dacă vrei să extinzi aplicația)

- Notificare automată (ex. joi seara) către cei care nu au răspuns încă — necesită integrare cu WhatsApp Business API sau trimitere de SMS/email.
- Istoric de prezență și un mic clasament („cine a jucat cel mai des”).
- Generare automată a celor două echipe.

Spune-mi dacă vrei să construim oricare dintre acestea — structura de date (jucători, meciuri, prezențe) e deja pregătită să susțină toate ideile de mai sus.
