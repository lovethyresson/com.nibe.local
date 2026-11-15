'use strict';

// The Day plan widget's one endpoint: one pump's plan today, translated, from the Main device the
// owner picked (app.ts dayPlanWidget, lib/autopilot/day-plan.ts).
module.exports = {
  async getData({homey, query}) {
    return homey.app.dayPlanWidget(query.device);
  },
};
