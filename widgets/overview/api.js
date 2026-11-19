'use strict';

// The Overview widget's one endpoint: everything it draws, translated, for the pump whose Main
// device the owner picked (app.ts overviewWidget, lib/autopilot/overview.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.overviewWidget(query.device);
  },
};
