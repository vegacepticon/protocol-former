// src/protocol/protocol-file-resolver.ts
// Vault protocol file resolution helpers for .rp.json documents.

import { TFile, TFolder, type Vault } from 'obsidian';

/**
 * Normalize a vault-relative protocol folder path.
 *
 * Handles leading/trailing slashes and Windows backslashes before looking up the
 * folder in Obsidian's vault index.
 */
export function normalizeProtocolFolderPath(folderPath: string): string {
  return folderPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function resolveProtocolFilesBySuffix(
  vault: Vault,
  folderPath: string,
  suffix: string,
  debugLabel: string,
): TFile[] {
  const normalized = normalizeProtocolFolderPath(folderPath);
  if (normalized === '') {
    console.debug(`[Protocol Former][${debugLabel}] folderPath normalized to empty — skipping resolution.`);
    return [];
  }

  const folder = vault.getAbstractFileByPath(normalized);
  const out: TFile[] = [];

  if (folder instanceof TFolder) {
    const walk = (f: TFolder): void => {
      for (const child of f.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.path.endsWith(suffix)) out.push(child);
      }
    };
    walk(folder);
    console.debug(
      `[Protocol Former][${debugLabel}] Resolved '${folderPath}' → '${normalized}' via TFolder walk; ${out.length} file(s).`,
    );
    return out;
  }

  const prefix = normalized + '/';
  for (const f of vault.getFiles()) {
    if (!f.path.endsWith(suffix)) continue;
    if (f.path === normalized || f.path.startsWith(prefix)) out.push(f);
  }
  console.debug(
    `[Protocol Former][${debugLabel}] Resolved '${folderPath}' → '${normalized}' via getFiles() fallback; ${out.length} file(s). (getAbstractFileByPath returned ${folder === null ? 'null' : typeof folder})`,
  );
  return out;
}

export function resolveProtocolDocumentFiles(vault: Vault, folderPath: string): TFile[] {
  return resolveProtocolFilesBySuffix(vault, folderPath, '.rp.json', 'PROTOCOL-DOC');
}
