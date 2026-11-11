// src/protocol/protocol-document.ts
// Storage-neutral protocol document model for Protocol Former.
// This is the canonical on-disk shape for .rp.json protocol files.
//
// Design goals:
// - Decouple from Obsidian Canvas internals (no .canvas dependency).
// - Keep fields diffable and human-readable.
// - Support schema evolution via version field.
// - Map cleanly to runtime ProtocolGraph without loss.

import type { RPNodeKind } from '../graph/graph-model';

/** Canonical schema identifier for Protocol Former JSON files. */
export const PROTOCOL_SCHEMA = 'radiprotocol.protocol' as const;

/** Current on-disk schema version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Canonical on-disk shape for a Protocol Former protocol (.rp.json).
 * Versioned to allow future evolution without breaking existing files.
 */
export interface ProtocolDocumentV1 {
  /** Fixed schema identifier: 'radiprotocol.protocol' */
  schema: typeof PROTOCOL_SCHEMA;
  /** Schema version number. Current: 1 */
  version: typeof PROTOCOL_VERSION;
  /** Unique document ID (UUID or similar). */
  id: string;
  /** Human-readable protocol title. */
  title: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** All protocol nodes. Order is not semantically significant. */
  nodes: ProtocolNodeRecord[];
  /**
   * All protocol edges. Order is not semantically significant for traversal;
   * however, a question node's `fields.optionOrder` may reference edge ids to
   * express a display order for that question's outgoing selection options
   * (see ProtocolNodeRecord.fields.optionOrder).
   */
  edges: ProtocolEdgeRecord[];
  /** Whether final runner self-check checklist is enabled. */
  selfCheckEnabled?: boolean;
  /** Optional final runner self-check checklist items. */
  selfCheckItems?: string[];
  /**
   * Optional conclusion-draft items that seed the Runner's draft panel as soon
   * as a session starts. One array entry is one editable draft line; the user
   * can still edit, reorder, delete, or append before inserting the draft.
   * Empty or absent = the draft starts blank.
   */
  conclusionDraftItems?: string[];
  /** Optional viewport state for visual editor persistence. */
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
  /** Optional preferred editor auto-layout direction. */
  layoutDirection?: 'LR' | 'TB';
}

/**
 * On-disk node record. Maps to runtime RPNode after parsing.
 *
 * Design notes:
 * - `kind` may be null for untyped nodes during authoring.
 * - `fields` is a flat key-value map; parser normalizes to typed RPNode shape.
 * - Legacy `radiprotocol_*` prefix is NOT used in new .rp.json files.
 *   Keys in `fields` use camelCase without prefix (e.g. 'questionText').
 */
export interface ProtocolNodeRecord {
  /** Unique node ID within the document. */
  id: string;
  /** Node kind. Null means untyped/plain node (authoring intermediate state). */
  kind: RPNodeKind | null;
  /** X coordinate in visual editor space (pixels). */
  x: number;
  /** Y coordinate in visual editor space (pixels). */
  y: number;
  /** Node width in pixels. */
  width: number;
  /** Node height in pixels. */
  height: number;
  /** Optional node background color (CSS color string). */
  color?: string;
  /** Optional raw text content (fallback for label/body). */
  text?: string;
  /**
   * Typed node fields. Keys are camelCase without prefix:
   * - questionText, answerText, displayLabel, freeText, content, separator,
   *   loop, optionOrder, subfolderPath, snippetLabel, snippetSeparator, snippetPath.
   *
   * Parser validates field presence/absence per node kind.
   */
  fields: Record<string, unknown>;
}

/**
 * On-disk edge record. Maps directly to runtime RPEdge.
 */
export interface ProtocolEdgeRecord {
  /** Unique edge ID within the document. */
  id: string;
  /** Source node ID. Must reference an existing node. */
  fromNodeId: string;
  /** Target node ID. Must reference an existing node. */
  toNodeId: string;
  /** Optional edge label (shown on connector in visual editor and runner). */
  label?: string;
  /**
   * Loop-exit flag. When `true`, traversing this edge pops the current loop frame.
   * Absent or `false` = body branch. Replaces the former `+`-prefix label
   * convention. The one-time migration sets this flag on legacy `+`-prefixed
   * outgoing edges of `kind: 'loop'` nodes (now migrated to looped questions).
   */
  isLoopExit?: boolean;
}

/**
 * Utility: generate a new ProtocolDocumentV1 with minimal valid structure.
 * Used by ProtocolDocumentStore.create() and tests.
 *
 * Phase 4: seeds one Start node so newly created protocols open with a visible
 * green Start node and never trip the `noStartNode` validation error. The
 * seeded node uses the editor's default Start dimensions (200×80) and color
 * (rgba(76, 175, 80, 0.28)) — see NODE_KIND_DEFAULTS['start'] in
 * src/views/protocol-editor-view.ts. The values are inlined here with a cross
 * reference comment rather than imported from the views layer, to preserve the
 * protocol → views dependency direction (lower layers never import views).
 *
 * @param startNodeId Optional explicit Start node ID. Defaults to a generated
 *   `node-<timestamp>-<random>` ID derived from the injected `now`.
 */
export function createEmptyProtocolDocument(
  id: string,
  title: string,
  now = new Date(),
  startNodeId = `node-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
): ProtocolDocumentV1 {
  const iso = now.toISOString();
  return {
    schema: PROTOCOL_SCHEMA,
    version: PROTOCOL_VERSION,
    id,
    title,
    createdAt: iso,
    updatedAt: iso,
    nodes: [
      {
        id: startNodeId,
        kind: 'start',
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        // Matches NODE_KIND_DEFAULTS['start'].color in protocol-editor-view.ts.
        color: 'rgba(76, 175, 80, 0.28)',
        fields: {},
      },
    ],
    edges: [],
    layoutDirection: 'LR',
  };
}

/**
 * Utility: check if a value looks like a ProtocolDocumentV1.
 * Does NOT validate field semantics — only schema/version shape.
 */
export function isProtocolDocumentV1(value: unknown): value is ProtocolDocumentV1 {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Record<string, unknown>;
  return (
    doc['schema'] === PROTOCOL_SCHEMA &&
    doc['version'] === PROTOCOL_VERSION &&
    typeof doc['id'] === 'string' &&
    typeof doc['title'] === 'string' &&
    typeof doc['createdAt'] === 'string' &&
    typeof doc['updatedAt'] === 'string' &&
    Array.isArray(doc['nodes']) &&
    Array.isArray(doc['edges'])
  );
}
