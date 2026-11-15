'use strict';

// The Autopilot savings widget's one endpoint: everything it draws, translated, from the device the
// owner picked (app.ts savingsWidget, lib/autopilot/savings.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.savingsWidget(query.device, 'heating');
  },
};
