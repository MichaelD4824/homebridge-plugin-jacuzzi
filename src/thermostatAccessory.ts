import { CharacteristicEventTypes } from 'homebridge';
import type { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';

import { SpaHomebridgePlatform } from './platform';
import { VERSION } from './settings';

/**
 * A thermostat temperature control for the Spa.
 * 
 * It looks like it might be possible to move the Flow sensor to a pair of "Filter Condition", 
 * "Filter life" settings on the thermostat. Might be a slightly better fit for Homekit's approach.
 * At least we could have a "change soon" indicator on the thermostat alerting the user.
 * See https://developer.apple.com/documentation/homekit/hmcharacteristictypefilterlifelevel and 
 * related topics.
 * 
 * MD2024: Part of me wants to allow the cool state and show heating when hot tub heater is on and
 * cool when it's off, but theres no way to prevent HomeKit from prompting the user for a value.
 * Intead if I always force heating, at least the user can't attempt to set "cool".
 */
export class ThermostatAccessory {
	private service: Service;

	constructor(
		private readonly platform: SpaHomebridgePlatform,
		private readonly accessory: PlatformAccessory,
	) {

		// set accessory information
		this.accessory.getService(this.platform.Service.AccessoryInformation)!
			.setCharacteristic(this.platform.Characteristic.Manufacturer, 'Jacuzzi')
			.setCharacteristic(this.platform.Characteristic.Model, this.platform.name)
			.setCharacteristic(this.platform.Characteristic.SerialNumber, VERSION);

		// get the Thermostat service if it exists, otherwise create a new Thermostat service
		// you can create multiple services for each accessory
		this.service = this.accessory.getService(this.platform.Service.Thermostat) ?? this.accessory.addService(this.platform.Service.Thermostat);

		// set the service name, this is what is displayed as the default name on the Home app
		// in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
		this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

		// each service must implement at-minimum the "required characteristics" for the given service type
		// see https://developers.homebridge.io/#/service/Thermostat

		// register handlers for the required Characteristics
		this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
			.on(CharacteristicEventTypes.GET, this.getCurrentTemperature.bind(this));
		this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
			.on(CharacteristicEventTypes.SET, this.setTargetTemperature.bind(this))
			.on(CharacteristicEventTypes.GET, this.getTargetTemperature.bind(this));
		this.setTargetTempMinMax();
		this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
			.on(CharacteristicEventTypes.GET, this.getTemperatureDisplayUnits.bind(this));
		this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
			.on(CharacteristicEventTypes.GET, this.getHeatingState.bind(this)).setProps({
				minValue: 1,
				maxValue: 2,
				validValues: [1,2]
			})
		// Adjust properties to only allow Off and Heat (not Cool or Auto which are irrelevant)
		this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
			.on(CharacteristicEventTypes.SET, this.setTargetHeatingState.bind(this)).setProps({
				minValue: 1,
				maxValue: 2,
				validValues: [1,2]
			})
			.on(CharacteristicEventTypes.GET, this.getTargetHeatingState.bind(this));
	}

	//Jacuzzi allows 50F (10C) and 104F (40C).  Tell HomeKit that this is our range
	setTargetTempMinMax() {
		this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).setProps({
			minValue: 10,
			maxValue: 40.0,
			minStep: 0.5
		});
	}

	/**
	 * Handle the "GET" requests from HomeKit
	 * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
	 * 
	 * GET requests should return as fast as possbile. A long delay here will result in
	 * HomeKit being unresponsive and a bad user experience in general.
	 * 
	 * If your device takes time to respond you should update the status of your device
	 * asynchronously instead using the `updateCharacteristic` method instead.
  
	 * @example
	 * this.service.updateCharacteristic(this.platform.Characteristic.get, true)
	 */
	getCurrentTemperature(callback: CharacteristicGetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			callback(this.platform.connectionProblem);
		} else {
			const temperature = this.platform.spa!.getCurrentTemp();
			// Seems as if Homekit interprets null as something simply to be ignored, hence Homekit
			// just uses the previous known value.
			const val = (temperature == undefined ? null : temperature);

			this.platform.log.debug('Get Current Temperature <-', val, this.platform.status());

			callback(null, this.toCelsius(val ?? 50));
		}
	}

	getTemperatureDisplayUnits(callback: CharacteristicGetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			callback(this.platform.connectionProblem);
		} else {
			const units = this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
			this.platform.log.debug('Get Temperature Display Units <- Fahrenheit', units, this.platform.status());

			callback(null, units);
		}
	}

	getHeatingState(callback: CharacteristicGetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			callback(this.platform.connectionProblem);
		} else {
			const heating = this.platform.spa!.getIsHeatingNow() ?? true;

			callback(null, heating ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : this.platform.Characteristic.CurrentHeatingCoolingState.COOL);
		}
	}

	getTargetHeatingState(callback: CharacteristicGetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			callback(this.platform.connectionProblem);
		} else {
			const heating = this.platform.spa!.getIsHeatingNow() ?? true;

			callback(null, heating ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT : this.platform.Characteristic.TargetHeatingCoolingState.COOL);

		}
	}

	setTargetHeatingState(value: CharacteristicValue, callback: CharacteristicSetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			this.platform.recordAction(this.setTargetHeatingState.bind(this, value));
			callback(this.platform.connectionProblem);
			return;
		}

		//Thermostat accessory is designed for home, so you can turn it to "Cool" mode (AC) or "Heat" mode (Furnance).
		//This doesn't apply to Jacuzzi so do nothing here
		return;
	}

	getTargetTemperature(callback: CharacteristicGetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			callback(this.platform.connectionProblem);
		} else {
			const temperature = this.platform.spa!.getTargetTemp();
			this.platform.log.debug('Get Target Temperature <-', temperature, this.platform.status());

			let temperatureC = this.toCelsius(temperature ?? 10);
			if (temperatureC > 40 || temperatureC < 10)
				callback(null, 10);
			else
				callback(null, temperatureC);
		}
	}

	setTargetTemperature(value: CharacteristicValue, callback: CharacteristicSetCallback) {
		if (!this.platform.isCurrentlyConnected()) {
			this.platform.recordAction(this.setTargetTemperature.bind(this, value));
			callback(this.platform.connectionProblem);
			return;
		}
		let temp = value as number;
		//if (this.platform.spa!.getTempRangeIsHigh()) {
		if (temp < 10) {
			temp = 10;
			// TODO: This line doesn't actually seem to update homekit.  Unless we can find
			// a way to do this, we'll have to keep the line underneath to reject the change 
			// with an error in the callback.
			this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
				.updateValue(temp);
			callback(new Error("Temperature " + (value as number) + " out of bounds [50,104.0]; using " + temp));
			return;
		}
		// } else {
		else if (temp > 40.0) {
			temp = 40.0;
			// TODO: This line doesn't actually seem to update homekit.  Unless we can find
			// a way to do this, we'll have to keep the line underneath to reject the change 
			// with an error in the callback.
			this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
				.updateValue(temp);
			callback(new Error("Temperature " + (value as number) + " out of bounds [50.0,104.0]; using " + temp));
			return;
		}
		// }
		temp = Math.round(this.toFarenheit(temp));
		this.platform.spa!.setTargetTemperature(temp);
		this.platform.log.debug('Set Target Temperature ->', temp, " (may be different to", value, ")", this.platform.status());

		callback(null);
	}

	spaConfigurationKnown() {
		// Nothing to do
	}

	// If Spa state has changed, for example using manual controls on the spa, then we must update Homekit.
	updateCharacteristics() {
		if (!this.platform.isCurrentlyConnected()) {
			this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(this.platform.connectionProblem);
			this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).updateValue(this.platform.connectionProblem);
			this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).updateValue(this.platform.connectionProblem);
			this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).updateValue(this.platform.connectionProblem);
			return;
		}
		const mode = this.platform.spa!.getTempRangeIsHigh();
		const heating = this.platform.spa!.getIsHeatingNow();
		const temperature = this.platform.spa!.getCurrentTemp();
		const tempVal = (temperature == undefined ? null : temperature!);

		const targetTemperature = this.platform.spa!.getTargetTemp();
		const targetTempVal = (targetTemperature == undefined ? null : targetTemperature!);
		const flowState = this.platform.spa!.getFlowState();

		//this.platform.log.debug('Thermostat updating to: target:',targetTemperature,', current:', temperature, 'is high:', mode, ', is heating:', heating);

		this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(this.toCelsius(tempVal ?? 50));
		this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature).updateValue(this.toCelsius(targetTempVal ?? 50));
		this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState).updateValue(this.platform.spa!.getIsHeatingNow() ? this.platform.Characteristic.TargetHeatingCoolingState.HEAT : this.platform.Characteristic.TargetHeatingCoolingState.COOL);
		this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState).updateValue(this.platform.spa!.getIsHeatingNow() ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT : this.platform.Characteristic.CurrentHeatingCoolingState.COOL);
	}

	toCelsius(value: number) {
		return ((value - 32) * (5 / 9));
	}

	toFarenheit(value: number) {
		return ((value * (9 / 5)) + 32);
	}
}