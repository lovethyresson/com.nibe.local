import Homey from 'homey';
import {announceRelease} from './lib/release-announcements';
import {CONSENT_SETTING, appVersion, initAnalytics, refreshConsent, track} from './lib/analytics';

class NibeApp extends Homey.App {

  async onInit() {
    // A rejected promise nobody awaited is otherwise invisible here: Homey's app host doesn't
    // print one, so the only symptom is a device that quietly stopped updating. Everything that
    // can reject on a poll now has its own .catch, and this is the net under them — it names the
    // app in the log rather than letting the reason disappear.
    process.on('unhandledRejection', (reason: any) => {
      this.error('Unhandled promise rejection:', reason?.stack ?? reason?.message ?? reason);
    });

    // The single init for the whole app lifecycle. Without stored consent this touches nothing.
    initAnalytics(this.homey, (...args) => this.log(...args), (...args) => this.error(...args));
    track('Started App', {app_version: appVersion()});

    // The settings page toggles consent by writing the setting directly (the same way it already
    // reads the alarm history). Listening here is what makes that a real switch rather than a
    // stored preference nothing acts on — withdrawal takes effect on the next event, not next boot.
    this.homey.settings.on('set', (key: string) => {
      if (key === CONSENT_SETTING)
        refreshConsent(this.homey);
    });

    void announceRelease(this.homey).catch(error => this.error('Release announcement failed:', error));

    this.registerAutopilotWidget();
    this.registerHotwaterUseWidget();
    this.registerSavingsWidgets();
    this.registerDayPlanWidget();

    this.log('Nibe Live app has been initialized');
  }

  /** Every Heating and Hot water device, the ones Autopilot runs first. */
  private autopilotDevices(): any[] {
    const devices = Object.values(this.homey.drivers.getDrivers()).flatMap((driver: any) => driver.getDevices() as any[]);
    return devices.filter((d) => d.role === 'heating' || d.role === 'hotwater')
      .sort((a, b) => Number(b.smartMode?.() === 'autopilot' || b.smartMode?.() === 'test')
        - Number(a.smartMode?.() === 'autopilot' || a.smartMode?.() === 'test'));
  }

  /** The Autopilot widget (widgets/autopilot): its device picker, and its data by device. */
  private registerAutopilotWidget() {
    const widget = (this.homey as any).dashboards?.getWidget?.('autopilot');
    widget?.registerSettingAutocompleteListener('device', async (query: string) => this.autopilotDevices()
      .map((d) => ({id: String(d.getData().id), name: d.getName()}))
      .filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase())));
  }

  /** For widgets/autopilot/api.js. A problem comes back as a line in the owner's language, never as
   *  an error, so the widget only ever sees a failure when it cannot reach the app at all. */
  autopilotWidget(id: unknown) {
    const line = (key: string) => ({kind: 'none', title: '', chips: [], slots: [], ticks: [], legend: {}, empty: this.homey.__(key)});
    const devices = this.autopilotDevices();
    const device = devices.find((d) => String(d.getData().id) === String(id)) ?? (id ? undefined : devices[0]);
    // Right after a start the devices are not up yet: "starting", not "pick a device".
    if (!device && process.uptime() < 120) return {kind: 'none', title: '', chips: [], slots: [], ticks: [], legend: {}, loading: true,
      status: this.homey.__('autopilot.widget.starting_title'), reason: this.homey.__('autopilot.widget.starting_app')};
    if (!device) return line('autopilot.widget.not_function');
    try {
      return device.autopilotWidget();
    } catch (error) {
      this.error('Autopilot widget:', error);
      return line('autopilot.widget.error');
    }
  }

  /** The Hot water use widget (widgets/hotwater_use): its picker offers the Hot water devices. */
  private registerHotwaterUseWidget() {
    const widget = (this.homey as any).dashboards?.getWidget?.('hotwater_use');
    widget?.registerSettingAutocompleteListener('device', async (query: string) => this.autopilotDevices()
      .filter((d) => d.role === 'hotwater')
      .map((d) => ({id: String(d.getData().id), name: d.getName()}))
      .filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase())));
  }

  /** The savings widgets: Heating savings (widgets/savings, its id kept from when one widget did
   *  both) and Hot water savings (widgets/savings_hotwater). Each picker offers its own devices. */
  private registerSavingsWidgets() {
    for (const [id, role] of [['savings', 'heating'], ['savings_hotwater', 'hotwater']] as const) {
      const widget = (this.homey as any).dashboards?.getWidget?.(id);
      widget?.registerSettingAutocompleteListener('device', async (query: string) => this.autopilotDevices()
        .filter((d) => d.role === role)
        .map((d) => ({id: String(d.getData().id), name: d.getName()}))
        .filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase())));
    }
  }

  /** For the two savings widgets' api.js. A card set to a device shows that device, whatever its role, so
   *  a Heating savings card added before the split and set to Hot water keeps working. With no
   *  device picked: the first of `role`. Answers a problem with a line, like the Autopilot widget. */
  savingsWidget(id: unknown, role: 'heating' | 'hotwater' = 'heating') {
    const line = (key: string) => ({title: '', empty: this.homey.__(key)});
    const devices = this.autopilotDevices();
    const device = devices.find((d) => String(d.getData().id) === String(id)) ?? (id ? undefined : devices.find((d) => d.role === role));
    // Right after a start the devices are not up yet: a card asking then gets "starting", not "pick".
    if (!device && process.uptime() < 120) return {title: '', loading: true, status: this.homey.__('autopilot.widget.starting_title'),
      reason: this.homey.__('autopilot.savings.loading')};
    if (!device) return line(`autopilot.savings.pick_${role}`);
    try {
      return device.savingsWidget();
    } catch (error) {
      this.error('Savings widget:', error);
      return line('autopilot.widget.error');
    }
  }

  /** For widgets/hotwater_use/api.js. Answers a problem with a line, like the Autopilot widget. */
  /** The Day plan widget (widgets/day_plan): one per pump, so its picker offers the Main devices. */
  private registerDayPlanWidget() {
    const widget = (this.homey as any).dashboards?.getWidget?.('day_plan');
    widget?.registerSettingAutocompleteListener('device', async (query: string) => this.mainDevices()
      .map((d) => ({id: String(d.getData().id), name: d.getName()}))
      .filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase())));
  }

  private mainDevices(): any[] {
    return Object.values(this.homey.drivers.getDrivers()).flatMap((driver: any) => driver.getDevices() as any[])
      .filter((d) => d.role === 'main');
  }

  /** For widgets/day_plan/api.js. Like the others, a problem comes back as a translated line. */
  dayPlanWidget(id: unknown) {
    const line = (key: string) => ({title: '', chips: [], prices: [], ticks: [], lanes: {}, legend: {}, empty: this.homey.__(key)});
    const devices = this.mainDevices();
    const device = devices.find((d) => String(d.getData().id) === String(id)) ?? (id ? undefined : devices[0]);
    if (!device && process.uptime() < 120) return {title: '', chips: [], prices: [], ticks: [], lanes: {}, legend: {}, loading: true,
      status: this.homey.__('autopilot.widget.starting_title')};
    if (!device) return line('autopilot.day_plan.pick');
    try {
      return device.dayPlanWidget();
    } catch (error) {
      this.error('Day plan widget:', error);
      return line('autopilot.widget.error');
    }
  }

  hotwaterUseWidget(id: unknown) {
    const line = (key: string) => ({title: '', empty: this.homey.__(key)});
    const devices = this.autopilotDevices().filter((d) => d.role === 'hotwater');
    const device = devices.find((d) => String(d.getData().id) === String(id)) ?? (id ? undefined : devices[0]);
    if (!device) return line('autopilot.hotwater_use.pick');
    try {
      return device.hotwaterUseWidget();
    } catch (error) {
      this.error('Hot water use widget:', error);
      return line('autopilot.widget.error');
    }
  }

}

module.exports = NibeApp;
