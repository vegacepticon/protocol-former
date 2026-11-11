import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
// Slice 8 — library-managed protocols are read-only.
import { isLibraryManagedPath } from '../library/library-paths';
import type RadiProtocolPlugin from '../main';
import type { ProtocolDocumentV1, ProtocolEdgeRecord, ProtocolNodeRecord } from '../protocol/protocol-document';
import type { RPNodeKind } from '../graph/graph-model';
import { SnippetTreePicker, type SnippetTreePickerResult } from './snippet-tree-picker';
import { mountOptionOrderChips, type OptionOrderChipItem } from './option-order-chip-editor';
import { defaultT, type Translator } from '../i18n';
import dagre from 'dagre';
import { ProtocolEditorDocumentOwner, type EditorDocumentLease } from './protocol-editor-document-owner';

export const PROTOCOL_EDITOR_VIEW_TYPE = 'radiprotocol-protocol-editor';

/** Throw a consistent error when the protocol file is no longer in the vault. */
export function protocolMissingFileError(): never {
	throw new Error('Protocol file disappeared');
}

/**
 * Click-to-close guard for protocol-editor modal backdrops.
 *
 * A text selection dragged from inside an input and released over the
 * backdrop produces a synthetic click whose target is the common ancestor
 * of the press and release points — the backdrop itself. Closing on it
 * would dismiss the modal mid-edit and discard typed text, so close only
 * when the press itself started on the backdrop.
 */
export function createModalBackdropCloseGuard(backdrop: HTMLElement): {
	onPointerDown: (e: { target: EventTarget | null }) => void;
	shouldCloseOnClick: (e: { target: EventTarget | null }) => boolean;
} {
	let pressStartedOnBackdrop = false;
	return {
		onPointerDown: (e) => {
			pressStartedOnBackdrop = e.target === backdrop;
		},
		shouldCloseOnClick: (e) => {
			if (!pressStartedOnBackdrop) return false;
			pressStartedOnBackdrop = false;
			return e.target === backdrop;
		},
	};
}

/* Phase 4D — default node dimensions and kind-specific defaults */
const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 80;
/** Unique label target for the conclusion-draft preset textarea. */
let nextConclusionDraftFieldId = 0;
const DEFAULT_VIEWPORT_WIDTH = 30000;
const DEFAULT_VIEWPORT_HEIGHT = 24000;
const PROTOCOL_EDITOR_ORIGIN_X = DEFAULT_VIEWPORT_WIDTH / 2;
const PROTOCOL_EDITOR_ORIGIN_Y = DEFAULT_VIEWPORT_HEIGHT / 2;
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 50;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

interface NodeKindDefault {
  kind: RPNodeKind | null;
  fields: Record<string, unknown>;
  text?: string;
  color?: string;
}

type ProtocolEditorLayoutDirection = 'LR' | 'TB';

type ProtocolEditorPortSide = 'left' | 'right' | 'top' | 'bottom';

interface ConnectionDragState {
  fromNodeId: string;
  startX: number;
  startY: number;
  previewPath: SVGPathElement;
}

interface ProtocolEditorEdgeRoute {
  d: string;
  labelX: number;
  labelY: number;
}

interface ProtocolEditorEdgePoint {
  x: number;
  y: number;
}

const EDGE_ROUTE_EPSILON = 0.5;

function roundProtocolEditorEdgeCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatProtocolEditorEdgeCoord(value: number): string {
  return String(roundProtocolEditorEdgeCoord(value));
}

function sameProtocolEditorEdgePoint(a: ProtocolEditorEdgePoint, b: ProtocolEditorEdgePoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < EDGE_ROUTE_EPSILON;
}

function normalizeProtocolEditorEdgePoints(points: ProtocolEditorEdgePoint[]): ProtocolEditorEdgePoint[] {
  const normalized: ProtocolEditorEdgePoint[] = [];
  for (const point of points) {
    const rounded = { x: roundProtocolEditorEdgeCoord(point.x), y: roundProtocolEditorEdgeCoord(point.y) };
    const previous = normalized[normalized.length - 1];
    if (previous !== undefined && sameProtocolEditorEdgePoint(previous, rounded)) continue;
    normalized.push(rounded);
  }
  return normalized;
}

function protocolEditorLineCommand(point: ProtocolEditorEdgePoint): string {
  return `L ${formatProtocolEditorEdgeCoord(point.x)} ${formatProtocolEditorEdgeCoord(point.y)}`;
}

function roundedProtocolEditorOrthogonalPath(points: ProtocolEditorEdgePoint[], maxBend: number): string {
  const normalized = normalizeProtocolEditorEdgePoints(points);
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return `M ${formatProtocolEditorEdgeCoord(normalized[0]!.x)} ${formatProtocolEditorEdgeCoord(normalized[0]!.y)}`;

  const commands = [`M ${formatProtocolEditorEdgeCoord(normalized[0]!.x)} ${formatProtocolEditorEdgeCoord(normalized[0]!.y)}`];
  for (let index = 1; index < normalized.length; index += 1) {
    const current = normalized[index]!;
    const next = normalized[index + 1];
    if (next === undefined || maxBend <= EDGE_ROUTE_EPSILON) {
      commands.push(protocolEditorLineCommand(current));
      continue;
    }

    const previous = normalized[index - 1]!;
    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const bend = Math.min(maxBend, inLength / 2, outLength / 2);
    if (bend <= EDGE_ROUTE_EPSILON) {
      commands.push(protocolEditorLineCommand(current));
      continue;
    }

    const inUnit = { x: (current.x - previous.x) / inLength, y: (current.y - previous.y) / inLength };
    const outUnit = { x: (next.x - current.x) / outLength, y: (next.y - current.y) / outLength };
    const bendStart = { x: current.x - inUnit.x * bend, y: current.y - inUnit.y * bend };
    const bendEnd = { x: current.x + outUnit.x * bend, y: current.y + outUnit.y * bend };

    commands.push(protocolEditorLineCommand(bendStart));
    commands.push(`Q ${formatProtocolEditorEdgeCoord(current.x)} ${formatProtocolEditorEdgeCoord(current.y)} ${formatProtocolEditorEdgeCoord(bendEnd.x)} ${formatProtocolEditorEdgeCoord(bendEnd.y)}`);
  }

  return commands.join(' ');
}

interface ProtocolEditorPortAnchor {
  x: number;
  y: number;
  side: ProtocolEditorPortSide;
}

interface ProtocolEditorNodeMeasurement {
  width: number;
  height: number;
}

interface ProtocolEditorMeasuredNodeGeometry extends ProtocolEditorNodeMeasurement {
  x: number;
  y: number;
}

interface ProtocolEditorLiveNodeGeometry extends ProtocolEditorMeasuredNodeGeometry {
  id: string;
}

interface ProtocolEditorLayoutOptions {
  direction: ProtocolEditorLayoutDirection;
  nodesep: number;
  ranksep: number;
  edgesep: number;
}

interface ProtocolEditorCreateNodeOptions {
  onEditModalOpened?: () => void;
  onCreateAbandoned?: () => void;
  onCreateFailed?: () => void;
}

const PROTOCOL_EDITOR_LAYOUT_CONFIG: Record<ProtocolEditorLayoutDirection, ProtocolEditorLayoutOptions> = {
  LR: {
    direction: 'LR',
    nodesep: 96,
    ranksep: 152,
    edgesep: 32,
  },
  TB: {
    direction: 'TB',
    nodesep: 112,
    ranksep: 144,
    edgesep: 36,
  },
};

function protocolEditorInputPortSide(direction: ProtocolEditorLayoutDirection): ProtocolEditorPortSide {
  return direction === 'TB' ? 'top' : 'left';
}

function protocolEditorOutputPortSide(direction: ProtocolEditorLayoutDirection): ProtocolEditorPortSide {
  return direction === 'TB' ? 'bottom' : 'right';
}

function protocolEditorPortAnchor(node: Pick<ProtocolNodeRecord, 'x' | 'y' | 'width' | 'height'>, side: ProtocolEditorPortSide): ProtocolEditorPortAnchor {
  switch (side) {
    case 'left':
      return { x: node.x, y: node.y + node.height / 2, side };
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2, side };
    case 'top':
      return { x: node.x + node.width / 2, y: node.y, side };
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height, side };
  }
}

function protocolEditorNodeMeasurement(node: Pick<ProtocolNodeRecord, 'width' | 'height'>): ProtocolEditorNodeMeasurement {
  return {
    width: Math.max(MIN_NODE_WIDTH, Math.round(node.width || DEFAULT_NODE_WIDTH)),
    height: Math.max(MIN_NODE_HEIGHT, Math.round(node.height || DEFAULT_NODE_HEIGHT)),
  };
}

function protocolEditorNormalizeNodeMeasurement(width: number, height: number): ProtocolEditorNodeMeasurement {
  return {
    width: Math.max(MIN_NODE_WIDTH, Math.round(width || DEFAULT_NODE_WIDTH)),
    height: Math.max(MIN_NODE_HEIGHT, Math.round(height || DEFAULT_NODE_HEIGHT)),
  };
}

function protocolEditorMeasuredNodeAnchor(
  nodeEl: HTMLElement,
  side: ProtocolEditorPortSide,
): ProtocolEditorPortAnchor {
  const left = parseFloat(nodeEl.style.left || '0');
  const top = parseFloat(nodeEl.style.top || '0');
  const width = Math.max(MIN_NODE_WIDTH, nodeEl.offsetWidth);
  const height = Math.max(MIN_NODE_HEIGHT, nodeEl.offsetHeight);
  return protocolEditorPortAnchor({
    x: left - PROTOCOL_EDITOR_ORIGIN_X,
    y: top - PROTOCOL_EDITOR_ORIGIN_Y,
    width,
    height,
  }, side);
}

function protocolEditorAnchorToSurfacePoint(anchor: ProtocolEditorPortAnchor): { x: number; y: number } {
  return {
    x: worldXToSurfaceX(anchor.x),
    y: worldYToSurfaceY(anchor.y),
  };
}

function protocolEditorLayoutDirectionFromDocument(doc: ProtocolDocumentV1 | null | undefined): ProtocolEditorLayoutDirection {
  return doc?.layoutDirection === 'TB' ? 'TB' : 'LR';
}

interface PanState {
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
}

function worldXToSurfaceX(x: number): number {
  return x + PROTOCOL_EDITOR_ORIGIN_X;
}

function worldYToSurfaceY(y: number): number {
  return y + PROTOCOL_EDITOR_ORIGIN_Y;
}

const NODE_KIND_DEFAULTS: Record<string, NodeKindDefault> = {
  start: { kind: 'start', fields: {}, color: 'rgba(76, 175, 80, 0.28)' },
  question: { kind: 'question', fields: { questionText: '' }, color: 'rgba(33, 150, 243, 0.24)' },
  answer: { kind: 'answer', fields: { answerText: '', freeText: false }, color: 'rgba(255, 193, 7, 0.28)' },
  'text-block': { kind: 'text-block', fields: { content: '' }, color: 'rgba(255, 235, 59, 0.24)' },
  snippet: { kind: 'snippet', fields: {}, color: 'rgba(156, 39, 176, 0.24)' },
};

const EDITABLE_NODE_KINDS: RPNodeKind[] = ['start', 'question', 'answer', 'snippet'];

/** CSS/attribute token for a node kind — always raw "untyped", never i18n. */
export function nodeKindToken(kind: RPNodeKind | null): string {
  return kind ?? 'untyped';
}

export function defaultColorForProtocolEditorNodeKind(kind: RPNodeKind | null): string | undefined {
  if (kind === null) return undefined;
  return NODE_KIND_DEFAULTS[kind]?.color;
}

export function fieldsForProtocolEditorNodeKind(kind: RPNodeKind | null): Record<string, unknown> {
  if (kind === null) return {};
  return { ...(NODE_KIND_DEFAULTS[kind]?.fields ?? {}) };
}

export function normalizeProtocolEditorEdgeLabel(label: string): string | undefined {
  const trimmed = label.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function displayProtocolEditorEdgeLabel(label: string | undefined): string {
  return (label ?? '').trim();
}

export function nodeTitle(node: ProtocolNodeRecord, t: Translator = defaultT): string {
  if (typeof node.text === 'string' && node.text.trim() !== '') return node.text.trim();
  if (typeof node.fields['displayLabel'] === 'string') return node.fields['displayLabel'];
  if (typeof node.fields['questionText'] === 'string') return node.fields['questionText'];
  if (typeof node.fields['answerText'] === 'string') return node.fields['answerText'];
  if (typeof node.fields['content'] === 'string') return node.fields['content'];
  return node.kind ?? t('protocolEditor.untyped');
}

export function defaultProtocolEditorEdgeLabelForTarget(node: ProtocolNodeRecord | undefined): string | undefined {
  if (node === undefined) return undefined;
  const candidates = node.kind === 'answer'
    ? [node.fields['displayLabel'], node.fields['answerText'], node.text]
    : node.kind === 'snippet'
      ? [node.fields['snippetLabel'], node.text]
      : [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

export function shouldAutoRefreshProtocolEditorEdgeLabel(
  currentLabel: string | undefined,
  previousAutoLabel: string | undefined,
): boolean {
  const currentTrim = currentLabel?.trim() || undefined;
  const previousTrim = previousAutoLabel?.trim() || undefined;
  return currentTrim === undefined || currentTrim === previousTrim;
}

export function shouldDisplayProtocolEditorEdgeLabel(
  edge: ProtocolEdgeRecord,
  fromNode: ProtocolNodeRecord | undefined,
  toNode: ProtocolNodeRecord | undefined,
): boolean {
  if (toNode?.kind === 'answer' || toNode?.kind === 'snippet') {
    const effectiveLabel = deriveProtocolEditorEdgeLabel(toNode, edge.label);
    return effectiveLabel !== undefined && effectiveLabel.trim() !== '';
  }
  // A looped-question exit edge carries a user-authored label that must be preserved
  // regardless of the target node kind (the runner dispatches via edge.isLoopExit).
  if (fromNode?.kind === 'question' && fromNode.fields['loop'] === true && edge.isLoopExit === true) {
    return true;
  }
  // Ordinary Question-to-Question edges may carry authored transition captions.
  // Looped-question body labels remain hidden; loop exits are handled above.
  if (
    fromNode?.kind === 'question' &&
    fromNode.fields['loop'] !== true &&
    toNode?.kind === 'question'
  ) {
    return edge.label !== undefined && edge.label.trim() !== '';
  }
  return false;
}

function deriveProtocolEditorEdgeLabel(
  targetNode: ProtocolNodeRecord | undefined,
  currentLabel: string | undefined,
): string | undefined {
  if (currentLabel !== undefined && currentLabel.trim() !== '') return currentLabel;
  return defaultProtocolEditorEdgeLabelForTarget(targetNode);
}

function optionOrderChipLabel(
  edge: ProtocolEdgeRecord,
  targetNode: ProtocolNodeRecord | undefined,
): string {
  // Authored non-blank edge label wins for all kinds; answer/snippet targets get
  // their default label via deriveProtocolEditorEdgeLabel. Question/text-block/
  // loop targets fall back to kind-aware on-disk fields mirroring `nodeLabel`
  // (node-label.ts) so chip captions match the runner's per-kind captions.
  // Labels are user-authored — never wrapped in t().
  const derived = deriveProtocolEditorEdgeLabel(targetNode, edge.label);
  if (derived !== undefined && derived.trim() !== '') return derived;
  if (targetNode === undefined) return edge.toNodeId;
  const kind = targetNode.kind;
  if (kind === 'question') {
    const qt = targetNode.fields['questionText'];
    if (typeof qt === 'string' && qt.trim() !== '') return qt;
  } else if (kind === 'text-block') {
    const content = targetNode.fields['content'];
    if (typeof content === 'string' && content.trim() !== '') return content.slice(0, 30);
  } else if (kind === 'loop-start') {
    const ll = targetNode.fields['loopLabel'];
    if (typeof ll === 'string' && ll.trim() !== '') return ll;
  }
  if (typeof targetNode.text === 'string' && targetNode.text.trim() !== '') return targetNode.text;
  return targetNode.id;
}

// Order on-disk outgoing-edge items by the question's `fields.optionOrder`.
// Mirrors `orderedOutgoingEdges` (src/graph/edge-order.ts) but operates on a
// generic `{ id }` item list (the editor works with on-disk records, not the
// runtime ProtocolGraph). Listed ids emit in order (stale + duplicates dropped);
// unlisted items append at the end in original order; absent `optionOrder`
// returns items unchanged (fallback). Stale ids are dropped here so the chip
// list shows only currently-outgoing edges (FR-3/FR-9); the on-disk field is
// rebuilt from the chip draft on save.
function orderItemsByOptionOrder<T extends { id: string }>(items: T[], optionOrder: string[] | undefined): T[] {
  if (optionOrder === undefined) return items;
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of optionOrder) {
    if (typeof id !== 'string') continue;
    const item = byId.get(id);
    if (item === undefined || seen.has(id)) continue;
    seen.add(id);
    ordered.push(item);
  }
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    ordered.push(item);
  }
  return ordered;
}

// FR-6: when a new outgoing edge is appended to a question that already has an
// authored `fields.optionOrder`, append the new edge id to the end of that list
// inside the same `protocolDocumentStore.update` mutator that appends the edge
// (atomic — one WriteMutex-protected write). No-op when the source is not a
// question or has no array optionOrder. Returns a new nodes array; the source
// node is shallow-copied with an updated `fields` object so unrelated metadata
// is preserved by the `{ ...n.fields }` spread. Exported for unit testing.
export function appendEdgeIdToOptionOrder(
  nodes: ProtocolNodeRecord[],
  sourceNodeId: string,
  edgeId: string,
): ProtocolNodeRecord[] {
  return nodes.map((n) => {
    if (n.id !== sourceNodeId || n.kind !== 'question') return n;
    const existingOrder = n.fields['optionOrder'];
    if (!Array.isArray(existingOrder)) return n;
    return {
      ...n,
      fields: { ...n.fields, optionOrder: [...existingOrder, edgeId] },
    };
  });
}

/* Phase 4D/4E — generate unique IDs */
function nodeUid(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function edgeUid(): string {
  return `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clampProtocolEditorZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenDeltaToProtocolEditorDelta(delta: number, zoom: number): number {
  return delta / clampProtocolEditorZoom(zoom);
}

export function canCreateProtocolEditorEdge(
  edges: Pick<ProtocolEdgeRecord, 'fromNodeId' | 'toNodeId'>[],
  fromNodeId: string,
  toNodeId: string,
): 'ok' | 'self' | 'duplicate' {
  if (fromNodeId === toNodeId) return 'self';
  if (edges.some((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId)) return 'duplicate';
  return 'ok';
}

export function removeProtocolEditorEdge(
  edges: ProtocolEdgeRecord[],
  edgeId: string,
): ProtocolEdgeRecord[] {
  return edges.filter((edge) => edge.id !== edgeId);
}

export function normalizeProtocolEditorSnippetFolderSelection(relativePath: string): string | undefined {
  const trimmed = relativePath.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? undefined : trimmed;
}

/** Maximum configured bend radius for edge Q-curves. */
const CONFIGURED_MAX_BEND = 32;
/** Backward route exit/entry offset in pixels. */
const BACKWARD_OFFSET = 40;

function computeEdgeBend(
  rankDelta: number,
  normalDelta: number,
  forward: boolean,
): number {
  if (forward) {
    // Forward: first L segment is rankDelta/2 - bend (must be >= 0)
    // Middle L segment is |normalDelta| - 2*bend (must be >= 0)
    // The computed safe maximum is authoritative: applying a visual minimum above
    // this value reintroduces backtracking on very short doglegs.
    return Math.max(0, Math.min(
      rankDelta / 2,
      Math.abs(normalDelta) / 2,
      CONFIGURED_MAX_BEND,
    ));
  }
  // Backward: exit/entry offset constrains first/last L: BACKWARD_OFFSET - bend >= 0
  // Cross-direction constraint: L2 + L4 = |normalDelta| - 2*bend >= 0 → bend <= |normalDelta|/2
  // Conservative bound |normalDelta|/2 always ≤ actual L2/L4 constraint (TB adds 40-56px margin).
  return Math.max(0, Math.min(
    BACKWARD_OFFSET,
    Math.abs(normalDelta) / 2,
    CONFIGURED_MAX_BEND,
  ));
}

export function protocolEditorEdgeRoute(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  direction: ProtocolEditorLayoutDirection = 'LR',
): ProtocolEditorEdgeRoute {
  const rankDelta = direction === 'TB' ? y2 - y1 : x2 - x1;
  const normalDelta = direction === 'TB' ? x2 - x1 : y2 - y1;
  const forward = rankDelta >= 0;
  const bend = computeEdgeBend(rankDelta, normalDelta, forward);

  if (forward) {
    if (direction === 'TB') {
      if (Math.abs(normalDelta) < 1) {
        return {
          d: `M ${x1} ${y1} L ${x2} ${y2}`,
          labelX: (x1 + x2) / 2,
          labelY: (y1 + y2) / 2 - 10,
        };
      }
      const midY = y1 + rankDelta / 2;
      return {
        d: roundedProtocolEditorOrthogonalPath([
          { x: x1, y: y1 },
          { x: x1, y: midY },
          { x: x2, y: midY },
          { x: x2, y: y2 },
        ], bend),
        labelX: (x1 + x2) / 2,
        labelY: midY - 10,
      };
    }

    const midX = x1 + rankDelta / 2;
    if (Math.abs(normalDelta) < 1) {
      return {
        d: `M ${x1} ${y1} L ${x2} ${y2}`,
        labelX: midX,
        labelY: y1 - 10,
      };
    }
    return {
      d: roundedProtocolEditorOrthogonalPath([
        { x: x1, y: y1 },
        { x: midX, y: y1 },
        { x: midX, y: y2 },
        { x: x2, y: y2 },
      ], bend),
      labelX: midX,
      labelY: (y1 + y2) / 2 - 10,
    };
  }

  if (direction === 'TB') {
    const routeX = Math.max(x1, x2) + Math.max(56, Math.abs(normalDelta) / 2 + 40);
    const exitY = y1 + 40;
    const entryY = y2 - 40;
    return {
      d: roundedProtocolEditorOrthogonalPath([
        { x: x1, y: y1 },
        { x: x1, y: exitY },
        { x: routeX, y: exitY },
        { x: routeX, y: entryY },
        { x: x2, y: entryY },
        { x: x2, y: y2 },
      ], bend),
      labelX: routeX + 14,
      labelY: (exitY + entryY) / 2,
    };
  }

  const routeY = Math.max(y1, y2) + Math.max(48, Math.abs(normalDelta) / 2 + 32);
  const exitX = x1 + 40;
  const entryX = x2 - 40;
  return {
    d: roundedProtocolEditorOrthogonalPath([
      { x: x1, y: y1 },
      { x: exitX, y: y1 },
      { x: exitX, y: routeY },
      { x: entryX, y: routeY },
      { x: entryX, y: y2 },
      { x: x2, y: y2 },
    ], bend),
    labelX: (exitX + entryX) / 2,
    labelY: routeY - 10,
  };
}

export class ProtocolEditorView extends ItemView {
  private readonly plugin: RadiProtocolPlugin;
  private protocolPath: string | null = null;
  // Slice 8 — true when the loaded protocol lives under the managed library
  // subtree; every mutating entry point is guarded via isLibraryReadOnly().
  private libraryReadOnly = false;
  private doc: ProtocolDocumentV1 | null = null;
  private rootEl: HTMLElement | null = null;
  private viewportEl: HTMLElement | null = null;
  private surfaceEl: HTMLElement | null = null;
  private svgEl: SVGSVGElement | null = null;
  private minimapEl: HTMLElement | null = null;
  private minimapSvgEl: SVGSVGElement | null = null;
  private minimapViewportEl: SVGRectElement | null = null;
  private minimapWorldBounds: { x: number; y: number; width: number; height: number } | null = null;
  private readonly nodeElementById = new Map<string, HTMLElement>();
  private readonly liveNodeGeometryById = new Map<string, ProtocolEditorLiveNodeGeometry>();
  private panState: PanState | null = null;

  private connectionDragState: ConnectionDragState | null = null;
  private viewportSaveTimer: number | null = null;
  private layoutDirection: ProtocolEditorLayoutDirection = 'LR';
  private zoom: number = 1;
  private loadGeneration = 0;
  private readonly documentOwner: ProtocolEditorDocumentOwner;

  constructor(leaf: WorkspaceLeaf, plugin: RadiProtocolPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.documentOwner = new ProtocolEditorDocumentOwner(
      plugin.protocolDocumentStore,
      () => ({ path: this.protocolPath, generation: this.loadGeneration, readOnly: this.libraryReadOnly }),
      () => { ++this.loadGeneration; this.clearPendingViewportSave(); },
    );
  }

  getViewType(): string { return PROTOCOL_EDITOR_VIEW_TYPE; }
  getDisplayText(): string { return this.plugin.i18n.t('protocolEditor.displayText'); }
  getIcon(): string { return 'workflow'; }

  async onOpen(): Promise<void> {
    this.documentOwner.open();
    this.renderShell();
  }

  async onClose(): Promise<void> {
    this.documentOwner.close();
    this.clearPendingViewportSave();
    this.rootEl = null;
    this.viewportEl = null;
    this.surfaceEl = null;
    this.svgEl = null;
    this.minimapEl = null;
    this.minimapSvgEl = null;
    this.minimapViewportEl = null;
    this.minimapWorldBounds = null;
    this.doc = null;
    this.protocolPath = null;
    this.libraryReadOnly = false;
    this.panState = null;
    this.connectionDragState = null;
    this.nodeElementById.clear();
    this.liveNodeGeometryById.clear();
    document.body.removeClass('rp-protocol-editor-drag-active');
    document.body.removeClass('rp-protocol-editor-resize-active');
  }

  async loadProtocol(protocolPath: string, refreshLease?: EditorDocumentLease): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(protocolPath);
    if (!(file instanceof TFile) || !file.path.endsWith('.rp.json')) {
      new Notice(this.plugin.i18n.t('protocolEditor.notProtocolFile'));
      return;
    }

    try {
      const result = await this.documentOwner.load(file.path, (doc) => {
        this.protocolPath = file.path;
        this.libraryReadOnly = isLibraryManagedPath(file.path, this.plugin.settings.protocolFolderPath);
        this.doc = doc;
        this.panState = null;
        this.connectionDragState = null;
        this.layoutDirection = protocolEditorLayoutDirectionFromDocument(doc);
        this.zoom = clampProtocolEditorZoom(doc.viewport?.zoom ?? 1);
        this.renderShell();
        this.renderDocument();
      }, refreshLease);
      if (result === 'failed') {
        this.renderShell();
        this.renderDocument();
        new Notice(this.plugin.i18n.t('protocolEditor.loadFailed'));
      }
    } catch (error) {
      this.renderShell();
      this.renderDocument();
      console.error('[Protocol Former] Protocol Editor load failed:', error);
      new Notice(this.plugin.i18n.t('protocolEditor.loadFailed'));
    }
  }

  /** Slice 8 — library-managed protocols are read-only. Returns true (and shows
   *  a Notice) when the loaded protocol lives under the managed library subtree,
   *  so every mutating entry point can early-return with a single guard. */
  private isLibraryReadOnly(): boolean {
    if (this.libraryReadOnly) {
      new Notice(this.plugin.i18n.t('library.readOnlyNotice'));
      return true;
    }
    return false;
  }

  private renderShell(): void {
    const container = this.containerEl.children[1] as HTMLElement | undefined;
    if (container === undefined) return;
    container.empty();
    this.rootEl = container.createDiv({ cls: 'rp-protocol-editor' });

    const workspace = this.rootEl.createDiv({ cls: 'rp-protocol-editor-workspace' });

    const floatingActions = workspace.createDiv({ cls: 'rp-protocol-editor-floating-actions' });
    const selfCheckBtn = floatingActions.createEl('button', {
      cls: 'rp-protocol-editor-floating-action',
      attr: {
        type: 'button',
        'aria-label': this.plugin.i18n.t('selfCheck.title'),
      },
    });
    setIcon(selfCheckBtn, 'list-checks');
    selfCheckBtn.addEventListener('click', () => this.openSelfCheckModal());

    const conclusionDraftBtn = floatingActions.createEl('button', {
      cls: 'rp-protocol-editor-floating-action',
      attr: {
        type: 'button',
        'aria-label': this.plugin.i18n.t('protocolEditor.conclusionDraftTitle'),
      },
    });
    setIcon(conclusionDraftBtn, 'pencil');
    conclusionDraftBtn.addEventListener('click', () => this.openConclusionDraftModal());

    const minimapToggleBtn = floatingActions.createEl('button', {
      cls: 'rp-protocol-editor-floating-action',
      attr: {
        type: 'button',
        'aria-label': this.plugin.i18n.t('protocolEditor.toggleMinimap'),
      },
    });
    setIcon(minimapToggleBtn, 'map');
    minimapToggleBtn.addEventListener('click', () => this.toggleMinimap());

    const autoLayoutBtn = floatingActions.createEl('button', {
      cls: 'rp-protocol-editor-floating-action',
      attr: {
        type: 'button',
        'aria-label': this.plugin.i18n.t('protocolEditor.autoLayout'),
      },
    });
    setIcon(autoLayoutBtn, 'layout');
    autoLayoutBtn.addEventListener('click', (event: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle(this.plugin.i18n.t('protocolEditor.autoLayoutVertical'))
        .setIcon('arrow-down')
        .onClick(() => this.autoLayoutNodes('TB')));
      menu.addItem((item) => item
        .setTitle(this.plugin.i18n.t('protocolEditor.autoLayoutHorizontal'))
        .setIcon('arrow-right')
        .onClick(() => this.autoLayoutNodes('LR')));
      menu.showAtMouseEvent(event);
    });

    workspace.createDiv({
      cls: 'rp-protocol-editor-canvas-title',
      text: this.doc?.title ?? this.plugin.i18n.t('protocolEditor.emptyTitle'),
    });
    // Slice 8 — read-only banner for library-managed protocols. The banner
    // conveys the state; drag/resize gestures stay silent (no Notice noise).
    if (this.libraryReadOnly) {
      const banner = workspace.createDiv({ cls: 'rp-protocol-editor-library-banner' });
      banner.createEl('span', { cls: 'radi-library-managed-badge', text: this.plugin.i18n.t('library.managedBadge') });
      banner.createEl('span', { text: this.plugin.i18n.t('library.readOnlyBanner') });
    }
    this.viewportEl = workspace.createDiv({ cls: 'rp-protocol-editor-viewport' });
    this.viewportEl.setAttr('data-zoom', String(this.zoom));
    this.viewportEl.setAttr('data-layout-direction', this.layoutDirection);
    this.surfaceEl = this.viewportEl.createDiv({ cls: 'rp-protocol-editor-surface' });
    this.svgEl = this.viewportEl.createSvg('svg', { cls: 'rp-protocol-editor-edges' });

    if (this.doc !== null) {
      this.minimapEl = workspace.createDiv({ cls: 'rp-protocol-editor-minimap' });
      this.minimapEl.setAttr('role', 'button');
      this.minimapEl.setAttr('tabindex', '0');
      // No aria-label: Obsidian renders it as a hover tooltip over the whole
      // minimap; keyboard/screen-reader users get the role + focus ring.
      this.minimapSvgEl = this.minimapEl.createSvg('svg', {
        attr: {
          class: 'rp-protocol-editor-minimap-svg',
          viewBox: `0 0 ${DEFAULT_VIEWPORT_WIDTH} ${DEFAULT_VIEWPORT_HEIGHT}`,
          preserveAspectRatio: 'none',
        },
      }) as SVGSVGElement;
      const zoomIndicator = this.minimapEl.createDiv({ cls: 'rp-protocol-editor-zoom-indicator' });
      zoomIndicator.setText(`${Math.round(this.zoom * 100)}%`);
    } else {
      this.minimapEl = null;
      this.minimapSvgEl = null;
      this.minimapViewportEl = null;
      this.minimapWorldBounds = null;
    }

    this.applyZoom();
    this.bindViewportControls();
    this.bindMinimapControls();
    this.restoreViewportState();

    if (this.doc === null) {
      this.surfaceEl.createDiv({
        cls: 'rp-protocol-editor-empty',
        text: this.plugin.i18n.t('protocolEditor.emptyState'),
      });
    }
  }

  private createProtocolEditorNode(kind: RPNodeKind | null, x: number, y: number): ProtocolNodeRecord {
    const defaults = (kind !== null && NODE_KIND_DEFAULTS[kind])
      ? NODE_KIND_DEFAULTS[kind]
      : { kind: null as RPNodeKind | null, fields: {} };

    const text = defaults.text ?? (kind !== null && kind !== 'start' ? this.plugin.i18n.t(`protocolEditor.defaultNodeText.${kind}`) : undefined);
    return {
      id: nodeUid(),
      kind: defaults.kind,
      x: Math.round(x),
      y: Math.round(y),
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      color: defaults.color ?? defaultColorForProtocolEditorNodeKind(defaults.kind),
      text,
      fields: { ...defaults.fields },
    };
  }

  private setNodeKindPickerBusy(modalEl: HTMLElement, busy: boolean): void {
    modalEl.toggleClass('is-saving', busy);
    for (const button of Array.from(modalEl.querySelectorAll('button'))) {
      (button as HTMLButtonElement).disabled = busy;
    }
  }

  private addNodeAtWorldPoint(
    kind: RPNodeKind | null,
    x: number,
    y: number,
    options: ProtocolEditorCreateNodeOptions = {},
  ): void {
    if (this.doc === null || this.protocolPath === null) {
      options.onCreateAbandoned?.();
      return;
    }
    if (this.isLibraryReadOnly()) { options.onCreateAbandoned?.(); return; }

    const newNode = this.createProtocolEditorNode(kind, x, y);
    const owner = this.documentOwner.capture();
    if (owner === null) { options.onCreateAbandoned?.(); return; }

    void this.documentOwner.update(owner, (existing) => {
      if (existing === null) protocolMissingFileError();
      return { ...existing, nodes: [...existing.nodes, newNode], viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
    }).then((updated) => {
      try {
        if (updated === null || !this.documentOwner.isCurrent(owner)) {
          options.onCreateAbandoned?.();
          return;
        }
        const createdNode = this.applyCreatedProtocolDocument(updated, newNode.id) ?? newNode;
        this.openEditModal(createdNode, { autofocusFirstTextField: true });
        options.onEditModalOpened?.();
        new Notice(this.plugin.i18n.t('protocolEditor.nodeCreated'));
      } catch (err) {
        console.error('[Protocol Former] Failed to update Protocol Editor UI after creating node:', err);
        options.onCreateFailed?.();
        new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
      }
    }, (err) => {
      options.onCreateFailed?.();
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    });
  }

  private openNodeKindPickerAtWorldPoint(x: number, y: number): void {
    if (this.doc === null || this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const modalEl = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = modalEl.createDiv({ cls: 'rp-protocol-editor-modal rp-protocol-editor-node-kind-modal' });
    const header = modal.createDiv({ cls: 'rp-protocol-editor-modal-header' });
    header.createEl('h3', { text: t('protocolEditor.chooseNodeType') });
    const closeBtn = header.createEl('button', { cls: 'rp-protocol-editor-modal-close', text: '✕', attr: { 'aria-label': t('protocolEditor.close') } });
    let isCreating = false;
    const disposeModal = this.documentOwner.own(owner, () => modalEl.remove());
    const closeModal = (options?: { restoreFocus?: boolean }) => {
      disposeModal();
      if (options?.restoreFocus !== false && this.documentOwner.isCurrent(owner)) this.restoreEditorFocus();
    };
    const beginCreate = () => {
      isCreating = true;
      this.setNodeKindPickerBusy(modalEl, true);
    };
    const restorePicker = () => {
      isCreating = false;
      this.setNodeKindPickerBusy(modalEl, false);
    };
    closeBtn.addEventListener('click', () => {
      if (isCreating) return;
      closeModal();
    });

    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });
    const grid = body.createDiv({ cls: 'rp-protocol-editor-node-kind-grid' });
    const hasStart = this.doc.nodes.some(node => node.kind === 'start');
    const availableKinds = hasStart
      ? EDITABLE_NODE_KINDS.filter(kind => kind !== 'start')
      : EDITABLE_NODE_KINDS;
    for (const kind of availableKinds) {
      const btn = grid.createEl('button', {
        cls: 'rp-protocol-editor-node-kind-choice',
        text: t(`protocolEditor.nodeKind.${kind}`),
      });
      btn.setAttr('data-node-kind', kind);
      btn.addEventListener('click', () => {
        if (!this.documentOwner.isCurrent(owner)) return;
        if (isCreating) return;
        beginCreate();
        this.addNodeAtWorldPoint(kind, x, y, {
          onEditModalOpened: () => closeModal({ restoreFocus: false }),
          onCreateAbandoned: () => closeModal(),
          onCreateFailed: restorePicker,
        });
      });
    }
    const backdropGuard = createModalBackdropCloseGuard(modalEl);
    modalEl.addEventListener('pointerdown', backdropGuard.onPointerDown);
    modalEl.addEventListener('click', (e) => {
      if (isCreating) return;
      if (backdropGuard.shouldCloseOnClick(e)) closeModal();
    });
  }

  private openNodeKindPickerAndConnectAtWorldPoint(fromNodeId: string, x: number, y: number): void {
    if (this.doc === null || this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const modalEl = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = modalEl.createDiv({ cls: 'rp-protocol-editor-modal rp-protocol-editor-node-kind-modal' });
    const header = modal.createDiv({ cls: 'rp-protocol-editor-modal-header' });
    header.createEl('h3', { text: t('protocolEditor.chooseNodeType') });
    const closeBtn = header.createEl('button', { cls: 'rp-protocol-editor-modal-close', text: '✕', attr: { 'aria-label': t('protocolEditor.close') } });
    let isCreating = false;
    const disposeModal = this.documentOwner.own(owner, () => modalEl.remove());
    const closeModal = (options?: { restoreFocus?: boolean }) => {
      disposeModal();
      if (options?.restoreFocus !== false && this.documentOwner.isCurrent(owner)) this.restoreEditorFocus();
    };
    const beginCreate = () => {
      isCreating = true;
      this.setNodeKindPickerBusy(modalEl, true);
    };
    const restorePicker = () => {
      isCreating = false;
      this.setNodeKindPickerBusy(modalEl, false);
    };
    closeBtn.addEventListener('click', () => {
      if (isCreating) return;
      closeModal();
    });

    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });
    const grid = body.createDiv({ cls: 'rp-protocol-editor-node-kind-grid' });
    const hasStart = this.doc.nodes.some(node => node.kind === 'start');
    const availableKinds = hasStart
      ? EDITABLE_NODE_KINDS.filter(kind => kind !== 'start')
      : EDITABLE_NODE_KINDS;
    for (const kind of availableKinds) {
      const btn = grid.createEl('button', {
        cls: 'rp-protocol-editor-node-kind-choice',
        text: t(`protocolEditor.nodeKind.${kind}`),
      });
      btn.setAttr('data-node-kind', kind);
      btn.addEventListener('click', () => {
        if (!this.documentOwner.isCurrent(owner)) return;
        if (isCreating) return;
        beginCreate();
        this.addNodeAndConnectAtWorldPoint(fromNodeId, kind, x, y, {
          onEditModalOpened: () => closeModal({ restoreFocus: false }),
          onCreateAbandoned: () => closeModal(),
          onCreateFailed: restorePicker,
        });
      });
    }
    const backdropGuard = createModalBackdropCloseGuard(modalEl);
    modalEl.addEventListener('pointerdown', backdropGuard.onPointerDown);
    modalEl.addEventListener('click', (e) => {
      if (isCreating) return;
      if (backdropGuard.shouldCloseOnClick(e)) closeModal();
    });
  }

  private addNodeAndConnectAtWorldPoint(
    fromNodeId: string,
    kind: RPNodeKind | null,
    x: number,
    y: number,
    options: ProtocolEditorCreateNodeOptions = {},
  ): void {
    if (this.doc === null || this.protocolPath === null) {
      options.onCreateAbandoned?.();
      return;
    }
    if (this.isLibraryReadOnly()) { options.onCreateAbandoned?.(); return; }

    const newNode = this.createProtocolEditorNode(kind, x, y);
    const owner = this.documentOwner.capture();
    if (owner === null) { options.onCreateAbandoned?.(); return; }

    void this.documentOwner.update(owner, (existing) => {
      if (existing === null) protocolMissingFileError();
      const sourceNode = existing.nodes.find((n) => n.id === fromNodeId);
      const targetNode = { ...newNode };
      const defaultLabel = defaultProtocolEditorEdgeLabelForTarget(targetNode);
      const shouldDisplay = shouldDisplayProtocolEditorEdgeLabel(
        { id: 'preview', fromNodeId, toNodeId: newNode.id, label: defaultLabel },
        sourceNode,
        targetNode,
      );
      const newEdge: ProtocolEdgeRecord = {
        id: edgeUid(),
        fromNodeId,
        toNodeId: newNode.id,
        label: shouldDisplay ? defaultLabel : undefined,
      };
      const edgeAdded = canCreateProtocolEditorEdge(existing.edges, fromNodeId, newNode.id) === 'ok';
      const edges = edgeAdded ? [...existing.edges, newEdge] : existing.edges;
      const baseNodes = [...existing.nodes, newNode];
      const nodes = edgeAdded ? appendEdgeIdToOptionOrder(baseNodes, fromNodeId, newEdge.id) : baseNodes;
      return { ...existing, nodes, edges, viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
    }).then((updated) => {
      try {
        if (updated === null || !this.documentOwner.isCurrent(owner)) {
          options.onCreateAbandoned?.();
          return;
        }
        const createdNode = this.applyCreatedProtocolDocument(updated, newNode.id) ?? newNode;
        this.openEditModal(createdNode, { autofocusFirstTextField: true });
        options.onEditModalOpened?.();
        new Notice(this.plugin.i18n.t('protocolEditor.nodeCreated'));
      } catch (err) {
        console.error('[Protocol Former] Failed to update Protocol Editor UI after creating connected node:', err);
        options.onCreateFailed?.();
        new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
      }
    }, (err) => {
      options.onCreateFailed?.();
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    });
  }

  private renderDocument(): void {
    if (this.doc === null || this.surfaceEl === null || this.svgEl === null) return;
    this.nodeElementById.clear();
    this.liveNodeGeometryById.clear();
    this.surfaceEl.empty();
    this.svgEl.empty();
    this.applyZoom();

    if (this.doc.nodes.length === 0) {
      this.surfaceEl.createDiv({
        cls: 'rp-protocol-editor-empty',
        text: this.plugin.i18n.t('protocolEditor.noNodes'),
      });
      this.renderMinimap();
      return;
    }

    for (const node of this.doc.nodes) {
      this.renderNode(node);
    }

    this.renderEdges();
    this.renderMinimap();
  }

  private renderNode(node: ProtocolNodeRecord): HTMLElement | null {
    if (this.surfaceEl === null) return null;
    this.surfaceEl.querySelector('.rp-protocol-editor-empty')?.remove();

    const nodeEl = this.surfaceEl.createDiv({ cls: 'rp-protocol-editor-node' });
    nodeEl.toggleClass('is-untyped', node.kind === null);
    nodeEl.setAttr('data-node-id', node.id);
    nodeEl.setAttr('data-node-kind', nodeKindToken(node.kind));
    nodeEl.setAttr('tabindex', '0');
    nodeEl.setAttr('role', 'group');
    nodeEl.setAttr('aria-label', nodeTitle(node, this.plugin.i18n.t.bind(this.plugin.i18n)));
    if (node.color === undefined) node.color = defaultColorForProtocolEditorNodeKind(node.kind);
    this.applyNodePosition(nodeEl, node);

    const inputPort = nodeEl.createDiv({ cls: 'rp-protocol-editor-port rp-protocol-editor-port-input' });
    inputPort.setAttr('data-node-id', node.id);
    inputPort.setAttr('data-port-kind', 'input');
    inputPort.setAttr('data-port-side', protocolEditorInputPortSide(this.layoutDirection));
    inputPort.setAttr('aria-label', this.plugin.i18n.t('protocolEditor.inputPortLabel'));

    const outputPort = nodeEl.createDiv({ cls: 'rp-protocol-editor-port rp-protocol-editor-port-output' });
    outputPort.setAttr('data-node-id', node.id);
    outputPort.setAttr('data-port-kind', 'output');
    outputPort.setAttr('data-port-side', protocolEditorOutputPortSide(this.layoutDirection));
    outputPort.setAttr('aria-label', this.plugin.i18n.t('protocolEditor.outputPortLabel'));

    nodeEl.createDiv({ cls: 'rp-protocol-editor-node-kind', text: node.kind ?? this.plugin.i18n.t('protocolEditor.untyped') });
    const displayTitle = nodeTitle(node, this.plugin.i18n.t.bind(this.plugin.i18n));
    if (displayTitle !== (node.kind ?? this.plugin.i18n.t('protocolEditor.untyped'))) {
      nodeEl.createDiv({ cls: 'rp-protocol-editor-node-title', text: displayTitle });
    }
    if (node.kind === 'question' && node.fields['loop'] === true) {
      const badge = nodeEl.createDiv({ cls: 'rp-protocol-editor-node-loop-badge' });
      setIcon(badge, 'repeat');
      badge.setAttr('aria-label', this.plugin.i18n.t('protocolEditor.loopBadgeAriaLabel'));
    }
    if (node.kind === 'answer' && node.fields['freeText'] === true) {
      const badge = nodeEl.createDiv({ cls: 'rp-protocol-editor-node-free-text-badge' });
      setIcon(badge, 'text-cursor-input');
      badge.setAttr('aria-label', this.plugin.i18n.t('protocolEditor.freeTextBadgeAriaLabel'));
    }
    const resizeHandle = nodeEl.createDiv({ cls: 'rp-protocol-editor-resize-handle' });
    resizeHandle.setAttr('aria-label', this.plugin.i18n.t('protocolEditor.resizeNodeLabel'));

    this.bindConnectionDrag(outputPort, node);
    this.bindDrag(nodeEl, node);
    this.bindResize(resizeHandle, nodeEl, node);
    this.nodeElementById.set(node.id, nodeEl);

    nodeEl.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.rp-protocol-editor-port') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this.openEditModal(node);
    });

    nodeEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('.rp-protocol-editor-port') !== null) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.openEditModal(node);
      }
    });

    return nodeEl;
  }

  private applyCreatedProtocolDocument(updated: ProtocolDocumentV1, newNodeId: string): ProtocolNodeRecord | null {
    this.doc = updated;
    this.layoutDirection = protocolEditorLayoutDirectionFromDocument(updated);
    this.viewportEl?.setAttr('data-layout-direction', this.layoutDirection);

    const createdNode = updated.nodes.find((node) => node.id === newNodeId) ?? null;
    if (createdNode === null) {
      this.renderDocument();
      return null;
    }

    const existingNodeEl = this.nodeElementById.get(createdNode.id);
    if (existingNodeEl === undefined || !existingNodeEl.isConnected) {
      this.renderNode(createdNode);
    } else {
      this.applyNodePosition(existingNodeEl, createdNode);
    }

    this.renderEdges();
    this.renderMinimap();
    return createdNode;
  }

  private renderEdges(): void {
    if (this.doc === null || this.svgEl === null) return;
    this.svgEl.empty();
    const nodeById = new Map(this.doc.nodes.map(node => [node.id, node]));
    const outputSide = protocolEditorOutputPortSide(this.layoutDirection);
    const inputSide = protocolEditorInputPortSide(this.layoutDirection);
    for (const edge of this.doc.edges) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (from === undefined || to === undefined) continue;
      const sourceNodeEl = this.nodeElementById.get(from.id);
      const targetNodeEl = this.nodeElementById.get(to.id);
      const source = sourceNodeEl !== undefined
        ? protocolEditorAnchorToSurfacePoint(protocolEditorMeasuredNodeAnchor(sourceNodeEl, outputSide))
        : protocolEditorAnchorToSurfacePoint(protocolEditorPortAnchor(from, outputSide));
      const target = targetNodeEl !== undefined
        ? protocolEditorAnchorToSurfacePoint(protocolEditorMeasuredNodeAnchor(targetNodeEl, inputSide))
        : protocolEditorAnchorToSurfacePoint(protocolEditorPortAnchor(to, inputSide));
      const route = protocolEditorEdgeRoute(source.x, source.y, target.x, target.y, this.layoutDirection);
      const isLoopExit = edge.isLoopExit === true;
      const group = this.svgEl.createSvg('g', {
        attr: {
          class: 'rp-protocol-editor-edge-group',
          'data-edge-id': edge.id,
          role: 'button',
          tabindex: '0',
          'aria-label': this.plugin.i18n.t('protocolEditor.editEdge'),
        },
      }) as SVGGElement;
      const openEdge = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.openEdgeModal(edge);
      };
      group.addEventListener('click', openEdge);
      group.addEventListener('dblclick', openEdge);
      group.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          openEdge(e);
          return;
        }
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        e.stopPropagation();
        void this.deleteEdge(edge.id);
      });
      group.createSvg('path', {
        attr: {
          d: route.d,
          class: 'rp-protocol-editor-edge-hitbox',
        },
      });
      const edgePathEl = group.createSvg('path', {
        attr: {
          d: route.d,
          class: 'rp-protocol-editor-edge',
        },
      }) as SVGPathElement;
      // Loop exits carry `isLoopExit`; the modifier class lets CSS render them
      // apart from the loop body edges (green), matching the loop badge cue on
      // the source node.
      if (isLoopExit) edgePathEl.classList.add('is-loop-exit');
      const effectiveLabel = shouldDisplayProtocolEditorEdgeLabel(edge, from, to)
        ? deriveProtocolEditorEdgeLabel(to, edge.label)
        : undefined;
      if (effectiveLabel !== undefined && effectiveLabel.trim() !== '') {
        const labelGroup = group.createSvg('g', { attr: { class: 'rp-protocol-editor-edge-label-group' } });
        const labelText = displayProtocolEditorEdgeLabel(effectiveLabel);
        const labelX = route.labelX;
        const labelY = route.labelY;
        const approxWidth = Math.min(220, Math.max(48, labelText.length * 7 + 18));
        labelGroup.createSvg('rect', {
          attr: {
            x: String(labelX - approxWidth / 2),
            y: String(labelY - 15),
            width: String(approxWidth),
            height: '22',
            rx: '11',
            class: 'rp-protocol-editor-edge-label-bg',
          },
        });
        const label = labelGroup.createSvg('text', {
          attr: {
            x: String(labelX),
            y: String(labelY),
            class: 'rp-protocol-editor-edge-label',
            'text-anchor': 'middle',
          },
        });
        label.textContent = labelText.length > 28 ? `${labelText.slice(0, 27)}…` : labelText; // User-authored protocol text
      }
    }
  }

  /**
   * Incrementally update edge path geometry in-place during drag/resize.
   * Unlike renderEdges(), this does NOT destroy or recreate SVG elements —
   * it only updates the `d` attribute on existing hitbox and visible path elements,
   * plus label position. Modeled after updateConnectionPreview() at line 1093.
   * Uses cached live node geometry first, falling back to document coordinates,
   * so drag listeners remain correct after async saves replace this.doc.
   */
  private updateEdgePaths(): void {
    if (this.doc === null || this.svgEl === null) return;
    const nodeById = new Map(this.doc.nodes.map(node => [node.id, node]));
    const outputSide = protocolEditorOutputPortSide(this.layoutDirection);
    const inputSide = protocolEditorInputPortSide(this.layoutDirection);
    for (const edge of this.doc.edges) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (from === undefined || to === undefined) continue;
      // Use live geometry when available, fall back to document coordinates
      const source = protocolEditorAnchorToSurfacePoint(protocolEditorPortAnchor(this.currentNodeGeometry(from), outputSide));
      const target = protocolEditorAnchorToSurfacePoint(protocolEditorPortAnchor(this.currentNodeGeometry(to), inputSide));
      const route = protocolEditorEdgeRoute(source.x, source.y, target.x, target.y, this.layoutDirection);
      const group = this.svgEl.querySelector(`[data-edge-id="${CSS.escape(edge.id)}"]`) as SVGGElement | null;
      if (group === null) continue;
      const hitboxEl = group.querySelector('.rp-protocol-editor-edge-hitbox') as SVGPathElement | null;
      if (hitboxEl !== null) hitboxEl.setAttr('d', route.d);
      const pathEl = group.querySelector('.rp-protocol-editor-edge') as SVGPathElement | null;
      if (pathEl !== null) pathEl.setAttr('d', route.d);
      const labelGroup = group.querySelector('.rp-protocol-editor-edge-label-group') as SVGGElement | null;
      if (labelGroup !== null) {
        const rectEl = labelGroup.querySelector('rect');
        const textEl = labelGroup.querySelector('text');
        if (rectEl !== null && textEl !== null) {
          const labelText = textEl.textContent ?? '';
          const approxWidth = Math.min(220, Math.max(48, labelText.length * 7 + 18));
          rectEl.setAttr('x', String(route.labelX - approxWidth / 2));
          rectEl.setAttr('y', String(route.labelY - 15));
          rectEl.setAttr('width', String(approxWidth));
          textEl.setAttr('x', String(route.labelX));
          textEl.setAttr('y', String(route.labelY));
        }
      }
    }
  }

  private renderMinimap(): void {
    if (this.doc === null || this.minimapSvgEl === null) return;
    this.minimapSvgEl.empty();

    const nodeById = new Map(this.doc.nodes.map(node => [node.id, node]));

    // Compute content bounds so the viewBox fits all nodes with some padding.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.doc.nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      const right = node.x + node.width;
      const bottom = node.y + node.height;
      if (right > maxX) maxX = right;
      if (bottom > maxY) maxY = bottom;
    }
    // Include edges in bounds
    for (const edge of this.doc.edges) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (from === undefined || to === undefined) continue;
      const x1 = from.x + from.width;
      const x2 = to.x;
      if (x1 < minX) minX = x1;
      if (x2 < minX) minX = x2;
      if (x1 > maxX) maxX = x1;
      if (x2 > maxX) maxX = x2;
      const y1 = from.y + from.height / 2;
      const y2 = to.y + to.height / 2;
      if (y1 < minY) minY = y1;
      if (y2 < minY) minY = y2;
      if (y1 > maxY) maxY = y1;
      if (y2 > maxY) maxY = y2;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      minX = -100;
      minY = -100;
      maxX = 100;
      maxY = 100;
    }

    const PADDING = 80;
    const vbWidth = Math.max(maxX - minX + PADDING * 2, 300);
    const vbHeight = Math.max(maxY - minY + PADDING * 2, 220);
    const vbX = minX - PADDING;
    const vbY = minY - PADDING;
    this.minimapWorldBounds = { x: vbX, y: vbY, width: vbWidth, height: vbHeight };
    this.minimapSvgEl.setAttr('viewBox', `${vbX} ${vbY} ${vbWidth} ${vbHeight}`);

    // Adaptive container size: match the element's aspect ratio to the
    // content's aspect ratio, bounded by the live viewport of the editor
    // (~90% width / ~92% height) so large protocols can use nearly the whole
    // canvas while small ones stay compact. The SVG keeps
    // preserveAspectRatio="none", which stays distortion-free because the
    // element aspect tracks the viewBox aspect.
    const MINIMAP_MIN_WIDTH = 180;
    const MINIMAP_MIN_HEIGHT = 130;
    let MINIMAP_MAX_WIDTH = 640;
    let MINIMAP_MAX_HEIGHT = 720;
    const vpW = this.viewportEl?.clientWidth ?? 0;
    const vpH = this.viewportEl?.clientHeight ?? 0;
    if (Number.isFinite(vpW) && vpW > 0 && Number.isFinite(vpH) && vpH > 0) {
      MINIMAP_MAX_WIDTH = Math.max(MINIMAP_MIN_WIDTH, Math.round(vpW * 0.9));
      MINIMAP_MAX_HEIGHT = Math.max(MINIMAP_MIN_HEIGHT, Math.round(vpH * 0.92));
    }
    if (this.minimapEl !== null) {
      const scale = Math.min(MINIMAP_MAX_WIDTH / vbWidth, MINIMAP_MAX_HEIGHT / vbHeight);
      let cssWidth = vbWidth * scale;
      let cssHeight = vbHeight * scale;
      if (cssWidth < MINIMAP_MIN_WIDTH) {
        cssHeight *= MINIMAP_MIN_WIDTH / cssWidth;
        cssWidth = MINIMAP_MIN_WIDTH;
      }
      if (cssHeight < MINIMAP_MIN_HEIGHT) {
        cssWidth *= MINIMAP_MIN_HEIGHT / cssHeight;
        cssHeight = MINIMAP_MIN_HEIGHT;
      }
      this.minimapEl.setCssProps({
        '--rp-minimap-width': `${Math.round(cssWidth)}px`,
        '--rp-minimap-height': `${Math.round(cssHeight)}px`,
      });
    }

    // Background
    this.minimapSvgEl.createSvg('rect', {
      attr: {
        x: String(vbX),
        y: String(vbY),
        width: String(vbWidth),
        height: String(vbHeight),
        class: 'rp-protocol-editor-minimap-bg',
      },
    });

    // Edges
    for (const edge of this.doc.edges) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (from === undefined || to === undefined) continue;
      const minimapEdgeEl = this.minimapSvgEl.createSvg('line', {
        attr: {
          x1: String(from.x + from.width / 2),
          y1: String(from.y + from.height / 2),
          x2: String(to.x + to.width / 2),
          y2: String(to.y + to.height / 2),
          class: 'rp-protocol-editor-minimap-edge',
        },
      });
      if (edge.isLoopExit === true) minimapEdgeEl.classList.add('is-loop-exit');
    }

    // Nodes — deliberately no SVG <title> tooltips: they duplicated the node
    // title already visible on the canvas and added hover noise while panning.
    for (const node of this.doc.nodes) {
      this.minimapSvgEl.createSvg('rect', {
        attr: {
          x: String(node.x),
          y: String(node.y),
          width: String(node.width),
          height: String(node.height),
          rx: '4',
          class: `rp-protocol-editor-minimap-node rp-protocol-editor-minimap-node-${nodeKindToken(node.kind)}`,
        },
      });
    }

    this.minimapViewportEl = this.minimapSvgEl.createSvg('rect', {
      attr: {
        class: 'rp-protocol-editor-minimap-viewport',
        x: '0',
        y: '0',
        width: '0',
        height: '0',
      },
    }) as SVGRectElement;
    this.updateMinimapViewport();
  }

  private updateMinimapViewport(): void {
    if (this.viewportEl === null || this.minimapViewportEl === null) return;
    const x = this.viewportEl.scrollLeft / this.zoom - PROTOCOL_EDITOR_ORIGIN_X;
    const y = this.viewportEl.scrollTop / this.zoom - PROTOCOL_EDITOR_ORIGIN_Y;
    const width = this.viewportEl.clientWidth / this.zoom;
    const height = this.viewportEl.clientHeight / this.zoom;
    this.minimapViewportEl.setAttr('x', String(x));
    this.minimapViewportEl.setAttr('y', String(y));
    this.minimapViewportEl.setAttr('width', String(width));
    this.minimapViewportEl.setAttr('height', String(height));
  }

  private centerViewportOnSurfacePoint(surfaceX: number, surfaceY: number): void {
    if (this.viewportEl === null) return;
    this.viewportEl.scrollLeft = (surfaceX + PROTOCOL_EDITOR_ORIGIN_X) * this.zoom - this.viewportEl.clientWidth / 2;
    this.viewportEl.scrollTop = (surfaceY + PROTOCOL_EDITOR_ORIGIN_Y) * this.zoom - this.viewportEl.clientHeight / 2;
    this.updateMinimapViewport();
    this.scheduleViewportSave();
  }

  private minimapClientPointToSurfacePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    if (this.minimapSvgEl === null || this.minimapWorldBounds === null) return null;
    const rect = this.minimapSvgEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: this.minimapWorldBounds.x + ((clientX - rect.left) / rect.width) * this.minimapWorldBounds.width,
      y: this.minimapWorldBounds.y + ((clientY - rect.top) / rect.height) * this.minimapWorldBounds.height,
    };
  }

  private panViewportFromMinimapPointer(clientX: number, clientY: number): void {
    const point = this.minimapClientPointToSurfacePoint(clientX, clientY);
    if (point === null) return;
    this.centerViewportOnSurfacePoint(point.x, point.y);
  }

  private async deleteEdge(edgeId: string): Promise<void> {
    if (this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    try {
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        return {
          ...existing,
          edges: removeProtocolEditorEdge(existing.edges, edgeId),
          viewport: this.currentViewportState(),
          updatedAt: new Date().toISOString(),
        };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      new Notice(this.plugin.i18n.t('protocolEditor.edgeDeleted'));
      await this.loadProtocol(owner.path, owner);
    } catch (err) {
      new Notice(this.plugin.i18n.t('protocolEditor.deleteFailed', { error: String(err) }));
    } finally {
      if (this.documentOwner.isCurrent(owner)) this.restoreEditorFocus();
    }
  }

  private applyNodePosition(nodeEl: HTMLElement, node: ProtocolNodeRecord): void {
    this.rememberLiveNodeGeometry(node);
    nodeEl.setAttr('style', `left:${worldXToSurfaceX(node.x)}px;top:${worldYToSurfaceY(node.y)}px;width:${node.width}px;min-height:${node.height}px;${node.color !== undefined ? `--rp-node-color:${node.color};` : ''}`);
  }

  private fallbackNodeGeometry(node: ProtocolNodeRecord): ProtocolEditorMeasuredNodeGeometry {
    const measurement = protocolEditorNodeMeasurement(node);
    return {
      x: node.x,
      y: node.y,
      width: measurement.width,
      height: measurement.height,
    };
  }

  private rememberLiveNodeGeometry(node: Pick<ProtocolNodeRecord, 'id' | 'x' | 'y' | 'width' | 'height'>): void {
    this.liveNodeGeometryById.set(node.id, {
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    });
  }

  private currentNodeGeometry(node: ProtocolNodeRecord): ProtocolEditorMeasuredNodeGeometry {
    return this.liveNodeGeometryById.get(node.id) ?? this.fallbackNodeGeometry(node);
  }

  private collectCurrentNodeGeometry(): Map<string, ProtocolEditorMeasuredNodeGeometry> {
    const geometry = new Map<string, ProtocolEditorMeasuredNodeGeometry>();
    if (this.doc === null) return geometry;
    for (const node of this.doc.nodes) {
      const nodeEl = this.nodeElementById.get(node.id);
      if (nodeEl === undefined) {
        geometry.set(node.id, this.fallbackNodeGeometry(node));
        continue;
      }
      const left = parseFloat(nodeEl.style.left || '0');
      const top = parseFloat(nodeEl.style.top || '0');
      const measurement = protocolEditorNormalizeNodeMeasurement(nodeEl.offsetWidth, nodeEl.offsetHeight);
      geometry.set(node.id, {
        x: left - PROTOCOL_EDITOR_ORIGIN_X,
        y: top - PROTOCOL_EDITOR_ORIGIN_Y,
        width: measurement.width,
        height: measurement.height,
      });
    }
    return geometry;
  }

  private bindConnectionDrag(outputPort: HTMLElement, node: ProtocolNodeRecord): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    outputPort.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0 || this.svgEl === null) return;
      // Slice 8 — silent gesture-start guard: a managed protocol must never
      // begin a connection gesture (finishConnectionDrag would reject it, but
      // the visible gesture-start is cosmetic noise).
      if (this.libraryReadOnly) return;
      e.preventDefault();
      e.stopPropagation();

      const start = protocolEditorAnchorToSurfacePoint(protocolEditorPortAnchor(node, protocolEditorOutputPortSide(this.layoutDirection)));
      const previewPath = this.svgEl.createSvg('path', {
        attr: {
          d: protocolEditorEdgeRoute(start.x, start.y, start.x + (this.layoutDirection === 'TB' ? 0 : 80), start.y + (this.layoutDirection === 'TB' ? 80 : 0), this.layoutDirection).d,
          class: 'rp-protocol-editor-edge rp-protocol-editor-edge-preview',
        },
      }) as SVGPathElement;
      this.connectionDragState = { fromNodeId: node.id, startX: start.x, startY: start.y, previewPath };

      const onMove = (ev: MouseEvent) => this.updateConnectionPreview(ev);
      const onUp = (ev: MouseEvent) => {
        void this.finishConnectionDrag(ev);
      };

      this.bindOwnedPointerGesture(owner, onMove, onUp, () => {
        previewPath.remove();
        this.connectionDragState = null;
      });
    });
  }

  private updateConnectionPreview(ev: MouseEvent): void {
    if (this.connectionDragState === null || this.viewportEl === null) return;
    const point = this.clientPointToCanvasPoint(ev.clientX, ev.clientY);
    this.connectionDragState.previewPath.setAttr('d', protocolEditorEdgeRoute(
      this.connectionDragState.startX,
      this.connectionDragState.startY,
      point.x,
      point.y,
      this.layoutDirection,
    ).d);
  }

  private findInputPortAt(clientX: number, clientY: number): HTMLElement | null {
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const direct = target?.closest('.rp-protocol-editor-port-input') as HTMLElement | null;
    if (direct !== null) return direct;

    let best: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    const tolerance = 32;
    for (const port of Array.from(document.querySelectorAll('.rp-protocol-editor-port-input')) as HTMLElement[]) {
      const rect = port.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const distance = Math.hypot(clientX - cx, clientY - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = port;
      }
    }
    return bestDistance <= tolerance ? best : null;
  }

  private async finishConnectionDrag(ev: MouseEvent): Promise<void> {
    const state = this.connectionDragState;
    this.connectionDragState = null;
    state?.previewPath.remove();
    if (state === null || this.doc === null || this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;

    const inputPort = this.findInputPortAt(ev.clientX, ev.clientY);
    const toNodeId = inputPort?.getAttr('data-node-id');

    if (toNodeId === undefined || toNodeId === null) {
      // Dropped on empty canvas — open node kind picker and create node + edge
      const worldPoint = this.clientPointToWorldPoint(ev.clientX, ev.clientY);
      this.openNodeKindPickerAndConnectAtWorldPoint(
        state.fromNodeId,
        worldPoint.x - DEFAULT_NODE_WIDTH / 2,
        worldPoint.y - DEFAULT_NODE_HEIGHT / 2,
      );
      return;
    }

    const decision = canCreateProtocolEditorEdge(this.doc.edges, state.fromNodeId, toNodeId);
    if (decision === 'self') {
      new Notice(this.plugin.i18n.t('protocolEditor.selfEdgeRejected'));
      return;
    }
    if (decision === 'duplicate') {
      new Notice(this.plugin.i18n.t('protocolEditor.duplicateEdgeRejected'));
      return;
    }

    const sourceNode = this.doc.nodes.find((node) => node.id === state.fromNodeId);
    const targetNode = this.doc.nodes.find((node) => node.id === toNodeId);
    const defaultLabel = defaultProtocolEditorEdgeLabelForTarget(targetNode);
    const newEdge: ProtocolEdgeRecord = {
      id: edgeUid(),
      fromNodeId: state.fromNodeId,
      toNodeId,
      label: shouldDisplayProtocolEditorEdgeLabel(
        { id: 'preview', fromNodeId: state.fromNodeId, toNodeId, label: defaultLabel },
        sourceNode,
        targetNode,
      ) ? defaultLabel : undefined,
    };

    const owner = this.documentOwner.capture();
    if (owner === null) return;
    try {
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        const currentDecision = canCreateProtocolEditorEdge(existing.edges, state.fromNodeId, toNodeId);
        if (currentDecision !== 'ok') return existing;
        const nodes = appendEdgeIdToOptionOrder(existing.nodes, state.fromNodeId, newEdge.id);
        return { ...existing, nodes, edges: [...existing.edges, newEdge], viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      new Notice(this.plugin.i18n.t('protocolEditor.edgeCreated'));
      await this.loadProtocol(owner.path, owner);
    } catch (err) {
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    }
  }

  private openSelfCheckModal(): void {
    if (this.doc === null || this.protocolPath === null) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const backdrop = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = backdrop.createDiv({ cls: 'rp-protocol-editor-modal rp-protocol-editor-self-check-modal' });
    modal.createEl('h3', { text: t('selfCheck.title') });
    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });
    const enabledRow = body.createEl('label', { cls: 'rp-protocol-editor-self-check-enabled' });
    const enabledCheckbox = enabledRow.createEl('input', { type: 'checkbox' });
    enabledCheckbox.checked = this.doc.selfCheckEnabled === true;
    enabledRow.createSpan({ text: t('selfCheck.enabled') });
    const rows = body.createDiv({ cls: 'rp-protocol-editor-self-check-list' });
    const values = [...(this.doc.selfCheckItems ?? []), ''];
    let enabled = enabledCheckbox.checked;

    const closeModal = this.documentOwner.own(owner, () => backdrop.remove());
    const persist = async () => {
      if (!this.documentOwner.isCurrent(owner) || this.isLibraryReadOnly()) return;
      const items = values.map(value => value.trim()).filter(value => value.length > 0);
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        return { ...existing, selfCheckEnabled: enabled, selfCheckItems: items, updatedAt: new Date().toISOString() };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      if (this.doc !== null) this.doc = { ...this.doc, selfCheckEnabled: enabled, selfCheckItems: items };
    };
    const createSelfCheckRow = (index: number) => {
      const row = rows.createDiv({ cls: 'rp-protocol-editor-self-check-row' });
      const input = row.createEl('input', {
        type: 'text',
        value: values[index] ?? '',
        attr: { placeholder: t('selfCheck.addItem') },
      });
      const removeBtn = row.createEl('button', {
        cls: 'rp-protocol-editor-modal-btn',
        text: '×',
        attr: { 'aria-label': t('selfCheck.removeItem') },
      });
      input.addEventListener('input', () => {
        values[index] = input.value;
        if (index === values.length - 1 && input.value.trim().length > 0) {
          values.push('');
          createSelfCheckRow(values.length - 1);
        }
        void persist();
      });
      removeBtn.addEventListener('click', () => {
        values[index] = '';
        row.remove();
        void persist();
      });
    };
    const renderRows = () => {
      rows.empty();
      rows.toggle(enabled);
      if (!enabled) return;
      if (values.length === 0 || values[values.length - 1]?.trim().length !== 0) values.push('');
      for (let index = 0; index < values.length; index += 1) createSelfCheckRow(index);
    };
    enabledCheckbox.addEventListener('change', () => {
      enabled = enabledCheckbox.checked;
      renderRows();
      void persist();
    });
    renderRows();

    const footer = modal.createDiv({ cls: 'rp-protocol-editor-modal-footer' });
    const doneBtn = footer.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-primary',
      text: t('protocolEditor.save'),
    });
    doneBtn.addEventListener('click', () => {
      void persist().then(closeModal);
    });
    const backdropGuard = createModalBackdropCloseGuard(backdrop);
    backdrop.addEventListener('pointerdown', backdropGuard.onPointerDown);
    backdrop.addEventListener('click', (e) => {
      if (backdropGuard.shouldCloseOnClick(e)) closeModal();
    });
  }

  /**
   * Author the per-protocol conclusion-draft preset. One non-empty line becomes
   * one editable Runner draft item; the Runner seeds its draft panel from this
   * array when a session starts. Persistence is debounced while typing and
   * flushed on Save/close so a long draft does not write on every keystroke.
   */
  private openConclusionDraftModal(): void {
    if (this.doc === null || this.protocolPath === null) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const backdrop = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = backdrop.createDiv({ cls: 'rp-protocol-editor-modal rp-protocol-editor-conclusion-draft-modal' });
    modal.createEl('h3', { text: t('protocolEditor.conclusionDraftTitle') });
    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });
    body.createDiv({
      cls: 'rp-protocol-editor-modal-help',
      text: t('protocolEditor.conclusionDraftHelp'),
    });
    const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field' });
    const textareaId = `rp-conclusion-draft-items-${++nextConclusionDraftFieldId}`;
    field.createEl('label', {
      text: t('protocolEditor.conclusionDraftLabel'),
      attr: { for: textareaId },
    });
    const textarea = field.createEl('textarea', {
      attr: {
        id: textareaId,
        rows: '6',
        placeholder: t('protocolEditor.conclusionDraftPlaceholder'),
      },
    });
    textarea.value = (this.doc.conclusionDraftItems ?? []).join('\n');

    let saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const readItems = (): string[] => textarea.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const persist = async (): Promise<void> => {
      if (!this.documentOwner.isCurrent(owner) || this.libraryReadOnly) return;
      const items = readItems();
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        return {
          ...existing,
          conclusionDraftItems: items.length > 0 ? items : undefined,
          updatedAt: new Date().toISOString(),
        };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      if (this.doc !== null) {
        this.doc = { ...this.doc, conclusionDraftItems: items.length > 0 ? items : undefined };
      }
    };
    const reportSaveFailure = (error: unknown): void => {
      console.error('[Protocol Former] Conclusion draft preset save failed:', error);
      new Notice(t('protocolEditor.saveFailed', { error: String(error) }));
    };
    const flush = async (): Promise<void> => {
      if (saveTimer !== null) {
        globalThis.clearTimeout(saveTimer);
        saveTimer = null;
      }
      await persist();
    };
    textarea.addEventListener('input', () => {
      if (saveTimer !== null) globalThis.clearTimeout(saveTimer);
      saveTimer = globalThis.setTimeout(() => {
        saveTimer = null;
        void persist().catch(reportSaveFailure);
      }, 400);
    });

    const closeModal = this.documentOwner.own(owner, () => {
      if (saveTimer !== null) {
        globalThis.clearTimeout(saveTimer);
        saveTimer = null;
      }
      backdrop.remove();
    });
    const saveAndClose = (): void => {
      void flush().then(closeModal).catch(reportSaveFailure);
    };

    const footer = modal.createDiv({ cls: 'rp-protocol-editor-modal-footer' });
    const doneBtn = footer.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-primary',
      text: t('protocolEditor.save'),
    });
    doneBtn.addEventListener('click', saveAndClose);
    const backdropGuard = createModalBackdropCloseGuard(backdrop);
    backdrop.addEventListener('pointerdown', backdropGuard.onPointerDown);
    backdrop.addEventListener('click', (e) => {
      if (backdropGuard.shouldCloseOnClick(e)) saveAndClose();
    });
  }

  /* Phase 4D — bind mouse drag events to a node element */
  private bindDrag(nodeEl: HTMLElement, node: ProtocolNodeRecord): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    nodeEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.rp-protocol-editor-port') !== null) return;
      // Slice 8 — silent gesture-start guard: managed nodes never visibly move.
      if (this.libraryReadOnly) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = node.x;
      const origY = node.y;

      nodeEl.addClass('rp-node-dragging');
      document.body.addClass('rp-protocol-editor-drag-active');

      let dragRafId: number | null = null;
      const onMove = (ev: MouseEvent) => {
        const dx = screenDeltaToProtocolEditorDelta(ev.clientX - startX, this.zoom);
        const dy = screenDeltaToProtocolEditorDelta(ev.clientY - startY, this.zoom);
        node.x = origX + dx;
        node.y = origY + dy;
        // Batch position writes and edge updates into a single rAF frame
        if (dragRafId === null) {
          dragRafId = window.requestAnimationFrame(() => {
            dragRafId = null;
            this.applyNodePosition(nodeEl, node);
            this.updateEdgePaths();
          });
        }
      };

      const onUp = (ev: MouseEvent) => {
        if (dragRafId !== null) {
          window.cancelAnimationFrame(dragRafId);
          dragRafId = null;
        }
        nodeEl.removeClass('rp-node-dragging');
        document.body.removeClass('rp-protocol-editor-drag-active');
        this.restoreEditorFocus();

        const dx = screenDeltaToProtocolEditorDelta(ev.clientX - startX, this.zoom);
        const dy = screenDeltaToProtocolEditorDelta(ev.clientY - startY, this.zoom);
        const newX = Math.round(origX + dx);
        const newY = Math.round(origY + dy);

        if (newX === origX && newY === origY) return;

        node.x = newX;
        node.y = newY;
        this.applyNodePosition(nodeEl, node);
        this.updateEdgePaths();
        void this.saveNodeGeometry(node);
      };

      this.bindOwnedPointerGesture(owner, onMove, onUp, () => {
        if (dragRafId !== null) window.cancelAnimationFrame(dragRafId);
        nodeEl.removeClass('rp-node-dragging');
        document.body.removeClass('rp-protocol-editor-drag-active');
      });
    });
  }

  private bindResize(handleEl: HTMLElement, nodeEl: HTMLElement, node: ProtocolNodeRecord): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    handleEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0) return;
      // Slice 8 — silent gesture-start guard: managed nodes never visibly resize.
      if (this.libraryReadOnly) return;
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      const origWidth = node.width;
      const origHeight = node.height;

      nodeEl.addClass('rp-node-resizing');
      document.body.addClass('rp-protocol-editor-resize-active');

      let resizeRafId: number | null = null;
      const onMove = (ev: MouseEvent) => {
        const dx = screenDeltaToProtocolEditorDelta(ev.clientX - startX, this.zoom);
        const dy = screenDeltaToProtocolEditorDelta(ev.clientY - startY, this.zoom);
        node.width = Math.max(MIN_NODE_WIDTH, origWidth + dx);
        node.height = Math.max(MIN_NODE_HEIGHT, origHeight + dy);
        if (resizeRafId === null) {
          resizeRafId = window.requestAnimationFrame(() => {
            resizeRafId = null;
            this.applyNodePosition(nodeEl, node);
            this.updateEdgePaths();
          });
        }
      };

      const onUp = (ev: MouseEvent) => {
        if (resizeRafId !== null) {
          window.cancelAnimationFrame(resizeRafId);
          resizeRafId = null;
        }
        nodeEl.removeClass('rp-node-resizing');
        document.body.removeClass('rp-protocol-editor-resize-active');
        this.restoreEditorFocus();

        const dx = screenDeltaToProtocolEditorDelta(ev.clientX - startX, this.zoom);
        const dy = screenDeltaToProtocolEditorDelta(ev.clientY - startY, this.zoom);
        const newWidth = Math.max(MIN_NODE_WIDTH, Math.round(origWidth + dx));
        const newHeight = Math.max(MIN_NODE_HEIGHT, Math.round(origHeight + dy));
        if (newWidth === origWidth && newHeight === origHeight) return;
        node.width = newWidth;
        node.height = newHeight;
        this.applyNodePosition(nodeEl, node);
        this.renderEdges();
        void this.saveNodeGeometry(node);
      };

      this.bindOwnedPointerGesture(owner, onMove, onUp, () => {
        if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
        nodeEl.removeClass('rp-node-resizing');
        document.body.removeClass('rp-protocol-editor-resize-active');
      });
    });
  }

  /* Phase 4D — persist node position/size change */
  private async saveNodeGeometry(node: ProtocolNodeRecord): Promise<void> {
    if (this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;

    const geometry = {
      id: node.id,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height),
    };
    const viewport = this.currentViewportState();

    const owner = this.documentOwner.capture();
    if (owner === null) return;
    try {
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        const nodes = existing.nodes.map((n) =>
          n.id === geometry.id
            ? { ...n, x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height }
            : n,
        );
        return { ...existing, nodes, viewport, updatedAt: new Date().toISOString() };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;

      this.doc = updated;
      const nodeEl = this.nodeElementById.get(geometry.id);
      const updatedNode = updated.nodes.find((n) => n.id === geometry.id);
      if (nodeEl !== undefined && updatedNode !== undefined) {
        this.applyNodePosition(nodeEl, updatedNode);
      }
      this.updateEdgePaths();
      this.renderMinimap();
    } catch (err) {
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    }
  }

  private bindViewportControls(): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    if (this.viewportEl === null) return;

    this.viewportEl.addEventListener('dblclick', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0) return;
      const target = e.target as Element;
      if (target.closest('.rp-protocol-editor-minimap') !== null) return;
      if (target.closest('.rp-protocol-editor-node') !== null) return;
      if (target.closest('.rp-protocol-editor-port') !== null) return;
      if (target.closest('.rp-protocol-editor-edge-group') !== null) return;
      e.preventDefault();
      e.stopPropagation();
      const point = this.clientPointToWorldPoint(e.clientX, e.clientY);
      this.openNodeKindPickerAtWorldPoint(point.x - DEFAULT_NODE_WIDTH / 2, point.y - DEFAULT_NODE_HEIGHT / 2);
    });

    this.viewportEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0 || e.detail > 1) return;
      const target = e.target as Element;
      if (target.closest('.rp-protocol-editor-minimap') !== null) return;
      if (target.closest('.rp-protocol-editor-node') !== null) return;
      if (target.closest('.rp-protocol-editor-port') !== null) return;
      if (target.closest('.rp-protocol-editor-edge-group') !== null) return;
      e.preventDefault();
      if (this.viewportEl === null) return;
      this.viewportEl.addClass('is-panning');
      this.panState = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startScrollLeft: this.viewportEl.scrollLeft,
        startScrollTop: this.viewportEl.scrollTop,
      };

      const onMove = (ev: MouseEvent) => {
        if (this.viewportEl === null || this.panState === null) return;
        this.viewportEl.scrollLeft = this.panState.startScrollLeft - (ev.clientX - this.panState.startClientX);
        this.viewportEl.scrollTop = this.panState.startScrollTop - (ev.clientY - this.panState.startClientY);
        this.updateMinimapViewport();
      };
      const onUp = () => {
        this.viewportEl?.removeClass('is-panning');
        this.panState = null;
        this.restoreEditorFocus();
        void this.persistViewportState();
      };
      this.bindOwnedPointerGesture(owner, onMove, onUp, () => {
        this.viewportEl?.removeClass('is-panning');
        this.panState = null;
      });
    });

    this.viewportEl.addEventListener('wheel', (e: WheelEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (!e.ctrlKey && !e.metaKey) return;
      if (this.viewportEl === null) return;
      e.preventDefault();

      const oldZoom = this.zoom;
      const direction = e.deltaY > 0 ? -1 : 1;
      const nextZoom = clampProtocolEditorZoom(oldZoom + direction * ZOOM_STEP);
      if (nextZoom === oldZoom) return;

      const rect = this.viewportEl.getBoundingClientRect();
      const anchorX = this.viewportEl.scrollLeft + e.clientX - rect.left;
      const anchorY = this.viewportEl.scrollTop + e.clientY - rect.top;
      const docX = anchorX / oldZoom;
      const docY = anchorY / oldZoom;

      this.zoom = nextZoom;
      this.applyZoom();
      this.viewportEl.scrollLeft = docX * nextZoom - (e.clientX - rect.left);
      this.viewportEl.scrollTop = docY * nextZoom - (e.clientY - rect.top);
      this.updateMinimapViewport();
      this.scheduleViewportSave();
    }, { passive: false });

    this.viewportEl.addEventListener('scroll', () => {
      if (!this.documentOwner.isCurrent(owner)) return;
      this.updateMinimapViewport();
      this.scheduleViewportSave();
    });
  }

  private autoLayoutNodes(direction: ProtocolEditorLayoutDirection): void {
    if (this.doc === null || this.protocolPath === null) return;
    if (this.isLibraryReadOnly()) return;
    const nodes = this.doc.nodes;
    const edges = this.doc.edges;
    if (nodes.length === 0) return;

    const layout = PROTOCOL_EDITOR_LAYOUT_CONFIG[direction];
    const g = new dagre.graphlib.Graph({ compound: false });
    g.setGraph({
      rankdir: layout.direction,
      nodesep: layout.nodesep,
      ranksep: layout.ranksep,
      edgesep: layout.edgesep,
      marginx: 64,
      marginy: 64,
    });
    g.setDefaultEdgeLabel(() => ({}));

    const currentGeometry = this.collectCurrentNodeGeometry();
    const nodeMap = new Map<string, ProtocolNodeRecord>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
      const measurement = currentGeometry.get(node.id) ?? this.fallbackNodeGeometry(node);
      g.setNode(node.id, measurement);
    }
    for (const edge of edges) {
      if (!nodeMap.has(edge.fromNodeId) || !nodeMap.has(edge.toNodeId)) continue;
      g.setEdge(edge.fromNodeId, edge.toNodeId);
    }

    dagre.layout(g);

    const positions = new Map<string, { x: number; y: number }>();
    const measuredSizes = new Map<string, ProtocolEditorNodeMeasurement>();
    for (const node of nodes) {
      const dagreNode = g.node(node.id);
      if (dagreNode === undefined) continue;
      const measurement = currentGeometry.get(node.id) ?? this.fallbackNodeGeometry(node);
      measuredSizes.set(node.id, { width: measurement.width, height: measurement.height });
      positions.set(node.id, {
        x: dagreNode.x - measurement.width / 2,
        y: dagreNode.y - measurement.height / 2,
      });
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      const p = positions.get(node.id);
      if (p === undefined) continue;
      const measurement = measuredSizes.get(node.id) ?? protocolEditorNodeMeasurement(node);
      if (p.x < minX) minX = p.x;
      if (p.x + measurement.width > maxX) maxX = p.x + measurement.width;
      if (p.y < minY) minY = p.y;
      if (p.y + measurement.height > maxY) maxY = p.y + measurement.height;
    }
    const shiftX = Number.isFinite(minX) && Number.isFinite(maxX) ? (minX + maxX) / 2 : 0;
    const shiftY = Number.isFinite(minY) && Number.isFinite(maxY) ? (minY + maxY) / 2 : 0;
    for (const position of positions.values()) {
      position.x = Math.round(position.x - shiftX);
      position.y = Math.round(position.y - shiftY);
    }

    this.layoutDirection = direction;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    void this.documentOwner.update(owner, (existing) => {
      if (existing === null) protocolMissingFileError();
      const updatedNodes = existing.nodes.map((n) => {
        const p = positions.get(n.id);
        if (p === undefined) return n;
        const measurement = measuredSizes.get(n.id) ?? protocolEditorNodeMeasurement(n);
        return { ...n, x: p.x, y: p.y, width: measurement.width, height: measurement.height };
      });
      return {
        ...existing,
        layoutDirection: direction,
        nodes: updatedNodes,
        viewport: this.currentViewportState(),
        updatedAt: new Date().toISOString(),
      };
    }).then(async (updated) => {
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      new Notice(this.plugin.i18n.t('protocolEditor.autoLayoutDone'));
      await this.loadProtocol(owner.path, owner);
    }).catch((err) => {
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    });
  }

  private toggleMinimap(): void {
    if (this.minimapEl === null) return;
    this.minimapEl.toggleClass('is-hidden', !this.minimapEl.hasClass('is-hidden'));
  }

  private bindMinimapControls(): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    if (this.minimapEl === null) return;

    this.minimapEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleMinimap();
      }
    });

    this.minimapEl.addEventListener('mousedown', (e: MouseEvent) => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.minimapEl?.addClass('is-dragging');
      this.panViewportFromMinimapPointer(e.clientX, e.clientY);

      const onMove = (ev: MouseEvent) => {
        ev.preventDefault();
        this.panViewportFromMinimapPointer(ev.clientX, ev.clientY);
      };
      const onUp = () => {
        this.minimapEl?.removeClass('is-dragging');
        void this.persistViewportState();
      };
      this.bindOwnedPointerGesture(owner, onMove, onUp, () => this.minimapEl?.removeClass('is-dragging'));
    });
  }

  private applyZoom(): void {
    const scaledWidth = `${DEFAULT_VIEWPORT_WIDTH * this.zoom}px`;
    const scaledHeight = `${DEFAULT_VIEWPORT_HEIGHT * this.zoom}px`;
    if (this.viewportEl !== null) {
      this.viewportEl.setAttr('data-zoom', String(this.zoom));
      this.viewportEl.setAttr('data-layout-direction', this.layoutDirection);
      this.viewportEl.style.setProperty('--rp-protocol-editor-zoom', String(this.zoom));
      const indicator = this.rootEl?.querySelector('.rp-protocol-editor-zoom-indicator');
      indicator?.setText(`${Math.round(this.zoom * 100)}%`);
    }
    if (this.surfaceEl !== null) {
      this.surfaceEl.setAttr('style', `width:${DEFAULT_VIEWPORT_WIDTH}px;height:${DEFAULT_VIEWPORT_HEIGHT}px;transform:scale(${this.zoom});`);
    }
    if (this.svgEl !== null) {
      this.svgEl.setAttr('viewBox', `0 0 ${DEFAULT_VIEWPORT_WIDTH} ${DEFAULT_VIEWPORT_HEIGHT}`);
      this.svgEl.setAttr('style', `width:${DEFAULT_VIEWPORT_WIDTH}px;height:${DEFAULT_VIEWPORT_HEIGHT}px;transform:scale(${this.zoom});`);
    }
    if (this.viewportEl !== null) {
      this.viewportEl.style.setProperty('--rp-protocol-editor-scaled-width', scaledWidth);
      this.viewportEl.style.setProperty('--rp-protocol-editor-scaled-height', scaledHeight);
    }
  }

  private clientPointToCanvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    if (this.viewportEl === null) return { x: 0, y: 0 };
    const rect = this.viewportEl.getBoundingClientRect();
    return {
      x: (this.viewportEl.scrollLeft + clientX - rect.left) / this.zoom,
      y: (this.viewportEl.scrollTop + clientY - rect.top) / this.zoom,
    };
  }

  private clientPointToWorldPoint(clientX: number, clientY: number): { x: number; y: number } {
    const point = this.clientPointToCanvasPoint(clientX, clientY);
    return { x: point.x - PROTOCOL_EDITOR_ORIGIN_X, y: point.y - PROTOCOL_EDITOR_ORIGIN_Y };
  }

  private bindOwnedPointerGesture(
    owner: EditorDocumentLease,
    move: (event: MouseEvent) => void,
    end: (event: MouseEvent) => void,
    cancel: () => void,
  ): void {
    let finished = false;
    const onMove = (event: MouseEvent) => {
      if (this.documentOwner.isCurrent(owner)) move(event);
    };
    const onUp = (event: MouseEvent) => {
      finished = true;
      dispose();
      if (this.documentOwner.isCurrent(owner)) end(event);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    const dispose = this.documentOwner.own(owner, () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (!finished) cancel();
    });
  }

  private restoreEditorFocus(): void {
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    window.requestAnimationFrame(() => {
      if (!this.documentOwner.isCurrent(owner)) return;
      if (this.viewportEl === null || !this.viewportEl.isConnected) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.rp-protocol-editor-modal') !== null) return;
      this.viewportEl.setAttr('tabindex', '-1');
      this.viewportEl.focus({ preventScroll: true });
    });
  }

  private restoreViewportState(): void {
    if (this.viewportEl === null || this.doc === null) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const viewport = this.doc.viewport ?? { x: 0, y: 0, zoom: this.zoom };
    window.requestAnimationFrame(() => {
      if (!this.documentOwner.isCurrent(owner) || this.viewportEl === null) return;
      this.viewportEl.scrollLeft = Math.max(0, viewport.x + PROTOCOL_EDITOR_ORIGIN_X * this.zoom);
      this.viewportEl.scrollTop = Math.max(0, viewport.y + PROTOCOL_EDITOR_ORIGIN_Y * this.zoom);
      this.updateMinimapViewport();
    });
  }

  private currentViewportState(): { x: number; y: number; zoom: number } {
    if (this.viewportEl === null) {
      return { x: this.doc?.viewport?.x ?? 0, y: this.doc?.viewport?.y ?? 0, zoom: this.zoom };
    }
    return {
      x: Math.round(this.viewportEl.scrollLeft - PROTOCOL_EDITOR_ORIGIN_X * this.zoom),
      y: Math.round(this.viewportEl.scrollTop - PROTOCOL_EDITOR_ORIGIN_Y * this.zoom),
      zoom: this.zoom,
    };
  }

  private scheduleViewportSave(): void {
    if (this.protocolPath === null || this.doc === null) return;
    this.clearPendingViewportSave();
    this.viewportSaveTimer = window.setTimeout(() => {
      void this.persistViewportState();
    }, 400);
  }

  private clearPendingViewportSave(): void {
    if (this.viewportSaveTimer !== null) {
      window.clearTimeout(this.viewportSaveTimer);
      this.viewportSaveTimer = null;
    }
  }

  private async persistViewportState(): Promise<void> {
    if (this.protocolPath === null || this.doc === null) return;
    if (this.isLibraryReadOnly()) return;
    this.clearPendingViewportSave();
    const viewport = this.currentViewportState();
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    try {
      const updated = await this.documentOwner.update(owner, (existing) => {
        if (existing === null) protocolMissingFileError();
        return { ...existing, viewport, updatedAt: new Date().toISOString() };
      });
      if (updated === null || !this.documentOwner.isCurrent(owner)) return;
      this.doc = { ...this.doc, viewport };
    } catch (err) {
      new Notice(this.plugin.i18n.t('protocolEditor.saveFailed', { error: String(err) }));
    }
  }

  private openEdgeModal(edge: ProtocolEdgeRecord): void {
    if (this.protocolPath === null || this.doc === null) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const modalEl = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = modalEl.createDiv({ cls: 'rp-protocol-editor-modal' });
    const header = modal.createDiv({ cls: 'rp-protocol-editor-modal-header' });
    header.createEl('h3', { text: t('protocolEditor.editEdge') });
    const closeBtn = header.createEl('button', { cls: 'rp-protocol-editor-modal-close', text: '✕', attr: { 'aria-label': t('protocolEditor.close') } });
    const closeModal = this.documentOwner.own(owner, () => {
      modalEl.remove();
      if (this.documentOwner.isCurrent(owner)) this.restoreEditorFocus();
    });
    closeBtn.addEventListener('click', closeModal);

    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });
    const nodes = this.doc.nodes;
    const nodeLabelForSelect = (node: ProtocolNodeRecord) => `${nodeTitle(node, this.plugin.i18n.t.bind(this.plugin.i18n))} (${node.kind ?? this.plugin.i18n.t('protocolEditor.untyped')})`;
    const addNodeSelect = (label: string, initial: string) => {
      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field' });
      field.createEl('label', { text: label });
      const select = field.createEl('select') as HTMLSelectElement;
      for (const node of nodes) {
        select.createEl('option', { attr: { value: node.id }, text: nodeLabelForSelect(node) });
      }
      select.value = initial;
      return select;
    };
    const fromSelect = addNodeSelect(t('protocolEditor.edgeFromLabel'), edge.fromNodeId);
    const toSelect = addNodeSelect(t('protocolEditor.edgeToLabel'), edge.toNodeId);
    const labelField = body.createDiv({ cls: 'rp-protocol-editor-modal-field' });
    labelField.createEl('label', { text: t('protocolEditor.edgeLabelLabel') });
    const labelInput = labelField.createEl('input', {
      attr: {
        type: 'text',
        value: displayProtocolEditorEdgeLabel(edge.label),
        placeholder: t('protocolEditor.edgeLabelPlaceholder'),
      },
    }) as HTMLInputElement;
    labelField.createDiv({ cls: 'rp-protocol-editor-modal-help', text: t('protocolEditor.edgeLabelHelp') });
    const exitField = body.createDiv({ cls: 'rp-protocol-editor-modal-field rp-protocol-editor-checkbox-field' });
    const exitLabel = exitField.createEl('label');
    const exitCheckbox = exitLabel.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
    exitLabel.appendText(` ${t('protocolEditor.loopExitLabel')}`);
    exitCheckbox.checked = edge.isLoopExit === true;
    const syncExitVisibility = () => {
      const fromNode = nodes.find((node) => node.id === fromSelect.value);
      const isLoopSource = fromNode?.kind === 'question' && fromNode.fields['loop'] === true;
      exitField.style.display = isLoopSource ? '' : 'none';
      if (!isLoopSource) exitCheckbox.checked = false;
    };
    fromSelect.addEventListener('change', syncExitVisibility);
    syncExitVisibility();

    const footer = modal.createDiv({ cls: 'rp-protocol-editor-modal-footer' });
    const deleteBtn = footer.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-danger',
      text: t('protocolEditor.deleteEdgeLabel'),
    });
    const actionBtns = footer.createDiv({ cls: 'modal-actions' });
    const cancelBtn = actionBtns.createEl('button', { cls: 'rp-protocol-editor-modal-btn', text: t('protocolEditor.cancel') });
    const saveBtn = actionBtns.createEl('button', { cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-primary', text: t('protocolEditor.save') });
    cancelBtn.addEventListener('click', closeModal);

    saveBtn.addEventListener('click', async () => {
      if (!this.documentOwner.isCurrent(owner)) return;
      const nextFrom = fromSelect.value;
      const nextTo = toSelect.value;
      const duplicate = this.doc?.edges.some((candidate) => candidate.id !== edge.id && candidate.fromNodeId === nextFrom && candidate.toNodeId === nextTo) ?? false;
      if (nextFrom === nextTo) { new Notice(t('protocolEditor.selfEdgeRejected')); return; }
      if (duplicate) { new Notice(t('protocolEditor.duplicateEdgeRejected')); return; }
      const selectedSource = nodes.find((node) => node.id === nextFrom);
      const selectedTarget = nodes.find((node) => node.id === nextTo);
      const typedLabel = normalizeProtocolEditorEdgeLabel(labelInput.value);
      const defaultLabel = defaultProtocolEditorEdgeLabelForTarget(selectedTarget);
      const nextIsLoopExit = exitCheckbox.checked ? true : undefined;
      const shouldDisplayLabel = shouldDisplayProtocolEditorEdgeLabel(
        { ...edge, fromNodeId: nextFrom, toNodeId: nextTo, label: typedLabel ?? defaultLabel, isLoopExit: nextIsLoopExit },
        selectedSource,
        selectedTarget,
      );
      const nextLabel = shouldDisplayLabel ? typedLabel ?? defaultLabel : undefined;
      if (this.isLibraryReadOnly()) return;
      try {
        const updated = await this.documentOwner.update(owner, (existing) => {
          if (existing === null) protocolMissingFileError();
          const nodes = existing.nodes.map((candidate) => {
            if (candidate.id !== nextTo || candidate.kind !== 'snippet' || typedLabel === undefined || nextIsLoopExit === true) {
              return candidate;
            }
            return {
              ...candidate,
              text: typedLabel,
              fields: {
                ...candidate.fields,
                snippetLabel: typedLabel,
              },
            };
          });
          const edges = existing.edges.map((candidate) => candidate.id === edge.id
            ? { ...candidate, fromNodeId: nextFrom, toNodeId: nextTo, label: nextLabel, isLoopExit: nextIsLoopExit }
            : candidate);
          return { ...existing, nodes, edges, viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
        });
        if (updated === null || !this.documentOwner.isCurrent(owner)) return;
        this.doc = updated;
        closeModal();
        new Notice(t('protocolEditor.edgeSaved'));
        void this.loadProtocol(owner.path, owner);
      } catch (err) {
        new Notice(t('protocolEditor.saveFailed', { error: String(err) }));
      }
    });

    deleteBtn.addEventListener('click', async () => {
      closeModal();
      if (this.documentOwner.isCurrent(owner)) await this.deleteEdge(edge.id);
    });

    const backdropGuard = createModalBackdropCloseGuard(modalEl);
    modalEl.addEventListener('pointerdown', backdropGuard.onPointerDown);
    modalEl.addEventListener('click', (e) => {
      if (backdropGuard.shouldCloseOnClick(e)) closeModal();
    });
  }

  /* Phase 4D — open edit modal for a node */
  private openEditModal(node: ProtocolNodeRecord, options?: { autofocusFirstTextField?: boolean }): void {
    if (this.protocolPath === null) return;
    const owner = this.documentOwner.capture();
    if (owner === null) return;
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    const modalEl = document.body.createDiv({ cls: 'rp-protocol-editor-modal-backdrop' });
    const modal = modalEl.createDiv({ cls: 'rp-protocol-editor-modal' });

    const header = modal.createDiv({ cls: 'rp-protocol-editor-modal-header' });
    header.createEl('h3', { text: t('protocolEditor.editNode') });
    const closeBtn = header.createEl('button', { cls: 'rp-protocol-editor-modal-close', text: '✕', attr: { 'aria-label': t('protocolEditor.close') } });
    let closeActiveSnippetTargetPicker: (() => void) | null = null;
    let optionOrderChipHandle: { destroy(): void } | null = null;
    const closeModal = this.documentOwner.own(owner, () => {
      if (closeActiveSnippetTargetPicker !== null) {
        closeActiveSnippetTargetPicker();
        closeActiveSnippetTargetPicker = null;
      }
      optionOrderChipHandle?.destroy();
      optionOrderChipHandle = null;
      modalEl.remove();
      if (this.documentOwner.isCurrent(owner)) this.restoreEditorFocus();
    });
    modalEl.setAttr('tabindex', '-1');
    modalEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (closeActiveSnippetTargetPicker !== null) {
        closeActiveSnippetTargetPicker();
        return;
      }
      closeModal();
    });
    closeBtn.addEventListener('click', closeModal);

    const body = modal.createDiv({ cls: 'rp-protocol-editor-modal-body' });

    const textControls: Array<{ key: string; value: () => string | boolean | string[] | undefined }> = [];
    const firstEditableField: Array<HTMLInputElement | HTMLTextAreaElement> = [];
    const addInput = (key: string, label: string, value: unknown, multiline = false): HTMLElement => {
      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field' });
      field.createEl('label', { text: label });
      const initialValue = typeof value === 'string' ? value : '';
      if (multiline) {
        const input = field.createEl('textarea') as HTMLTextAreaElement;
        input.value = initialValue;
        // Multiline node-body fields (questionText/answerText/content)
        // intentionally preserve an empty string. Empty answerText is a valid
        // skip-like answer, not an instruction to fall back to stale node.text.
        textControls.push({ key, value: () => input.value });
        if (firstEditableField.length === 0) firstEditableField.push(input);
      } else {
        const input = field.createEl('input', { attr: { type: 'text', value: initialValue } }) as HTMLInputElement;
        input.value = initialValue;
        textControls.push({ key, value: () => input.value || undefined });
        if (firstEditableField.length === 0) firstEditableField.push(input);
      }
      return field;
    };
    const addStartPointCheckbox = (): HTMLInputElement => {
      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field rp-protocol-editor-modal-checkbox-field rp-protocol-editor-modal-start-point-field' });
      const label = field.createEl('label');
      const input = label.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
      input.checked = node.fields['startPointEnabled'] === true;
      label.createSpan({ text: t('protocolEditor.startPointEnabledLabel') });
      textControls.push({ key: 'startPointEnabled', value: () => input.checked ? true : undefined });

      // Optional per-node label shown by the "start from specific node" picker
      // instead of the node's own caption. Only persisted while enabled.
      let labelInput: HTMLInputElement | null = null;
      const labelField = body.createDiv({
        cls: 'rp-protocol-editor-modal-field rp-protocol-editor-modal-start-point-label-field',
      });
      labelField.createEl('label', { text: t('protocolEditor.startPointCustomLabelLabel') });
      labelInput = labelField.createEl('input', {
        attr: {
          type: 'text',
          value: typeof node.fields['startPointLabel'] === 'string' ? node.fields['startPointLabel'] as string : '',
          placeholder: t('protocolEditor.startPointCustomLabelPlaceholder'),
        },
      }) as HTMLInputElement;
      if (firstEditableField.length === 0 && input.checked) firstEditableField.push(labelInput);
      textControls.push({
        key: 'startPointLabel',
        value: () => {
          if (!input.checked) return undefined;
          const trimmed = labelInput.value.trim();
          return trimmed === '' ? undefined : trimmed;
        },
      });
      const syncLabelVisibility = () => labelField.toggleClass('is-hidden', !input.checked);
      input.addEventListener('change', syncLabelVisibility);
      syncLabelVisibility();
      return input;
    };

    const addLoopToggle = (nodeRecord: ProtocolNodeRecord) => {
      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field rp-protocol-editor-checkbox-field' });
      const label = field.createEl('label');
      const input = label.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
      input.checked = nodeRecord.fields['loop'] === true;
      label.createSpan({ text: t('protocolEditor.loopToggleLabel') });
      textControls.push({ key: 'loop', value: () => input.checked ? true : undefined });
    };

    const addAnswerFreeTextToggle = (nodeRecord: ProtocolNodeRecord, answerTextField: HTMLElement) => {
      const field = body.createDiv({
        cls: 'rp-protocol-editor-modal-field rp-protocol-editor-checkbox-field',
      });
      const label = field.createEl('label');
      const input = label.createEl('input', {
        attr: { type: 'checkbox' },
      }) as HTMLInputElement;
      const canonicalFreeText = nodeRecord.fields['freeText'];
      input.checked = canonicalFreeText === true
        || (canonicalFreeText === undefined
          && nodeRecord.fields['radiprotocol_freeText'] === true);
      label.createSpan({ text: t('protocolEditor.freeTextAnswerLabel') });
      field.createDiv({
        cls: 'rp-protocol-editor-modal-help',
        text: t('protocolEditor.freeTextAnswerHelp'),
      });
      textControls.push({ key: 'freeText', value: () => input.checked });
      // Free-text Answers use the display label as the runner prompt; the
      // multiline answer text is not appended, so hide it to reduce noise.
      const syncAnswerTextVisibility = () => answerTextField.toggleClass('is-hidden', input.checked);
      input.addEventListener('change', syncAnswerTextVisibility);
      syncAnswerTextVisibility();
    };

    const addOptionOrderChips = (nodeRecord: ProtocolNodeRecord) => {
      const outgoing = (this.doc?.edges ?? []).filter((e) => e.fromNodeId === nodeRecord.id);
      const nodeById = new Map((this.doc?.nodes ?? []).map((n) => [n.id, n] as [string, ProtocolNodeRecord]));
      const items: OptionOrderChipItem[] = outgoing.map((e) => ({
        id: e.id,
        label: optionOrderChipLabel(e, nodeById.get(e.toNodeId)),
      }));
      const optionOrderRaw = nodeRecord.fields['optionOrder'];
      const originalOptionOrder = Array.isArray(optionOrderRaw)
        ? optionOrderRaw.filter((v): v is string => typeof v === 'string')
        : undefined;
      const originallyPresent = originalOptionOrder !== undefined;
      const draft = orderItemsByOptionOrder(items, originalOptionOrder);
      // FR-5/FR-9/backward-compat: persist only when the user reordered (modified)
      // OR the question already had an optionOrder — so saving a legacy question
      // without reordering does NOT activate the interleaved renderer (existing
      // protocols keep their grouped rendering) and does NOT scrub the field.
      // When the user reorders, preserve any original stale ids (edges since
      // deleted/reassigned) appended after the reordered live ids — stale ids are
      // filtered at render, never cleaned on write (FR-9).
      let modified = false;
      const container = body.createDiv();
      optionOrderChipHandle = mountOptionOrderChips(container, draft, () => { modified = true; }, { t });
      textControls.push({
        key: 'optionOrder',
        value: () => {
          if (!modified && !originallyPresent) return undefined;     // legacy save, no reorder → omit (fallback preserved)
          if (!modified) return originalOptionOrder;                 // originally present, untouched → preserve verbatim (incl. stale ids)
          const draftIds = draft.map((i) => i.id);
          const liveIds = new Set(draftIds);
          const stale = (originalOptionOrder ?? []).filter((id) => !liveIds.has(id));
          return [...draftIds, ...stale];                            // reordered: live ids + preserved stale
        },
      });
    };

    const addSeparator = (key: string, label: string, value: unknown) => {
      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field' });
      field.createEl('label', { text: label });
      const select = field.createEl('select') as HTMLSelectElement;
      const options: Array<[string, string]> = [['', t('protocolEditor.useGlobalSeparator')], ['newline', t('settings.newline')], ['space', t('settings.space')]];
      for (const [optionValue, optionLabel] of options) {
        select.createEl('option', { attr: { value: optionValue }, text: optionLabel });
      }
      select.value = value === 'newline' || value === 'space' ? value : '';
      textControls.push({ key, value: () => (select.value === 'newline' || select.value === 'space') ? select.value : undefined });
    };

    const addSnippetTargetPicker = (folderValue: unknown, fileValue: unknown) => {
      let selectedFolder = normalizeProtocolEditorSnippetFolderSelection(typeof folderValue === 'string' ? folderValue : '');
      let selectedFile = normalizeProtocolEditorSnippetFolderSelection(typeof fileValue === 'string' ? fileValue : '');
      if (selectedFile !== undefined) selectedFolder = undefined;
      type SelectedSnippetTarget = { kind: 'folder' | 'file'; path: string } | null;

      const field = body.createDiv({ cls: 'rp-protocol-editor-modal-field rp-protocol-editor-snippet-target-field' });
      field.createEl('label', { text: t('protocolEditor.snippetTargetLabel') });

      const summary = field.createDiv({ cls: 'rp-protocol-editor-snippet-target-summary' });
      const summaryKind = summary.createSpan({ cls: 'rp-protocol-editor-snippet-target-kind' });
      const summaryPath = summary.createSpan({ cls: 'rp-protocol-editor-snippet-target-path' });

      const actions = field.createDiv({ cls: 'rp-protocol-editor-snippet-target-actions' });
      const browseBtn = actions.createEl('button', {
        cls: 'rp-protocol-editor-modal-btn',
        text: t('protocolEditor.browseSnippetTarget'),
        attr: { type: 'button' },
      });
      const clearBtn = actions.createEl('button', {
        cls: 'rp-protocol-editor-modal-btn',
        text: t('protocolEditor.clearSnippetTarget'),
        attr: { type: 'button' },
      });

      const currentTarget = (): SelectedSnippetTarget => {
        if (selectedFile !== undefined) return { kind: 'file', path: selectedFile };
        if (selectedFolder !== undefined) return { kind: 'folder', path: selectedFolder };
        return null;
      };

      const renderSummary = () => {
        const target = currentTarget();
        clearBtn.toggleAttribute('disabled', target === null);
        if (target === null) {
          summaryKind.setText(t('protocolEditor.noSnippetTarget'));
          summaryPath.setText(t('protocolEditor.snippetTargetHelp'));
          summary.toggleClass('is-empty', true);
          return;
        }
        summaryKind.setText(target.kind === 'folder'
          ? t('protocolEditor.snippetFolderTarget')
          : t('protocolEditor.snippetFileTarget'));
        summaryPath.setText(target.path);
        summary.toggleClass('is-empty', false);
      };

      const applySelection = (result: SnippetTreePickerResult) => {
        const normalized = normalizeProtocolEditorSnippetFolderSelection(result.relativePath);
        if (result.kind === 'folder') {
          selectedFolder = normalized;
          selectedFile = undefined;
        } else {
          selectedFile = normalized;
          selectedFolder = undefined;
        }
        renderSummary();
      };

      const openBrowseModal = () => {
        if (!this.documentOwner.isCurrent(owner) || closeActiveSnippetTargetPicker !== null) return;

        const pickerBackdrop = document.body.createDiv({
          cls: 'rp-protocol-editor-modal-backdrop rp-protocol-editor-snippet-target-picker-backdrop',
        });
        pickerBackdrop.setAttr('tabindex', '-1');

        const pickerShell = pickerBackdrop.createDiv({ cls: 'rp-protocol-editor-modal rp-protocol-editor-snippet-target-picker-shell' });
        const pickerHeader = pickerShell.createDiv({ cls: 'rp-protocol-editor-modal-header' });
        pickerHeader.createEl('h3', { text: t('protocolEditor.browseSnippetTargetTitle') });
        const pickerCloseBtn = pickerHeader.createEl('button', {
          cls: 'rp-protocol-editor-modal-close',
          text: '✕',
          attr: { 'aria-label': t('protocolEditor.close') },
        });

        const pickerBody = pickerShell.createDiv({ cls: 'rp-protocol-editor-modal-body rp-protocol-editor-snippet-target-picker-body' });
        pickerBody.createDiv({ cls: 'rp-protocol-editor-snippet-target-picker-help', text: t('protocolEditor.snippetTargetHelp') });
        const pickerHost = pickerBody.createDiv({ cls: 'rp-stp-modal-host rp-protocol-editor-snippet-target-picker-modal' });

        let picker: SnippetTreePicker | null = null;
        let closed = false;
        const closePicker = (options?: { restoreFocus?: boolean }) => {
          if (closed) return;
          closed = true;
          if (picker !== null) {
            picker.unmount();
            picker = null;
          }
          pickerBackdrop.remove();
          if (closeActiveSnippetTargetPicker === closePicker) closeActiveSnippetTargetPicker = null;
          if (options?.restoreFocus === false) return;
          window.requestAnimationFrame(() => {
            if (browseBtn.isConnected) browseBtn.focus({ preventScroll: true });
          });
        };

        picker = new SnippetTreePicker({
          app: this.app,
          snippetService: this.plugin.snippetService,
          container: pickerHost,
          mode: 'both',
          rootPath: this.plugin.settings.snippetFolderPath,
          initialSelection: selectedFile ?? selectedFolder,
          t,
          onSelect: (result) => {
            if (!modalEl.isConnected) {
              closePicker({ restoreFocus: false });
              return;
            }
            applySelection(result);
            closePicker();
          },
        });
        closeActiveSnippetTargetPicker = closePicker;

        pickerCloseBtn.addEventListener('click', () => closePicker());
        const pickerBackdropGuard = createModalBackdropCloseGuard(pickerBackdrop);
        pickerBackdrop.addEventListener('pointerdown', pickerBackdropGuard.onPointerDown);
        pickerBackdrop.addEventListener('click', (e) => {
          if (pickerBackdropGuard.shouldCloseOnClick(e)) closePicker();
        });
        pickerBackdrop.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        });

        void picker.mount();
        window.setTimeout(() => {
          if (closed || !this.documentOwner.isCurrent(owner)) return;
          const searchInput = pickerBackdrop.querySelector('.rp-stp-search-input') as HTMLElement | null;
          (searchInput ?? pickerBackdrop).focus({ preventScroll: true });
        }, 0);
      };

      browseBtn.addEventListener('click', openBrowseModal);
      clearBtn.addEventListener('click', () => {
        selectedFolder = undefined;
        selectedFile = undefined;
        renderSummary();
      });

      renderSummary();
      textControls.push({ key: 'subfolderPath', value: () => selectedFolder });
      textControls.push({ key: 'snippetPath', value: () => selectedFile });
    };

    switch (node.kind) {
      case 'question':
        addInput('questionText', t('protocolEditor.questionTextLabel'), node.fields['questionText'] ?? node.text, true);
        addLoopToggle(node);
        addOptionOrderChips(node);
        break;
      case 'answer': {
        addInput('displayLabel', t('protocolEditor.answerButtonLabelLabel'), node.fields['displayLabel']);
        const answerTextField = addInput('answerText', t('protocolEditor.answerTextLabel'), node.fields['answerText'] ?? node.text, true);
        addAnswerFreeTextToggle(node, answerTextField);
        addSeparator('separator', t('protocolEditor.answerSeparatorLabel'), node.fields['separator']);
        break;
      }
      case 'text-block':
        addInput('content', t('protocolEditor.contentLabel'), node.fields['content'] ?? node.text, true);
        addSeparator('separator', t('protocolEditor.textSeparatorLabel'), node.fields['separator']);
        break;
      case 'snippet':
        addSnippetTargetPicker(node.fields['subfolderPath'], node.fields['snippetPath']);
        addInput('snippetLabel', t('protocolEditor.snippetNodeLabelLabel'), node.fields['snippetLabel']);
        addSeparator('snippetSeparator', t('protocolEditor.snippetSeparatorLabel'), node.fields['snippetSeparator']);
        break;
      case 'start':
      case 'loop-start':
      case 'loop-end':
      case null:
        body.createDiv({ cls: 'rp-protocol-editor-modal-help', text: t('protocolEditor.noEditableFields') });
        break;
    }

    addStartPointCheckbox();

    const footer = modal.createDiv({ cls: 'rp-protocol-editor-modal-footer' });
    const deleteBtn = footer.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-danger',
      text: t('protocolEditor.delete'),
    });
    const actionBtns = footer.createDiv({ cls: 'modal-actions' });
    const cancelBtn = actionBtns.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn',
      text: t('protocolEditor.cancel'),
    });
    const saveBtn = actionBtns.createEl('button', {
      cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-primary',
      text: t('protocolEditor.save'),
    });

    cancelBtn.addEventListener('click', closeModal);

    saveBtn.addEventListener('click', async () => {
      if (!this.documentOwner.isCurrent(owner)) return;
      const nextFields: Record<string, unknown> = { ...node.fields };
      for (const control of textControls) {
        const value = control.value();
        if (value === undefined) delete nextFields[control.key];
        else nextFields[control.key] = value;
      }

      const updatedNode: ProtocolNodeRecord = {
        ...node,
        kind: node.kind,
        fields: nextFields,
      };

      const titleKind = updatedNode.kind;
      const titleKey = titleKind === 'question'
        ? 'questionText'
        : titleKind === 'answer'
          ? 'answerText'
          : titleKind === 'text-block'
            ? 'content'
            : titleKind === 'snippet'
              ? 'snippetLabel'
              : null;
      if (titleKey !== null && typeof nextFields[titleKey] === 'string') {
        updatedNode.text = nextFields[titleKey] as string;
      }

      if (this.isLibraryReadOnly()) return;
      try {
        const updated = await this.documentOwner.update(owner, (existing) => {
          if (existing === null) protocolMissingFileError();
          const nodes = existing.nodes.map((n) => n.id === updatedNode.id ? updatedNode : n);
          const edgeNodeById = new Map(nodes.map((n) => [n.id, n]));
          const shouldSyncIncomingLabels = updatedNode.kind === 'answer' || updatedNode.kind === 'snippet';
          const previousAutoLabel = defaultProtocolEditorEdgeLabelForTarget(node);
          const nextAutoLabel = defaultProtocolEditorEdgeLabelForTarget(updatedNode);
          const edges = shouldSyncIncomingLabels
            ? existing.edges.map((candidate) => {
              if (candidate.toNodeId !== updatedNode.id) return candidate;
              if (!shouldAutoRefreshProtocolEditorEdgeLabel(candidate.label, previousAutoLabel)) return candidate;
              const fromNode = edgeNodeById.get(candidate.fromNodeId);
              const shouldDisplayLabel = shouldDisplayProtocolEditorEdgeLabel(
                { ...candidate, label: nextAutoLabel },
                fromNode,
                updatedNode,
              );
              return { ...candidate, label: shouldDisplayLabel ? nextAutoLabel : undefined };
            })
            : existing.edges;
          return { ...existing, nodes, edges, viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
        });
        if (updated === null || !this.documentOwner.isCurrent(owner)) return;
        closeModal();
        new Notice(t('protocolEditor.nodeSaved'));
        void this.loadProtocol(owner.path, owner);
      } catch (err) {
        new Notice(t('protocolEditor.saveFailed', { error: String(err) }));
      }
    });

    deleteBtn.addEventListener('click', () => {
      deleteBtn.setAttr('disabled', 'disabled');
      const confirmWrap = footer.createDiv({ cls: 'rp-protocol-editor-confirm' });
      confirmWrap.createSpan({ text: t('protocolEditor.deleteNodeConfirm') });
      const confirmBtn = confirmWrap.createEl('button', {
        cls: 'rp-protocol-editor-modal-btn rp-protocol-editor-modal-btn-danger',
        text: t('protocolEditor.confirmDelete'),
      });
      confirmBtn.addEventListener('click', async () => {
        if (!this.documentOwner.isCurrent(owner)) return;
        if (this.isLibraryReadOnly()) return;
        try {
          const updated = await this.documentOwner.update(owner, (existing) => {
            if (existing === null) protocolMissingFileError();
            const nodes = existing.nodes.filter((n) => n.id !== node.id);
            const edges = existing.edges.filter((e) => e.fromNodeId !== node.id && e.toNodeId !== node.id);
            return { ...existing, nodes, edges, viewport: this.currentViewportState(), updatedAt: new Date().toISOString() };
          });
          if (updated === null || !this.documentOwner.isCurrent(owner)) return;
          this.doc = updated;
          closeModal();
          new Notice(t('protocolEditor.nodeDeleted'));
          void this.loadProtocol(owner.path, owner);
        } catch (err) {
          new Notice(t('protocolEditor.deleteFailed', { error: String(err) }));
        }
      });
    });

    const backdropGuard = createModalBackdropCloseGuard(modalEl);
    modalEl.addEventListener('pointerdown', backdropGuard.onPointerDown);
    modalEl.addEventListener('click', (e) => {
      if (backdropGuard.shouldCloseOnClick(e)) closeModal();
    });

    // Autofocus the first editable text field when opening for a newly-created node
    if (options?.autofocusFirstTextField && firstEditableField.length > 0) {
      const field = firstEditableField[0]!;
      window.setTimeout(() => {
        if (modalEl.isConnected && this.documentOwner.isCurrent(owner)) { field.focus(); field.select(); }
      }, 0);
    }
  }

}
