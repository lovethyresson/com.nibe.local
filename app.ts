import Homey from 'homey';

class NibeApp extends Homey.App {

  async onInit() {
    this.log('Nibe Heatpumps app has been initialized');
  }

}

module.exports = NibeApp;
