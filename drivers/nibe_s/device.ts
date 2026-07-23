import {NibePumpDevice} from '../../lib/device';
import {sProfile} from './profile';

// Thin S-series device: the whole implementation is the shared NibePumpDevice base; this
// class only supplies the S model profile.
class NibeSDevice extends NibePumpDevice {
    profile = sProfile;
}

module.exports = NibeSDevice;
