// Flags runtime code the oldest supported TV engine cannot run.
// Tizen 6.5 (2022 TVs) ships Chromium M85: https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html
// CSS is checked against MDN browser-compat-data; JavaScript must parse as ES5.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as acorn from 'acorn';
import postcss from 'postcss';

const require = createRequire(import.meta.url);
const bcd = require('@mdn/browser-compat-data');
const CHROME = 85;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const app = path.join(root, 'app');

// Unsupported features that are deliberate, each with the reason it is harmless on M85.
const ALLOWED = {
  'selector :focus-visible': 'Only adds a keyboard outline in its own rule; M85 drops that rule and remote focus uses .is-focus.',
  'property font-synthesis': 'A guard against faux bold/italic; the bundled variable fonts already cover the weights used.',
  'font-synthesis: none': 'Same declaration as above.',
  '@font-face size-adjust': 'Metric fine-tuning; M85 ignores it and uses the font’s own metrics, so text sits marginally differently.',
  '@font-face ascent-override': 'As size-adjust.',
  '@font-face descent-override': 'As size-adjust.',
  '@font-face line-gap-override': 'As size-adjust.'
};
// Non-standard properties MDN does not track; engines that do not know them ignore the declaration.
const NONSTANDARD = new Set(['-webkit-font-smoothing']);

const problems = [], allowedSeen = new Set();
function files(dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full, ext) : e.name.endsWith(ext) ? [full] : [];
  });
}
function rel(file) { return path.relative(root, file).replace(/\\/g, '/'); }

// Whether some unflagged Chrome entry covers the target. Partial implementations count (e.g. outline before
// it followed border-radius); prefixed entries count only when the source uses that prefix.
function chromeSupport(feature, prefix) {
  const s = feature && feature.__compat && feature.__compat.support && feature.__compat.support.chrome;
  let earliest = null;
  for (const entry of [].concat(s || [])) {
    if (entry.flags || entry.alternative_name || (entry.prefix || '') !== (prefix || '')) continue;
    const added = entry.version_added === true ? 1 : typeof entry.version_added === 'string' ? parseFloat(entry.version_added.replace('≤', '')) || 1 : null;
    const removed = typeof entry.version_removed === 'string' ? parseFloat(entry.version_removed) : null;
    if (added === null) continue;
    if (added <= CHROME && (removed === null || removed > CHROME)) return { ok: true };
    if (removed === null && (earliest === null || added < earliest)) earliest = added;
  }
  return { ok: false, since: earliest };
}
function require85(label, feature, where, prefix) {
  if (!feature || !feature.__compat) return;
  const support = chromeSupport(feature, prefix);
  if (support.ok) return;
  if (ALLOWED[label]) { allowedSeen.add(label); return; }
  problems.push(where + ': ' + label + ' needs Chrome ' + (support.since === null ? '(unsupported)' : support.since) + ', TV has ' + CHROME);
}
const prefixOf = name => (name.match(/^-(webkit|moz|ms|o)-/) || [''])[0];
const unprefix = name => name.slice(prefixOf(name).length);

const css = bcd.css;
const FUNCTION_HOMES = [css.types, css.types.color, css.types.image, css.types.image && css.types.image.gradient, css.types['transform-function'], css.types['filter-function']].filter(Boolean);
function checkValue(prop, value, where) {
  const known = css.properties[prop] || {};
  for (const m of value.matchAll(/([a-z-]+)\(/gi)) {
    const fn = m[1].toLowerCase();
    if (fn === 'var' || fn === 'url') continue;
    const home = FUNCTION_HOMES.find(h => h[fn] && h[fn].__compat);
    if (home) require85('function ' + fn + '()', home[fn], where);
  }
  for (const word of value.replace(/"[^"]*"|'[^']*'|url\([^)]*\)/g, ' ').match(/[a-z][a-z-]*/gi) || []) {
    const sub = known[word.toLowerCase()];
    if (sub && sub.__compat) require85(prop + ': ' + word, sub, where);
  }
}
function checkSelector(selector, where) {
  for (const m of selector.matchAll(/::?([a-z-]+)/gi)) {
    const name = m[1].toLowerCase(), feature = css.selectors[name];
    if (feature) require85('selector ' + (m[0].startsWith('::') ? '::' : ':') + name, feature, where);
  }
}
for (const file of files(app, '.css')) {
  postcss.parse(readFileSync(file, 'utf8'), { from: file }).walk(node => {
    const where = rel(file) + ':' + (node.source && node.source.start ? node.source.start.line : '?');
    if (node.type === 'decl') {
      const name = node.prop.toLowerCase(), prop = unprefix(name), inFontFace = node.parent && node.parent.type === 'atrule' && node.parent.name === 'font-face';
      if (name.startsWith('--') || NONSTANDARD.has(name)) return;
      if (inFontFace) { require85('@font-face ' + name, css['at-rules']['font-face'][name], where); return; }
      if (!css.properties[prop]) problems.push(where + ': unknown property ' + node.prop);
      // An unprefixed declaration is covered when the same rule also carries a prefixed form the TV supports.
      else if (!prefixOf(name) && node.parent.nodes.some(n => n.type === 'decl' && prefixOf(n.prop) && unprefix(n.prop.toLowerCase()) === prop && chromeSupport(css.properties[prop], prefixOf(n.prop)).ok)) return;
      else require85('property ' + prop, css.properties[prop], where, prefixOf(name));
      checkValue(prop, node.value, where);
    } else if (node.type === 'rule') checkSelector(node.selector, where);
    else if (node.type === 'atrule') {
      const rule = css['at-rules'][unprefix(node.name.toLowerCase())];
      require85('@' + node.name, rule, where);
      if (node.name === 'media' && rule) for (const m of node.params.matchAll(/\(\s*([a-z-]+)/gi)) {
        const feature = rule[m[1].toLowerCase().replace(/^(min|max)-/, '')];
        if (feature) require85('@media ' + m[1], feature, where);
      }
    }
  });
}

// Runtime JavaScript: every file the widget loads must parse as ES5.
for (const file of files(app, '.js')) {
  try { acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 5, sourceType: 'script' }); }
  catch (e) { problems.push(rel(file) + ':' + (e.loc ? e.loc.line + ':' + e.loc.column : '?') + ': not ES5 (' + e.message + ')'); }
}

for (const label of Object.keys(ALLOWED)) if (!allowedSeen.has(label)) problems.push('Stale allowance, no longer used: ' + label);
if (problems.length) { console.error(problems.join('\n') + '\n' + problems.length + ' compatibility problem(s) for Chrome ' + CHROME + '.'); process.exit(1); }
console.log('App CSS and JavaScript are compatible with Chrome ' + CHROME + ' (Tizen 6.5) and ES5.');
