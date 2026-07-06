/**
 * Scaffold assembly (M1 item 7, authoring standard A5): boilerplate shells
 * are versioned files copied around the model's output — regenerating a
 * solved shell spends the user's money on nothing. The model streams only a
 * `<style>` block (tokens/@font-face/@keyframes) followed by body markup;
 * this module splices both into the scaffold's {{STYLE}} and {{BODY}} slots.
 *
 * Streaming-safe by construction: while the fragment's style block is still
 * open, everything after `<style>` goes to the STYLE slot — the canvas
 * paints the token block first, exactly the A1 ordering the brief wants.
 */

const STYLE_SLOT = '{{STYLE}}';
const BODY_SLOT = '{{BODY}}';

export function assembleArtifact(scaffold: string, fragment: string): string {
  // A model that disobeys and emits a full document must not get nested
  // shells — pass it through and let the validator judge it.
  if (/^\s*(?:<!doctype|<html)\b/i.test(fragment)) {
    return fragment;
  }
  const styleOpen = fragment.search(/<style\b[^>]*>/i);
  let styleContent = '';
  let body = fragment;
  if (styleOpen !== -1) {
    const afterOpen = fragment.indexOf('>', styleOpen) + 1;
    const styleClose = fragment.indexOf('</style>', afterOpen);
    if (styleClose === -1) {
      // Style block still streaming: everything so far is token CSS.
      styleContent = fragment.slice(afterOpen);
      body = fragment.slice(0, styleOpen);
    } else {
      styleContent = fragment.slice(afterOpen, styleClose);
      body = fragment.slice(0, styleOpen) + fragment.slice(styleClose + '</style>'.length);
    }
  }
  return scaffold.replace(STYLE_SLOT, () => styleContent.trim()).replace(BODY_SLOT, () => body.trim());
}

/** True when the artifact carries a scaffold provenance marker (validator awareness). */
export function hasScaffoldMarker(html: string): boolean {
  return /<!--\s*underpainting-scaffold:/.test(html);
}
