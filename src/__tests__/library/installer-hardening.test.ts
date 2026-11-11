// src/__tests__/library/installer-hardening.test.ts
// Stage A0 regression tests: the transaction/uninstall path must not trust
// shape-valid-but-forged vault metadata (journals / installed records).
//
// Threats covered (plan Этап A0, audits/Protocol Former-Library/2026-09-06):
// 1. Forged journal with paths OUTSIDE Library namespaces + missing marker —
//    recovery must NOT delete non-Library files and must not claim rollback.
// 2. Corrupted journal shape (no marker entry / empty strings / marker not
//    last / two markers) — stays skipped, never silently deleted.
// 3. Installed record whose protocolPath/snippetNamespace do not match the
//    namespace derived from its packageId/releaseVersion — uninstall must
//    fail explicitly with no deletions and a manual-recovery instruction.
// 4. Partial-failure uninstall — marker preserved, idempotent 'failed' so a
//    retry can complete.
// 5. Recovery report distinguishes confirmed successes from failed entries.
// 6. Orphan cleanup failure is not reported as cleaned.
// 7. Roots changed after install → old-namespace files are still legally
//    cleaned by the orphan scan (record paths vs current settings).

import { describe, it, expect, vi } from 'vitest';
import { LibraryInstaller, type LibraryInstallerSettings } from '../../library/library-installer';
import {
  TransactionJournalIO, transactionJournalPath, isTransactionJournal,
  TRANSACTIONS_SCHEMA, TRANSACTIONS_VERSION, type TransactionJournal,
} from '../../library/transaction-journal';
import { installedRecordPath } from '../../library/installed-record-store';
import {
  INSTALLED_RECORD_SCHEMA, INSTALLED_RECORD_VERSION,
} from '../../library/library-model';
import { packageNamespaceSegment, slugifyPackageId } from '../../library/library-paths';
import { WriteMutex } from '../../utils/write-mutex';

/** One-level directory listing derived from the in-memory files map (mirrors the
 *  real non-recursive adapter.list contract). */
function listPath(files: Record<string, string>, dirPath: string): { files: string[]; folders: string[] } {
  const prefix = dirPath === '' ? '' : dirPath + '/';
  const out: string[] = [];
  const folders = new Set<string>();
  for (const p of Object.keys(files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) out.push(p);
    else folders.add(prefix + rest.slice(0, slash));
  }
  return { files: out, folders: [...folders] };
}

/** In-memory vault with injectable write/remove failure gates. */
function makeHardenedVault(opts: { files?: Record<string, string>; failWriteFor?: (p: string) => boolean; failRemoveFor?: (p: string) => boolean } = {}) {
  // A0 retry semantics: the caller may keep mutating the SAME files map between
  // phases (blocked-then-unblocked remove) — alias it, never copy it.
  const files: Record<string, string> = opts.files ?? {};
  const failWriteFor = opts.failWriteFor ?? (() => false);
  const failRemoveFor = opts.failRemoveFor ?? (() => false);
  const vault = {
    adapter: {
      exists: vi.fn(async (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(p + '/'))),
      read: vi.fn(async (p: string) => { if (!(p in files)) throw new Error('ENOENT: ' + p); return files[p]; }),
      write: vi.fn(async (p: string, data: string) => {
        if (failWriteFor(p)) throw new Error('write blocked: ' + p);
        files[p] = data;
      }),
      list: vi.fn(async (p: string) => listPath(files, p)),
      remove: vi.fn(async (p: string) => {
        if (failRemoveFor(p)) throw new Error('remove blocked: ' + p);
        // Folder removal mirrors real adapter semantics: only succeeds when empty.
        const listing = listPath(files, p);
        if (listing.files.length > 0 || listing.folders.length > 0) throw new Error('folder not empty: ' + p);
        delete files[p];
      }),
    },
    createFolder: vi.fn(async (_p: string) => { /* no-op in-memory */ }),
  };
  return { vault, files };
}
const makeApp = (vault: ReturnType<typeof makeHardenedVault>['vault']) => ({ vault } as unknown);

const SETTINGS: LibraryInstallerSettings = { protocolFolderPath: 'Protocols', snippetFolderPath: 'Snippets' };

async function pathsFor(packageId: string, version: string) {
  const s = await packageNamespaceSegment(packageId);
  const v = slugifyPackageId(version);
  return {
    segment: s,
    versionSlug: v,
    protocol: `Protocols/library/${s}/${v}/${s}.rp.json`,
    snippet: (relPath: string) => `Snippets/library/${s}/${v}/${relPath}`,
    snippetNs: `Snippets/library/${s}/${v}`,
    marker: installedRecordPath(s, v),
    journal: transactionJournalPath(s, v),
  };
}

const pkg = 'chest-ct';
const ver = '1.0.0';

async function writeJournal(vault: ReturnType<typeof makeHardenedVault>['vault'], entries: TransactionJournal['entries'], packageId = pkg, releaseVersion = ver) {
  const journalIO = new TransactionJournalIO({ vault } as never);
  await journalIO.write({
    schema: TRANSACTIONS_SCHEMA, version: TRANSACTIONS_VERSION,
    packageId, releaseVersion, startedAt: '2026-01-01T00:00:00Z', entries,
  }, new WriteMutex());
}

describe('A0 — forged journal recovery', () => {
  it('does NOT delete non-Library paths from a shape-valid forged journal; reports failure, not rollback', async () => {
    const { vault, files } = makeHardenedVault();
    const p = await pathsFor(pkg, ver);
    // Forged journal: entries outside any Library namespace, marker entry missing.
    await writeJournal(vault, [
      { path: 'Scratch/unowned.rp.json', kind: 'owned' },
      { path: 'Scratch/unowned.md', kind: 'owned' },
    ]);
    files['Scratch/unowned.rp.json'] = '{"data":true}\n';
    files['Scratch/unowned.md'] = '# mine\n';

    const installer = new LibraryInstaller(makeApp(vault) as never, SETTINGS);
    const report = await installer.recoverInterrupted();

    expect(files['Scratch/unowned.rp.json']).toBeDefined();
    expect(files['Scratch/unowned.md']).toBeDefined();
    expect(report.rolledBack).toEqual([]);
    // The journal stays for inspection (quarantine), nothing silently deleted.
    expect(files[p.journal]).toBeDefined();
    // Failed entries are surfaced separately with a reason.
    expect(report.rollbackFailed).toEqual([
      { packageId: pkg, releaseVersion: ver, reason: expect.any(String) },
    ]);
  });
});

describe('A0 — corrupt journal shapes are skipped', () => {
  it.each([
    ['no marker entry', [{ path: 'Protocols/library/x/y.md', kind: 'owned' }]],
    ['two marker entries', [
      { path: 'Protocols/library/x/m1.json', kind: 'marker' }, { path: 'Protocols/library/x/m2.json', kind: 'marker' },
    ]],
    ['marker not last', [
      { path: 'Protocols/library/x/m.json', kind: 'marker' }, { path: 'Protocols/library/x/f.md', kind: 'owned' },
    ]],
  ])('%s → journal skipped, not deleted, no paths removed', async (_name, entries) => {
    const { vault, files } = makeHardenedVault();
    await writeJournal(vault, entries as TransactionJournal['entries']);
    files['Protocols/library/x/f.md'] = 'x\n';
    const jPath = transactionJournalPath(await packageNamespaceSegment(pkg), slugifyPackageId(ver));

    const installer = new LibraryInstaller(makeApp(vault) as never, SETTINGS);
    const report = await installer.recoverInterrupted();

    expect(files[jPath]).toBeDefined(); // never silently deleted
    expect(files['Protocols/library/x/f.md']).toBeDefined();
    expect(report.rolledBack).toEqual([]);
  });

  it('guard rejects empty strings and duplicate/misordered markers', () => {
    const base = { schema: TRANSACTIONS_SCHEMA, version: TRANSACTIONS_VERSION, startedAt: '2026-01-01T00:00:00Z' };
    expect(isTransactionJournal({ ...base, packageId: '', releaseVersion: '1.0.0', entries: [{ path: 'a', kind: 'marker' }] })).toBe(false);
    expect(isTransactionJournal({ ...base, packageId: 'p', releaseVersion: '', entries: [{ path: 'a', kind: 'marker' }] })).toBe(false);
    expect(isTransactionJournal({ ...base, packageId: 'p', releaseVersion: '1.0.0', entries: [{ path: '', kind: 'marker' }] })).toBe(false);
    expect(isTransactionJournal({ ...base, packageId: 'p', releaseVersion: '1.0.0', entries: [] })).toBe(false);
    expect(isTransactionJournal({
      ...base, packageId: 'p', releaseVersion: '1.0.0',
      entries: [{ path: 'a', kind: 'owned' }, { path: 'b', kind: 'marker' }, { path: 'c', kind: 'marker' }],
    })).toBe(false);
    expect(isTransactionJournal({
      ...base, packageId: 'p', releaseVersion: '1.0.0',
      entries: [{ path: 'b', kind: 'marker' }, { path: 'a', kind: 'owned' }],
    })).toBe(false);
    expect(isTransactionJournal({
      ...base, packageId: 'p', releaseVersion: '1.0.0',
      entries: [{ path: 'a', kind: 'owned' }, { path: 'b', kind: 'marker' }],
    })).toBe(true);
  });
});

describe('A0 — forged installed record on uninstall', () => {
  it('record paths outside the derived namespace → failed, no deletions, manual-recovery hint', async () => {
    const { vault, files } = makeHardenedVault();
    const p = await pathsFor(pkg, ver);
    const record = {
      schema: INSTALLED_RECORD_SCHEMA, version: INSTALLED_RECORD_VERSION,
      packageId: pkg, releaseVersion: ver, installedAt: '2026-01-01T00:00:00Z',
      protocolPath: 'Protocols/Untrusted/forged.rp.json',
      snippetNamespace: 'Snippets/Untrusted',
      snippetFiles: [{ relPath: 'lung.md', sha256: 'a'.repeat(64) }],
      protocolSha256: 'a'.repeat(64),
    };
    files[p.marker] = JSON.stringify(record, null, 2) + '\n';
    files['Protocols/Untrusted/forged.rp.json'] = '{"x":1}\n';
    files['Snippets/Untrusted/lung.md'] = '# other package content?\n';

    const installer = new LibraryInstaller(makeApp(vault) as never, SETTINGS);
    const result = await installer.uninstall(pkg, ver);

    expect(result.status).toBe('failed');
    expect((result as { reason: string }).reason).toMatch(/manually/i);
    expect(files['Protocols/Untrusted/forged.rp.json']).toBeDefined();
    expect(files['Snippets/Untrusted/lung.md']).toBeDefined();
    expect(files[p.marker]).toBeDefined();
  });
});

describe('A0 — partial-failure uninstall is idempotent', () => {
  it('blocked remove → failed with marker kept; retry succeeds', async () => {
    const { files } = makeHardenedVault();
    const p = await pathsFor(pkg, ver);
    // A committed install: marker + snippet + protocol present.
    const record = {
      schema: INSTALLED_RECORD_SCHEMA, version: INSTALLED_RECORD_VERSION,
      packageId: pkg, releaseVersion: ver, installedAt: '2026-01-01T00:00:00Z',
      protocolPath: p.protocol, snippetNamespace: p.snippetNs,
      snippetFiles: [{ relPath: 'lung.md', sha256: 'a'.repeat(64) }],
      protocolSha256: 'a'.repeat(64),
    };
    files[p.marker] = JSON.stringify(record, null, 2) + '\n';
    files[p.snippet('lung.md')] = '# Lung content\n';
    files[p.protocol] = '{}\n';

    let blocked = true;
    const gated = makeHardenedVault({ files, failRemoveFor: () => blocked });
    const installer = new LibraryInstaller(makeApp(gated.vault) as never, SETTINGS);

    const first = await installer.uninstall(pkg, ver);
    expect(first.status).toBe('failed');
    expect(files[p.marker]).toBeDefined(); // marker kept for retry
    expect(files[p.snippet('lung.md')]).toBeDefined();

    blocked = false;
    const second = await installer.uninstall(pkg, ver);
    expect(second.status).toBe('ok');
    expect(files[p.marker]).toBeUndefined();
    expect(files[p.snippet('lung.md')]).toBeUndefined();
    expect(files[p.protocol]).toBeUndefined();
  });
});

describe('A0 — orphan cleanup failure reporting', () => {
  it('cleanOrphanedNamespace failure is not reported as cleaned', async () => {
    const { files } = makeHardenedVault();
    const orphan = 'Protocols/library/orphan-pkg/1-0-0';
    files[`${orphan}/orphan.rp.json`] = '{}\n';
    const gated = makeHardenedVault({ files, failRemoveFor: () => true });
    const installer = new LibraryInstaller(makeApp(gated.vault) as never, SETTINGS);
    const report = await installer.recoverInterrupted();
    expect(report.orphansCleaned).toEqual([]);
    expect(report.orphanCleanupFailed).toEqual([{ namespace: orphan, reason: expect.any(String) }]);
    expect(files[`${orphan}/orphan.rp.json`]).toBeDefined();
  });
});

describe('A0 — roots changed after install', () => {
  it('journal written under OLD roots + roots changed → rollback quarantined, no deletions; old-ns leftovers untouched', async () => {
    const { vault, files } = makeHardenedVault();
    const s = await packageNamespaceSegment(pkg);
    const v = slugifyPackageId(ver);
    // An interrupted install journaled paths under the OLD root; the user then
    // changed the configured roots. Expected namespaces derive from CURRENT
    // settings, so the journal's old-root paths no longer match → quarantine
    // (no deletions from a namespace we cannot re-derive as owned).
    const oldNs = `OldProtocols/library/${s}/${v}`;
    await writeJournal(vault, [
      { path: `${oldNs}/${s}.rp.json`, kind: 'owned' },
      { path: `${oldNs}/lung.md`, kind: 'owned' },
      { path: installedRecordPath(s, v), kind: 'marker' },
    ]);
    files[`${oldNs}/${s}.rp.json`] = '{}\n';
    files[`${oldNs}/lung.md`] = '# lung (stale)\n';

    const changedSettings: LibraryInstallerSettings = {
      protocolFolderPath: 'Protocols', snippetFolderPath: 'Snippets',
    };
    const installer = new LibraryInstaller(makeApp(vault) as never, changedSettings);
    const report = await installer.recoverInterrupted();

    // Quarantined — surfaced as failed, nothing silently deleted.
    expect(report.rolledBack).toEqual([]);
    expect(report.rollbackFailed).toEqual([
      { packageId: pkg, releaseVersion: ver, reason: expect.any(String) },
    ]);
    expect(files[`${oldNs}/lung.md`]).toBeDefined();
    expect(files[`${oldNs}/${s}.rp.json`]).toBeDefined();
    // The journal itself is preserved for manual inspection.
    expect(files[transactionJournalPath(s, v)]).toBeDefined();
  });
});
