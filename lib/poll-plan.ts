import type {ModelProfile} from './profile';
import type {Register} from './registers';

// Keep every input consumed by a completed energy/thermostat poll in that poll.
// Background values are dispatched separately and never passed off as fresh energy inputs.
export function frequentRegisterNames(profile: ModelProfile): Set<string> {
    return new Set([
        ...(profile.polling?.frequent ?? []),
        ...profile.role.powerSources.flat(),
        profile.role.priorityRegisterName,
        ...Object.values(profile.role.producedRegisterForRole),
        profile.role.totalConsumptionRegister, profile.role.totalProductionRegister,
        ...Object.values(profile.roomThermostat ?? {}),
        ...Object.values(profile.hotwaterTank ? {
            top: profile.hotwaterTank.topRegister, lower: profile.hotwaterTank.lowerRegister
        } : {})
    ].filter((name): name is string => !!name));
}

export function planPoll(profile: ModelProfile, registers: Register[], attempted: Map<string, number>, now: number) {
    if (!profile.polling) return {frequent: registers, background: [] as Register[]};
    const names = frequentRegisterNames(profile);
    const background = registers.filter((r) => !names.has(r.name)
        && now - (attempted.get(r.name) ?? -Infinity) >= profile.polling!.backgroundIntervalMs)
        .sort((a, b) => (attempted.get(a.name) ?? -Infinity) - (attempted.get(b.name) ?? -Infinity))
        .slice(0, 1);
    return {frequent: registers.filter((r) => names.has(r.name)), background};
}
