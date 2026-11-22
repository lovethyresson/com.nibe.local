'use strict';

// The Getting started widget's one endpoint (app.ts gettingStartedWidget, lib/autopilot/settling.ts).
module.exports = {
  async getData({homey, query}) {
    homey.app.widgetShown('getting_started');
    return homey.app.gettingStartedWidget(query.device);
  },
};
