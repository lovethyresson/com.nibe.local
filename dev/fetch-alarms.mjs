// Maintainer tool (not shipped — see .homeyignore). Regenerates lib/alarm-codes.json from
// NIBE's own alarm-code database, which is the only public source that maps a Nibe alarm
// *number* to text. See dev/README.md.
//
//   node dev/fetch-alarms.mjs
//
// WHY THIS EXISTS
// The pump reports faults as a bare number (S: register 1975). Nibe's Modbus documentation
// and the open-source register libraries all list that register with no enum, so the mapping
// has to come from elsewhere. nibe.eu's support page is backed by a small JSON API that
// returns, per series: {code, text (short title), textLong (cause + suggested action)}.
//
// CRITICAL: the two series use DIFFERENT numbering. 301 codes exist in both lists and 300 of
// them mean different things (438 = "lost wireless connection" on S, "temporarily overheated
// inverter" on F). Using the wrong table is worse than having none, so each driver's profile
// must reference its own series.
//
// LANGUAGES: nibe.eu publishes this page in Swedish only, so `sv` is NIBE's own wording and
// is authoritative. `en` is generated here by phrase substitution over a curated dictionary
// and then checked for residual Swedish — good enough for short, formulaic fault titles, but
// it is a translation, not NIBE copy. The long advice text is kept in Swedish only: it runs
// to whole paragraphs and machine-rendering it would be worse than linking to the source.

import {readFileSync, writeFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'lib', 'alarm-codes.json');

// Hand-written English for the titles the dictionary can't reach (Swedish compound nouns).
// Keyed by NIBE's exact Swedish string, applied after the dictionary pass.
const OVERRIDES = JSON.parse(readFileSync(join(here, 'alarm-en.json'), 'utf8'));

// nibe.eu is SiteVision; the widget fetches its data from this route. `noah` is the S-series
// list and `emmy` the F-series one (the same ids the page's own dropdown uses).
const BASE = 'https://www.nibe.eu/sv-se/support/larmkoder'
    + '?sv.target=12.11473d79186620520971f59'
    + '&sv.12.11473d79186620520971f59.route=/all';
const SERIES = {s: 'noah', f: 'emmy'};

export const SOURCE_URL = 'https://www.nibe.eu/sv-se/support/larmkoder';

// Ordered longest-first: multi-word phrases must win over their component words.
const DICTIONARY = [
    ['stöd för funktion saknas', 'Function not supported'],
    // Compound nouns that carry no å/ä/ö and so used to slip past the residual check.
    ['pooltemperaturgivare', 'pool temperature sensor'],
    ['kondensortemperatur', 'condenser temperature'],
    ['tilluftstemperatur', 'supply air temperature'],
    ['avluftstemperatur', 'exhaust air temperature'],
    ['soltanktemp', 'solar tank temperature'],
    ['givarnoggrannhet', 'sensor accuracy'],
    ['sensorkalibrering', 'sensor calibration'],
    ['motorskyddslarm', 'motor protection alarm'],
    ['avfrostningstid', 'defrosting time'],
    ['avfrostningsfel', 'defrosting fault'],
    ['kylframledning', 'cooling supply line'],
    ['framledningstemp', 'supply temperature'],
    ['returtemperatur', 'return temperature'],
    ['kollektorgivare', 'collector sensor'],
    ['uteluftsgivare', 'outdoor air sensor'],
    ['temperaturskydd', 'temperature protection'],
    ['inverterskydd', 'inverter protection'],
    ['elpatronsdrift', 'immersion heater operation'],
    ['anslutningsfel', 'connection fault'],
    ['lufttrycksfel', 'air pressure fault'],
    ['pressostatlarm', 'pressure switch alarm'],
    ['temperaturlarm', 'temperature alarm'],
    ['mjukstartskort', 'soft start card'],
    ['rumsgivarfel', 'room sensor fault'],
    ['jordningsfel', 'earth fault'],
    ['motorskydd', 'motor protection'],
    ['tryckgivare', 'pressure sensor'],
    ['fuktgivaren', 'the humidity sensor'],
    ['rumsenheten', 'the room unit'],
    ['misslyckats', 'failed'],
    ['misslyckad', 'Failed'],
    ['detekterat', 'detected'],
    ['temperatur', 'temperature'],
    ['hetgaslarm', 'hot gas alarm'],
    ['panngivare', 'boiler sensor'],
    ['effektvakt', 'load monitor'],
    ['rumsenhet', 'room unit'],
    ['aktiverad', 'activated'],
    ['upprepade', 'Repeated'],
    ['sensorfel', 'Sensor fault'],
    ['difftryck', 'differential pressure'],
    ['tryckdiff', 'pressure differential'],
    ['felaktig', 'Incorrect'],
    ['drifttid', 'operating time'],
    ['kyldrift', 'cooling operation'],
    ['hetgas', 'hot gas'],
    ['kortet', 'the card'],
    ['avslut', 'termination'],
    ['tillf.', 'Temporary'],
    ['enhet', 'unit'],
    ['kort', 'Short'],
    ['vv', 'hot water'],
    ['i', 'in'],
    ['dags att rengöra filtret', 'Time to clean the filter'],
    ['dags att byta filter', 'Time to replace the filter'],
    ['dags att byta', 'Time to replace'],
    ['kommunikationsfel', 'Communication error'],
    ['uteluftsvärmepump', 'outdoor air heat pump'],
    ['framledningsgivare', 'supply sensor'],
    ['returledningsgivare', 'return sensor'],
    ['rumstemperaturgivare', 'room temperature sensor'],
    ['tilluftsgivare', 'supply air sensor'],
    ['frånluftsgivare', 'extract air sensor'],
    ['avluftsgivare', 'exhaust air sensor'],
    ['hetgasgivare', 'hot gas sensor'],
    ['lågtryckstransmitter', 'low pressure transmitter'],
    ['högtryckstransmitter', 'high pressure transmitter'],
    ['lågtryckslarm', 'Low pressure alarm'],
    ['högtryckslarm', 'High pressure alarm'],
    ['temperaturbegränsare', 'temperature limiter'],
    ['motorskyddsbrytare', 'motor protection breaker'],
    ['fasföljd', 'phase sequence'],
    ['filterlarm', 'Filter alarm'],
    ['skyddsstopp', 'protective stop'],
    ['skyddsläge', 'protection mode'],
    ['klimatsystem', 'climate system'],
    ['köldbärare', 'brine'],
    ['värmebärare', 'heating medium'],
    ['varmvatten', 'hot water'],
    ['solfångare', 'solar collector'],
    ['solpanel', 'solar panel'],
    ['grundvatten', 'groundwater'],
    ['kondensvatten', 'condensation water'],
    ['nivåvakt', 'level switch'],
    ['givarfel', 'Sensor fault'],
    ['kalibrering', 'Calibration'],
    ['värmepump', 'heat pump'],
    ['tillbehör', 'accessory'],
    ['elpatron', 'immersion heater'],
    ['tillsats', 'additional heat'],
    ['inverter', 'inverter'],
    ['kompressor', 'compressor'],
    ['kompr.', 'compressor'],
    ['förångare', 'evaporator'],
    ['kondensor', 'condenser'],
    ['utegivare', 'outdoor sensor'],
    ['rumsgivare', 'room sensor'],
    ['framledning', 'supply line'],
    ['returledning', 'return line'],
    ['blockerad', 'blocked'],
    ['rapporterar', 'reports'],
    ['shuntstyrd', 'shunt controlled'],
    ['stegstyrd', 'step controlled'],
    ['avfrostning', 'defrosting'],
    ['nödomstart', 'Emergency restart'],
    ['omstart', 'restart'],
    ['överhettad', 'overheated'],
    ['tillfälligt', 'Temporarily'],
    ['trådlös enhet', 'wireless device'],
    ['trådlösa', 'wireless'],
    ['anslutning', 'connection'],
    ['tappad', 'Lost'],
    ['osäker', 'Uncertain'],
    ['noggrannhet', 'accuracy'],
    ['mjukstart', 'soft start'],
    ['serienummer', 'serial number'],
    ['programvara', 'firmware'],
    ['luftflöde', 'air flow'],
    ['frysskydd', 'antifreeze protection'],
    ['strömkänn', 'current sens'],
    ['fuktgivare', 'humidity sensor'],
    ['givare', 'sensor'],
    ['larm', 'alarm'],
    ['elfel', 'Electrical fault'],
    ['komm. fel', 'communication error'],
    ['komm.fel', 'communication error'],
    ['kom.fel', 'communication error'],
    ['komfel', 'communication error'],
    ['best.', 'Permanent'],
    ['saknad', 'missing'],
    ['saknas', 'missing'],
    ['laddning', 'charging'],
    ['stopp', 'Stop'],
    ['pga', 'due to'],
    ['p.g.a.', 'due to'],
    ['eller', 'or'],
    ['övertemperatur', 'overtemperature'],
    ['lågtryck', 'low pressure'],
    ['högtryck', 'high pressure'],
    ['filtret', 'the filter'],
    ['filter', 'filter'],
    ['rengöra', 'clean'],
    ['byta', 'replace'],
    ['dags', 'Time'],
    ['pump', 'pump'],
    ['topp', 'top'],
    ['botten', 'bottom'],
    ['extern', 'external'],
    ['intern', 'internal'],
    ['aktiv', 'active'],
    ['nivå', 'level'],
    ['tryck', 'pressure'],
    ['flöde', 'flow'],
    ['kyla', 'cooling'],
    ['kyl', 'cooling'],
    ['värme', 'heating'],
    ['drift', 'operation'],
    ['fläkt', 'fan'],
    ['ström', 'current'],
    ['effekt', 'power'],
    ['fasfel', 'phase fault'],
    ['fas', 'phase'],
    ['hög', 'High'],
    ['låg', 'Low'],
    ['fel', 'fault'],
    ['mot', 'with'],
    ['från', 'from'],
    ['för', 'for'],
    ['med', 'with'],
    ['och', 'and'],
    ['att', 'to'],
    ['har', 'has'],
    ['ut', 'out'],
    ['in', 'in'],
    ['på', 'on'],
    // Function words. These carry no å/ä/ö, so they slip past the residual check unless
    // translated here — "Lost connection till wireless device" was the giveaway.
    ['till', 'to'],
    ['inte', 'not'],
    ['kan', 'can'],
    ['vid', 'at'],
    ['samt', 'and'],
    ['ingen', 'no'],
    ['inget', 'no'],
    ['inga', 'no'],
    ['ej', 'not'],
    ['av', 'of']
];

// Swedish words with no å/ä/ö that would otherwise pass the residual check unnoticed.
const SWEDISH_STOPWORDS = new Set([
    'till', 'inte', 'kan', 'vid', 'samt', 'ingen', 'inget', 'inga', 'ej', 'av', 'och', 'att',
    'har', 'med', 'mot', 'som', 'den', 'det', 'ett', 'eller', 'pga', 'genom', 'under'
]);

// Swedish words that legitimately survive translation (product/accessory designations).
const KEEP = /^(ers|flm|hts|bm\d*|az\d*|aa\d*|eb\d*|ep\d*|eq\d*|gp\d*|bp\d*|bt\d*|bs\d*|be\d*|qn\d*|em\d*|rmu|sam|hpac|dew|pcd\d*|smo|vvm|s?\d+)$/i;

// Swedish letters are outside JS's \w, so \b fires in the middle of "förångare". Use explicit
// look-around on the Swedish alphabet instead: substring matching is what turned
// "Lågtryckslarm" into "Low pressure aalarm" and "kylmediemängd" into "coolingwithiemängd".
const L = '[A-Za-zÅÄÖåäöÉé]';

// Longest phrase first, always: a shorter entry must never consume part of a longer one
// ("enhet" -> "unit" firing before "trådlös enhet" -> "wireless device" produced the nonsense
// "Lost connection to trådlös unit"). Sorting here means new entries can be added anywhere.
const ORDERED = [...DICTIONARY].sort((a, b) => b[0].length - a[0].length);

function translate(sv) {
    let out = sv;
    for (const [from, to] of ORDERED) {
        const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Only match as a whole word. Phrases ending in "." keep their dot inside the match.
        const re = new RegExp(`(?<!${L})${esc}(?!${L})`, 'gi');
        out = out.replace(re, to);
    }
    out = out.replace(/\s+/g, ' ').replace(/^[–-]\s*/, '').trim();
    return out.charAt(0).toUpperCase() + out.slice(1);
}

function residualSwedish(text) {
    return (text.match(/[A-Za-zÅÄÖåäö]{2,}/g) || []).filter((w) =>
        (/[åäöÅÄÖ]/.test(w) || SWEDISH_STOPWORDS.has(w.toLowerCase())) && !KEEP.test(w));
}

async function fetchSeries(route) {
    const res = await fetch(`${BASE}/${route}&svAjaxReqParam=ajax`, {
        headers: {'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0'}
    });
    if (!res.ok)
        throw new Error(`${route}: HTTP ${res.status}`);
    const {result} = await res.json();
    return result;
}

const out = {
    _source: SOURCE_URL,
    _generated: new Date().toISOString().slice(0, 10),
    _note: 'Generated by dev/fetch-alarms.mjs. sv = NIBE original; en = translated; '
        + 'advice (sv) is NIBE\'s cause/action text. Series numbering differs — do not mix.',
    s: {},
    f: {}
};

const flagged = [];
for (const [key, route] of Object.entries(SERIES)) {
    const rows = await fetchSeries(route);
    for (const row of rows) {
        // Some entries list several sensor variants on separate lines; join them readably.
        const sv = String(row.text || '').replace(/\s*\n\s*/g, ' / ').trim();
        if (!sv)
            continue;
        const en = OVERRIDES[sv] || translate(sv);
        const advice = String(row.textLong || '').replace(/\s*\n\s*/g, '\n').trim();
        out[key][row.code] = advice ? {sv, en, advice} : {sv, en};
        const left = residualSwedish(en);
        if (left.length)
            flagged.push(`${key}/${row.code}: "${sv}" -> "${en}"  [${left.join(', ')}]`);
    }
    console.log(`${key} (${route}): ${Object.keys(out[key]).length} codes`);
}

writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nWrote ${OUT}`);

if (flagged.length) {
    console.log(`\n${flagged.length} English titles still contain Swedish — extend DICTIONARY:`);
    for (const f of flagged.slice(0, 40))
        console.log('  ' + f);
    if (flagged.length > 40)
        console.log(`  … and ${flagged.length - 40} more`);
} else {
    console.log('\nNo residual Swedish in the English titles.');
}
