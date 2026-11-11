#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

const errors = [];
const warnings = [];

function fail(message) { errors.push(`❌ ${message}`); }
function warn(message) { warnings.push(`⚠️  ${message}`); }
function info(message) { console.log(`  ${message}`); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function readText(path) { return readFileSync(path, 'utf8'); }
function git(args) { return execFileSync('git', args, { encoding: 'utf8' }).trim(); }
function trackedFiles(pathspec) { return git(['ls-files', pathspec]).split('\n').filter(Boolean); }

console.log('\n▸ Check 1: version surfaces');
const pkg = readJson('package.json');
const manifest = readJson('manifest.json');
const lock = readJson('package-lock.json');
const versions = readJson('versions.json');

if (pkg.version !== manifest.version) fail(`package.json version "${pkg.version}" !== manifest.json version "${manifest.version}"`);
else info(`OK: package.json "${pkg.version}" ↔ manifest.json "${manifest.version}"`);

if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) fail(`package-lock.json root versions must both equal package.json version "${pkg.version}"`);
else info(`OK: package-lock.json mirrors package version "${pkg.version}"`);

if (versions[manifest.version] !== manifest.minAppVersion) fail(`versions.json["${manifest.version}"] must equal manifest minAppVersion "${manifest.minAppVersion}"`);
else info(`OK: versions.json maps ${manifest.version} → ${manifest.minAppVersion}`);

console.log('\n▸ Check 2: README split and release text');
if (!existsSync('README.md')) fail('README.md is missing');
if (!existsSync('README.ru.md')) fail('README.ru.md is missing');

const readme = existsSync('README.md') ? readText('README.md') : '';
const readmeRu = existsSync('README.ru.md') ? readText('README.ru.md') : '';
const latestReleaseRe = /Latest release|Последний релиз/;
const docsLinkRe = /\bdocs\//;

if (!readme.includes('[Русская версия](README.ru.md)')) fail('README.md must link to README.ru.md with [Русская версия](README.ru.md)');
if (!readmeRu.includes('[English version](README.md)')) fail('README.ru.md must link back to README.md with [English version](README.md)');
if (latestReleaseRe.test(readme) || latestReleaseRe.test(readmeRu)) fail('README files must not hardcode latest-release text; link to GitHub Releases instead');
if (docsLinkRe.test(readme) || docsLinkRe.test(readmeRu)) fail('README files must not link missing docs/ paths');
for (const asset of ['main.js', 'styles.css', 'manifest.json']) {
  if (!readme.includes(asset) || !readmeRu.includes(asset)) fail(`Both README files must mention release asset ${asset}`);
}
if (errors.length === 0) info('OK: README split invariants hold');

console.log('\n▸ Check 3: stale .planning/ references in tracked files');
let planningRefs = [];
try { planningRefs = git(['grep', '--name-only', '\\.planning/', '--', ':(exclude).planning/*']).split('\n').filter(Boolean); }
catch { planningRefs = []; }
const planningPolicyFiles = new Set(['.gitignore', 'eslint.config.mjs', 'scripts/check-planning-freshness.mjs', 'scripts/check-consistency.mjs']);
const stalePlanningRefs = planningRefs.filter((file) => !planningPolicyFiles.has(file) && !file.startsWith('.rpiv/artifacts/'));
if (stalePlanningRefs.length > 0) fail(`${stalePlanningRefs.length} tracked file(s) have stale .planning/ references:\n${stalePlanningRefs.map((file) => `    ${file}`).join('\n')}`);
else info(`OK: no stale tracked .planning/ references (${planningRefs.length} total reference file(s))`);

console.log('\n▸ Check 4: phantom source references');
const phantomPatterns = ['runner-view.ts', 'session-recovery-coordinator.ts', 'SessionService', 'sessionFolderPath'];
const srcFiles = trackedFiles('src/**/*.ts');
let phantomFound = 0;
for (const pattern of phantomPatterns) {
  const matches = [];
  for (const file of srcFiles) {
    if (readText(file).includes(pattern)) matches.push(file);
  }
  const nonTestMatches = matches.filter((file) => !file.includes('__tests__'));
  if (nonTestMatches.length > 0) {
    warn(`Phantom ref "${pattern}" found in: ${nonTestMatches.join(', ')}`);
    phantomFound++;
  }
}
if (phantomFound === 0) info('OK: no phantom references in source');

console.log('\n▸ Check 5: stale phase anchors in TODO/FIXME');
const phasePattern = /TODO\s+(Phase\s+\d+|Plan\s+\d+)|FIXME\s+(Phase\s+\d+|Plan\s+\d+)/;
const todoHits = [];
for (const file of srcFiles) {
  readText(file).split('\n').forEach((line, index) => {
    if (phasePattern.test(line)) todoHits.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}
if (todoHits.length > 0) warn(`Found ${todoHits.length} stale phase-anchored TODO/FIXME:\n${todoHits.map((hit) => `    ${hit}`).join('\n')}`);
else info('OK: no stale phase references in TODO/FIXME');

console.log('\n▸ Check 6: unused exports advisory');
try {
  const knip = execSync('npx knip --reporter compact 2>&1', { encoding: 'utf8', timeout: 60000 });
  if (/Unused (exports|files|dependencies)/i.test(knip)) warn(`Knip reported possible unused code:\n${knip.trim()}`);
  else info('OK: knip reports no unused exports/files/dependencies');
} catch (error) {
  warn(`Knip advisory skipped or reported issues: ${error.message}`);
}

console.log('\n▸ Check 7: en/ru i18n key parity');
const enLocale = readJson('src/i18n/locales/en.json');
const ruLocale = readJson('src/i18n/locales/ru.json');
function flatKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix === '' ? k : `${prefix}.${k}`;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) keys.push(...flatKeys(v, path));
    else keys.push(path);
  }
  return keys;
}
const enKeys = new Set(flatKeys(enLocale));
const ruKeys = new Set(flatKeys(ruLocale));
const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k));
const missingInEn = [...ruKeys].filter((k) => !enKeys.has(k));
if (missingInRu.length > 0) fail(`en.json keys missing from ru.json: ${missingInRu.join(', ')}`);
if (missingInEn.length > 0) fail(`ru.json keys missing from en.json: ${missingInEn.join(', ')}`);
if (missingInRu.length === 0 && missingInEn.length === 0) info(`OK: en/ru i18n key sets match (${enKeys.size} keys)`);

console.log('\n▸ Check 8: documented commands');
const mainSource = readText('src/main.ts');
const addCommandCount = (mainSource.match(/this\.addCommand\(\{/g) ?? []).length;
const commandMatches = [...mainSource.matchAll(/id:\s*'([^']+)',\s*\n\s*name:\s*'([^']+)'/g)];
const commandNames = commandMatches.map((match) => match[2]);
if (commandNames.length === 0) {
  fail('Could not extract addCommand names from src/main.ts');
} else if (commandNames.length !== addCommandCount) {
  fail(`Extracted ${commandNames.length} command name(s) for ${addCommandCount} addCommand call(s); update the extractor or the command formatting`);
} else {
  for (const name of commandNames) {
    if (!readme.includes(name)) fail(`README.md does not mention command "${name}"`);
    if (!readmeRu.includes(name)) fail(`README.ru.md does not mention command "${name}"`);
  }
  info(`OK: ${commandNames.length} commands are mentioned in both README files`);
}

const staleDocPhrases = ['Run protocol in inline', 'does not ship with a registry endpoint'];
for (const phrase of staleDocPhrases) {
  if (readme.includes(phrase)) fail(`README.md contains stale phrase: "${phrase}"`);
  if (readmeRu.includes(phrase)) fail(`README.ru.md contains stale phrase: "${phrase}"`);
}

console.log('\n═══════════════════════════════════════════════');
if (errors.length > 0) {
  console.log(`❌ FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
  errors.forEach((error) => console.log(`  ${error}`));
  warnings.forEach((warning) => console.log(`  ${warning}`));
  process.exit(1);
}
if (warnings.length > 0) {
  console.log(`⚠️  PASSED with ${warnings.length} warning(s)`);
  warnings.forEach((warning) => console.log(`  ${warning}`));
  process.exit(0);
}
console.log('✅ All checks passed');