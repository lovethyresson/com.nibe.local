// Raw wire evidence for remote model/gateway validation. This deliberately says when
// Homey received a value, never when the heat pump measured it: gateways may cache it.
export interface ReadDiagnostic {
    receivedAt: string;
    address: number;
    functionCode: 3 | 4;
    count: number;
    words: number[];
    durationMs: number;
    queueMs: number;
    error?: string;
}

export function formatReadDiagnostic(sample: ReadDiagnostic): string {
    const words = sample.words.map((word) => `0x${word.toString(16).padStart(4, '0')}`).join(',');
    return `received=${sample.receivedAt} FC${sample.functionCode} address=${sample.address} `
        + `count=${sample.count} words=[${words}] request=${sample.durationMs}ms queue=${sample.queueMs}ms`
        + (sample.error ? ` error=${sample.error}` : '');
}
