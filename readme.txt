Nibe Live talks to your Nibe heat pump directly over your local network, without going through the myUplink
cloud. Temperatures, power, energy and operating modes are all shown, you can change settings such as modes and
target temperatures, and everything is available as Flow triggers, conditions and actions.

What makes it different is that one physical pump is added as several devices — one per function, such as
heating, hot water, cooling and pool — each with its own values and its own energy meter, so you can see how
much energy goes to hot water versus heating and automate each function separately. A main device carries the
shared sensors and reports faults in plain language rather than as a bare number. You need Modbus TCP enabled
on the pump (menu 7.5.9) and the pump on the same network as your Homey.

Setup notes, supported models, what differs between them, and troubleshooting are in the Homey Community topic
linked on this page. Changing settings on a heat pump can affect how it runs, so take the same care you would
in myUplink or on the pump itself.

Based on the original app by Jan Sparud.
