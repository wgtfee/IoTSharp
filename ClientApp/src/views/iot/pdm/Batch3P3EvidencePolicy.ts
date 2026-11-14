import type { PdmP3Shadow } from '/@/api/pdm/p3';

export interface Batch3EvidenceVerdict {
  trustedStatistics: boolean;
  report: PdmP3Shadow | null;
  reason: string;
}

/**
 * Client-side defense in depth: never display non-reviewed model-like
 * payloads as trustworthy statistics. The API/JWT/DB gates remain authoritative.
 * Synthetic or unverified P3 responses can never become a fault probability.
 */
export function checkPdmP3Evidence(
  raw: PdmP3Shadow | null | undefined
): Batch3EvidenceVerdict {
  const blocked = (reason: string): Batch3EvidenceVerdict => ({
    trustedStatistics: false,
    report: null,
    reason,
  });
  if (!raw || raw.readOnly !== true || raw.isAlertDelivered !== false ||
    raw.isWorkOrderCreated !== false ||
    raw.failureProbability != null || raw.remainingUsefulLifeHours != null) {
    return blocked('P3 证据缺少只读安全标记或包含未经批准的预测/派工结果。');
  }
  if (raw.state === 'Unverified') {
    return {
      trustedStatistics: false,
      report: {
        ...raw,
        robustDeviationScore: null,
        baselineMedian: null,
        baselineMad: null,
        experimentSha256: null,
        failureProbability: null,
        remainingUsefulLifeHours: null,
      },
      reason: '',
    };
  }
  if (raw.state !== 'StatisticsOnly' &&
      raw.state !== 'HistoricalStatisticsOnly') {
    return blocked('未知 P3 状态已拒绝展示。');
  }
  const validMetric = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const validUtc = (v: string | null): boolean =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/i.test(v) &&
    !Number.isNaN(Date.parse(v));
  if (!validMetric(raw.robustDeviationScore) ||
      !validMetric(raw.baselineMedian) ||
      !validMetric(raw.baselineMad) ||
      !raw.pointKey?.trim() || !raw.unit?.trim() ||
      !raw.operatingMode?.trim() ||
      !validUtc(raw.windowEndUtc) ||
      !/^[0-9a-f]{64}$/.test(raw.experimentSha256 ?? '') ||
      !raw.profileId || raw.profileVersion < 1) {
    return blocked('统计证据的点位、工况、UTC、数值或实验指纹未通过核验。');
  }
  return { trustedStatistics: true, report: raw, reason: '' };
}

