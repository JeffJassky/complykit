import type {
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
} from '../../shared/api';

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
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
};
