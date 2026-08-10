import { appmessage, IListQueryParam } from '../iapiresult';
import request from '/@/utils/request';
interface QueryParam extends IListQueryParam {
    offset: number;
    limit: number;
    Name?: string;
    sorter?: string;
    status?: any;
    AckDateTime?: any;
    ClearDateTime?: any;
    StartDateTime?: any;
    EndDateTime?: any;
    AlarmType?: string;
    OriginatorName?: string;
    alarmStatus?: string;
    originatorId?: string;
    serverity?: string;
    originatorType?: string;
}
export function getAlarmList(query: QueryParam) {
    return request.post(`/api/alarm/list`, {
        Offset: Number(query.offset) || 0,
        Limit: Number(query.limit) || 10,
        Name: query.Name || '',
        AlarmType: query.AlarmType || '',
        AlarmStatus: normalizeFilterNumber(query.alarmStatus),
        Serverity: normalizeFilterNumber(query.serverity),
        OriginatorType: normalizeFilterNumber(query.originatorType),
        OriginatorId: normalizeOptionalValue(query.originatorId),
        AckDateTime: normalizeDateRange(query.AckDateTime),
        ClearDateTime: normalizeDateRange(query.ClearDateTime),
        StartDateTime: normalizeDateRange(query.StartDateTime),
        EndDateTime: normalizeDateRange(query.EndDateTime),
    })
}



export function clear(id: string) {
    return request.post(`/api/alarm/clearAlarm`, {
        id: id
    })
}



export function acquire(id: string) {
    return request.post(`/api/alarm/ackAlarm`, {
        id: id
    })
}
export function getoriginators(params: any) {
    return request.post(`/api/alarm/originators`, {
        ...params,
        OriginatorType: normalizeFilterNumber(params?.OriginatorType ?? params?.originatorType),
    })
}

function normalizeFilterNumber(value: unknown) {
    if (value === '' || value === null || value === undefined) return -1;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : -1;
}

function normalizeDateRange(value: unknown) {
    return Array.isArray(value) && value.length === 2 ? value : undefined;
}

function normalizeOptionalValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
