// Report vocabulary is findings / evidence / coverage. The word "compliant"
// (and "non-compliant") must never appear in renderer output — accessiBe took a
// finalized $1M FTC order for exactly that overclaim (README). This guard is
// asserted over every renderer's output in the report tests.

const BANNED = /\b(non-?)?compliant\b/i;

export function containsBannedVocabulary(text: string): boolean {
  return BANNED.test(text);
}

/** Throw if a renderer ever emits a conformance verdict. Belt to the tests' braces. */
export function assertReportVocabulary(text: string): void {
  const m = text.match(BANNED);
  if (m) {
    throw new Error(
      `report output contains forbidden verdict vocabulary "${m[0]}" — reports state ` +
        `findings, evidence, and coverage, never conformance conclusions`,
    );
  }
}
