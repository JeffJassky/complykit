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
];
