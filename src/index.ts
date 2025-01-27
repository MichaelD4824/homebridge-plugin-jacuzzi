import type { API } from 'homebridge';

import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { SpaHomebridgePlatform } from './platform';

/**
 * This method registers the platform with Homebridge
 */
export = (api: API) => {
	api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SpaHomebridgePlatform);
}