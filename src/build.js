/**
 * build.js — packs the engine into the HTML template to produce a single,
 * self-contained file with no dependencies and no network requests.
 *
 *   node src/build.js                    → index.html (empty tool: the GitHub Pages entry)
 *   require('./build.js').build({...})   → a report with the analysis already loaded
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const ROOT = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/** Stops a stray '</script' inside the inlined code from closing the tag. */
function neutralise(text) {
  return String(text).replace(/<\/script/gi, '<\\/script');
}

/**
 * @param {{report?: object}} options
 * @returns {string} full HTML document
 */
function build(options) {
  options = options || {};
  const engine = read('engine.js');
  const template = read('template.html');
  const data = options.report ? 'window.__REPORT__ = ' + JSON.stringify(options.report) + ';' : '';
  const engineMarker = '/*__ENGINE__*/';
  const dataMarker = '/*__DATA__*/';
  if (template.indexOf(engineMarker) < 0 || template.indexOf(dataMarker) < 0) {
    throw new Error('The template is missing the expected markers (' + engineMarker + ' / ' + dataMarker + ').');
  }
  return template
    .replace(engineMarker, () => neutralise(engine))
    .replace(dataMarker, () => neutralise(data));
}

/** Writes to the project root, not to src/. */
function write(name, contents) {
  const target = path.join(ROOT, name);
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

module.exports = { build, write };

if (require.main === module) {
  const { checkDocs } = require('./check-docs.js');
  const problems = checkDocs();
  if (problems.length) {
    console.error('The documentation is out of step with the engine:');
    problems.forEach((problem) => console.error('  - ' + problem));
    process.exit(1);
  }
  const html = build({});
  const target = write('index.html', html);
  console.log('Wrote ' + target + ' (' + Math.round(html.length / 1024) + ' KB)');
  console.log('Open it in a browser and drop a CSV in: the analysis runs on your own machine.');
}
