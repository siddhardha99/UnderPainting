/**
 * Validator v1 (M1 item 6): deterministic structural checks for the §7
 * authoring standards — enforced, not merely requested in the prompt.
 * Violations feed the orchestrator's bounded correction loop; whatever
 * survives the cap is surfaced to the user, never silently accepted.
 *
 * Pure string/tokenizer implementation: the extension host has no DOM and
 * the dependency budget (§4) rules out importing one. Checks favor
 * determinism over cleverness — anything ambiguous is left to the golden
 * evals rather than guessed at here.
 */

export interface ValidationIssue {
  rule: 'structure' | 'A1' | 'A2' | 'A3' | 'A4' | 'scripts';
  message: string;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/** Inline-style properties that must consume tokens via var(--…) (A1). */
const TOKENED_PROPERTIES =
  /^(color|background|background-color|border(-\w+)*-color|border(-\w+)*|outline(-color)?|fill|stroke|box-shadow|text-shadow|font-family|font-size|margin(-\w+)?|padding(-\w+)?|gap|row-gap|column-gap)$/;

/** Structural raw values tolerated without a token (brief §7 A1). */
const TOLERATED_VALUE =
  /^(0|auto|none|inherit|initial|unset|transparent|currentcolor|normal|-?\d*\.?\d+(px|%|vw|vh|em|rem|fr|ch)?|\d+\s*\/\s*\d+)$/i;

/** Raw color literal anywhere in a tokened property's value = violation. */
const RAW_COLOR = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;

export interface ValidateOptions {
  /**
   * Interactive artifacts (2c) permit inline behavior scripts — vanilla JS
   * that wires events and toggles state, never builds layout. Static
   * artifacts (the default) keep the full script ban so direct-edit / split
   * / A2-literal-DOM keep working (the two-type boundary, ADR-002 addendum).
   */
  interactive?: boolean;
}

export function validateArtifact(html: string, options: ValidateOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- structure: one complete document
  if (!/^\s*<!doctype html>/i.test(html)) {
    issues.push({ rule: 'structure', message: 'Document must begin with <!doctype html>.' });
  }
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  if (styleBlocks.length !== 1) {
    issues.push({
      rule: 'A1',
      message: `Exactly one <style> block is permitted (found ${styleBlocks.length}).`,
    });
  }

  // ---- A1: the style block may hold only :root, @font-face, @keyframes, base reset
  if (styleBlocks.length >= 1) {
    for (const selector of topLevelSelectors(styleBlocks[0]![1]!)) {
      const allowed =
        selector === ':root' ||
        selector.startsWith('@font-face') ||
        selector.startsWith('@keyframes') ||
        selector.startsWith('@media') === false && isBaseResetSelector(selector);
      if (!allowed) {
        issues.push({
          rule: 'A1',
          message: `Style block contains a disallowed rule "${selector}" — only :root tokens, @font-face, @keyframes, and a base element reset are permitted.`,
        });
      }
    }
  }

  // ---- A1: inline styles consume tokens for color/spacing/type
  for (const styleAttr of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) {
    for (const declaration of styleAttr[1]!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (!TOKENED_PROPERTIES.test(property) || value.includes('var(--')) continue;
      const parts = value.split(/\s+/);
      const allTolerated = parts.every((p) => TOLERATED_VALUE.test(p) || /^(solid|dashed|dotted|double)$/i.test(p));
      if (RAW_COLOR.test(value) || !allTolerated) {
        issues.push({
          rule: 'A1',
          message: `Inline style "${property}: ${value}" uses a raw value — consume a design token via var(--…) instead.`,
        });
      }
    }
  }

  // ---- scripts (2c): static artifacts ban them entirely; interactive
  // artifacts permit inline behavior scripts but never script-built layout.
  issues.push(...scriptChecks(html, options.interactive ?? false));

  // ---- A3: self-containment — no external resource references
  const externalPatterns: Array<[RegExp, string]> = [
    [/<link\b/i, '<link> element'],
    [/<(?:img|source|video|audio|iframe|embed|object|script)\b[^>]*\s(?:src|srcset|data)\s*=\s*["'](?:https?:)?\/\//i, 'external resource URL'],
    [/@import\b/i, 'CSS @import'],
    [/url\(\s*["']?(?:https?:)?\/\//i, 'external url() reference'],
  ];
  for (const [pattern, label] of externalPatterns) {
    if (pattern.test(html)) {
      issues.push({
        rule: 'A3',
        message: `Artifact references an external resource (${label}) — artifacts must be fully self-contained.`,
      });
    }
  }

  // ---- A2 + A4: structural walks over a minimal tokenizer
  issues.push(...walkChecks(html));

  return issues;
}

/**
 * A7 diff-minimality for refinements: the share of the base document's lines
 * that survived into the refinement. Surfaced as a warning when a targeted
 * edit rewrote most of the document — never a correction trigger (re-running
 * the same instruction would spend money for the same result; surfacing
 * beats silently accepting, per §7).
 */
export function refinementSurvivalRatio(base: string, refined: string): number {
  const baseLines = nonEmptyLines(base);
  if (baseLines.length === 0) return 1;
  const refinedSet = new Map<string, number>();
  for (const line of nonEmptyLines(refined)) {
    refinedSet.set(line, (refinedSet.get(line) ?? 0) + 1);
  }
  let survived = 0;
  for (const line of baseLines) {
    const count = refinedSet.get(line) ?? 0;
    if (count > 0) {
      survived++;
      refinedSet.set(line, count - 1);
    }
  }
  return survived / baseLines.length;
}

/** Instructions that legitimately license a rewrite (A7: "a full redesign request may change anything"). */
export function isRedesignInstruction(instruction: string): boolean {
  return /\b(redesign|start over|from scratch|rework|new (layout|design|direction)|completely (different|new))\b/i.test(
    instruction,
  );
}

// ------------------------------------------------------------- internals

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Top-level selector/at-rule names of a stylesheet, comments stripped. */
function topLevelSelectors(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of stripped) {
    if (char === '{') {
      if (depth === 0) {
        const selector = current.trim();
        if (selector) selectors.push(selector);
        current = '';
      }
      depth++;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      current += char;
    }
  }
  return selectors;
}

/** A base reset targets elements/universal (with optional pseudo-elements) — no classes, ids, or attributes. */
function isBaseResetSelector(selector: string): boolean {
  return selector
    .split(',')
    .every((part) => /^\s*(\*|[a-z][a-z0-9]*)(::?[a-z-]+)*\s*$/i.test(part.trim()));
}

interface OpenElement {
  tag: string;
  hasElementChild: boolean;
  hasText: boolean;
  attrs: string;
}

/**
 * Script policy (2c). Static artifacts: any `<script>` is a violation.
 * Interactive artifacts: inline scripts are allowed for BEHAVIOR only —
 * external scripts (A3) and DOM-construction APIs (A2: script-built layout)
 * are still rejected, so the editable-DOM guarantees survive and the sandbox
 * is the only thing standing between a script and the outside world.
 */
const DOM_CONSTRUCTION: Array<[RegExp, string]> = [
  [/\.innerHTML\s*[+]?=/, 'assigning innerHTML'],
  [/\.outerHTML\s*=/, 'assigning outerHTML'],
  [/\bdocument\.write\b/, 'document.write'],
  [/\.insertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bcreateElement\b|\bcreateElementNS\b/, 'document.createElement'],
  [/\bcreateContextualFragment\b/, 'createContextualFragment'],
  [/\.appendChild\b|\.append\(|\.prepend\(|\.insertBefore\b|\.replaceChildren\b/, 'node insertion (appendChild/append/…)'],
];

function scriptChecks(html: string, interactive: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const hasAnyScript = /<script\b/i.test(html);

  if (!interactive) {
    if (hasAnyScript) {
      issues.push({
        rule: 'scripts',
        message: 'Static artifacts contain no <script> — layout and content are markup only (use an interactive prototype for behavior).',
      });
    }
    return issues;
  }

  // Interactive: inline behavior scripts only.
  for (const script of scripts) {
    const attrs = script[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) {
      issues.push({
        rule: 'A3',
        message: 'Interactive artifacts use inline scripts only — an external <script src> breaks self-containment.',
      });
    }
    const body = script[2] ?? '';
    for (const [pattern, label] of DOM_CONSTRUCTION) {
      if (pattern.test(body)) {
        issues.push({
          rule: 'A2',
          message: `Script builds layout via ${label} — scripts add behavior only; structure and content must be literal markup (so edits map to source).`,
        });
        break; // one A2-construction flag per script is enough signal
      }
    }
  }
  return issues;
}

/** Minimal well-formedness walk for the A2 leaf rule and A4 explicit dimensions. */
function walkChecks(html: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stack: OpenElement[] = [];
  const flagged = new Set<string>();
  const tokenizer = /<!--[\s\S]*?-->|<!\w[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>|([^<]+)/g;

  let match: RegExpExecArray | null;
  let inRawText: string | null = null;
  while ((match = tokenizer.exec(html)) !== null) {
    const [token, closeTag, openTag, attrs, text] = match;
    if (inRawText) {
      if (closeTag?.toLowerCase() === inRawText) inRawText = null;
      continue;
    }
    if (openTag) {
      const tag = openTag.toLowerCase();
      const parent = stack[stack.length - 1];
      if (parent) parent.hasElementChild = true;

      if (tag === 'img' || tag === 'svg') {
        const attrText = attrs ?? '';
        const hasDimensions =
          (/\bwidth\s*=/.test(attrText) && /\bheight\s*=/.test(attrText)) ||
          /style\s*=\s*"[^"]*width[^"]*height|style\s*=\s*"[^"]*height[^"]*width/.test(attrText) ||
          (tag === 'svg' && /\bviewBox\s*=/i.test(attrText) && /\bwidth\s*=/.test(attrText));
        if (!hasDimensions && !flagged.has(`dim:${tag}`)) {
          flagged.add(`dim:${tag}`);
          issues.push({
            rule: 'A4',
            message: `<${tag}> without explicit width and height — late-arriving content must not shift layout while streaming.`,
          });
        }
      }

      if (tag === 'style' || tag === 'script') {
        inRawText = tag;
        continue;
      }
      if (tag === 'svg') {
        // Treat the whole svg subtree as one opaque leaf for A2 purposes.
        inRawText = 'svg';
        continue;
      }
      if (!VOID_ELEMENTS.has(tag) && !token.endsWith('/>')) {
        stack.push({ tag, hasElementChild: false, hasText: false, attrs: attrs ?? '' });
      }
    } else if (closeTag) {
      const closed = stack.pop();
      if (closed && closed.hasText && closed.hasElementChild && !flagged.has('a2-mixed')) {
        flagged.add('a2-mixed');
        issues.push({
          rule: 'A2',
          message: `<${closed.tag}> mixes text with child elements — every run of user-visible text must live in its own leaf element so canvas edits map to exactly one source span.`,
        });
      }
    } else if (text && text.trim().length > 0) {
      const parent = stack[stack.length - 1];
      if (parent) parent.hasText = true;
    }
  }
  return issues;
}
