import type {
  ConsentConfigRequest,
  ConsentConfigResponse,
  CreateBatchRequest,
  CreateBatchResponse,
  JobDetail,
  JobSummary,
  JobsResponse,
  KbConfirmRequest,
  KbDismissRequest,
  KbEntry,
  KbProposal,
  KbRejectRequest,
  KbResearchRequest,
  KbResearchState,
  KbResponse,
  RerenderRequest,
  RerenderResponse,
  RescanRequest,
  RescanResponse,
  SiteWorkspace,
  SiteWorkspacePatch,
  SiteWorkspacePatchResponse,
  SitesResponse,
  VerifyTaskResponse,
} from '../../shared/api';

/** An API failure: the server's message, plus its HTTP status so callers can word 400/409 for people. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The JSON error body, when there was one (e.g. rerender's `configStored`). */
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let data: Record<string, unknown> | undefined;
    try {
      data = (await res.json()) as Record<string, unknown>;
      if (typeof data?.error === 'string' && data.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status, data && typeof data === 'object' ? data : undefined);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  jobs: () => request<JobsResponse>('GET', '/api/jobs'),
  job: (id: string) => request<JobDetail>('GET', `/api/jobs/${encodeURIComponent(id)}`),
  createBatch: (req: CreateBatchRequest) => request<CreateBatchResponse>('POST', '/api/batches', req),
  cancel: (id: string) => request<JobSummary>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  remove: (id: string) => request<void>('DELETE', `/api/jobs/${encodeURIComponent(id)}`),

  kb: () => request<KbResponse>('GET', '/api/kb'),
  kbPacket: async (domain: string) => (await send('GET', `/api/kb/packet/${encodeURIComponent(domain)}`)).text(),
  kbResearch: (req: KbResearchRequest) => request<KbResearchState>('POST', '/api/kb/research', req),
  kbConfirm: (id: string, req: KbConfirmRequest) => request<KbEntry>('POST', `/api/kb/proposals/${encodeURIComponent(id)}/confirm`, req),
  kbReject: (id: string, req: KbRejectRequest) => request<KbProposal>('POST', `/api/kb/proposals/${encodeURIComponent(id)}/reject`, req),
  kbDismiss: (req: KbDismissRequest) => request<void>('POST', '/api/kb/dismiss', req),

  sites: () => request<SitesResponse>('GET', '/api/sites'),
  siteWorkspace: (domain: string) => request<SiteWorkspace>('GET', `/api/sites/${encodeURIComponent(domain)}/workspace`),
  generateConsentConfig: (jobId: string, req: ConsentConfigRequest = {}) =>
    request<ConsentConfigResponse>('POST', `/api/jobs/${encodeURIComponent(jobId)}/consent-config`, req),
  patchWorkspace: (domain: string, patch: SiteWorkspacePatch) => request<SiteWorkspacePatchResponse>('PATCH', `/api/sites/${encodeURIComponent(domain)}/workspace`, patch),
  /** Re-render a job's consent report with the site's current workspace; `generate: true` makes the config from that run first (R2). */
  rerender: (jobId: string, req: RerenderRequest = {}) => request<RerenderResponse>('POST', `/api/jobs/${encodeURIComponent(jobId)}/rerender`, req),
  /** The checklist's last step: a new consent job with the options of the site's latest one. */
  rescan: (domain: string, req: RescanRequest = {}) => request<RescanResponse>('POST', `/api/sites/${encodeURIComponent(domain)}/rescan`, req),
  /** Run one checklist task's check (R4); the service stores the result under task:change:<id>. */
  verifyTask: (domain: string, id: string) => request<VerifyTaskResponse>('POST', `/api/sites/${encodeURIComponent(domain)}/remediation/${encodeURIComponent(id)}/verify`, {}),
};
