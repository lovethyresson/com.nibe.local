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

  /** For widgets/autopilot/api.js. Throws in the owner's language when the device is gone. */
  autopilotWidget(id: unknown) {
    const devices = this.autopilotDevices();
    const device = devices.find((d) => String(d.getData().id) === String(id)) ?? (id ? undefined : devices[0]);
    if (!device) throw new Error(this.homey.__('autopilot.widget.not_function'));
    return device.autopilotWidget();
  }

}

module.exports = NibeApp;
