import Homey from 'homey';
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
    track('Started App', {prompt_version: 'BA400.4', app_version: appVersion()});

    // The settings page toggles consent by writing the setting directly (the same way it already
    // reads the alarm history). Listening here is what makes that a real switch rather than a
    // stored preference nothing acts on — withdrawal takes effect on the next event, not next boot.
    this.homey.settings.on('set', (key: string) => {
      if (key === CONSENT_SETTING)
        refreshConsent(this.homey);
    });

    this.log('Nibe Live app has been initialized');
  }

}

module.exports = NibeApp;
