import {NibePumpDriver} from '../../lib/driver';
import {sProfile} from './profile';

// Thin S-series driver: the whole implementation is the shared NibePumpDriver base; this
// class only supplies the S model profile.
class NibeSDriver extends NibePumpDriver {
    profile = sProfile;
}

module.exports = NibeSDriver;
