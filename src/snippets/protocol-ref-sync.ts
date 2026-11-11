// snippets/protocol-ref-sync.ts
// Vault-wide utility: rewrite snippetPath / subfolderPath references in every
// .rp.json protocol file when a snippet file or folder is moved.

import type { App, TFile } from 'obsidian';
import { isProtocolDocumentV1, type ProtocolDocumentV1 } from '../protocol/protocol-document';
import { withProtocolFileLock } from '../protocol/protocol-file-lock';

export interface ProtocolSyncResult {
  updated: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Rewrite fields.snippetPath and fields.subfolderPath on snippet nodes across
 * every .rp.json file in the vault, given an old→new path mapping.
 *
 * Matching rules (same as canvas-ref-sync):
 *   - Exact match: path === oldKey → replace with newValue.
 *   - Prefix match with `/` boundary: path.startsWith(oldKey + '/')
 *     → replace prefix, keeping the trailing segment(s).
 *
 * Semantics:
 *   - Only nodes with kind === 'snippet' are considered.
 *   - Empty-string / null / missing snippetPath or subfolderPath → skipped.
 *   - Best-effort: a read/parse/write failure on one file is recorded in `skipped`
 *     and does not abort the loop. Never throws.
 *   - No-op early return: a file whose parsed JSON contains no matching snippet
 *     nodes is not written (avoids churn and mtime bumps).
 *
 * @param app Obsidian App
 * @param mapping old path → new path (paths are relative to settings.snippetFolderPath)
 */
export async function rewriteProtocolSnippetRefs(
  app: App,
  mapping: Map<string, string>,
): Promise<ProtocolSyncResult> {
  const updated: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  if (mapping.size === 0) return { updated, skipped };

  const protocolFiles: TFile[] = app.vault
    .getFiles()
    .filter((f) => f.path.endsWith('.rp.json'));

  for (const file of protocolFiles) {
    await withProtocolFileLock(app.vault, file.path, async () => {
      try {
        const raw = await app.vault.read(file);
        let parsed: ProtocolDocumentV1;
        try {
          parsed = JSON.parse(raw) as ProtocolDocumentV1;
        } catch (e) {
          const reason = `invalid JSON: ${(e as Error).message}`;
          console.error('[Protocol Former] protocol-ref-sync:', file.path, reason);
          skipped.push({ path: file.path, reason });
          return;
        }

        if (!isProtocolDocumentV1(parsed)) {
          skipped.push({ path: file.path, reason: 'invalid protocol document schema' });
          return;
        }

        let mutated = false;
        for (const node of parsed.nodes) {
          if (node.kind !== 'snippet') continue;

          const snippetPath = node.fields?.snippetPath;
          if (typeof snippetPath === 'string' && snippetPath !== '') {
            const rewritten = applyMapping(snippetPath, mapping);
            if (rewritten !== null && rewritten !== snippetPath) {
              node.fields.snippetPath = rewritten;
              mutated = true;
            }
          }

          const subfolderPath = node.fields?.subfolderPath;
          if (typeof subfolderPath === 'string' && subfolderPath !== '') {
            const rewritten = applyMapping(subfolderPath, mapping);
            if (rewritten !== null && rewritten !== subfolderPath) {
              node.fields.subfolderPath = rewritten;
              mutated = true;
            }
          }
        }

        if (!mutated) return;

        try {
          const next = JSON.stringify(parsed, null, 2) + '\n';
          await app.vault.modify(file, next);
          updated.push(file.path);
        } catch (e) {
          const reason = `write failed: ${(e as Error).message}`;
          console.error('[Protocol Former] protocol-ref-sync:', file.path, reason);
          skipped.push({ path: file.path, reason });
        }
      } catch (e) {
        const reason = `read failed: ${(e as Error).message}`;
        console.error('[Protocol Former] protocol-ref-sync:', file.path, reason);
        skipped.push({ path: file.path, reason });
      }
    });
  }

  return { updated, skipped };
}

/**
 * Apply old→new mapping to a single path.
 * Returns the rewritten path, or null if no mapping key matched.
 * Exact match wins over prefix match. Longest prefix wins on ties.
 */
function applyMapping(
  current: string,
  mapping: Map<string, string>,
): string | null {
  // Exact match
  const exact = mapping.get(current);
  if (exact !== undefined) return exact;

  // Prefix match with `/` boundary — pick the longest matching key
  let bestKey: string | null = null;
  for (const key of mapping.keys()) {
    if (current.startsWith(key + '/')) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  if (bestKey === null) return null;
  const newPrefix = mapping.get(bestKey)!;
  return newPrefix + current.slice(bestKey.length);
}
