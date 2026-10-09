import { escapeHtml as esc } from './human.js';

export interface ReviewQuestion { id: string; label: string; hint: string; options?: string[]; }
const q = (id: string, label: string, hint: string): ReviewQuestion => ({ id, label, hint });
export function actionQuestions(rule: string, requirement: string): ReviewQuestion[] {
  const common = [q('assignee', 'Who owns this action?', 'Name the person or team responsible for deciding and implementing the next step.')];
  if (/inventory|unrecognized/.test(rule)) return [...common,
    q('identity', 'Who provides this tool, and why was it added?', 'Check vendor documentation, your tag manager, or the person who installed it. Record the tool-specific answers in the inventory below.'),
    q('decision', 'What did your research establish, and what remains unknown?', 'Record the conclusion and any questions you still need the owner to answer.')];
  if (/wiretap/.test(rule)) return [...common,
    q('shared', 'What information was shared, with whom, and for what purpose?', 'Compare the reported data with vendor documentation and the site’s actual configuration.'),
    q('implementation', 'Where did you hold it until the visitor accepts?', 'Name the consent tool setting, tag manager trigger or script you changed.')];
  if (/consent|tracking|cookie/.test(rule)) return [...common,
    q('purpose', 'What does this tool do on your site?', 'Only needed when complykit could not identify it. complykit applies the rules for that purpose.'),
    q('implementation', 'Where did you change the settings or implementation?', 'Name the tag, consent platform setting, script, banner, or vendor configuration changed.'),
    q('verification', 'What happened before a choice, after rejection, and after acceptance?', 'Record the test location, date, expected behavior and observed result. Include withdrawal or reopening settings where relevant.')];
  if (requirement.startsWith('wcag') || /axe|keyboard|contrast/.test(rule)) return [...common,
    q('implementation', /contrast/.test(rule) ? 'Which colors or styles changed, and what contrast did you measure?' : /name|label|alt/.test(rule) ? 'What accessible label or alternative text did you add?' : /keyboard|focus/.test(rule) ? 'What keyboard or focus behavior did you change?' : 'What did you change in the affected element or component?', 'Identify the affected page/component and the specific correction.'),
    q('verification', 'How did you check this correction against the reported requirement?', 'Record the result, date, and relevant browser, screen size, keyboard or assistive-technology test.')];
  if (/art50/.test(rule) || requirement.startsWith('eu-ai-act')) return [...common,
    q('disclosure', 'What AI disclosure did you add, and where does the visitor see it?', 'Record the wording, placement and timing for the affected interaction.'),
    q('verification', 'How did you confirm visitors can understand this disclosure?', 'Record the reviewer, test and result.')];
  return [...common, q('decision', 'What did you conclude about this observation?', 'Record the cause, agreed correction or reason no change was needed.'), q('verification', 'How did you verify your conclusion?', 'Record the test, reviewer, date and result.')];
}
export function questionFields(questions: ReviewQuestion[]): string {
  return questions.map(q => `<label>${esc(q.label)}<textarea data-review-answer="${esc(q.id)}" data-question-label="${esc(q.label)}" rows="2" maxlength="4000" placeholder="${esc(q.hint)}"></textarea><span class="human-muted">${esc(q.hint)}</span></label>`).join('');
}
