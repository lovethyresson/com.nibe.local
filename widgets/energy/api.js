'use strict';

// The Energy today widget's one endpoint: everything it draws, translated, for the pump whose Main
// device the owner picked (app.ts energyWidget, lib/autopilot/energy.ts).
module.exports = {
  async getData({homey, query}) {
    homey.app.widgetShown('energy');
    return homey.app.energyWidget(query.device);
  },
};
