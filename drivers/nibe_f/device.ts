import {NibePumpDevice} from '../../lib/device';
import {fProfile} from './profile';

class NibeFDevice extends NibePumpDevice {
    profile = fProfile;
}

module.exports = NibeFDevice;
