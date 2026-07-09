import {Driver} from 'homey';
import PairSession from "homey/lib/PairSession";
import net from "net";
import {capabilitiesOptions} from './driver.compose.json';
import {Selection, groupIds, isAdjustable, isRegisterEnabled, registers} from './registers';
import {DetectionResult, probeHost} from './detection';

class NibeSDriver extends Driver {
  async onInit() {
    this.log('Nibe S-Series driver has been initialized');
  }

  // Group/register metadata for the features view, with titles localized the
  // same way as the flow-card autocompletes (per-instance compose titles).
  private groupInfo() {
    const language = this.homey.i18n.getLanguage();
    const title = (name: string) => {
      const option: any = (capabilitiesOptions as any)[name];
      return option?.title?.[language] || option?.title?.en || name;
    };
    return groupIds.map((id) => ({
      id,
      name: this.homey.__(`groups.${id}`) || id,
      registers: registers
        .filter((register) => register.group === id)
        .map((register) => ({
          name: register.name,
          title: title(register.name),
          adjustable: isAdjustable(register),
          description: (register.info as any)[language] || register.info.en
        }))
    }));
  }

  // Build the {groups, overrides} selection from what the features view sends,
  // only keeping overrides that differ from their group's setting.
  private static cleanSelection(raw: any): Selection {
    const groups: Selection["groups"] = {};
    for (const id of groupIds)
      groups[id] = !!raw?.groups?.[id];
    const overrides: Selection["overrides"] = {};
    for (const register of registers) {
      if (register.group === "core")
        continue; // core registers are always enabled
      const override = raw?.overrides?.[register.name];
      if (typeof override === "boolean" && override !== groups[register.group])
        overrides[register.name] = override;
    }
    return {groups, overrides};
  }

  async onPair(session: PairSession): Promise<void> {
    let ipAddress: string | null = null;
    let detection: DetectionResult | null = null;
    let detectionRunning: Promise<DetectionResult> | null = null;

    session.setHandler('ip_address_entered', async (data) => {
      this.log('onPair: ip_address_entered:', data);
      if (!net.isIP(data.ipaddress)) {
        throw new Error(this.homey.__('pair.valid_ip_address'));
      }
      ipAddress = data.ipaddress;
      return true;
    });

    session.setHandler('get_context', async () => ({
      mode: 'pair',
      groups: this.groupInfo(),
      selection: null
    }));

    session.setHandler('start_detection', async () => {
      if (!detectionRunning) {
        detectionRunning = probeHost(ipAddress!, (pass, passes) =>
          session.emit('detection_progress', {pass, passes}).catch(() => {}))
          .catch((error) => {
            detectionRunning = null; // allow the view's retry button to try again
            throw error;
          });
      }
      detection = await detectionRunning;
      this.log('Detection result:', JSON.stringify(detection));
      return detection;
    });

    session.setHandler('get_detection', async () => detection);

    session.setHandler('selection_done', async (raw) => {
      const selection = NibeSDriver.cleanSelection(raw);
      this.log('onPair: selection:', JSON.stringify(selection));
      return {
        name: 'Nibe S-Series',
        data: {
          id: ipAddress,
        },
        settings: {
          address: ipAddress
        },
        store: {
          selection
        },
        capabilities: [
          'meter_power.total',
          ...registers
            .filter((register) => isRegisterEnabled(register, selection))
            .map((register) => register.name)
        ]
      };
    });
  };

  async onRepair(session: PairSession, device: any): Promise<void> {
    let detection: DetectionResult | null = null;
    let detectionRunning: Promise<DetectionResult> | null = null;

    session.setHandler('get_context', async () => {
      const selection = (device.getStoreValue('selection') ?? null) as Selection | null;
      return {
        mode: 'repair',
        groups: this.groupInfo(),
        selection
      };
    });

    session.setHandler('start_detection', async () => {
      if (!detectionRunning) {
        detectionRunning = device.probeForDetection((pass: number, passes: number) =>
          session.emit('detection_progress', {pass, passes}).catch(() => {}))
          .catch((error: any) => {
            detectionRunning = null; // allow the view's retry button to try again
            throw error;
          });
      }
      detection = await detectionRunning;
      this.log('Repair detection result:', JSON.stringify(detection));
      return detection;
    });

    session.setHandler('get_detection', async () => detection);

    session.setHandler('selection_done', async (raw) => {
      const selection = NibeSDriver.cleanSelection(raw);
      this.log('onRepair: selection:', JSON.stringify(selection));
      await device.applySelection(selection);
      return true;
    });
  }
}

module.exports = NibeSDriver;
