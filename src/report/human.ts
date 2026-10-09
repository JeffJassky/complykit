// HTML-only explanations. Stored findings and machine reports keep their
// original vocabulary, identifiers, confidence and aggregation contracts.
import { getRequirement } from '../registry/index.js';
import type { Finding } from '../record/index.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Evidence is untrusted site content: link it without executable schemes. */
export function safeHref(value: string): string {
  try {
    const protocol = new URL(value, 'https://report.invalid/').protocol;
    return protocol === 'https:' || protocol === 'http:' ? value : '#';
  } catch {
    return '#';
  }
}

/** Collectors sometimes store a CSS selector as the element's "name". */
export function elementLabel(f: Finding): string | undefined {
  const d = f.details as { textSample?: unknown } | undefined;
  const sample = typeof d?.textSample === 'string' ? d.textSample : undefined;
  const name = f.subject.locator?.name;
  const readable = name && name !== f.subject.locator?.cssPath && !/^[.#\[]|:nth-|\s>\s/.test(name) ? name : undefined;
  const text = sample || readable;
  return text ? text.slice(0, 160) + (text.length > 160 ? '…' : '') : undefined;
}

export interface Explanation {
  title: string;
  topic: string;
  impact: string;
  fix: string;
  owner: string;
  verify: string;
}

const accessibility = (title: string, impact: string, fix: string, verify: string): Explanation => ({
  title, topic: 'Accessibility', impact, fix, verify, owner: 'Design and development',
});
const tracking = (title: string, impact: string, fix: string, verify: string): Explanation => ({
  title, topic: 'Cookies & tracking', impact, fix, verify, owner: 'Marketing and development',
});

const contrast = accessibility('Text is difficult to read', 'Some visitors may struggle to read text that blends into its background, especially people with low vision.', 'Adjust the text or background color so the words are clearly readable. Ask your designer or developer to check the contrast against the requirement in the evidence.', 'Recheck the affected text on each reported page, screen size and color theme. Run the contrast check again.');
const name = accessibility('A control does not explain what it does', 'Someone using a screen reader may hear a button or link without enough information to understand its purpose.', 'Give the control a clear, meaningful label. The label should describe the action or destination and work with a screen reader.', 'Navigate to the control with a keyboard and screen reader. Confirm its announced name explains the action, then scan again.');

/** Match known rules/requirements; unknown checks get an honest fallback. */
export function explain(rule: string, requirement: string): Explanation {
  const id = rule.toLowerCase();
  if (id.includes('non-text-contrast') || requirement === 'wcag22.1.4.11') return accessibility('A control is hard to distinguish from its surroundings', 'Visitors with low vision may have difficulty seeing a control, its border or its state.', 'Increase the visual contrast of the affected control or indicator against the surrounding colors.', 'Check the control in its normal, focused and selected states on the reported screen sizes and color themes.');
  if (id.includes('contrast') || requirement === 'wcag22.1.4.3') return contrast;
  if (id === 'keyboard.trap' || id.includes('keyboard-trap')) return accessibility('Visitors can get stuck using the keyboard', 'A visitor who cannot use a mouse may be unable to leave this part of the page.', 'Make it possible to move into and out of the component with the keyboard. If it is a dialog, provide an accessible close control and an Escape-key exit.', 'Use Tab, Shift+Tab and Escape to enter and leave the component. Confirm focus returns to a useful place.');
  if (id.includes('focus-visible') || requirement === 'wcag22.2.4.7') return accessibility('Keyboard users cannot see where they are', 'Visitors using Tab need a visible highlight to know which control they will activate.', 'Add a clearly visible focus outline or equivalent highlight to each interactive control.', 'Tab through the affected page and confirm every focused control remains visibly highlighted.');
  if (id.includes('alt-text') || id.includes('alttext') || id.includes('image-alt')) return accessibility('An image needs a useful description', 'Visitors who cannot see the image may miss information that other visitors receive.', 'Describe meaningful images with alternative text. Mark purely decorative images as decorative so screen readers can skip them.', 'Read the page using a screen reader and confirm meaningful images are described without unnecessary repetition.');
  if (id.includes('button-name') || id.includes('link-name') || id.includes('anchor-has-content') || id.includes('control-has-associated-label')) return name;
  if (id.includes('label') || requirement === 'wcag22.3.3.2') return accessibility('A form field needs a clear label', 'Visitors may not know what information to enter, particularly when using a screen reader.', 'Add a visible, descriptive label and associate it with the form field. Explain any required format or instructions.', 'Focus the field with a screen reader and confirm the label and instructions are announced.');
  if (id.includes('html-has-lang') || id.includes('lang')) return accessibility('The page language needs to be identified', 'A screen reader may pronounce the page incorrectly when its language is missing or incorrect.', 'Set the correct language on the page and identify passages that use a different language.', 'Check the language setting and listen to the page with a screen reader.');
  if (id.includes('heading')) return accessibility('Page headings need a clearer structure', 'Visitors using headings to navigate may have trouble understanding or finding sections of the page.', 'Use descriptive headings in a logical order that reflects the structure of the content.', 'Review the heading list with a screen reader and confirm it provides a useful outline.');
  if (id.includes('duplicate-id')) return accessibility('Controls may be connected to the wrong label or description', 'When several elements share the same internal identifier, assistive technology may connect a control to the wrong information.', 'Give the affected elements unique identifiers and update the labels or descriptions that refer to them.', 'Check that each control’s label and description are announced correctly with a screen reader, then run the check again.');
  if (id.includes('aria-') || id.includes('role-has-required')) return accessibility('A component may describe itself incorrectly to assistive technology', 'Visitors using a screen reader may receive incomplete or incorrect information about a control’s role, state or relationships.', 'Ask your developer to correct the accessibility attributes identified in the evidence. Prefer standard HTML controls where possible.', 'Test the component’s name, role, states and interactions using a screen reader, then rerun the flagged check.');
  if (id.includes('landmark') || id.includes('region')) return accessibility('Page sections need clearer navigation landmarks', 'Visitors using assistive technology may find it harder to jump to the main content or understand the page structure.', 'Use clear main-content, navigation and other appropriate regions. Give repeated regions distinct, helpful names.', 'Review the page’s region list with a screen reader and confirm visitors can find the main content and navigation.');
  if (id.includes('document-title')) return accessibility('The browser tab needs a descriptive page title', 'Visitors may struggle to identify the page or distinguish it from other open tabs.', 'Give each page a concise title that identifies its purpose and the site.', 'Open the affected pages and confirm their browser tab titles are useful and distinguishable.');
  if (id.includes('meta-viewport')) return accessibility('Visitors need to be able to zoom the page', 'Visitors who need larger text may be unable to enlarge the page comfortably.', 'Remove settings that disable or unnecessarily restrict browser zoom.', 'On a mobile device, enlarge the page and confirm the content remains readable and usable.');
  if (id.includes('target-size')) return accessibility('Some controls may be too small to use easily', 'Small or crowded controls can be difficult to activate for visitors with limited dexterity or using a touch screen.', 'Increase the affected control’s usable area or spacing, considering any exceptions in the cited requirement.', 'Try the affected controls on a small touch screen and rerun the target-size check.');
  if (id.includes('prior-consent') || id === 'consent.pre-consent-tracker') return tracking('Tracking needs a consent review', 'A visitor’s information may be collected before they have agreed, or after they have declined.', 'Confirm the tool’s purpose. For non-essential tracking that needs permission, change your consent settings so it waits for the visitor’s agreement and respects rejection.', 'Repeat a fresh visit without choosing, then reject cookies. Confirm the reported non-essential activity stays blocked; accept it and confirm it starts only when permitted.');
  if (id === 'consent.click-asymmetry') return tracking('Rejecting cookies is harder than accepting', 'Visitors may be steered into accepting because declining takes more effort.', 'Make accepting and rejecting non-essential cookies equally easy to find and use.', 'Open the banner on a fresh visit and compare the steps needed to accept and reject. Confirm both choices work.');
  if (id.includes('withdraw')) return tracking('Visitors need a working way to change their mind', 'A visitor may be unable to withdraw permission, or tracking may continue after they do.', 'Keep a visible privacy-settings link available. Connect changes in consent to the tools already running on the site.', 'Accept tracking, reopen privacy settings, withdraw permission and confirm the affected activity stops.');
  if (id.includes('opt-out-display')) return tracking('Visitors need confirmation of their privacy choice', 'Visitors may not know whether the site recognized their browser’s request to opt out.', 'Show a clear acknowledgement when the browser’s privacy signal is honored.', 'Visit with the privacy signal enabled and confirm the acknowledgement appears and the relevant tracking respects the choice.');
  if (id.includes('opt-out-signal')) return tracking('A browser privacy request needs attention', 'The browser asked to opt out, but the reported activity may not respect that request.', 'Connect the signal to the opt-out settings of the tools named here, so they stop or restrict as soon as the browser sends it.', 'Visit with the browser privacy signal enabled and confirm the affected data-sharing activity is stopped as required.');
  if (id.includes('opt-out-link')) return tracking('Visitors need a usable privacy-choice link', 'Visitors may be unable to find or complete the process for opting out of data sharing.', 'Provide a clearly labeled privacy-choice link and make the opt-out process usable without an unnecessary account or email requirement.', 'Follow the link as a new visitor, complete the choice and confirm the affected tools respect it.');
  if (id.includes('wiretap')) return { ...tracking('Visitor information was sent to an outside service before consent', 'This is the pattern wiretap suits in this state are built on. complykit holds these tools until the visitor accepts.', 'Load the tool only after the visitor accepts, through your consent tool or tag manager.', 'Rescan and check the tool sends nothing before the visitor accepts.'), owner: 'Marketing, with the developer' };
  if (id.includes('unrecognized') || id.startsWith('inventory.')) return { ...tracking('Confirm what this tool does', 'The scan has identified a tool or technology that needs investigation. Detection alone does not establish a problem.', 'Identify what it does and who provides it, then classify its purpose in the report. complykit applies the rules for that purpose.', 'Confirm the classification with the tool’s owner or documentation, update your inventory and scan again.'), topic: 'Needs investigation', owner: 'Marketing or the site owner' };
  if (id.includes('art50') || requirement.startsWith('eu-ai-act')) return { title: 'Make the use of AI clear to visitors', topic: 'AI transparency', impact: 'Visitors may not realize they are interacting with an AI system.', fix: 'Review the interaction and provide a clear, timely explanation of the AI’s role where needed.', owner: 'Product and privacy lead', verify: 'Try the interaction as a first-time visitor and confirm the explanation is visible and understandable.' };
  const req = getRequirement(requirement);
  return { title: req?.title ?? 'Review this finding', topic: requirement.startsWith('wcag') ? 'Accessibility' : 'Other findings', impact: 'This check found something that needs review. Read the observation below to understand the affected behavior.', fix: 'Ask the relevant site owner to review the observation and supporting evidence, confirm the cause and agree on a correction.', owner: requirement.startsWith('wcag') ? 'Development' : 'Site owner', verify: 'Repeat the reported behavior after the correction and rerun the relevant check.' };
}

export function findingStatus(rule: string, requirement: string, confidence: string): string {
  const kind = getRequirement(requirement)?.kind;
  if (kind === 'exposure') return 'Legal review';
  if (kind === 'practice' || rule.startsWith('inventory.')) return 'Needs investigation';
  return confidence === 'violation' ? 'Problem observed' : 'Needs confirmation';
}

export function workBrief(p: Explanation): string {
  return `<dl class="work-brief"><div><dt>Why it matters</dt><dd>${escapeHtml(p.impact)}</dd></div><div><dt>What to do</dt><dd>${escapeHtml(p.fix)}</dd></div><div><dt>Who can help</dt><dd>${escapeHtml(p.owner)} <span class="human-muted">(suggested)</span></dd></div><div><dt>How to check the fix</dt><dd>${escapeHtml(p.verify)}</dd></div></dl>`;
}

export const GAP_EXPLANATIONS: Record<string, string> = {
  'bot-blocked': 'The site blocked the scanner, so this page could not be checked.',
  'page-timeout': 'The page did not finish loading in time, so its results are incomplete.',
  'cross-origin-iframe': 'An embedded part of the page is hosted elsewhere and could not be inspected.',
  'closed-shadow-root': 'A component hides its internal content from the scanner.',
  'scroll-cap': 'The scanner could not reach all of the content on this page.',
  'no-key': 'The AI-assisted review did not run because its access key was unavailable.',
  crash: 'A check stopped unexpectedly and needs to be run again.',
  'contrast-unmeasured': 'Text readability could not be measured reliably; a manual check is needed.',
};

export const HUMAN_CSS = `
html{scroll-behavior:smooth}section[id],h2[id],article[id]{scroll-margin-top:24px}
body{overflow-wrap:anywhere}
.human-nav{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 30px}.human-nav a,.human-link{color:var(--accent,#2456d6);text-decoration:underline;text-underline-offset:3px}.human-nav a{padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);text-decoration:none}
.human-intro{font-size:17px;max-width:76ch;line-height:1.65}.human-muted{color:var(--muted,var(--dim,#5f6875))}
.human-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}.human-stat{padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.human-stat strong{display:block;font-size:30px;line-height:1.2}.human-stat span{display:block;margin-top:6px;font-size:14px}
.human-callout{padding:16px 20px;border-left:4px solid var(--accent,#2456d6);background:var(--card);border-radius:0 10px 10px 0;max-width:85ch;margin:18px 0}
.human-card{padding:22px;margin:16px 0;border:1px solid var(--line);border-radius:12px;background:var(--card)}.human-card h3{font-size:21px;line-height:1.35;margin:10px 0}.human-status{display:inline-block;padding:3px 9px;border:1px solid var(--line);border-radius:20px;font-size:13px;font-weight:600}
.work-brief{margin:18px 0}.work-brief>div{margin:14px 0}.work-brief dt{font:600 14px/1.5 system-ui,sans-serif;text-transform:none;letter-spacing:0}.work-brief dd{margin:4px 0 0;font-size:15px;line-height:1.65;max-width:80ch}
.human-details{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}.human-details>summary{cursor:pointer;font-size:14px;font-weight:600;padding:4px 0}.human-details>div{padding:12px 0}.human-details pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:480px;overflow:auto}.human-table{width:100%;border-collapse:collapse;font-size:14px}.human-table th,.human-table td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.human-table th{font-size:13px}.human-table-wrap{overflow-x:auto;max-width:100%}.human-table caption{text-align:left;padding:10px 0;color:var(--muted,var(--dim,#5f6875))}.human-card code{overflow-wrap:anywhere}.human-empty{padding:18px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.human-section-title{font-size:25px!important;text-transform:none!important;letter-spacing:0!important;margin:36px 0 8px!important}.human-next li{margin:10px 0}.human-card p{max-width:82ch}.human-badge{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px}
:focus-visible{outline:3px solid var(--accent,#2456d6);outline-offset:3px}button{cursor:pointer}a{overflow-wrap:anywhere}
@media(max-width:600px){.human-card{padding:16px}.human-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.human-table{min-width:700px}.human-table th,.human-table td{padding:8px}.human-nav{gap:6px}.human-intro{font-size:16px}}
@media print{.human-nav,button,.bar{display:none!important}body{background:white!important;color:#111!important}.human-card{break-inside:avoid}.human-details{break-inside:avoid}details[open]{display:block}.human-stat{padding:10px}}
`;
