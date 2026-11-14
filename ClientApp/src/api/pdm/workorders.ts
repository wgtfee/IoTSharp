import request from '/@/utils/request';
import type { PdmResponse } from './index';

export type PdmWorkOrderState = 'Open' | 'Assigned' | 'InProgress' | 'Completed' | 'Closed';

export interface PdmInternalWorkOrder {
  id: string;
  tenantId: string;
  customerId: string;
  deviceId: string;
  profileId: string;
  profileVersion: number;
  riskEventId: string;
  workOrderNo: string;
  riskLevel: 'Warning' | 'Critical';
  title: string;
  description: string;
  state: PdmWorkOrderState;
  assignedTo: string | null;
  resolution: string;
  revision: number;
  firstObservedUtc: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  completedAtUtc: string | null;
  closedAtUtc: string | null;
}

export interface PdmInternalWorkOrderPage {
  total: number;
  page: number;
  pageSize: number;
  rows: PdmInternalWorkOrder[];
}

export interface PdmInternalWorkOrderTransition {
  expectedRevision: number;
  action: 'Assign' | 'Start' | 'Complete' | 'Close';
  assignedTo: string | null;
  reason: string;
}

export const listPdmInternalWorkOrders = (params: {
  page?: number;
  pageSize?: number;
  state?: PdmWorkOrderState;
  deviceId?: string;
}): Promise<PdmResponse<PdmInternalWorkOrderPage>> =>
  request.get('/api/pdm/workorders', { params }) as unknown as Promise<PdmResponse<PdmInternalWorkOrderPage>>;

export const createPdmInternalWorkOrderFromRisk = (riskEventId: string):
  Promise<PdmResponse<PdmInternalWorkOrder>> =>
  request.post(`/api/pdm/workorders/from-risk/${encodeURIComponent(riskEventId)}`, {}) as unknown as Promise<PdmResponse<PdmInternalWorkOrder>>;

export const transitionPdmInternalWorkOrder = (id: string,
  data: PdmInternalWorkOrderTransition): Promise<PdmResponse<PdmInternalWorkOrder>> =>
  request.post(`/api/pdm/workorders/${encodeURIComponent(id)}/transition`, data) as unknown as Promise<PdmResponse<PdmInternalWorkOrder>>;
