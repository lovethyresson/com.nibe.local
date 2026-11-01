/** Sun on the house's walls, from where the sun is and what the forecast says reaches the ground.
 *  Pure. Design: docs/smart-heating-plan.md §5.3, §6.1.
 *
 *  Open-Meteo gives irradiance on one tilted surface per request. Three walls would take three
 *  requests, so the walls are computed here from direct-normal and diffuse light instead, with an
 *  isotropic sky. The south wall is still Open-Meteo's own (`gtiS`), which is what the history has
 *  always held; this module adds east and west, so a house with its windows facing west learns
 *  that its sun comes in the afternoon. */

const RAD = Math.PI / 180;

/** Ground reflectance seen by a vertical wall: grass and bare ground. Snow is ~0.6, not modelled. */
export const ALBEDO = 0.2;

/** Wall facing, degrees clockwise from north. */
export const WALLS = {east: 90, south: 180, west: 270} as const;

export interface SunPosition {
    /** Above the horizon, radians. */
    altitude: number;
    /** Clockwise from north, radians. */
    azimuth: number;
}

/** NOAA's low-precision series (Spencer 1971): within ~0.5° over the year, plenty for a window. */
export function sunPosition(ms: number, latitude: number, longitude: number): SunPosition {
    const date = new Date(ms);
    const start = Date.UTC(date.getUTCFullYear(), 0, 1);
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const day = Math.floor((ms - start) / 86_400_000);
    const g = 2 * Math.PI / 365 * (day + (hours - 12) / 24);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
        - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
        + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const solarMinutes = hours * 60 + eqTime + 4 * longitude;
    const hourAngle = (solarMinutes / 4 - 180) * RAD;
    const lat = latitude * RAD;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
    const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
    const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
    return {altitude, azimuth};
}

/** W/m² on a vertical wall facing `wall` degrees: the direct beam where it strikes the wall, half
 *  the sky's diffuse light and half the ground's reflection. */
export function wallIrradiance(dni: number, dhi: number, ghi: number, sun: SunPosition, wall: number): number {
    const incidence = sun.altitude > 0 ? Math.cos(sun.altitude) * Math.cos(sun.azimuth - wall * RAD) : 0;
    return Math.max(0, dni) * Math.max(0, incidence) + Math.max(0, dhi) / 2 + ALBEDO * Math.max(0, ghi) / 2;
}
