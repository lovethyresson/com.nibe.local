/** The app's Web API: one read-only endpoint that returns exactly what a dashboard widget is sent,
 *  so the maintainer (or Claude) can check a widget against live data without a phone:
 *  GET /api/app/com.nibe.local/widget/<savings|savings_hotwater|autopilot|hotwater_use|hotwater_tank|energy|cost_check|day_plan|overview|crashes>?device=<data id>.
 *  It needs an owner's token like any app endpoint, and writes nothing. */
module.exports = {
  async getWidgetData({homey, params, query}: {homey: any; params: {id: string}; query: {device?: string}}) {
    const app = homey.app;
    switch (params.id) {
      case 'savings': return app.savingsWidget(query.device, 'heating');
      case 'savings_hotwater': return app.savingsWidget(query.device, 'hotwater');
      case 'autopilot': return app.autopilotWidget(query.device);
      case 'hotwater_use': return app.hotwaterUseWidget(query.device);
      case 'hotwater_tank': return app.hotwaterTankWidget(query.device);
      case 'energy': return app.energyWidget(query.device);
      case 'cost_check': return app.costCheckWidget(query.device);
      case 'day_plan': return app.dayPlanWidget(query.device);
      case 'overview': return app.overviewWidget(query.device);
      case 'crashes': return app.crashJournal();
      default: throw new Error(`No widget ${params.id}`);
    }
  },
};
