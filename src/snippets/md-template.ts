// snippets/md-template.ts
// Markdown template snippets: YAML-like frontmatter + Markdown body.
import type { MdTemplateSnippet, SnippetPlaceholder } from './snippet-model';
import { validatePlaceholders } from './snippet-model';
import type { Translator } from '../i18n';
import { defaultT } from '../i18n';

export function hasMarkdownTemplateFrontmatter(text: string): boolean {
  return text.startsWith('---\n') && text.indexOf('\n---\n', 4) > 0;
}

export function parseMarkdownTemplate(
  path: string,
  text: string,
  fallbackName: string,
  t: Translator = defaultT,
): MdTemplateSnippet {
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    return {
      kind: 'md-template',
      path,
      name: fallbackName,
      template: text,
      placeholders: [],
      validationError: null,
    };
  }
  const { data, body } = parsed;
  const placeholders = normalizePlaceholders(data.placeholders);
  const validationError = validatePlaceholders(placeholders, t) ?? validateBodyPlaceholders(body, placeholders);
  return {
    kind: 'md-template',
    path,
    name: stringValue(data.name) || fallbackName,
    template: body,
    placeholders,
    validationError,
    id: stringValue(data.id) || undefined,
    lang: normalizeLang(data.lang),
    category: stringValue(data.category) || undefined,
    description: stringValue(data.description) || undefined,
    version: numberValue(data.version),
  };
}

export function serializeMarkdownTemplate(snippet: MdTemplateSnippet): string {
  const lines: string[] = ['---'];
  if (snippet.id) lines.push(`id: ${escapeYamlScalar(snippet.id)}`);
  lines.push(`name: ${escapeYamlScalar(snippet.name)}`);
  if (snippet.lang) lines.push(`lang: ${snippet.lang}`);
  if (snippet.category) lines.push(`category: ${escapeYamlScalar(snippet.category)}`);
  if (snippet.description) lines.push(`description: ${escapeYamlScalar(snippet.description)}`);
  if (snippet.version !== undefined) lines.push(`version: ${snippet.version}`);
  if (snippet.placeholders.length === 0) {
    lines.push('placeholders: []');
  } else {
    lines.push('placeholders:');
    for (const placeholder of snippet.placeholders) {
      lines.push(`  - id: ${escapeYamlScalar(placeholder.id)}`);
      lines.push(`    label: ${escapeYamlScalar(placeholder.label)}`);
      lines.push(`    type: ${placeholder.type}`);
      if (placeholder.separator) lines.push(`    separator: ${escapeYamlScalar(placeholder.separator)}`);
      if (placeholder.type === 'choice' && placeholder.options && placeholder.options.length > 0) {
        lines.push('    options:');
        for (const option of placeholder.options) {
          lines.push(`      - ${escapeYamlScalar(option)}`);
        }
      }
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n${snippet.template}${snippet.template.endsWith('\n') ? '' : '\n'}`;
}

function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } | null {
  if (!hasMarkdownTemplateFrontmatter(text)) return null;
  const end = text.indexOf('\n---\n', 4);
  const raw = text.slice(4, end);
  const body = text.slice(end + 5).replace(/\n$/, '');
  return { data: parseYamlSubset(raw), body };
}

function parseYamlSubset(raw: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i += 1; continue; }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) { i += 1; continue; }
    const key = match[1]!;
    const value = match[2] ?? '';
    if (key === 'placeholders') {
      if (value.trim() === '[]') {
        data.placeholders = [];
        i += 1;
      } else {
        const placeholders: Record<string, unknown>[] = [];
        i += 1;
        while (i < lines.length && lines[i]!.startsWith('  ')) {
          if (!lines[i]!.startsWith('  - ')) { i += 1; continue; }
          const item: Record<string, unknown> = {};
          const first = lines[i]!.slice(4);
          if (first.trim() !== '') assignYamlKeyValue(item, first);
          i += 1;
          while (i < lines.length && lines[i]!.startsWith('    ')) {
            const nested = lines[i]!.slice(4);
            if (nested.startsWith('options:')) {
              const options: string[] = [];
              i += 1;
              while (i < lines.length && lines[i]!.startsWith('      - ')) {
                options.push(unquote(lines[i]!.slice(8).trim()));
                i += 1;
              }
              item.options = options;
            } else {
              assignYamlKeyValue(item, nested);
              i += 1;
            }
          }
          placeholders.push(item);
        }
        data.placeholders = placeholders;
      }
    } else {
      data[key] = unquote(value.trim());
      i += 1;
    }
  }
  return data;
}

function assignYamlKeyValue(target: Record<string, unknown>, line: string): void {
  const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
  if (!match) return;
  target[match[1]!] = unquote((match[2] ?? '').trim());
}

function normalizePlaceholders(value: unknown): SnippetPlaceholder[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: stringValue(item.id),
      label: stringValue(item.label) || stringValue(item.id),
      type: item.type === 'choice' ? 'choice' : 'free-text',
      options: Array.isArray(item.options) ? item.options.map(String) : undefined,
      separator: stringValue(item.separator) || undefined,
    }));
}

function validateBodyPlaceholders(body: string, placeholders: SnippetPlaceholder[]): string | null {
  const declared = new Set(placeholders.map((placeholder) => placeholder.id));
  const re = /{{\s*([^{}\s]+)\s*}}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const id = match[1]!;
    if (!declared.has(id)) return `Markdown template uses undeclared placeholder '{{${id}}}'.`;
  }
  return null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeLang(value: unknown): 'ru' | 'en' | undefined {
  return value === 'ru' || value === 'en' ? value : undefined;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeYamlScalar(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
