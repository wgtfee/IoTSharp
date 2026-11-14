import request from '/@/utils/request';
import type { PdmResponse } from './index';

export interface PdmP2Review {
  id: string;
  deviceId: string;
  profileId: string;
  profileVersion: number;
  riskEventId: string;
  fingerprint: string;
  title: string;
  state: 'AwaitingHumanReview' | 'ApprovedForPlanning' | 'Rejected';
  revision: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface PdmP2ReviewAudit {
  id: string;
  reviewId: string;
  actorId: string;
  action: string;
  reason: string;
  atUtc: string;
}

export interface PdmP2ReviewPage {
  total: number;
  page: number;
  pageSize: number;
  rows: PdmP2Review[];
  audits: PdmP2ReviewAudit[];
}

// Read-only review trail. There is intentionally no approve/reject/order POST API.
export function getPdmP2Reviews(
  deviceId: string,
  page = 1,
  pageSize = 20
): Promise<PdmResponse<PdmP2ReviewPage>> {
  return request.get('/api/pdm/p2/reviews', { params: { deviceId, page, pageSize } }) as unknown as Promise<PdmResponse<PdmP2ReviewPage>>;
}