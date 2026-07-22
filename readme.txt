This app monitors and controls Nibe heat pumps directly on your local network over Modbus TCP, without going through
the MyUplink cloud connection. Current power, energy, temperature and flow values are collected and shown, and you can
set modes, target temperatures and other settings. All values are also exposed as flow triggers, conditions and actions.

What makes this app different is that a single physical pump is paired as several devices — one per function
(heating, hot water, pool and cooling) — each with its own capabilities and its own energy meter. The pump's total
power draw is allocated to the right function device based on the pump's current operating priority, so you can see,
for example, how much energy goes to heating versus cooling over a year. A main device carries the shared sensors
(outdoor temperature, operating priority and mode) and diagnostics. During pairing the app scans your network for
pumps and highlights which functions have live data, but you can still add any of them.

To use this app you need:
- A Nibe heat pump with Modbus TCP enabled (menu 7.5.9), on the same local network as your Homey.
- The pump's local IP address (pairing can also autodetect it).

With this app you can change many values on your Nibe. The machine and how it operates is complex, so make sure you
know what you are doing when changing settings. The app is provided free of charge and the authors cannot take
responsibility for any problems caused by such changes. The changes are the same as can be done in the MyUplink app,
and/or in your heatpumps local settings. Be extra careful when automating control.

If a flow action tries to write a value that is out of range the flow will fail with a descriptive error message.

Credits: based on the original app by Jan Sparud. Register definitions
were cross-checked against the yozik04/nibe register library (GPL-3.0) to verify
addresses and scaling across the Nibe S-series.
