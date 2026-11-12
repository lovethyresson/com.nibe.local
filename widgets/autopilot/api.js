'use strict';

// The Autopilot widget's one endpoint: everything it draws, translated, from the device the owner
// picked (app.ts autopilotWidget, lib/autopilot/widget.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.autopilotWidget(query.device);
  },
};
