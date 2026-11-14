import request from '/@/utils/request';

export interface PdmResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export interface PdmStatus {
  enabled: boolean;
  configured: boolean;
  state: 'Disabled' | 'PendingApproval' | 'Configured';
  message: string;
  readOnly: boolean;
  requiresVerifiedDeviceData: boolean;
}

export type PdmRiskLevel = 'Normal' | 'Attention' | 'Warning' | 'Critical' | 'Unknown';

export interface PdmDeviceHealth {
  profileId: string;
  deviceId: string;
  assetId: string | null;
  productId: string | null;
  profileVersion: number;
  profileEnabled: boolean;
  pointMappingsVerified: boolean;
  runStateVerified: boolean;
  dataQuality: string;
  riskLevel: PdmRiskLevel;
  healthIndex: number | null;
  lastEvaluatedUtc: string | null;
  failedPointCount: number;
}

export interface PdmOverview {
  totalDevices: number;
  activeRisks: number;
  page: number;
  pageSize: number;
  rows: PdmDeviceHealth[];
}

export interface PdmRiskEvent {
  id: string;
  deviceId: string;
  profileVersion: number;
  riskType: string;
  riskLevel: PdmRiskLevel;
  status: 'Open' | 'Cleared';
  firstObservedUtc: string;
  lastObservedUtc: string;
  clearedAtUtc: string | null;
  occurrenceCount: number;
  recoveryStreak: number;
  evidenceJson: string;
}

export interface PdmRisks {
  total: number;
  page: number;
  pageSize: number;
  rows: PdmRiskEvent[];
}

export interface PdmTrend {
  id: string;
  windowStartUtc: string;
  windowEndUtc: string;
  healthIndex: number | null;
  coverageRatio: number;
  riskLevel: PdmRiskLevel;
  dataQuality: string;
  failedPointCount: number;
  explanationJson: string;
}

export interface PdmPointPolicy {
  telemetryKey: string;
  unit: string;
  enabled: boolean;
  required: boolean;
  expectedIntervalSeconds: number;
  minValidValue: number;
  maxValidValue: number;
  warningHighValue: number;
  criticalHighValue: number;
  risingTrendPerMinute: number | null;
}

export interface PdmProfile {
  profileId: string;
  deviceId: string;
  version: number;
  enabled: boolean;
  pointMappingsVerified: boolean;
  runStateVerified: boolean;
  windowMinutes: number;
  minimumCoverageRatio: number;
  points: PdmPointPolicy[];
}

// All calls are read-only. Axios response interceptor already unwraps the HTTP body.
function read<T>(path: string, params?: Record<string, string | number>): Promise<PdmResponse<T>> {
  return request.get(path, { params }) as unknown as Promise<PdmResponse<T>>;
}

export const getPdmStatus = () => read<PdmStatus>('/api/pdm/status');

export const getPdmOverview = (page = 1, pageSize = 20) =>
  read<PdmOverview>('/api/pdm/overview', { page, pageSize });

export const getPdmRisks = (status: 'Open' | 'Cleared' | 'All', page = 1, pageSize = 20, deviceId?: string) =>
  read<PdmRisks>('/api/pdm/risks', { status, page, pageSize, ...(deviceId ? { deviceId } : {}) });

export const getPdmTrend = (deviceId: string, days = 7) =>
  read<PdmTrend[]>('/api/pdm/trend', { deviceId, days });

export const getPdmProfile = (deviceId: string) =>
  read<PdmProfile>('/api/pdm/profile', { deviceId });

