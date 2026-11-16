'use strict';

// The Hot water savings widget's one endpoint (app.ts savingsWidget, lib/autopilot/savings.ts). Its
// page is its own: Heating savings (widgets/savings) is designed separately.
module.exports = {
  async getData({homey, query}) {
    return homey.app.savingsWidget(query.device, 'hotwater');
  },
};
