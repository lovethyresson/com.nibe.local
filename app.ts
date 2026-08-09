import Homey from 'homey';

class NibeApp extends Homey.App {

  async onInit() {
    // A rejected promise nobody awaited is otherwise invisible here: Homey's app host doesn't
    // print one, so the only symptom is a device that quietly stopped updating. Everything that
    // can reject on a poll now has its own .catch, and this is the net under them — it names the
    // app in the log rather than letting the reason disappear.
    process.on('unhandledRejection', (reason: any) => {
      this.error('Unhandled promise rejection:', reason?.stack ?? reason?.message ?? reason);
    });

    this.log('Nibe Heatpumps app has been initialized');
  }

}

module.exports = NibeApp;
