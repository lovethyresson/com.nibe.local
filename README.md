# Nibe Heatpumps (local Modbus, multi-device)

A Homey app that talks directly to Nibe heat pumps over Modbus TCP on the local network (bypassing the MyUplink
cloud). A single physical pump is paired as several devices — Main, Heating, Hot Water, Pool and Cooling — each with
its own capabilities and energy meter, with the pump's power allocated per function by its operating priority.

Originally forked from [sparud/net.sparud.nibe_s](https://github.com/sparud/net.sparud.nibe_s) (by Jan Sparud, with
Kjell Blomberg); reworked into a local multi-device app with per-function energy tracking.
