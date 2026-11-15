'use strict';

// The Hot water tank widget's one endpoint: everything it draws, translated, from the device the
// owner picked (app.ts hotwaterTankWidget, lib/autopilot/hotwater-tank.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.hotwaterTankWidget(query.device);
  },
};
