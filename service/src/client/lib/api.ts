import type { CreateBatchRequest, CreateBatchResponse, JobDetail, JobSummary, JobsResponse } from '../../shared/api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  jobs: () => request<JobsResponse>('GET', '/api/jobs'),
  job: (id: string) => request<JobDetail>('GET', `/api/jobs/${encodeURIComponent(id)}`),
  createBatch: (req: CreateBatchRequest) => request<CreateBatchResponse>('POST', '/api/batches', req),
  cancel: (id: string) => request<JobSummary>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  remove: (id: string) => request<void>('DELETE', `/api/jobs/${encodeURIComponent(id)}`),
};
