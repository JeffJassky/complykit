import { makeInventoryRule } from './inventory-rule.js';

// PII-shaped fields in a data model are scoping input for the GDPR Art. 13
// notice and the C2 data-flow skill. Heuristic (a field named `email` may not be
// personal data in every schema), so always needs-review — never a violation.
export const inventoryPii = makeInventoryRule({
  id: 'inventory.pii-surface',
  category: 'pii',
  requirement: 'gdpr.art13',
  remediation:
    'Confirm this personal-data field is covered by the privacy notice (purpose, legal basis, retention) and the data-subject rights flows.',
  falsePositives:
    'A field whose name matches a PII pattern but holds non-personal data (e.g. a product "address" of a store) is a false positive — dispose accordingly.',
  message: (name, count) =>
    `Personal-data field "${name}" appears in ${count} model definition${count === 1 ? '' : 's'} — confirm GDPR Art. 13 coverage.`,
});
