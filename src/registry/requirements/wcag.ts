import type { Requirement } from '../schema.js';
import type { Severity } from '../ids.js';
import { asRequirementId, asInstrumentId } from '../ids.js';

// WCAG 2.2 Level A/AA — the audit bar (README: 2.1 AA is what DOJ Title II and
// EN 301 549 legally incorporate; we check to 2.2). Most of these arrive as
// findings via axe mappings; a few have own browser rules. Normative excerpts
// are short paraphrase-free quotes under the W3C Document License.

const WCAG = asInstrumentId('wcag');
const WCAG_22_EFFECTIVE = '2023-10-05'; // WCAG 2.2 Recommendation

function sc(
  id: string,
  principle: number,
  guideline: number,
  scNum: number,
  level: 'A' | 'AA',
  title: string,
  text: string,
  severity: Severity,
  opts: { version?: string } = {},
): Requirement {
  return {
    id: asRequirementId(id),
    instrument: WCAG,
    citation: { kind: 'sc', principle, guideline, sc: scNum, level },
    title,
    text,
    urls: [
      {
        href: `https://www.w3.org/WAI/WCAG22/Understanding/${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}.html`,
      },
    ],
    effective: { from: WCAG_22_EFFECTIVE },
    version: opts.version ?? '2.2',
    // No appliesIf: accessibility obligations apply regardless of property tags.
    severity,
  };
}

export const WCAG_REQUIREMENTS: Requirement[] = [
  sc('wcag22.1.1.1', 1, 1, 1, 'A', 'Non-text Content',
    'All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.2.2', 1, 2, 2, 'A', 'Captions Prerecorded',
    'Captions are provided for all prerecorded audio content in synchronized media, except when the media is a media alternative for text and is clearly labeled as such.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.3.1', 1, 3, 1, 'A', 'Info and Relationships',
    'Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.3.5', 1, 3, 5, 'AA', 'Identify Input Purpose',
    'The purpose of each input field collecting information about the user can be programmatically determined when the field serves a purpose identified in the Input Purposes list and the technology supports it.',
    'moderate', { version: '2.1' }),
  sc('wcag22.1.4.3', 1, 4, 3, 'AA', 'Contrast Minimum',
    'The visual presentation of text and images of text has a contrast ratio of at least 4.5:1, except for large text (3:1), incidental, and logotype text.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.4.11', 1, 4, 11, 'AA', 'Non-text Contrast',
    'User interface components and graphical objects have a contrast ratio of at least 3:1 against adjacent colors.',
    'serious', { version: '2.1' }),
  sc('wcag22.2.1.1', 2, 1, 1, 'A', 'Keyboard',
    'All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes.',
    'critical', { version: '2.0' }),
  sc('wcag22.2.2.2', 2, 2, 2, 'A', 'Pause Stop Hide',
    'For moving, blinking, scrolling, or auto-updating information, mechanisms are available to pause, stop, or hide it, subject to the stated exceptions.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.4.3', 2, 4, 3, 'A', 'Focus Order',
    'If a page can be navigated sequentially and the navigation sequences affect meaning or operation, focusable components receive focus in an order that preserves meaning and operability.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.4.4', 2, 4, 4, 'A', 'Link Purpose In Context',
    'The purpose of each link can be determined from the link text alone or together with its programmatically determined context, except where ambiguous to users in general.',
    'moderate', { version: '2.0' }),
  sc('wcag22.2.4.7', 2, 4, 7, 'AA', 'Focus Visible',
    'Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.5.8', 2, 5, 8, 'AA', 'Target Size Minimum',
    'The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except where spacing, equivalent, inline, essential, or user-agent-controlled.',
    'moderate'),
  sc('wcag22.3.1.1', 3, 1, 1, 'A', 'Language of Page',
    'The default human language of each Web page can be programmatically determined.',
    'serious', { version: '2.0' }),
  sc('wcag22.3.2.2', 3, 2, 2, 'A', 'On Input',
    'Changing the setting of a user interface component does not automatically cause a change of context unless the user has been advised beforehand.',
    'moderate', { version: '2.0' }),
  sc('wcag22.3.3.2', 3, 3, 2, 'A', 'Labels or Instructions',
    'Labels or instructions are provided when content requires user input.',
    'serious', { version: '2.0' }),
  sc('wcag22.4.1.2', 4, 1, 2, 'A', 'Name Role Value',
    'For all user interface components, the name and role can be programmatically determined; states, properties, and values can be programmatically set; and notification of changes is available to user agents.',
    'critical', { version: '2.0' }),

  // Criteria reached mainly via axe mappings (browser layer). Kept concise.
  sc('wcag22.1.2.1', 1, 2, 1, 'A', 'Audio-only and Video-only Prerecorded',
    'For prerecorded audio-only and video-only media, an alternative presents equivalent information, except when the media is itself an alternative for text and clearly labeled.',
    'moderate', { version: '2.0' }),
  sc('wcag22.1.3.4', 1, 3, 4, 'AA', 'Orientation',
    'Content does not restrict its view and operation to a single display orientation, such as portrait or landscape, unless a specific orientation is essential.',
    'moderate', { version: '2.1' }),
  sc('wcag22.1.4.1', 1, 4, 1, 'A', 'Use of Color',
    'Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.4.2', 1, 4, 2, 'A', 'Audio Control',
    'If any audio plays automatically for more than 3 seconds, a mechanism is available to pause or stop it or to control its volume independently of the system volume.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.4.4', 1, 4, 4, 'AA', 'Resize Text',
    'Except for captions and images of text, text can be resized without assistive technology up to 200 percent without loss of content or functionality.',
    'serious', { version: '2.0' }),
  sc('wcag22.1.4.12', 1, 4, 12, 'AA', 'Text Spacing',
    'No loss of content or functionality occurs when a user sets line height to 1.5x font size, paragraph spacing to 2x, letter spacing to 0.12x, and word spacing to 0.16x.',
    'moderate', { version: '2.1' }),
  sc('wcag22.2.2.1', 2, 2, 1, 'A', 'Timing Adjustable',
    'For each time limit set by the content, the user can turn it off, adjust it, or extend it, subject to the stated exceptions.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.4.1', 2, 4, 1, 'A', 'Bypass Blocks',
    'A mechanism is available to bypass blocks of content that are repeated on multiple Web pages.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.4.2', 2, 4, 2, 'A', 'Page Titled',
    'Web pages have titles that describe topic or purpose.',
    'serious', { version: '2.0' }),
  sc('wcag22.2.5.3', 2, 5, 3, 'A', 'Label in Name',
    'For user interface components with labels that include text or images of text, the accessible name contains the visible label text.',
    'serious', { version: '2.1' }),
  sc('wcag22.3.1.2', 3, 1, 2, 'AA', 'Language of Parts',
    'The human language of each passage or phrase in the content can be programmatically determined, subject to the stated exceptions.',
    'moderate', { version: '2.0' }),
  sc('wcag22.4.1.1', 4, 1, 1, 'A', 'Parsing',
    'In content implemented using markup languages, elements have complete start and end tags, are nested according to specification, do not contain duplicate attributes, and any IDs are unique (obsolete in WCAG 2.2 but retained for incorporated 2.0/2.1 references).',
    'minor', { version: '2.0' }),
];
