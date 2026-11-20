'use strict';

// The Plan vs actual widget's one endpoint (app.ts costCheckWidget, lib/autopilot/cost-check.ts).
module.exports = {
  async getData({homey, query}) {
    homey.app.widgetShown('cost_check');
    return homey.app.costCheckWidget(query.device);
  },
};
