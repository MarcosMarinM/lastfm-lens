'use strict';

/**
 * Tests for the analysis engine.
 *
 *   node --test
 *
 * No dependencies: Node's own test runner and assertions. The engine exposes only
 * the whole pipeline (`readCSV` + `analyse`) plus the exporters, so the tests drive
 * it the way `cli.js` and the report page do, and they lock the behaviours the
 * README promises rather than internal details.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'src', 'engine.js'));

// A plain epoch-seconds value (2023-11-14), so every fixture shares a base time.
const BASE = 1700000000;

/** Builds a CSV with the usual columns from [artist, album, track, epochSeconds]. */
function csv(rows) {
  return ['Artist;Album;Track;Date'].concat(rows.map((row) => row.join(';'))).join('\n');
}

function analyseRows(rows, options) {
  const parsed = engine.readCSV(csv(rows), 'test.csv');
  return { parsed, report: engine.analyse(parsed.scrobbles, options) };
}

function findingsOf(report, type) {
  return report.findings.filter((finding) => finding.type === type);
}

test('readCSV understands a reordered, non-English header', () => {
  const parsed = engine.readCSV('Título;Artista;Álbum;Fecha\nSong;Beta;Alb;1700000000\n', 'x.csv');
  assert.deepEqual(parsed.columns, { artist: 1, album: 2, albumId: -1, track: 0, date: 3 });
  assert.equal(parsed.scrobbles.length, 1);
  assert.equal(parsed.scrobbles[0].artist, 'Beta');
  assert.equal(parsed.scrobbles[0].title, 'Song');
  assert.equal(parsed.scrobbles[0].ts, BASE * 1000);
});

/* --- 6.6 Duplicate scrobbles ------------------------------------------------ */

test('a run of three identical scrobbles is one finding, not one per start', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song', BASE + 10],
    ['Alpha', 'X', 'Song', BASE + 20]
  ]);
  const duplicates = findingsOf(report, 'duplicate_scrobbles');
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].impact, 2);
  assert.match(duplicates[0].title, /3 times in a row/);
});

test('two separate runs are reported separately, each exactly once', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song', BASE + 10],
    ['Alpha', 'X', 'Song', BASE + 20],
    ['Alpha', 'X', 'Song', BASE + 500],
    ['Alpha', 'X', 'Song', BASE + 510]
  ]);
  const duplicates = findingsOf(report, 'duplicate_scrobbles');
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates.map((f) => f.impact).sort(), [1, 2]);
});

test('different tracks scrobbled seconds apart are not duplicates', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'One', BASE + 0],
    ['Alpha', 'X', 'Two', BASE + 5],
    ['Alpha', 'X', 'One', BASE + 40]
  ]);
  assert.equal(findingsOf(report, 'duplicate_scrobbles').length, 0);
});

/* --- Canonical choice ------------------------------------------------------- */

/** Five scrobbles of the older, more frequent spelling; two of the newer one. */
function recencyFixture() {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(['Jana Burceska', 'Y', 'Song', BASE + i]);
  rows.push(['Jana Burčeska', 'Y', 'Song', BASE + 100000]);
  rows.push(['Jana Burčeska', 'Y', 'Song', BASE + 100001]);
  return rows;
}

test('canonical "score" prefers the most recent form even when it is rarer', () => {
  const { report } = analyseRows(recencyFixture());
  const duplicate = findingsOf(report, 'duplicate_artists')[0];
  assert.ok(duplicate, 'the two spellings should be reported as the same artist');
  assert.equal(duplicate.proposed, 'Jana Burčeska');
  assert.equal(duplicate.current, 'Jana Burceska');
});

test('canonical "frequent" picks the most scrobbled, "recent" the most recent', () => {
  const frequent = analyseRows(recencyFixture(), { rules: { canonical: 'frequent' } }).report;
  assert.equal(findingsOf(frequent, 'duplicate_artists')[0].proposed, 'Jana Burceska');

  const recent = analyseRows(recencyFixture(), { rules: { canonical: 'recent' } }).report;
  assert.equal(findingsOf(recent, 'duplicate_artists')[0].proposed, 'Jana Burčeska');
});

/* --- Shared RULES isolation ------------------------------------------------- */

test('analyse restores RULES and does not leak unknown override keys', () => {
  const before = Object.assign({}, engine.RULES);
  const { report } = analyseRows(
    [
      ['Alpha', 'X', 'Song', BASE + 0],
      ['Alpha', 'X', 'Song', BASE + 10]
    ],
    { rules: { minimumConfidence: 'low', anUnknownOverride: 123 } }
  );
  assert.equal(report.summary.minimumConfidence, 'low', 'the override must apply during the call');
  assert.equal(report.meta.rules.minimumConfidence, 'low');
  assert.equal(engine.RULES.minimumConfidence, before.minimumConfidence, 'and be restored after');
  assert.ok(!('anUnknownOverride' in engine.RULES));
  assert.deepEqual(Object.keys(engine.RULES).sort(), Object.keys(before).sort());
});

/* --- Report shape, determinism, exporters ----------------------------------- */

test('the report is deterministic and its ids are unique', () => {
  const rows = [
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song', BASE + 10],
    ['Alpha', 'X', 'Song (Official Video)', BASE + 100]
  ];
  const first = analyseRows(rows).report;
  const second = analyseRows(rows).report;
  assert.deepEqual(first.findings, second.findings);
  assert.deepEqual(first.summary, second.summary);

  const ids = new Set(first.findings.map((f) => f.id));
  assert.equal(ids.size, first.findings.length);
  first.findings.forEach((finding) => {
    assert.match(finding.id, /#\d+$/, 'ids carry a unique suffix');
    assert.ok(
      !Object.keys(finding).some((k) => k.indexOf('__') === 0),
      'internal fields must be stripped from the report'
    );
  });
});

test('TYPE_ORDER lists exactly the sections of TYPE_LABELS', () => {
  assert.deepEqual(Object.keys(engine.TYPE_LABELS).slice().sort(), engine.TYPE_ORDER.slice().sort());
});

test('exporters produce the expected shapes', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song', BASE + 10]
  ]);
  assert.equal(JSON.parse(engine.toJSON(report)).findings.length, report.findings.length);
  assert.match(engine.toCSV(report).split('\n')[0], /^type;subtype;confidence;points;action/);
  assert.match(engine.toMarkdown(report), /Last\.fm Lens/);
});

/* --- A couple of detectors, so a regression in the rules is caught ---------- */

test('a platform badge in one title form is reported and stripped', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song (Official Video)', BASE + 100],
    ['Alpha', 'X', 'Song (Official Video)', BASE + 200]
  ]);
  const badge = findingsOf(report, 'title_variants').find((f) => f.subtype === 'platform_badge');
  assert.ok(badge, 'the badge form should be reported');
  assert.equal(badge.proposed, 'Song');
  assert.equal(badge.current, 'Song (Official Video)');
});

test('an artist repeated inside the title is flagged', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Alpha - Song', BASE + 0],
    ['Alpha', 'X', 'Song', BASE + 100],
    ['Alpha', 'X', 'Song', BASE + 200]
  ]);
  const finding = findingsOf(report, 'artist_in_title')[0];
  assert.ok(finding, 'the repeated artist should be flagged');
  assert.equal(finding.proposed, 'Song');
});

/* --- Choosing an alternative ------------------------------------------------ */

/** Two spellings of one title: 14 scrobbles with brackets, 9 with a dash. */
function titleVariantFixture() {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(['Zo\u00eb', 'Album', "Loin d'ici (Esc Version)", BASE + i * 1000]);
  for (let i = 0; i < 9; i++) rows.push(['Zo\u00eb', 'Album', "Loin d'ici - ESC Version", BASE + 20000 + i * 1000]);
  return rows;
}

test('an alternative carries the full swap, not just its value', () => {
  const { report } = analyseRows(titleVariantFixture());
  const finding = findingsOf(report, 'title_variants')[0];
  assert.ok(finding.alternatives.length > 0, 'the two forms should offer an alternative');
  finding.alternatives.forEach((alt) => {
    assert.equal(alt.proposed, alt.value);
    assert.ok(alt.current.indexOf(alt.value) < 0, 'the kept form is not on the "from" side');
    assert.ok(alt.impact > 0);
  });
});

test('proposalOf swaps to the chosen alternative and regenerates the how-to', () => {
  const { report } = analyseRows(titleVariantFixture());
  const finding = findingsOf(report, 'title_variants')[0];
  const alt = finding.alternatives[0];

  const fallback = engine.proposalOf(finding, null);
  assert.equal(fallback.proposed, finding.proposed);
  assert.equal(fallback.impact, finding.impact);

  const chosen = engine.proposalOf(finding, alt.value);
  assert.equal(chosen.proposed, alt.value);
  assert.equal(chosen.current, alt.current);
  assert.equal(chosen.impact, alt.impact);
  assert.notEqual(chosen.impact, fallback.impact);
  assert.ok(chosen.howTo.indexOf(alt.value) >= 0, 'the how-to names the chosen form');

  // An unknown choice must not swap anything.
  assert.equal(engine.proposalOf(finding, 'not-a-form').proposed, finding.proposed);
});

test('the exports honour the chosen alternative', () => {
  const { report } = analyseRows(titleVariantFixture());
  const finding = findingsOf(report, 'title_variants')[0];
  const alt = finding.alternatives[0];
  const decisions = { [finding.id]: 'accept' };
  const choices = { [finding.id]: alt.value };

  const row = engine
    .toCSV(report, { decisions, choices })
    .split('\n')
    .find((line) => line.indexOf('title_variants') === 0);
  const cols = row.split(';');
  assert.equal(cols[6], String(alt.impact), 'impact_scrobbles reflects the choice');
  assert.equal(cols[7], alt.current);
  assert.equal(cols[8], alt.value);

  const worklist = engine.toWorklist(report, decisions, choices);
  assert.ok(worklist.indexOf('`' + alt.current + '` → `' + alt.value + '`') >= 0);
  assert.ok(worklist.indexOf('· ' + alt.impact + ' scrobble(s)') >= 0);
});

test('a duplicate-artist alternative swaps the target the other way', () => {
  const { report } = analyseRows(recencyFixture());
  const finding = findingsOf(report, 'duplicate_artists')[0];
  assert.equal(finding.proposed, 'Jana Burčeska');
  const alt = finding.alternatives[0];
  assert.equal(alt.value, 'Jana Burceska');
  assert.equal(alt.proposed, 'Jana Burceska');
  assert.equal(alt.current, 'Jana Burčeska');
  assert.equal(alt.impact, 2);
  assert.match(alt.title, /Jana Burčeska/);
  assert.equal(engine.proposalOf(finding, alt.value).proposed, 'Jana Burceska');
});

test('proposalOf leaves a finding with no choice exactly as it was', () => {
  const { report } = analyseRows([
    ['Alpha', 'X', 'Song', BASE + 0],
    ['Alpha', 'X', 'Song (Official Video)', BASE + 100],
    ['Alpha', 'X', 'Song (Official Video)', BASE + 200]
  ]);
  const finding = findingsOf(report, 'title_variants').find((f) => f.subtype === 'platform_badge');
  const view = engine.proposalOf(finding, null);
  assert.equal(view.title, finding.title);
  assert.equal(view.current, finding.current);
  assert.equal(view.proposed, finding.proposed);
  assert.equal(view.impact, finding.impact);
  assert.equal(view.howTo, finding.howTo);
});
