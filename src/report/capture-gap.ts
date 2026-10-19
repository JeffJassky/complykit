// plans/report-truth.md B — which coverage notes could hide a tool's activity. Contract stub.
export interface CoverageNote { scope: string; id: string; location?: string; reason: string }
export function hidesActivity(_note: CoverageNote, _party: { domain: string; hosts: readonly string[] }): boolean {
  throw new Error('not implemented (plans/report-truth.md B)');
}
