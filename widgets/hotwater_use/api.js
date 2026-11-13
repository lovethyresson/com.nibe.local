'use strict';

// The Hot water use widget's one endpoint: everything it draws, translated, from the device the
// owner picked (app.ts hotwaterUseWidget, lib/autopilot/hotwater-use.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.hotwaterUseWidget(query.device);
  },
};
