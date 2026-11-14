import request from '/@/utils/request';
import type { PdmResponse } from './index';

export interface PdmP2Trend {
  direction: 'Unknown' | 'Stable' | 'Declining' | 'Improving';
  validWindows: number;
  slopePointsPerHour: number | null;
  changePoints: number | null;
  windowEndUtc: string | null;
  reason: string;
}

export interface PdmP2Alert {
  kind: 'Held' | 'BelowThreshold' | 'Suppressed' | 'Notify' | 'Escalate';
  reason: string;
  idempotencyKey: string | null;
  isProposalOnly: boolean;
  isDelivered: boolean;
}

export interface PdmP2Maintenance {
  state: 'NotApplicable' | 'NeedsDataVerification' | 'ReadyForHumanReview';
  linkedRiskEventId: string | null;
  title: string;
  explanation: string;
  suggestedChecks: string[];
  requiresHumanApproval: boolean;
  isWorkOrderIssued: boolean;
  failureProbability: number | null;
  remainingUsefulLifeHours: number | null;
}

export interface PdmP2Shadow {
  deviceId: string;
  profileId: string;
  profileVersion: number;
  state: 'Unknown' | 'NoOpenRisk' | 'Unverified' | 'ProposalOnly';
  latestWindowUtc: string | null;
  trend: PdmP2Trend;
  alert: PdmP2Alert;
  maintenance: PdmP2Maintenance;
  readOnly: boolean;
  message: string;
}

// Deliberately GET-only: never deliver alerts or mutate production work orders.
export const getPdmP2Shadow = (deviceId: string): Promise<PdmResponse<PdmP2Shadow>> =>
  request.get('/api/pdm/p2/shadow', { params: { deviceId } }) as unknown as Promise<PdmResponse<PdmP2Shadow>>;

