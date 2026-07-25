import alarmData from './alarm-codes.json';

// Nibe alarm-code lookup. The pump reports faults as a bare *number* (S: register 1975
// "Alarm number"); neither Nibe's Modbus CSVs nor the open-source register datasets map that
// number to text, so lib/alarm-codes.json is generated from NIBE's own alarm-code database
// by dev/fetch-alarms.mjs. See dev/README.md.
//
// THE TWO SERIES USE DIFFERENT NUMBERING — this is not cosmetic. 301 codes exist in both
// lists and 300 of them mean different things: 438 is "lost connection to wireless device"
// on S but "temporarily overheated inverter" on F; 163 is "incorrect phase sequence" on S but
// "high condenser in temperature" on F. Applying the wrong table is worse than having none,
// so every profile must name its own series and the lookup is series-scoped.
//
// LANGUAGES. NIBE publishes this database on nibe.eu in Swedish only — there is no official
// de/nl/no/da (or even English) edition to import, and the country sites don't host the
// widget. So: `sv` is NIBE's own wording (authoritative), `en` is our translation, and every
// other language falls back to English rather than to a machine rendering we cannot verify.
// The alarm *capability titles* and *Flow cards* are localized into all six app languages —
// it's only the fault descriptions that are en/sv. The long `advice` text (cause + suggested
// action) stays Swedish: it runs to whole paragraphs, so we show NIBE's words verbatim and
// link to the source instead of guessing.

export type AlarmSeries = 's' | 'f';

export interface AlarmEntry {
    sv: string;
    en: string;
    advice?: string;
}

// Where the descriptions come from; shown alongside the advice so a user can read the
// original (and look up a code we don't know).
export const ALARM_SOURCE_URL = 'https://www.nibe.eu/sv-se/support/larmkoder';

const TABLES: Record<AlarmSeries, Record<string, AlarmEntry>> =
    {s: (alarmData as any).s, f: (alarmData as any).f};

export function alarmEntry(series: AlarmSeries, code: number): AlarmEntry | undefined {
    return TABLES[series]?.[String(code)];
}

// Short label for a code: "No alarm" at 0, "<code>: <text>" when known, and a localized
// "Alarm <n>" fallback otherwise — so an unrecognised code still reads as something
// actionable rather than blank.
const NO_ALARM: Record<string, string> = {
    en: "No alarm", sv: "Inget larm", de: "Kein Alarm", nl: "Geen alarm", no: "Ingen alarm", da: "Ingen alarm"
};
const UNKNOWN: Record<string, string> = {
    en: "Alarm", sv: "Larm", de: "Alarm", nl: "Alarm", no: "Alarm", da: "Alarm"
};

export function alarmDescription(series: AlarmSeries, code: number, language: string): string {
    if (code === 0)
        return NO_ALARM[language] || NO_ALARM.en;
    const entry = alarmEntry(series, code);
    if (!entry)
        return `${UNKNOWN[language] || UNKNOWN.en} ${code}`;
    // Swedish is NIBE's original; everything else gets the English translation.
    return `${code}: ${language === 'sv' ? entry.sv : entry.en}`;
}

// NIBE's cause/suggested-action text for a code, when they publish one. Swedish only.
export function alarmAdvice(series: AlarmSeries, code: number): string | undefined {
    return alarmEntry(series, code)?.advice;
}
