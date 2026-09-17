/**
 * cli.js — produces the cleanup report from a CSV of scrobbles.
 *
 *   node src/cli.js [path.csv] [output-prefix]
 *
 * Writes three files to the project root:
 *   <prefix>.html   the report, self-contained and browsable
 *   <prefix>.csv    the action list (one row per finding, `decision` column left blank)
 *   <prefix>.md     the same report in Markdown
 * and also index.html, the empty tool that GitHub Pages serves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');
const { checkDocs } = require('./check-docs.js');
const { build, write } = require('./build.js');

const ROOT = path.join(__dirname, '..');
const input = process.argv[2] || path.join(ROOT, 'lastfmstats-MarcosMarinM.csv');
const prefix = process.argv[3] || 'lastfm-report';

if (!fs.existsSync(input)) {
  console.error('Cannot find the file: ' + input);
  process.exit(1);
}

// Fail fast: a report that documents a case the README does not know about is a
// report nobody can review.
const docProblems = checkDocs();
if (docProblems.length) {
  console.error('The documentation is out of step with the engine:');
  docProblems.forEach((problem) => console.error('  - ' + problem));
  console.error('  (run node src/check-docs.js to see it on its own)');
  process.exit(1);
}

console.log('Reading ' + path.basename(input) + '…');
const text = fs.readFileSync(input, 'utf8');
const t0 = Date.now();
const parsed = engine.readCSV(text, path.basename(input));
console.log('  ' + engine.util.num(parsed.scrobbles.length) + ' scrobbles parsed in ' + (Date.now() - t0) + ' ms');
parsed.warnings.forEach((w) => console.log('  warning: ' + w));

const t1 = Date.now();
const report = engine.analyse(parsed.scrobbles, { warnings: parsed.warnings, source: path.basename(input) });
console.log('  analysis took ' + (Date.now() - t1) + ' ms');

const m = report.meta;
console.log('');
console.log('Summary');
console.log('  scrobbles            ' + engine.util.num(m.scrobbles) + '  (' + engine.util.shortDate(m.from) + ' → ' + engine.util.shortDate(m.to) + ')');
console.log('  artists / tracks     ' + engine.util.num(m.artists) + ' / ' + engine.util.num(m.tracks));
console.log('  scrobbles affected   ' + engine.util.num(report.summary.affectedScrobbles) + ' (' + Math.round((100 * report.summary.affectedScrobbles) / m.scrobbles) + '%)');
console.log('  findings             ' + engine.util.num(report.summary.findings) + '  (' + engine.util.num(report.summary.actions) + ' with an action, ' + engine.util.num(report.summary.highConfidenceActions) + ' high confidence)');
console.log('');
report.summary.byType.forEach((t) => {
  console.log(
    '  ' + (t.label + ' ').padEnd(30, '.') + ' ' + String(t.findings).padStart(5) +
    '  actions ' + String(t.actionable).padStart(4) +
    '  high ' + String(t.high).padStart(4) +
    '  affected ' + String(t.impact).padStart(6)
  );
});
console.log('');

write(prefix + '.md', engine.toMarkdown(report));
write(prefix + '.csv', engine.toCSV(report));
write(prefix + '.html', build({ report: report }));
write('index.html', build({}));

console.log('Written:');
['.html', '.csv', '.md'].forEach((ext) => {
  const file = path.join(ROOT, prefix + ext);
  console.log('  ' + file + '  (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
});
console.log('  ' + path.join(ROOT, 'index.html') + '  (the empty tool, for sharing)');
