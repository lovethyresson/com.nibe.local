# External temperature Flow actions

Heating exposes **Set outdoor temperature (BT1)** when its outdoor-temperature capability is
selected. It accepts −50–60 °C as a number or numeric Flow token and writes holding register 5217.
Values are rounded to tenths, encoded as signed 16-bit words and sent using FC6 through the
existing shared connection/write queue. The range is an app guardrail.

BT50 is supplied by the automatic Homey sensor feed configured in Heating Setup, rather than a
standalone Flow card. Users can select one sensor or an equal average of several. Pairing saves a
pending configuration; Repair verifies and activates the persistent feed. See
[indoor sensor plan](indoor-sensor-plan.md) for its lifecycle and recovery requirements.

A successful BT1 action means the Modbus write was accepted, not proof that the external sensor is
enabled. Transport failures reach the Flow. No second pump connection is opened.

## Pump setup

Enable Modbus TCP/IP writes in menu 7.5.9 and the relevant external sensor in **7.5.9.2**.
BT50 writes were introduced in firmware **4.2.4**. Room-sensor/zone configuration must also select
an appropriate controlling sensor. Existing wireless zone control may continue to determine the
climate-system average; turning on external BT50 alone does not demonstrate replacement.
Do not automatically change zones, SPA, heating curves, or external-sensor activation.

The BT1 card sends once. A Flow must supply fresh readings regularly, including when the measured
value is unchanged. Its loss-of-feed timeout and wired-sensor fallback remain unverified; do not
assume stopping a Flow restores the physical sensor.

The activated BT50 feed refreshes in the background. Stopping it requires restoring the pump's
native sensor and disabling external BT50 on the pump before switching back in Heating Setup.
Installing the app does not activate a new feed; an already active feed resumes after restart.

## Hardware evidence — S1155-16, 2026-09-11

Pump reports raw firmware code 1036 (not mapped to a display version).

- Both holding registers initially returned 32768 (`0x8000`, unavailable).
- FC6 to 5987 with raw 238 was acknowledged and read back as 238 after 300 ms. After another
  1.2 seconds it returned 32768. A later raw 239 was also accepted; climate-system average input
  116 stayed at 238. Individual room inputs 26/25/24 returned exceptions. **Initial write acceptance was verified, but effective readback was unavailable.** After the
  owner selected BT50 to control the zone, input 26 became readable: writing 239 changed it from
  238 to 239 after two seconds. Restoring 238 restored input 26 to 238. **BT50 scale 10 and
  effective sensor replacement are now verified.** Input 116 stayed at 238 during this eight-second
  test; its aggregation/update timing and the eventual heating response remain unverified.
- FC6 to 5217 with raw 149 changed input 1 from 148 to 149 (14.8 → 14.9 °C). It remained 149 for a further 30-second test without refreshing, after
  the holding register cleared. Restoring raw 148 restored input 1 to 148. **BT1 scale 10 and
  effective temperature replacement are verified.**
- Both mailboxes clear to 32768 within roughly a second. Re-reading persistent state would give
  false failures. Writing 32768 back is not a way to undo a consumed temperature; restore the
  temperature itself. Final feeds were restored to BT50 23.8 °C and BT1 14.8 °C.
- Holding 5986 returned exception 1; do not use it as a universal activation switch.

This establishes a BT1 input for experimenting with outdoor-temperature compensation. It does not
establish a validated Ngenic-equivalent controller, loss-of-communication handling or energy savings.

## Sources

- [NIBE firmware history](https://www.nibe.eu/webdav/files/myuplink_changelog/nibe-n.pdf), 4.2.4.
- [NIBE Modbus manual](https://assetstore.nibe.se/hcms/v2.3/entity/document/878103/storage/ODc4MTAzLzAvbWFzdGVy), external sensors. Its factor-1 statement conflicts with measured BT1 behaviour.
- [SMO S40 BT50 report and export](https://github.com/home-assistant/core/issues/155175), raw 217 = 21.7 °C; this is another model, not proof of this S1155's controlling input.
