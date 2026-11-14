import request from '/@/utils/request';
import type { PdmResponse } from './index';

export interface PdmP3Shadow {
  deviceId: string;
  profileId: string;
  profileVersion: number;
  state: 'Unverified' | 'StatisticsOnly' | 'HistoricalStatisticsOnly';
  windowEndUtc: string | null;
  explanation: string;
  pointKey: string | null;
  unit: string | null;
  operatingMode: string | null;
  robustDeviationScore: number | null;
  baselineMedian: number | null;
  baselineMad: number | null;
  experimentSha256: string | null;
  readOnly: boolean;
  isAlertDelivered: boolean;
  isWorkOrderCreated: boolean;
  failureProbability: number | null;
  remainingUsefulLifeHours: number | null;
}

// Deliberately GET only: does not run inference, mutate equipment or issue work orders.
export const getPdmP3Shadow = (deviceId: string): Promise<PdmResponse<PdmP3Shadow>> =>
  request.get('/api/pdm/p3/shadow', { params: { deviceId } }) as unknown as Promise<PdmResponse<PdmP3Shadow>>;

