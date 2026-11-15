'use strict';

// The Hot water savings widget's one endpoint (app.ts savingsWidget, lib/autopilot/savings.ts). Its
// page is widgets/savings/public/index.html, copied byte for byte (a test keeps them identical).
module.exports = {
  async getData({homey, query}) {
    return homey.app.savingsWidget(query.device, 'hotwater');
  },
};
