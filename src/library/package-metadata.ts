// src/library/package-metadata.ts
// Pure helpers for the library export/submit flow: the fixed submission
// category taxonomy (checkbox list in the submit modal; ids are stable API
// values, labels are localized via i18n keys `library.category.<id>`), and
// automatic package metadata derivation (packageId from the protocol title,
// next release version from settings bookkeeping).
// Zero Obsidian imports — fully unit-testable.

import { slugifyLabel } from '../snippets/snippet-model';
import { sha256String } from './integrity';

/** Stable category ids sent to the registry (`meta.categories`). Order is the
 *  display order of the checkbox list. Extend here — the UI renders whatever
 *  this array contains. */
export const LIBRARY_SUBMISSION_CATEGORIES: readonly string[] = [
  'brain',
  'neck',
  'cervical-spine',
  'chest',
  'thoracic-spine',
  'abdomen-retroperitoneum',
  'pelvis',
  'lumbosacral-spine',
  'upper-extremities',
  'lower-extremities',
];

/**
 * Derive a packageId from a protocol title: slugified (Unicode-aware, Cyrillic
 * preserved), non-empty fallback for titles that slugify to nothing (e.g. pure
 * punctuation). The installer's validPackageSlug requires a non-empty slug.
 */
export function derivePackageId(protocolTitle: string): string {
  const slug = slugifyLabel(protocolTitle);
  return slug === '' ? 'protocol' : slug;
}

/** Parse "major.minor.patch"; returns null for anything else. */
export function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Next patch version after `previous`. Unparseable/absent previous → '1.0.0'
 * (fresh package). Never decrements.
 */
export function nextReleaseVersion(previous: string | undefined): string {
  const parsed = previous === undefined ? null : parseSemver(previous);
  if (parsed === null) return '1.0.0';
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/** Stable unique suffix for generated package ids: 8 hex chars from the SHA-256
 *  of the input (async — callers await it once at first-bind time). */
export async function stableIdSuffix(seed: string): Promise<string> {
  return (await sha256String(seed)).slice(0, 8);
}

/**
 * Binding key for the persistent submission identity (Stage D):
 * `<registryKey>|<protocolDoc.id>`. The registry key scopes bindings per
 * source (official vs custom registry); the document id is the stable local
 * identity — path and title are hints, never identity.
 */
export function submissionBindingKey(registryKey: string, documentId: string): string {
  return `${registryKey.trim().replace(/\/+$/, '')}|${documentId}`;
}

/**
 * Resolve the package identity for a document being submitted (Stage D items
 * 3/4/6): a saved binding wins over any derivation; otherwise the packageId is
 * derived from the title slug PLUS a stable unique suffix (two authors with
 * the same title must not collide), and `lastAcceptedVersion` is absent.
 * `legacyLastSubmitted` (settings.libraryLastSubmittedVersions) is advisory —
 * it suggests a version for an already-known slug but NEVER re-binds identity.
 */
export function resolveSubmissionIdentity(options: {
  boundPackageId?: string;
  boundLastAcceptedVersion?: string;
  titleSlug: string;
  suffix: string;
  legacyLastSubmitted?: string;
}): { packageId: string; isNew: boolean; suggestedVersion: string } {
  if (options.boundPackageId !== undefined && options.boundPackageId !== '') {
    return {
      packageId: options.boundPackageId,
      isNew: false,
      suggestedVersion: nextReleaseVersion(options.boundLastAcceptedVersion),
    };
  }
  const base = derivePackageId(options.titleSlug);
  return {
    packageId: `${base}-${options.suffix}`,
    isNew: true,
    // Legacy advisory: a package with this exact slug may already exist from a
    // pre-binding submission; suggest the next patch version after it.
    suggestedVersion: nextReleaseVersion(options.legacyLastSubmitted),
  };
}

