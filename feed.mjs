// Liest die Mitglieder-Vorverkaufstermine (MG) der FC-Heimspiele von fc.de und schreibt sie als ICS-Feed.
// Quelle ist bewusst fc.de, nicht der Ticketshop: der sitzt hinter Queue-it und wird nicht automatisiert abgefragt.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://fc.de';
const OUT = 'effzeh-vvk.ics';
const KOELN_ID = '9'; // Team-ID des 1. FC Köln im Spieldaten-Feed von fc.de
const SHOP = 'https://www.ticket-onlineshop.com/ols/fckoeln/de/maenner';
const DAY = 86400000;

// fc.de liefert seine Daten als React-Router-"turbo-stream": ein flaches Array, Objekte verweisen per Index.
export function decode(html) {
  const text = [...html.matchAll(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/g)].map(m => JSON.parse(m[1])).join('');
  const vals = [], promises = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const p = line.match(/^P(\d+):([\s\S]*)$/);
    if (p) { promises[p[1]] = vals.length; vals.push(...JSON.parse(p[2])); }
    else vals.push(...JSON.parse(line));
  }
  if (!vals.length) throw new Error('Kein Datenblock in der Seite gefunden – Seitenaufbau geändert?');
  const memo = new Map();
  const hyd = i => {
    if (i < 0) return null; // negative Indizes sind Sonderwerte (undefined, null, …)
    if (memo.has(i)) return memo.get(i);
    const v = vals[i];
    let out = v;
    if (Array.isArray(v) && v[0] === 'P') out = promises[v[1]] === undefined ? null : hyd(promises[v[1]]);
    else if (Array.isArray(v) && typeof v[0] !== 'string') { out = []; memo.set(i, out); for (const x of v) out.push(hyd(x)); }
    else if (v && typeof v === 'object' && !Array.isArray(v)) { out = {}; memo.set(i, out); for (const [k, x] of Object.entries(v)) out[vals[+k.slice(1)]] = hyd(x); }
    memo.set(i, out);
    return out;
  };
  return hyd(0);
}

// Alle Objekte im Baum, auf die pred zutrifft (Seitenlayout-unabhängig).
function collect(root, pred) {
  const found = [], seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && pred(o)) found.push(o);
    for (const v of Object.values(o)) walk(v);
  })(root);
  return found;
}

const richText = n => n?.value ?? (n?.content ?? []).map(richText).join('');

// "MG: 20.10., 10 Uhr" oder "Verkaufsstart, 10 Uhr … MG: 17.09." → {day, month, hour, minute}; null = noch nicht angekündigt.
export function parseMg(text) {
  const line = text.match(/MG:[ \t]*([^\n]*)/)?.[1].trim();
  if (!line || !/\d/.test(line)) return null; // leer oder "n. n. bekannt"
  const d = line.match(/(\d{1,2})\.(\d{1,2})\b/);
  const t = line.match(/(\d{1,2})(?:[.:](\d{2}))?\s*Uhr/) ?? text.match(/Verkaufsstart,\s*(\d{1,2})(?:[.:](\d{2}))?\s*Uhr/);
  const r = d && t && { day: +d[1], month: +d[2], hour: +t[1], minute: +(t[2] ?? 0) };
  // lieber laut scheitern als still einen Termin verlieren
  if (!r || r.month < 1 || r.month > 12 || r.day < 1 || r.day > 31 || r.hour > 23) throw new Error(`MG-Zeile nicht lesbar: "${line}"`);
  return r;
}

// Verkauf liegt vor dem Spiel: Verkaufsmonat nach Spielmonat heißt Vorjahr (Dezember-Verkauf, Januar-Spiel).
export const saleYear = (mg, matchDate) => {
  const [, mo, y] = matchDate.split('.').map(Number);
  return mg.month > mo ? y - 1 : y;
};

export function berlinToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  return new Date(2 * guess - Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute));
}

const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = s => s.replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n');

// RFC 5545: Zeilen höchstens 75 Byte, Fortsetzung mit führendem Leerzeichen.
export function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fc-vvk-feed//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:effzeh Vorverkauf', 'X-WR-TIMEZONE:Europe/Berlin', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'];
  for (const e of events) {
    const start = new Date(e.sale - 35 * 60000); // 5 Minuten vor Öffnung des Pre-Warteraums
    const evening = berlinToUtc(...e.dayBefore, 20, 0);
    lines.push('BEGIN:VEVENT', `UID:fc-vvk-mg-${e.id}@fc-vvk-feed`,
      `DTSTAMP:${stamp(start)}`, // fest statt "jetzt", sonst ändert sich die Datei bei jedem Lauf
      `DTSTART:${stamp(start)}`, `DTEND:${stamp(e.sale)}`,
      `SUMMARY:${esc(`effzeh VVK: ${e.opponent} – Pre-Warteraum ab ${e.windowOpens}`)}`,
      `DESCRIPTION:${esc(e.description)}`, `URL:${SHOP}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Pre-Warteraum öffnet ${e.windowOpens} – ${e.opponent}`)}`, 'TRIGGER:PT0S', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Morgen Vorverkauf ${e.opponent}, ${e.windowOpens} Pre-Warteraum`)}`, `TRIGGER;VALUE=DATE-TIME:${stamp(evening)}`, 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'user-agent': 'Mozilla/5.0 (fc-vvk-feed; privater Kalender-Feed)' } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return decode(await res.text());
}

const isMatch = o => o.match_date && o.home?.id && o.away?.name && o.id;

// shortcut: Pokal-Seiten hängen an der Runde im Pfad; Slugs ab Achtelfinale sind geraten. Fehlt einer, scheitert der Lauf laut und der Slug kommt hier dazu.
export async function findPokal(season, id) {
  for (const slug of ['1-runde', '2-runde', 'achtelfinale', 'viertelfinale', 'halbfinale', 'finale']) {
    try {
      const m = collect(await get(`/mannschaften/maenner/dfb-pokal/${season}/${slug}/${id}`), isMatch).find(x => x.id === id);
      if (m) return m;
    } catch (e) { if (!/HTTP 404/.test(e.message)) throw e; }
  }
  return null;
}

async function main() {
  const ticketing = await get('/service/stadionerlebnis/ticketing');
  const infos = [...new Map(collect(ticketing, o => o.id && o.infoText?.json && o.competition?.name && !/Frauen/i.test(o.competition.name)).map(o => [o.id, o])).values()];
  if (!infos.length) throw new Error('Keine Männer-Spiele mit Verkaufsinfo auf der Ticketing-Seite – Seitenaufbau geändert?');
  const menUrl = collect(ticketing, o => typeof o.menMatchUrl === 'string')[0]?.menMatchUrl;
  const season = menUrl?.match(/saison\d{4}/)?.[0];
  if (!season) throw new Error(`Aktuelle Saison nicht ermittelbar (menMatchUrl: ${menUrl})`);
  // Spielplan immer von einer Bundesliga-Seite: menMatchUrl zeigt an Pokaltagen auf die Pokalseite, die nur Pokalspiele kennt.
  // shortcut: Liga-Slug fest auf 1-bundesliga, bei einem Abstieg schlägt die Prüfung unten laut fehl und der Slug muss angepasst werden.
  const blUrl = `/mannschaften/maenner/1-bundesliga/${season}/1-spieltag/${infos.find(i => i.competition.name === 'Bundesliga')?.id}`;
  const schedule = new Map(collect(await get(blUrl), isMatch).map(m => [m.id, m]));
  const koelnGames = [...schedule.values()].filter(m => m.home.id === KOELN_ID || m.away.id === KOELN_ID).length;
  if (koelnGames < 30) throw new Error(`Spielplan unvollständig: nur ${koelnGames} Köln-Spiele unter ${blUrl}`);

  const now = Date.now(), events = [];
  for (const info of infos) {
    const mg = parseMg(richText(info.infoText.json));
    if (!mg) continue;
    const y0 = new Date(now).getUTCFullYear();
    // Jahr grob raten, nur zum Aussortieren alter Spiele: MG-Termine stehen höchstens ~6 Wochen vorher fest.
    const rough = Math.max(...[y0 - 1, y0, y0 + 1].map(y => Date.UTC(y, mg.month - 1, mg.day)).filter(t => t <= now + 60 * DAY));
    if (rough < now - 7 * DAY) continue; // längst vorbei
    let match = schedule.get(info.id);
    if (!match && /pokal/i.test(info.competition.name)) {
      match = await findPokal(season, info.id);
      if (!match) throw new Error(`Pokalspiel ${info.id} hat einen MG-Termin, die Spielseite ist aber nicht auffindbar`);
    }
    if (!match) continue; // Bundesliga-Eintrag der Vorsaison (die Ticketing-Seite führt sie noch) oder andere Wettbewerbe
    if (match.home.id !== KOELN_ID) continue; // nur Heimspiele
    const y = saleYear(mg, match.match_date);
    const sale = berlinToUtc(y, mg.month, mg.day, mg.hour, mg.minute);
    const opensMin = mg.hour * 60 + mg.minute - 30;
    const windowOpens = `${Math.floor(opensMin / 60)}:${String(opensMin % 60).padStart(2, '0')}`;
    const prev = new Date(Date.UTC(y, mg.month - 1, mg.day) - DAY);
    events.push({
      id: info.id, sale, windowOpens, opponent: match.away.shortname || match.away.name,
      dayBefore: [prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate()],
      description: `Heimspiel gegen ${match.away.name}, ${match.match_date}${/\d/.test(match.match_time) ? ` ${match.match_time} Uhr` : ' (Anstoß noch offen)'} (${info.competition.name}).\n\n` +
        `1. Zwischen ${windowOpens} und ${mg.hour}:${String(mg.minute).padStart(2, '0')} den Ticketshop öffnen, FC-Mail-Adresse eingeben\n` +
        '2. Sechsstelliger Code kommt per Mail von no-reply@ticket-onlineshop.com (ggf. Spam)\n' +
        '3. Code eingeben → in der Warteschlange\n' +
        `4. Um ${mg.hour}:${String(mg.minute).padStart(2, '0')} wird die Reihenfolge ausgelost, dann einloggen und buchen (max. 2 Karten)\n\n${SHOP}`,
    });
  }
  events.sort((a, b) => a.sale - b.sale);
  writeFileSync(OUT, buildIcs(events));
  console.log(`${events.length} Heimspiel-Vorverkauf(e) in ${OUT}:`);
  for (const e of events) console.log(`  ${e.sale.toISOString()}  ${e.opponent}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
