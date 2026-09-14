import {NibePumpDriver} from '../../lib/driver';
import {fProfile} from './profile';

class NibeFDriver extends NibePumpDriver {
    profile = fProfile;
}

module.exports = NibeFDriver;
