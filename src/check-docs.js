/**
 * check-docs.js — fails when a case the engine can produce is not documented.
 *
 *   node src/check-docs.js
 *
 * The README and the “How it works” panel inside the report are the contract with
 * whoever reads the report. This script keeps all three in step:
 *
 *   1. every section of TYPE_LABELS is documented in the README and in the panel;
 *   2. every sub-case a detector emits has a label in SUBTYPE_LABELS, and that
 *      label appears in the README (the panel is prose, so it is not checked
 *      word for word);
 *   3. every action a detector emits exists in ACTIONS, and every ACTIONS entry is
 *      emitted by something (no dead action);
 *   4. TYPE_ORDER lists exactly the sections of TYPE_LABELS.
 *
 * `src/cli.js` and `src/build.js` run it before writing anything, so a new
 * detector cannot ship undocumented by accident.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./engine.js');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Case- and accent-insensitive, punctuation-free, so prose can be matched. */
function normalise(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * @returns {string[]} one message per problem; empty means the docs are in step
 */
function checkDocs() {
  const problems = [];
  const source = read('src/engine.js');
  const documents = {
    'README.md': normalise(read('README.md')),
    'src/template.html': normalise(read('src/template.html'))
  };

  // 1. every section is documented in both places
  Object.keys(engine.TYPE_LABELS).forEach((type) => {
    const label = normalise(engine.TYPE_LABELS[type]);
    Object.keys(documents).forEach((file) => {
      if (documents[file].indexOf(label) < 0) {
        problems.push(
          'the section “' + engine.TYPE_LABELS[type] + '” (' + type + ') is not documented in ' + file
        );
      }
    });
  });

  // 2. every sub-case the code emits has a label, and the README lists it
  const labelled = new Set();
  Object.keys(engine.SUBTYPE_LABELS).forEach((type) => {
    if (!engine.TYPE_LABELS[type]) {
      problems.push('SUBTYPE_LABELS has an entry for the unknown section ' + type);
    }
    Object.keys(engine.SUBTYPE_LABELS[type]).forEach((subtype) => {
      labelled.add(subtype);
      const label = normalise(engine.SUBTYPE_LABELS[type][subtype]);
      if (label && documents['README.md'].indexOf(label) < 0) {
        problems.push('the sub-case label “' + engine.SUBTYPE_LABELS[type][subtype] + '” is not listed in README.md');
      }
    });
  });
  const emittedSubtypes = new Set();
  collect(source, /subtype\s*[:=]\s*'([a-z_]+)'/g, emittedSubtypes);
  emittedSubtypes.forEach((subtype) => {
    if (!labelled.has(subtype)) {
      problems.push('the sub-case “' + subtype + '” has no label in SUBTYPE_LABELS');
    }
  });

  // 3. actions both ways: defined and used
  const emittedActions = new Set();
  collect(source, /action\s*[:=]\s*'([a-z_]+)'/g, emittedActions);
  emittedActions.forEach((action) => {
    if (!engine.ACTIONS[action]) {
      problems.push('the action “' + action + '” is emitted but not defined in ACTIONS');
    }
  });
  Object.keys(engine.ACTIONS).forEach((action) => {
    if (!emittedActions.has(action)) {
      problems.push('ACTIONS defines “' + action + '” but no detector emits it');
    }
  });

  // 4. the reading order covers exactly the sections
  const declared = Object.keys(engine.TYPE_LABELS).sort().join('|');
  const ordered = engine.TYPE_ORDER.slice().sort().join('|');
  if (declared !== ordered) {
    problems.push('TYPE_ORDER and TYPE_LABELS list different sections');
  }

  return problems;
}

function collect(source, pattern, into) {
  let match;
  while ((match = pattern.exec(source)) !== null) into.add(match[1]);
}

module.exports = { checkDocs, normalise };

if (require.main === module) {
  const problems = checkDocs();
  if (problems.length) {
    console.error('The documentation is out of step with the engine:');
    problems.forEach((p) => console.error('  - ' + p));
    console.error('');
    console.error('Fix ' + (problems.length === 1 ? 'it' : 'them') + ' in README.md and src/template.html.');
    process.exit(1);
  }
  console.log('Documentation check passed: every section, sub-case and action is documented.');
}
