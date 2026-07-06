import type { VersionMeta } from '../store/DocumentStore';

/**
 * Export & handoff builders (M1 item 9): pure functions that assemble the
 * handoff package from data the pipeline already has — the version history,
 * the extracted token set, the component inventory. No API call is involved
 * anywhere in export (P3/P4: handoff is free).
 */

export interface HandoffInput {
  projectSlug: string;
  artifactHtml: string;
  version: VersionMeta;
  /** Full version history, oldest first — the design intent trail. */
  history: VersionMeta[];
  /** Contents of .design/system/tokens.css, when extracted. */
  tokensCss: string | null;
  /** Contents of .design/system/components.md, when extracted. */
  componentsMd: string | null;
  extensionVersion: string;
}

export interface TokenPair {
  name: string;
  value: string;
}

/** Parse `--name: value;` declarations out of a tokens.css block. */
export function parseTokenPairs(tokensCss: string | null): TokenPair[] {
  if (!tokensCss) return [];
  return [...tokensCss.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => ({
    name: m[1]!,
    value: m[2]!.trim().replace(/\s*\/\*.*?\*\/\s*$/, ''),
  }));
}

/** Tokens the artifact actually consumes (via var(--…)), from the extracted set. */
export function tokensUsed(artifactHtml: string, pairs: TokenPair[]): TokenPair[] {
  return pairs.filter((p) => artifactHtml.includes(`var(${p.name}`));
}

const INTEGRATION_DIRECTIVES = [
  'index.html is self-contained (no external resources) — it renders as-is in any browser and is safe to iframe.',
  "All design values flow through the CSS custom properties declared in the artifact's single <style> block. To adopt your codebase's theme, map or replace those :root declarations; element markup needs no edits for a reskin.",
  'Every run of visible text is its own leaf element, and repeated structure is written out literally — safe to template: convert repeated siblings into your loop construct and lift leaf text into your i18n/copy layer.',
  'handoff.json is the machine-readable companion: design intent (full prompt/refinement history), the token set with values, and validation status. Treat it as the spec; treat index.html as the reference rendering.',
  'The artifact intentionally contains no JavaScript. Behavior is yours to add in your own framework.',
];

export function buildHandoffJson(input: HandoffInput): string {
  const pairs = parseTokenPairs(input.tokensCss);
  const used = tokensUsed(input.artifactHtml, pairs);
  return (
    JSON.stringify(
      {
        schema_version: 1,
        generator: `underpainting@${input.extensionVersion}`,
        artifact: {
          file: 'index.html',
          project: input.projectSlug,
          created: input.version.created,
          model: input.version.model,
          costUsd: input.version.costUsd,
          validated: input.version.validated ?? true,
          issues: input.version.issues ?? [],
        },
        intent: {
          prompt: input.version.prompt,
          history: input.history.map((v) => ({
            created: v.created,
            model: v.model,
            costUsd: v.costUsd,
            prompt: v.prompt,
          })),
        },
        tokens: {
          extracted: pairs,
          usedByArtifact: used.map((t) => t.name),
        },
        integration: INTEGRATION_DIRECTIVES,
      },
      null,
      2,
    ) + '\n'
  );
}

export function buildHandoffMd(input: HandoffInput): string {
  const pairs = parseTokenPairs(input.tokensCss);
  const used = new Set(tokensUsed(input.artifactHtml, pairs).map((t) => t.name));
  const lines: string[] = [
    `# Handoff — ${input.projectSlug}`,
    '',
    `Exported from Underpainting ${input.extensionVersion}. \`index.html\` is the reference rendering; \`handoff.json\` is the machine-readable spec.`,
    '',
    '## Design intent',
    '',
    `Final request (${input.version.model}${input.version.costUsd !== null ? `, $${input.version.costUsd.toFixed(4)}` : ''}):`,
    '',
    `> ${input.version.prompt}`,
    '',
  ];
  if (input.history.length > 1) {
    lines.push('Iteration history (oldest first):', '');
    for (const v of input.history) {
      lines.push(`- ${v.created} — ${v.model}: ${v.prompt}`);
    }
    lines.push('');
  }
  const validated = input.version.validated ?? true;
  lines.push(
    '## Validation',
    '',
    validated
      ? 'The artifact passed all authoring-standard checks (token-referenced styling, editable leaf structure, self-containment, explicit dimensions).'
      : `⚠ The artifact carries unresolved authoring issues:\n${(input.version.issues ?? []).map((i) => `- ${i}`).join('\n')}`,
    '',
  );
  if (pairs.length > 0) {
    lines.push('## Design tokens', '', '| Token | Value | Used by artifact |', '|---|---|---|');
    for (const p of pairs) {
      lines.push(`| \`${p.name}\` | \`${p.value}\` | ${used.has(p.name) ? 'yes' : '—'} |`);
    }
    lines.push('');
  }
  if (input.componentsMd) {
    lines.push('## Workspace component inventory (extracted)', '', input.componentsMd.trim(), '');
  }
  lines.push('## Integration directives', '');
  for (const directive of INTEGRATION_DIRECTIVES) {
    lines.push(`1. ${directive}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Wrap an artifact in the browser-frame scaffold for presentation exports. */
export function wrapInBrowserFrame(frameScaffold: string, artifactHtml: string, url: string): string {
  const iframe = `<iframe title="Design artifact" srcdoc="${escapeAttr(artifactHtml)}"></iframe>`;
  return frameScaffold.replace('{{URL}}', () => escapeText(url)).replace('{{BODY}}', () => iframe);
}

export interface PlannedWrite {
  relative: string;
  content: string;
  status: 'new' | 'changed' | 'identical';
  existing?: string;
}

/** Classify each pending file against what exists — the diff-preview input (P9). */
export async function planWrites(
  files: Array<{ relative: string; content: string }>,
  readExisting: (relative: string) => Promise<string | null>,
): Promise<PlannedWrite[]> {
  const plan: PlannedWrite[] = [];
  for (const file of files) {
    const existing = await readExisting(file.relative);
    if (existing === null) {
      plan.push({ ...file, status: 'new' });
    } else if (existing === file.content) {
      plan.push({ ...file, status: 'identical', existing });
    } else {
      plan.push({ ...file, status: 'changed', existing });
    }
  }
  return plan;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
