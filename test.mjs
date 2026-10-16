// Selbsttest ohne Netz: node test.mjs
import assert from 'node:assert/strict';
import { decode, parseMg, saleYear, berlinToUtc, fold, buildIcs } from './feed.mjs';

// Echter Text von fc.de (Elversberg, 16.10.2026)
const info = 'Verkaufsstart\n20+:  16.10., 10 Uhr\nU25: 19.10., 16 Uhr \nMG: 20.10., 10 Uhr\n\nKontingentierung: 2\nPreisliste: 2';
assert.deepEqual(parseMg(info), { day: 20, month: 10, hour: 10, minute: 0 });
assert.equal(parseMg('Verkaufsstart, 10 Uhr\n20+:\nU25:\nMG:\n'), null); // noch nicht angekündigt
assert.deepEqual(parseMg('MG: Dienstag, 3.11.2026, 10:30 Uhr'), { day: 3, month: 11, hour: 10, minute: 30 });
// Varianten von der Ticketing-Seite (Oktober 2026)
assert.deepEqual(parseMg('Verkaufsstart, 10 Uhr\nMG: 17.09.\n\nKontingentierung: \n2'), { day: 17, month: 9, hour: 10, minute: 0 });
assert.deepEqual(parseMg('Verkaufsstart, 10 Uhr\nMG: 09.04.Kontingentierung: \n2'), { day: 9, month: 4, hour: 10, minute: 0 });
assert.deepEqual(parseMg('Verkaufsstart, 10 Uhr\n20+: 16.01.\nU25: 19.01.\nMG: 20.01\n'), { day: 20, month: 1, hour: 10, minute: 0 });
assert.equal(parseMg('Verkaufsstart, 10 Uhr\n20+: n. n. bekannt \nMG: n. n. bekannt\n'), null);
assert.throws(() => parseMg('MG: am 20. Oktober'), /nicht lesbar/);
assert.throws(() => parseMg('MG: 17.09.'), /nicht lesbar/); // Datum ohne jede Uhrzeit
assert.throws(() => parseMg('MG: 10.30 Uhr'), /nicht lesbar/); // Uhrzeit für ein Datum gehalten

assert.equal(saleYear({ month: 12 }, '10.01.2027'), 2026);
assert.equal(saleYear({ month: 10 }, '28.11.2026'), 2026);

assert.equal(berlinToUtc(2026, 10, 20, 9, 25).toISOString(), '2026-10-20T07:25:00.000Z'); // Sommerzeit
assert.equal(berlinToUtc(2026, 11, 3, 9, 25).toISOString(), '2026-11-03T08:25:00.000Z'); // Winterzeit

// Mini-turbo-stream: Objekt-Schlüssel und -Werte sind Indizes, P-Zeilen hängen nachgeladene Daten an
const payload = '[{"_1":2,"_3":4},"name","Köln","later",["P",5]]\nP5:[{"_1":6},"Elversberg"]\n';
const html = `<script>streamController.enqueue(${JSON.stringify(payload)})</script>`;
assert.deepEqual(decode(html), { name: 'Köln', later: { name: 'Elversberg' } });

const long = 'DESCRIPTION:' + 'Ü'.repeat(100);
for (const l of fold(long).split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75);
assert.equal(fold(long).replace(/\r\n /g, ''), long);

const ics = buildIcs([{ id: '1', sale: berlinToUtc(2026, 10, 20, 10, 0), windowOpens: '9:30', opponent: 'Elversberg', dayBefore: [2026, 10, 19], description: 'a, b; c\nd' }]);
assert.match(ics, /DTSTART:20261020T072500Z/);
assert.match(ics, /DTEND:20261020T080000Z/);
assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20261019T180000Z/); // Vorabend 20 Uhr
assert.match(ics, /DESCRIPTION:a\\, b\\; c\\nd/);

console.log('Selbsttest ok');
