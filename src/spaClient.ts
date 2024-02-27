import * as crc from "crc";
import type { Logger } from 'homebridge';
import * as net from "net";

export const FLOW_GOOD = "Good";
export const FLOW_LOW = "Low";
export const FLOW_FAILED = "Failed";
export const FLOW_STATES = [FLOW_GOOD, FLOW_LOW, FLOW_FAILED];
const HEATINGMODES = ['Ready', 'Rest', 'Ready in Rest'];
const LIGHTOFF = 0;
const LIGHTFAST = 1;
const LIGHTSLOW = 2;
const LIGHTFREEZE = 3;
const LIGHTBLUE = 4;
const LIGHTVIOLET = 5;
const LIGHTRED = 6;
const LIGHTAMBER = 7;
const LIGHTGREEN = 8;
const LIGHTAQUA = 9;
const LIGHTWHITE = 10;
const LIGHTS = ['Off', 'Fast', 'Slow', 'Freeze', 'Blue', 'Violet', 'Red', 'Amber', 'Green', 'Aqua', 'White'];

const CELSIUS = 'Celsius';
const FAHRENHEIT = 'Fahrenheit';

const PrimaryRequest = new Uint8Array([0x0a, 0xbf, 0x22]);
const GetFaultsMessageContents = new Uint8Array([0x20, 0xff, 0x00]);
const GetFaultsReply = new Uint8Array([0x0a, 0xbf, 0x28]);
// These will tell us how many pumps, lights, etc the Spa has
const ControlTypesMessageContents = new Uint8Array([0x00, 0x00, 0x01]);
const ControlTypesReply = new Uint8Array([0x0a, 0xbf, 0x1e]);

// This one is sent to us automatically every second - no need to request it
const StateReply = new Uint8Array([0xff, 0xaf, 0xc4]);
// This one is sent to us automatically every second - no need to request it
const LightStateReply = new Uint8Array([0xff, 0xaf, 0xca]);
// Sent if the user sets the spa time from the Balboa app
const PreferencesReply = new Uint8Array([0xff, 0xaf, 0x26]);

// These three either don't have a reply or we don't care about it.
const SetTimeOfDayRequest = new Uint8Array([0x0a, 0xbf, 0x21]);
const SetTargetTempRequest = new Uint8Array([0x0a, 0xbf, 0x1a]);
const SetPumpRequest = new Uint8Array([0x0a, 0xbf, 0x17]);
const SetLightRequest = new Uint8Array([0x0a, 0xbf, 0x11]);

// These we send once, but don't actually currently make use of the results
// Need to investigate how to interpret them. 
const ConfigRequest = new Uint8Array([0x0a, 0xbf, 0x04]);
const ConfigReply = new Uint8Array([0x0a, 0xbf, 0x94]);

// Four different request message contents and their reply codes. Unclear of the 
// purpose/value of all of them yet. Again we send each once.
const ControlPanelRequest: Uint8Array[][] = [
	[new Uint8Array([0x01, 0x00, 0x00]), new Uint8Array([0x0a, 0xbf, 0x23])],
	[new Uint8Array([0x02, 0x00, 0x00]), new Uint8Array([0x0a, 0xbf, 0x24])],
	[new Uint8Array([0x04, 0x00, 0x00]), new Uint8Array([0x0a, 0xbf, 0x25])],
	[new Uint8Array([0x08, 0x00, 0x00]), new Uint8Array([0x0a, 0xbf, 0x26])]
];

// Perhaps something to do with ChromaZone
const KnownUnknownReply = new Uint8Array([0xff, 0xaf, 0x32]);

//MD2024: Apparently NodeJS is dumb and % isn't actually mod, it's a remainder.  I lost hours on this...
//https://stackoverflow.com/questions/4467539/javascript-modulo-gives-a-negative-result-for-negative-numbers
function mod(n, m) {
	return ((n % m) + m) % m;
}

export class SpaClient {
	initialSetup: boolean;
	socket?: net.Socket;
	// undefined means the light doesn't exist on the spa
	lightIsOn: (boolean | undefined)[];
	// Jacuzzi specific light settings.  We pull these, but only really use lightMode to determine on/off.
	lightMode: number;
	lightBrightness: number;
	lightR: number;
	lightG: number;
	lightB: number;
	lightCycleTime: number;
	lightStatus: number;
	lightLastUpdated: Date;

	// takes values from 0 to pumpsSpeedRange[thisPump]
	pumpsCurrentSpeed: number[];
	// 0 means doesn't exist, else 1 or 2 indicates number of speeds for this pump
	pumpsSpeedRange: number[];
	//Similar to temperature override below, used to trick HomeKit while multiple commands are sent
	pumpsOverrideSpeed: number[];

	// Current temperature
	currentTemp?: number;
	// When spa is in 'high' mode, what is the target temperature
	targetTempModeHigh?: number;
	// When spa is in 'low' mode, what is the target temperature
	targetTempModeLow?: number;
	// MD2024: Because we can't just send a number and we have to press buttons multiple times, the temperature
	// will iteratively make the change.  e.g. current 100, set 104, we'd see 104, 101, 102, 103, 104.
	// When this value is set, we'll just send this data to HomeKit.  Once target temp is reached, we reset this to -1
	targetTempOverride?: number;
	// Is spa in low or high mode.
	tempRangeIsHigh: boolean;
	// ready, ready at rest, etc.
	heatingMode: string;
	isHeatingNow: boolean;
	tempChangeMode: boolean;

	// MD2024: Just in case the wrong value gets set in HomeKit, I like to refresh every minute.
	// These values help me track when that happened.
	receivedStateUpdate: boolean;
	spaLastUpdated: Date;

	// Takes values from FLOW_STATES
	flow: string;
	// Once the Spa has told us what accessories it really has. Only need to do this once.
	accurateConfigReadFromSpa: boolean;
	// Should be true for almost all of the time, but occasionally the Spa's connection drops
	// and we must reconnect.
	private isCurrentlyConnectedToSpa: boolean;
	numberOfConnectionsSoFar: number = 0;
	liveSinceDate: Date;
	// Stored so that we can cancel intervals if needed
	faultCheckIntervalId: any;
	stateUpdateCheckIntervalId: any;
	isFilterMode: boolean;

	// Store the previous message of each type so we can track if the current message is different
	lastStateBytes = new Uint8Array();
	lastColorStateBytes = new Uint8Array();
	lastFaultBytes = new Uint8Array();

	constructor(public readonly log: Logger, public readonly host: string,
		public readonly spaConfigurationKnownCallback: () => void,
		public readonly changesCallback: () => void,
		public readonly reconnectedCallback: () => void, devMode?: boolean) {
		this.accurateConfigReadFromSpa = false;
		this.isCurrentlyConnectedToSpa = false;
		// Be generous to start. Once we've read the config we will reduce the number of lights if needed.
		this.initialSetup = false;
		this.lightIsOn = [false, false];
		this.lightMode = 0;
		this.lightBrightness = 0;
		this.lightR = 0;
		this.lightG = 0;
		this.lightB = 0;
		this.lightCycleTime = 0;
		this.lightStatus = 0;
		this.lightLastUpdated = new Date();
		this.lightLastUpdated.setDate(new Date().getDate() - 1);
		this.spaLastUpdated = new Date();
		this.spaLastUpdated.setDate(new Date().getDate() - 1);
		this.isFilterMode = false;
		// Be generous to start.  Once we've read the config, we'll set reduce the number of pumps and their number of speeds correctly
		// TODO: Read pumps from config startup.
		this.pumpsCurrentSpeed = [0, 0, 0, 0, 0, 0];
		this.pumpsSpeedRange = [0, 2, 1, 0, 0, 0];
		this.pumpsOverrideSpeed = [-1, -1, -1, -1, -1, -1];
		// All of these will be set by the Spa as soon as we get the first status update
		this.currentTemp = undefined;
		this.heatingMode = "";
		this.tempRangeIsHigh = true;
		this.targetTempModeLow = undefined;
		this.targetTempModeHigh = undefined;
		this.isHeatingNow = false;
		this.tempChangeMode = false;
		this.receivedStateUpdate = true;
		// This isn't updated as frequently as the above
		this.flow = FLOW_GOOD;
		this.liveSinceDate = new Date();
		// Our communications channel with the spa
		this.socket = this.get_socket(host);
	}

	get_socket(host: string) {
		if (this.isCurrentlyConnectedToSpa) {
			this.log.error("Already connected, should not be trying again.");
		}

		this.log.debug("Connecting to Spa at", host, "on port 4257");
		this.socket = net.connect({
			port: 4257,
			host: host
		}, () => {
			this.numberOfConnectionsSoFar++;
			this.liveSinceDate.getUTCDay
			const diff = Math.abs(this.liveSinceDate.getTime() - new Date().getTime());
			const diffDays = Math.ceil(diff / (1000 * 3600 * 24));
			this.log.info('Successfully connected to Spa at', host,
				'on port 4257. This is connection number', this.numberOfConnectionsSoFar,
				'in', diffDays, 'days');
			this.successfullyConnectedToSpa();
		});
		this.socket?.on('end', () => {
			this.log.debug("SpaClient: disconnected:");
		});
		// If we get an error, then retry
		this.socket?.on('error', (error: any) => {
			this.log.info("Had error - closing old socket, retrying in 20s");

			this.shutdownSpaConnection();
			this.reconnect(host);
		});

		return this.socket;
	}

	successfullyConnectedToSpa() {
		this.isCurrentlyConnectedToSpa = true;
		// Reset our knowledge of the state, since it will
		// almost certainly be out of date.
		this.resetRecentState();

		// Update homekit right away, and then again once some data comes in.
		// this.changesCallback();

		// listen for new messages from the spa. These can be replies to messages
		// We have sent, or can be the standard sending of status that the spa
		// seems to do every second.
		this.socket?.on('data', (data: any) => {
			const bufView = new Uint8Array(data);
			this.readAndActOnSocketContents(bufView);
		});

		// No need to do this once we already have all the config information once.
		if (!this.accurateConfigReadFromSpa) {
			// Get the Spa's primary configuration of accessories right away
			this.sendControlTypesRequest();

			// Some testing things. Not yet sure of their use.
			// Note: must use 'let' here so id is bound separately each time.
			for (let id = 0; id < 4; id++) {
				setTimeout(() => {
					this.sendControlPanelRequest(id);
				}, 1000 * (id + 1));
			}
			setTimeout(() => {
				this.send_config_request();
			}, 15000);
		}

		// Wait 5 seconds after startup to send a request to check for any faults
		setTimeout(() => {
			if (this.isCurrentlyConnectedToSpa) {
				this.send_request_for_faults_log();
			}
			if (this.faultCheckIntervalId) {
				this.log.error("Shouldn't ever already have a fault check interval running here.");
			}
			// And then request again once every 10 minutes.
			this.faultCheckIntervalId = setInterval(() => {
				if (this.isCurrentlyConnectedToSpa) {
					this.send_request_for_faults_log();
				}
			}, 10 * 60 * 1000);
		}, 5000);

		// Every minute, make sure we update the log. And if we haven't
		// received a state update, then message the spa so it starts sending
		// us messages again.
		if (this.stateUpdateCheckIntervalId) {
			this.log.error("Shouldn't ever already have a state update check interval running here.");
		}
		this.stateUpdateCheckIntervalId = setInterval(() => {
			if (this.isCurrentlyConnectedToSpa) {
				this.checkWeHaveReceivedStateUpdate();
			}
		}, 60 * 1000)

		// Call to ensure we catch up on anything that happened while we
		// were disconnected.
		this.reconnectedCallback();
	}

	lastIncompleteChunk: (Uint8Array | undefined) = undefined;
	lastChunkTimestamp: (Date | undefined) = undefined;

	/**
	 * We got some data from the Spa. Often one "chunk" exactly equals one message.
	 * But sometimes a single chunk will contain multiple messages back to back, and
	 * so we need to process each in turn. And sometimes a chunk will not contain a full
	 * message - it is incomplete - and we should store it and wait for the rest to
	 * arrive (or discard it if the rest doesn't arrive).
	 * 
	 * @param chunk 
	 */
	readAndActOnSocketContents(chunk: Uint8Array) {
		// If we have a lastIncompleteChunk, then it may be the new chunk is just what is needed to
		// complete that.
		if (this.lastIncompleteChunk) {
			const diff = Math.abs(this.lastChunkTimestamp!.getTime() - new Date().getTime());
			if (diff < 1000) {
				// Merge the messages, if timestamp difference less than 1 second
				chunk = this.concat(this.lastIncompleteChunk, chunk);
				//MD2024: Kinda noisy, supressing this.log.debug("Merging messages of length", this.lastIncompleteChunk.length, "and", chunk.length);
			} else {
				this.log.warn("Discarding old, incomplete message", this.prettify(this.lastIncompleteChunk));
			}
			this.lastIncompleteChunk = undefined;
			this.lastChunkTimestamp = undefined;
		}

		let messagesProcessed = 0;

		while (chunk.length > 0) {
			if (chunk.length < 2) {
				this.log.error("Very short message received (ignored)", this.prettify(chunk));
				break;
			}
			// Length is the length of the message, which excludes the checksum and 0x7e end.
			const msgLength = chunk[1];

			if (msgLength > (chunk.length - 2)) {
				// Cache this because more contents is coming in the next packet, hopefully
				this.lastIncompleteChunk = chunk;
				this.lastChunkTimestamp = new Date();
				//MD2024: Kinda noisy, supressing: this.log.debug("Incomplete message received (awaiting more data)", this.prettify(chunk), "missing", (msgLength - chunk.length +2), "bytes");
				break;
			}
			// We appear to have a full message, perhaps more than one.
			if (chunk[0] == 0x7e && chunk[msgLength + 1] == 0x7e) {
				// All spa messages start and end with 0x7e
				if (msgLength > 0) {
					const thisMsg = chunk.slice(0, msgLength + 2);
					const checksum = thisMsg[msgLength];
					// Seems like a good message. Check the checksum is ok
					if (checksum != this.compute_checksum(new Uint8Array([msgLength]), thisMsg.slice(2, msgLength))) {
						this.log.error("Bad checksum", checksum, "for", this.prettify(thisMsg));
					} else {
						const somethingChanged = this.readAndActOnMessage(msgLength, checksum, thisMsg);
						if (somethingChanged) {
							// Only log state when something has changed.
							this.log.debug("State change:", this.stateToString());
							// Call whoever has registered with us - this is our homekit platform plugin
							// which will arrange to go through each accessory and check if the state of
							// it has changed. There are 3 cases here to be aware of:
							// 1) The user adjusted something in Home and therefore this callback is completely
							// unnecessary, since Home is already aware.
							// 2) The user adjusted something in Home, but that change could not actually take
							// effect - for example the user tried to turn off the primary filter pump during
							// a filtration cycle, and the Spa will ignore such a change.  In this case this
							// callback is essential for the Home app to reflect reality
							// 3) The user adjusted something using the physical spa controls (or the Balboa app),
							// and again this callback is essential for Home to be in sync with those changes.
							//
							// Theoretically we could be cleverer and not call this for the unnecessary cases, but
							// that seems like a lot of complex work for little benefit.  Also theoretically we
							// could specify just the controls that have changed, and hence reduce the amount of
							// activity.  But again little genuine benefit really from that, versus the code complexity
							// it would require.
							this.changesCallback();
						}
					}
				} else {
					// Message length zero means there is no content at all. Not sure if this ever happens,
					// but no harm in just ignoring it.
				}
				messagesProcessed++;
			} else {
				// Message didn't start/end correctly
				this.log.error("Message with bad terminations encountered:", this.prettify(chunk));
			}
			// Process rest of the chunk, as needed (go round the while loop).
			// It might contain more messages
			chunk = chunk.slice(msgLength + 2);
		}
		return messagesProcessed;
	}

	checkWeHaveReceivedStateUpdate() {
		if (this.receivedStateUpdate) {
			// All good - reset for next time
			this.log.info('Latest spa state', this.stateToString());
			this.receivedStateUpdate = false;
		} else {
			this.log.error('No spa state update received for some time.  Last state was',
				this.stateToString());

			this.socket?.emit("error", Error("no spa update"));
		}
	}

	reconnecting: boolean = false;
	reconnect(host: string) {
		if (!this.reconnecting) {
			this.reconnecting = true;
			setTimeout(() => {
				this.socket = this.get_socket(host);
				this.reconnecting = false;
			}, 20000);
		}
	}

	// Used if we get an error on the socket, as well as during shutdown.
	// If we got an error, after this the code will retry to recreate the
	// connection (elsewhere).
	shutdownSpaConnection() {
		// Might already be disconnected, if we're in a repeat error situation.
		this.isCurrentlyConnectedToSpa = false;
		this.log.debug("Shutting down Spa socket");
		if (this.faultCheckIntervalId) {
			clearInterval(this.faultCheckIntervalId);
			this.faultCheckIntervalId = undefined;
		}
		if (this.stateUpdateCheckIntervalId) {
			clearInterval(this.stateUpdateCheckIntervalId);
			this.stateUpdateCheckIntervalId = undefined;
		}
		// Not sure I understand enough about these sockets to be sure
		// of best way to clean them up.
		if (this.socket != undefined) {
			this.socket.end();
			this.socket.destroy();
			this.socket = undefined;
		}
	}

	hasGoodSpaConnection() {
		return this.isCurrentlyConnectedToSpa;
	}

	/**
	 * Message starts and ends with 0x7e. Needs a checksum.
	 * @param purpose purely for logging clarity
	 * @param type 
	 * @param payload 
	 */
	sendMessageToSpa(purpose: string, type: Uint8Array, payload: Uint8Array) {

		//MD2024: Code lifted and translated from jacuzzi.py:send_message
		let bytes = this.concat(type, payload);
		let message_length = bytes.length + 2;
		let message = new Uint8Array(message_length + 2);
		message[0] = 0x7e;
		message[1] = message_length;
		for (let i = 0; i < bytes.length; i++) {
			message[2 + i] = bytes[i];
		}
		message[message.length - 2] = this.compute_checksum_encrypted(message.slice(1), message_length - 1);
		message[message.length - 1] = 0x7E;

		//this.log.error("Unencrypted", this.prettify(message));


		// MD2024: Jacuzzi change, need to encrypt.
		// Stolen from jacuzzi.py:encrypt
		// Get a dictionary of encryptable message types where each element
		// is in the form of unencrypted_type: encrypted_equivalent.
		let etypes = {
			0x11: 0xcc, // Balboa unencrypted button control message type
			0x17: 0xcc, // Jacuzzi unencrypted pump 1-3 control message type
			0x1a: 0xcc, // Jacuzzi unencrypted pump 4-6 control message type
			0x1b: 0xcc, // Jacuzzi Send Primary Filter Request message type
			0x20: 0xcc, // Balboa and Jacuzzi Set Target Temp message type
		};

		// Quit if this packet type has no encrypted equivalent
		let packet_type = message[4];
		if (etypes[packet_type] == undefined)
			return;

		// Write the new encrypted packet type into the packet.
		message[4] = etypes[packet_type]

		// Next few lines:
		// Insert the extra encryption key byte into the packet. For now
		// the key byte is a simple constant, and add 1 to the packet
		// length byte and update the local packet_length variable
		// with the new length value.

		// Need to insert 0x00 at index 5
		let packet = this.concat(message.slice(0, 5), new Uint8Array([0x00]));
		packet = this.concat(packet, message.slice(5));

		packet[1] += 1

		let packet_length = packet[1]

		// Encrypt the new packet by "decrypting" the unencrypted message data. (XOR ciphers are symmetric.)
		packet = this.decrypt(packet)

		// Calculate a new checksum for the new, encrypted packet and save it in the packet.
		packet[packet.length - 2] = this.compute_checksum_encrypted(packet.slice(1), packet_length - 1);

		this.log.debug("Sending (" + purpose + "):" + this.prettify(packet));
		this.socket?.write(packet);
	}


	/**
	 * Returns a decrypted version of type "C4" panel status and type "CA" LED status message packets sent by "encrypted" control boards for Jacuzzi and Sundance spas. 
	 * @param packet Packet to decrypt
	 */
	decrypt(packet: Uint8Array) {
		//MD2024: Heavily lifted from jacuzzi.py:decrypt

		/*Returns a decrypted version of type "C4" panel status and type
		"CA" LED status message packets sent by "encrypted" control boards
		for Jacuzzi and Sundance spas. 

		Also updates the packet checksum byte so that any decrypted packet
		is still a vald message packet.

		Returns all other message packet types unchanged.

		The encryption algorithm used by Jacuzzi and Sundance is a type of
		"XOR Cipher" where each byte of the message data is XORed with the
		corresponding byte of an equal-length cipher string. In this case
		the bytes of the cipher string are just a decreasing sequence derived
		from the length of the message data.  

		In addition the encrypted packet includes an extra prefix byte which
		is used to form a constant value that is also XORed with each byte
		of the message data.  

		As is typical with XOR cipher encryption, you would use the same
		algorithm to both encrypt and decrypt the nessage. 

		Typical encrypted C4 packet:
		byte #:    000102030405 060708 09101112 13141516 17181920 21222324 25262728 29303132 33343536 37 3839
		encrypted: 7e26ffafc41f 151b1a 1516a6ec 16107310 2d0c470b 68080a1d 05012206 b0000368 673c3f3e 39 937e
		decrypted: 7e26ffafc41f 0d0000 080ab9f2 07006002 3818501d 61000117 080d2d08 b100006a 62383838 00 8a7e*/

		if (packet.length < 7)
			return packet;

		// Encrypted packets have an extra byte that we use to form the first key value
		let packet_type = packet[4];
		let key1;
		if (packet_type == 0xc4)      // Status update packet
			key1 = packet[5] ^ 0x19;
		else if (packet_type == 0xca) // Lights update packet
			key1 = packet[5] ^ 0x59;
		else if (packet_type == 0xcc) // Button command packet
			key1 = packet[5] ^ 0xdf;
		else
			return packet;            // Done if not an encrypted message type

		// The second key value forms a cipher string which is a string of the same 
		// length as the encrypted data, and whose byte values are each decremented by
		// one from the previous, modulo 64.
		const HEADER_LENGTH = 5;
		let packet_length = packet[1];
		let key2 = packet_length - HEADER_LENGTH - 2;

		// Apply both keys to each encrypted value and save the decrypted result
		// back into the original packet.
		for (let i = 6; i < packet_length; i++) {
			key2 = mod((key2 - 1), 64);

			packet[i] = (packet[i] ^ key1 ^ key2);
		}

		// Force the "extra" encryption byte to zero just so packet checksums
		// will only change when the actual packet data fields change.
		packet[5] = 0;

		// Calculate a new checksum over entire decrypted packet and save it as
		// the new packet checksum.
		packet[packet.length - 2] = this.compute_checksum_encrypted(packet.slice(1), packet_length - 1);
		return packet;
	}

	/**
	 * Turn the bytes into a nice hex, comma-separated string like '0a,bf,2e'
	 * @param message the bytes
	 */
	prettify(message: Uint8Array) {
		return Buffer.from(message).toString('hex').match(/.{1,2}/g);
	}

	/**
	 * Returns the "set" temperature
	 */
	getTargetTemp() {
		return this.targetTempOverride ?? (this.tempRangeIsHigh ? this.targetTempModeHigh! : this.targetTempModeLow!);
	}

	/**
	 * Returns true if the "set" temperature is higher then current temperature
	 */
	getTempRangeIsHigh() {
		return this.targetTempModeHigh != undefined;
		//return this.tempRangeIsHigh;
	}

	/**
	 * Formats time string
	 */
	timeToString(hour: number, minute: number) {
		return hour.toString().padStart(2, '0') + ":" + minute.toString().padStart(2, '0');
	}

	/**
	 * Returns true if the lights are currently on
	 */
	getIsLightOn(index: number) {
		// Lights are numbered 1,2 by Balboa
		index--;
		return this.lightIsOn[index];
	}

	/**
	 * Returns true if the "set" hot tub is currently heating
	 */
	getIsHeatingNow() {
		return this.isHeatingNow;
	}

	/**
	 * Returns the current temperature
	 */
	getCurrentTemp() {
		if (this.currentTemp == undefined) {
			return undefined;
		} else {
			return this.currentTemp;
		}
	}

	/**
	 * Presses the "Lights" button on the hot tub
	 * @param index The light control to press
	 * @param value Required by HomeKit, but not used
	 */
	async setLightState(index: number, value: boolean) {
		/* HomeKit displays the light control as a toggle, so it will send an boolean indicating state.
			Obviously Jacuzzi is different and only accepts a button press, so value will be ignored.
			I tried briefly to look at HomeKit Lightbulb optional characteristics to set state (and would
			simulate multiple button presses to match requested state), but it doesn't seem like HomeKit
			supports what we needed.  Maybe in a future version we could do something neat with a drop down
			to set one of the 10 (+ off) states.
		*/

		// Lights are numbered 1,2 by Balboa
		index--;
		if ((this.lightIsOn[index] === value)) {
			return;
		}
		if (this.lightIsOn[index] == undefined) {
			this.log.error("Trying to set state of light", (index + 1), "which doesn't exist");
			return;
		}
		if (!this.isCurrentlyConnectedToSpa) {
			// Should we throw an error, or how do we handle this?
		}

		//0x12 is right for light 1.  I assume light 2 is 0x13, but I don't have a way to test.
		let lightCode: Uint8Array = new Uint8Array([0x12 + index]);
		this.sendMessageToSpa("SetLightState", SetLightRequest, lightCode);
	}

	/**
	 * Returns flow state
	 */
	getFlowState() {
		return this.flow;
	}

	/**
	 * Returns pump speed range
	 */
	getPumpSpeedRange(index: number) {
		if (index == 0) {
			return 0;
		} else {
			return this.pumpsSpeedRange[index - 1];
		}
	}

	/**
	 * Returns a human readable string indicating pump speed
	 * @param range How many states does this pump support?
	 * @param value Current pump state
	 */
	static getSpeedAsString(range: number, speed: number) {
		if (range == 1) {
			return ["Off", "High"][speed];
		} else if (range == 2) {
			return ["Off", "Low", "High"][speed];
		} else if (range == 3) {
			return ["Off", "Low", "Medium", "High"][speed];
		} else {
			return undefined;
		}
	}

	/**
	 * Returns integer indicating pump speed
	 * @param index The pump to return the data on
	 */
	getPumpSpeed(index: number) {
		if (index == 0) {
			this.log.error("Trying to get speed of circulation pump which doesn't exist");
			return 0;
		}
		// Pumps are numbered 1,2,3,... by Balboa
		index--;
		if (this.pumpsSpeedRange[index] == 0) {
			this.log.error("Trying to get speed of pump", (index + 1), "which doesn't exist");
			return 0;
		}

		if (this.pumpsOverrideSpeed[index] == -1)
			return this.pumpsCurrentSpeed[index];
		else {
			//this.log.debug('Sending override pump speed to index', index, '.  Current:', this.pumpsCurrentSpeed[index], ' Override:', this.pumpsOverrideSpeed[index])
			return this.pumpsOverrideSpeed[index];
		}
	}

	/**
	 * A complication here is that, during filtration cycles, a pump might be locked into an "on"
	 * state.  For example on my Spa, pump 1 goes into "low" state, and I can switch it to "high", but
	 * a toggle from "high" does not switch it off, but rather switches it straight to "low" again.
	 * With single-speed pumps this isn't such an issue, but with 2-speed pumps, this behaviour causes 
	 * problems for the easiest approach to setting the pump to a particular speed.  When we calculate that
	 * two 'toggles' are needed, the reality is that sometimes it might just be one, and hence two
	 * toggles will end us in the wrong pump speed.  There are really just two specific case that are 
	 * annoying as a user:
	 * 
	 * 1) the pump is "High". Desired speed is "Low". Hence we deduce the need for
	 * two toggles. But, since "Off" is skipped, we end up back where we started in "High".
	 * 
	 * 2) we're trying to turn the pump off, but it can't be turned off. We need to make sure
	 * the ending state is correctly reflected in Home.
	 * 
	 * @param index pump number (1-6) convert to index lookup (0-5) convert to Balboa message id (4-9)
	 * @param desiredSpeed 0...pumpsSpeedRange[index] depending on speed range of the pump
	 */
	async setPumpSpeed(index: number, desiredSpeed: number) {
		/* As mentioned in comment on the method, there is a weird behavior when the pump 1 is circulating.
			This is a TODO to at least handle setting to low or high correctly during this scenario.
			As far as I know HomeKit doesn't allow me to prevent the user from turning off Pump 1, so because
			I can't "fix" the UI the user experiences, I'm not in a huge rush to fix this state
			*/
		const pumpName = 'Pump' + index;
		// Pumps are numbered 1,2,3,... by Balboa
		index--;
		if (this.pumpsSpeedRange[index] == 0) {
			this.log.error("Trying to set speed of", pumpName, "which doesn't exist");
			return;
		}
		if (desiredSpeed > this.pumpsSpeedRange[index]) {
			this.log.error("Trying to set speed of", pumpName, " faster (", desiredSpeed, ") than the pump supports (", this.pumpsSpeedRange[index], ").");
			return;
		}
		if(this.isFilterMode && index == 1)
		{
			if (desiredSpeed == 0) {
				this.log.warn("Trying to turn off",pumpName,"but currently in filter mode.  Will set to low.");
				desiredSpeed = 1;
			}
		}
		//MD2024: lifted from jacuzzi.py:

		/*Overrides the parent method to accommodate differences
		in the Prolink message type fields.
	    
		# Each message sent emulates a button press on the Jacuzzi
		# topside control panel. So if a pump has two speeds for
		# example, then each message will effect one step through
		# the cycle of 0ff-low-high-off.
		#
		# The only difference between Balboa and Jacuzzi change pump
		# message packets (apart from type value itself) is that the
		# Jacuzzi type field has type field 0x17 for pumps 1 through 3
		# instead of 0x1A
		#
		# Example: 7E 06 0A BF 17 04 XX 7E 
		# (XX = calculated checksum)
		*/

		let pumpcode = new Uint8Array([index + 3]);

		//Set override pump speed.  We don't want to confuse the user in HomeKit as the pump iterates to the correct speed
		this.pumpsOverrideSpeed[index] = desiredSpeed;

		// Calculate how many times we need to press the pump button to achieve the achieve the desired state
		let timesToRun = 0;
		if (desiredSpeed > this.pumpsCurrentSpeed[index])
			timesToRun = desiredSpeed - this.pumpsCurrentSpeed[index];
		else if (desiredSpeed < this.pumpsCurrentSpeed[index]) {
			timesToRun = (this.pumpsSpeedRange[index] - this.pumpsCurrentSpeed[index]) + (desiredSpeed + 1);

			// If this pump is in filter mode, we can't turn it off, which requires one less push
			if(this.isFilterMode && index == 1)
				timesToRun--;
		}

		//Lines may be useful when trying to deal with pump 1 being in circulation mode.
		//this.log.debug('Changing pump',index, 'speed.  Current:', this.pumpsCurrentSpeed[index], '|Desired:', desiredSpeed,'|Pressing button',timesToRun,'times');
		//this.log.debug(pumpName, '.  Current speeds of all pumps: [', this.pumpsCurrentSpeed[0], ',', this.pumpsCurrentSpeed[1], ',', this.pumpsCurrentSpeed[2], ',', this.pumpsCurrentSpeed[3], ',', this.pumpsCurrentSpeed[4], ',', this.pumpsCurrentSpeed[5], ']');

		for (let i = 0; i < timesToRun; i++) {
			//Only send a new button command if we're not in the desired state yet.
			if (this.pumpsCurrentSpeed[index] != desiredSpeed) {
				this.sendMessageToSpa("SetPumpRequest", SetPumpRequest, pumpcode);
			}

			// Wait a second before pressing the button again
			await new Promise(resolve => setTimeout(resolve, 1000));
		}

		//Clear override as we should be at the correct speed
		this.pumpsOverrideSpeed[index] = -1;

		//MD2024: Bit of a hack, but I experienced a delay in the wifi unit reporting the state change by the app.
		//Lets manually set and let the next spa update correct our value
		this.pumpsCurrentSpeed[index] = desiredSpeed;
	}

	/**
	 * Calculates our checksum
	 * 
	 * @param length Length of packet
	 * @param bytes Packet
	 */
	compute_checksum(length: Uint8Array, bytes: Uint8Array) {
		const checksum = crc.crc8(Buffer.from(this.concat(length, bytes)), 0x02);
		return checksum ^ 0x02;
	}

	/**
	 * Calculates encrypted checksum
	 * 
	 * @param length Length of packet
	 * @param bytes Packet
	 */
	compute_checksum_encrypted(data: Uint8Array, length: number) {
		//MD2024: Lifted from balboa.py:balboa_calc_cs
		let crc = 0xb5;
		for (let cur = 0; cur < length; cur++) {
			for (let i = 0; i < 8; i++) {
				let bit = crc & 0x80;
				crc = ((crc << 1) & 0xff) | ((data[cur] >> (7 - i)) & 0x01);
				if (bit)
					crc = crc ^ 0x07;
			}
			crc &= 0xff;
		}
		for (let i = 0; i < 8; i++) {
			let bit = crc & 0x80;
			crc = (crc << 1) & 0xff;
			if (bit)
				crc ^= 0x07;
		}
		return (crc ^ 0x02);
	}

	/**
	 * Concatenates two byte arrays
	 * 
	 * @param a First byte array
	 * @param b Second byte array
	 */
	concat(a: Uint8Array, b: Uint8Array) {
		const c = new Uint8Array(a.length + b.length);
		c.set(a);
		c.set(b, a.length);
		return c;
	}

	/**
	 * Sets temperature on Spa.  If our target temp is 5 degrees above current set point, we must issue
	 * 5 commands to increase the temperature.
	 * Temperatures which are out of certain bounds will be rejected by the spa, we don't do bounds-checking ourselves.
	 * 
	 * @param temp Temperature we want the hot tub set to
	 */
	async setTargetTemperature(temp: number) {
		//Heavily lifted from jacuzzi.py: _adjust_encrypted_settemp

		//Set override temp
		this.targetTempOverride = temp;
		let settemp_changed:boolean = true;
		let previousSetTemp:number = (this.targetTempModeLow ?? this.targetTempModeHigh ?? 0);
		let original_temp:number = (this.targetTempModeLow ?? this.targetTempModeHigh ?? 0);
		//offchance spa never replies, lets only do this 60 times.
		for(let i = 0; i < 60; i++) {
			//Only send a new button command after the previous one has been applied.
			if (settemp_changed) {
				previousSetTemp = (this.targetTempModeLow ?? this.targetTempModeHigh ?? 0);

				//Decide which direction to go
				let reqd_change: number = temp - (this.targetTempModeLow ?? this.targetTempModeHigh ?? 0);
				let btncode;
				if (reqd_change >= 1)
					btncode = new Uint8Array([0x01]);	//Temp Up btn
				else if (reqd_change <= -1)
					btncode = new Uint8Array([0x02]);	//Temp down btn
				else {
					// We are at the setpoint so clear override and end this loop.
					this.targetTempOverride = undefined;
					return;
				}

				this.log.debug('Changing temperature.  Current set temp: ', this.targetTempModeLow ?? this.targetTempModeHigh);

				// Send a new button command to change setpoint temp.
				// This unencrypted button command will be converted
				// to an encrypted version by sendMessageToSpa
				this.sendMessageToSpa("SetTargetTempRequest", SetTargetTempRequest, btncode);
			}

			// Wait a second before checking the new setpoint temp
			await new Promise(resolve => setTimeout(resolve, 1000));

			//Determine if previous button press has been applied.  Check if the set point 
			settemp_changed = (previousSetTemp != this.targetTempModeLow ?? this.targetTempModeHigh) || (previousSetTemp == original_temp && this.tempChangeMode);
		}

		// If we hit here, not great.  Means we sent 60 commands and the hot tub still didn't get to target temp.
		// But instead of an infinite loop, lets reset the targetTempOverride so we don't lie to HomeKit
		this.targetTempOverride = undefined;
		return;
	}

	//Not sure if this works, didn't modify from Balboa code
	send_config_request() {
		this.sendMessageToSpa("ConfigRequest", ConfigRequest, new Uint8Array());
	}

	//Not sure if this works, didn't modify from Balboa code
	sendControlTypesRequest() {
		this.sendMessageToSpa("ControlTypesRequest", PrimaryRequest, ControlTypesMessageContents);
	}

	//Not sure if this works, didn't modify from Balboa code
	sendControlPanelRequest(id: number) {
		// 4 messages from [0x01,0x00,0x00] through 2,4,8
		this.sendMessageToSpa("ControlPanelRequest" + (id + 1), PrimaryRequest, ControlPanelRequest[id][0]);
	}

	//Not sure if this works, didn't modify from Balboa code
	send_request_for_faults_log() {
		this.sendMessageToSpa("Checking for any Spa faults", PrimaryRequest, GetFaultsMessageContents);
	}

	/**
	 * Returns temperature with unit(F) applied
	 * 
	 * @param temperature Temperature
	 */
	internalTemperatureToString(temperature?: number) {
		if (temperature == undefined) return "Unknown";
		return temperature.toFixed(0).toString() + "F";
	}

	/**
	 * Returns a string of the current state of the hot tub.  Useful for debugging
	 */
	stateToString() {
		let pumpDesc = '[';
		for (let i = 0; i < 6; i++) {
			if (this.pumpsSpeedRange[i] > 0) {
				pumpDesc += SpaClient.getSpeedAsString(this.pumpsSpeedRange[i], this.pumpsCurrentSpeed[i]) + ' ';
			}
		}
		pumpDesc += ']';

		const s = "Temp: " + this.internalTemperatureToString(this.currentTemp)
			+ ", Set Temp: " + this.internalTemperatureToString(this.targetTempModeLow ?? this.targetTempModeHigh)
			+ ", Pumps: " + pumpDesc
			+ ", Heating?: " + (this.isHeatingNow ? "Yes" : "No")
			+ ", Filter mode?: " + (this.isFilterMode ? "Yes" : "No")
		return s;
	}

	/**
	 * Returns a string of the current state of the lights.  Useful for debugging
	 */
	lightStateToString() {
		const s = "Lights: " + LIGHTS[this.lightStatus]
		return s;
	}

	/**
	 * Return true if anything in the state has changed as a result of the message
	 * received.
	 * 
	 * @param length
	 * @param checksum
	 * @param chunk - first and last bytes are 0x7e. Second byte is message length.
	 * Second-last byte is the checksum.  Then bytes 3,4,5 are the message type.
	 * Everything in between is the content.
	 */
	readAndActOnMessage(length: number, checksum: number, chunk: Uint8Array) {
		const contents = chunk.slice(5, length);
		const msgType = chunk.slice(2, 5);
		let stateChanged: boolean;
		let avoidHighFreqDevMessage: boolean = true;

		let unmodified = chunk;

		//Decrypt this packet
		chunk = this.decrypt(chunk);

		if (this.equal(msgType, StateReply)) {
			//This is a hot tub status update.
			//this.log.info("" + this.prettify(chunk));

			stateChanged = this.readStateFromBytes(chunk);

			if (!this.initialSetup) {
				this.interpretControlTypesReply();
			}

			//I want HomeKit to receive an update every minute, regardless if things have changed.
			//Calculate what time it was one minute ago and check that against the stored value to determine
			//if we should push this update to HomeKit.
			let oneMinAgo = new Date();
			if (this.spaLastUpdated <= new Date(oneMinAgo.getTime() - 60000)) {
				stateChanged = true;
				this.spaLastUpdated = new Date();

				this.log.debug("" + this.prettify(chunk));
				this.log.debug("DEBUG HEATING current|set:", this.currentTemp, "|", (this.targetTempModeHigh ?? this.targetTempModeLow ?? 0), "|Should be heating?", (this.currentTemp ?? 0 + 1) < (this.targetTempModeHigh ?? this.targetTempModeLow ?? 0))
			}

			avoidHighFreqDevMessage = stateChanged;
		}
		else if (this.equal(msgType, LightStateReply)) {
			//Light status update.
			//this.log.info("" + this.prettify(chunk));

			stateChanged = this.readLightStateFromBytes(chunk);

			//I want HomeKit to receive an update every minute, regardless if things have changed.
			//Calculate what time it was one minute ago and check that against the stored value to determine
			//if we should push this update to HomeKit.
			let oneMinAgo = new Date();
			if (this.lightLastUpdated <= new Date(oneMinAgo.getTime() - 60000)) {
				stateChanged = true;
				this.lightLastUpdated = new Date();
				this.log.debug("" + this.prettify(chunk));
			}
			avoidHighFreqDevMessage = stateChanged;
		}
		else if (this.equal(msgType, GetFaultsReply)) {
			//Not sure if this works, straight from Balboa plugin
			stateChanged = this.readFaults(contents);
		} else if (this.equal(msgType, ControlTypesReply)) {
			//Not sure if this works, straight from Balboa plugin
			this.log.info("Control types reply(" + this.prettify(msgType)
				+ "):" + this.prettify(contents));
			//stateChanged = this.interpretControlTypesReply(contents);
			stateChanged = this.interpretControlTypesReply();
		} else if (this.equal(msgType, ConfigReply)) {
			//Not sure if this works, straight from Balboa plugin
			this.log.info("Config reply with MAC address (" + this.prettify(msgType)
				+ "):" + this.prettify(contents));
			// Bytes 3-8 are the MAC address of the Spa.  They are also repeated later
			// on in the string, but split into two halves with two bytes inbetween (ff, ff)
			stateChanged = false;
		} else if (this.equal(msgType, PreferencesReply)) {
			//Not sure if this works, straight from Balboa plugin
			// Nothing to do here
			this.log.info("Set preferences reply (" + this.prettify(msgType)
				+ "):" + this.prettify(contents));
			stateChanged = false;
		} else if (this.equal(msgType, KnownUnknownReply)) {
			//Not sure if this works, straight from Balboa plugin
			// Nothing to do here
			stateChanged = false;
		} else {
			//Not sure if this works, straight from Balboa plugin
			stateChanged = false;
			let recognised = false;
			for (let id = 0; id < 4; id++) {
				if (this.equal(msgType, ControlPanelRequest[id][1])) {
					stateChanged = this.interpretControlPanelReply(id + 1, contents);
					recognised = true;
					break;
				}
			}
			// Various messages about controls, filters, etc. In theory we could
			// choose to implement more things here, but limited value in it.
			if (!recognised) {
				this.log.info("Not understood a received spa message",
					"(nothing critical, but please do report this):" + this.prettify(msgType),
					" contents: " + this.prettify(contents));
			}
		}

		return stateChanged;
	}

	/**
	 * By resetting our knowledge of recent state, we ensure the next time the spa reports 
	 * its state, that we broadcast that to Homekit as an update. This is useful whenever
	 * we have reason to believe the state might be out of sync. We therefore use it for
	 * two purposes: (a) immediately after a (re)connection with the spa, (b) when we try
	 * to turn a pump off, but believe it might not be allowed to be off.
	 */
	resetRecentState() {
		this.lastStateBytes = new Uint8Array();
		this.lastColorStateBytes = new Uint8Array();
		this.lastFaultBytes = new Uint8Array();
	}

	/**
	 * Interpret the standard response, which we are sent about every 1 second, covering
	 * all of the primary state of the spa.
	 * 
	 * Return true if anything important has changed (e.g. ignore the time changing!)
	 * 
	 * @param bytes
	 */
	readStateFromBytes(bytes: Uint8Array) {
		this.receivedStateUpdate = true;
		// Some fields are the entire byte, like pump 2 status and set temp.  Others are specific bits in that byte,
		// like "temperature mode".  For those ones, convert byte to binary and compare results.

		// If current_temp = 255, then the Spa is still not fully initialised
		// (but is not necessarily in "priming" state). Need to wait, really - after some seconds the
		// correct temperature is read.
		// Probably better to say the temperature is unknown, if homekit supports that.  The Balboa
		// app, for what it's worth, also is confused when current temp = 255.  We currently report
		// 'undefined' here, which our temperature accessory turns into a 'null' to send to Homekit.
		this.currentTemp = (bytes[15] == 255 ? undefined : bytes[15]);

		// Three possible states for heating mode. We can only set it to two states though.
		// MD2024: Not sure if this is correct
		this.heatingMode = HEATINGMODES[(bytes[18] >> 4) & 0x03];

		//Not sure if below 5 lines are correct
		const moreFlags = bytes[10];
		// It seems some spas have 3 states for this, idle, heating, heat-waiting.
		// We merge the latter two into just "heating" - there are two bits here though.
		//this.isHeatingNow = ((moreFlags & 48) !== 0);
		this.tempRangeIsHigh = (((moreFlags & 4) === 0) ? false : true);

		//byte[26]
		//	00000000
		//	AB??????
		//	A is filter mode
		//	B is heating mode

		this.isHeatingNow = ((bytes[26] >> 6) & 1) == 1;
		this.isFilterMode = (bytes[26] >> 7) == 1;

		//byte[10]
		// 00000000
		//	D?ABBCCC
		//	A appears to be "temperature mode"
		//	BB are two bits to indicate jet 1 status (on mine, 1 = off, 0 = low, high = 3.)
		//	CCC is day of the week, Sunday is 000.

		//Right most 3 bits appear to be day of week.  middle 2 are what we need.  Shift 3 in order to get pump speed
		if (((bytes[10] >> 3) & 3) == 1)
			this.pumpsCurrentSpeed[1] = 0;
		else if (((bytes[10] >> 3) & 3) == 0)
			this.pumpsCurrentSpeed[1] = 1;
		else	//should be 3 in above statement.  I like this as an else so I can bug check.
			this.pumpsCurrentSpeed[1] = 2;

		//Get pump speed 2:
		this.pumpsCurrentSpeed[2] = (bytes[8] & 0x0c) >> 2;

		//Pull if hot tub is in temperature mode
		this.tempChangeMode = ((bytes[10] >> 5) & 1) == 1;

		//Set temperature
		if (this.tempRangeIsHigh) {
			this.targetTempModeHigh = bytes[21];
		} else {
			this.targetTempModeLow = bytes[21];
		}

		// Store this for next time
		const oldBytes = this.lastStateBytes;
		this.lastStateBytes = new Uint8Array(bytes);

		// Return true if any values have changed
		if (oldBytes.length != this.lastStateBytes.length) return true;
		for (let i = 0; i < oldBytes.length; i++) {
			// Only care about bytes we actually look at
			if (i == 8 || i == 10 || i == 15 || i == 21) {
				if (oldBytes[i] != this.lastStateBytes[i]) {
					//this.log.error("Different. index=", i, " ", oldBytes[i], "!=", this.lastStateBytes[i])
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Interpret the standard light response, which we are sent about every 1 second
	 * Return true if anything important has changed (e.g. ignore the time changing!)
	 * 
	 * @param bytes
	 */
	readLightStateFromBytes(bytes: Uint8Array) {
		//I only have a single light on my hot tub, this may be vastly different if there is a second.
		//MD: For jacuzzi, we can have one of 10 states + off
		if (bytes[13] == 0x40)
			this.lightStatus = LIGHTOFF;
		else if (bytes[13] == 0xc0 && bytes[24] == 0x42)
			this.lightStatus = LIGHTFAST;
		else if (bytes[13] == 0xc0 && bytes[24] == 0x44)
			this.lightStatus = LIGHTSLOW;
		else if (bytes[13] == 0xbf)
			this.lightStatus = LIGHTFREEZE;
		else if (bytes[13] == 0x42)
			this.lightStatus = LIGHTBLUE;
		else if (bytes[13] == 0x47)
			this.lightStatus = LIGHTVIOLET;
		else if (bytes[13] == 0x46)
			this.lightStatus = LIGHTRED;
		else if (bytes[13] == 0x48)
			this.lightStatus = LIGHTAMBER;
		else if (bytes[13] == 0x43)
			this.lightStatus = LIGHTGREEN;
		else if (bytes[13] == 0x49)
			this.lightStatus = LIGHTAQUA;
		else if (bytes[13] == 0x41)
			this.lightStatus = LIGHTWHITE;

		this.lightMode = bytes[13];
		this.lightBrightness = bytes[6];
		this.lightR = bytes[22];
		this.lightG = bytes[18];
		this.lightB = bytes[10];
		this.lightCycleTime = bytes[24];

		this.lightIsOn[0] = !(this.lightStatus == LIGHTOFF);

		// Store this for next time
		const oldBytes = this.lastColorStateBytes;
		this.lastColorStateBytes = new Uint8Array(bytes);
		// Return true if any values have changed
		if (oldBytes.length != this.lastColorStateBytes.length) return true;
		for (let i = 0; i < oldBytes.length; i++) {
			// Only care about bytes we actually use, ignoring R/G/B/brightness because those will vary on rainbow
			if (i == 13 || i == 24) {
				if (oldBytes[i] !== this.lastColorStateBytes[i]) {
					return true;
				}
			}
		}

		return false;
	}

	//Important: Rest of the code below is unmodified from Balboa plugin.
	/**
	 * Get the set of accessories on this spa - how many pumps, lights, etc.
	 * 
	 * @param bytes 1a(=00011010),00,01,90,00,00 on my spa
	 */
	interpretControlTypesReply() {

		if (this.accurateConfigReadFromSpa) {
			//this.log.info("Already discovered Spa configuration.");
			return false;
		}
		// 2 bits per pump. Pumps 5 and 6 are apparently P6xxxxP5 in the second byte
		// Line up all the bites in a row
		//let pumpFlags1to6 = bytes[0] + 256 * (bytes[1] & 0x03) + 16 * (bytes[1] & 0xc0);
		let countPumps = 0;
		// for (let idx = 0; idx < 6; idx++) {
		//     // 0 = no such pump, 1 = off/high pump, 2 = off/low/high pump
		//     this.pumpsSpeedRange[idx] = pumpFlags1to6 & 0x03;
		//     if (this.pumpsSpeedRange[idx] === 3) {
		//         this.log.error("3-speed pumps not fully supported.  Please test carefully and report bugs.");
		//     }
		//     if (this.pumpsSpeedRange[idx] == 0) {
		//         this.pumpsCurrentSpeed[idx] = 0;
		//     } else {
		//         countPumps++;  
		//     }
		//     pumpFlags1to6 >>= 2;
		// }
		this.log.info("Discovered 2 pumps with speeds", this.pumpsSpeedRange);
		//const lights = [(bytes[2] & 0x03) != 0,(bytes[2] & 0xc0) != 0];
		// Store 'undefined' if the light doesn't exist. Else store 'false' which will
		// soon be over-ridden with the correct light on/off state.
		this.lightIsOn[0] = true;

		this.log.info("Discovered 1 light");

		this.accurateConfigReadFromSpa = true;
		this.spaConfigurationKnownCallback();
		// If we got an accurate read of all the components, then declare that
		// something has changed. We typically only ever do this once.
		return true;
	}

	/**
	 * Information returned from calls 1-4 here. Results shown below for my Spa.
	 * 
	 * 1: Filters: 14,00,01,1e,88,00,01,1e
	 * - Bytes0-3: Filter start at 20:00, duration 1 hour 30 minutes
	 * - Bytes4-7: Filter also start 8:00am (high-order bit says it is on), duration 1 hour 30 minutes
	 * 2: 64,e1,24,00,4d,53,34,30,45,20,20,20,01,c3,47,96,36,03,0a,44,00
	 * - First three bytes are the software id.  
	 * - Bytes 5-12 (4d,53,34,30,45,20,20,20) are the motherboard model in ascii
	 *   which is MS40E in this case (SIREV16 is a value reported by another user).
	 * - After that comes 1 byte for 'current setup' and then 4 bytes which encode
	 * the 'configuration signature'. 
	 * 3: Results for various people: 
	 * 05,01,32,63,50,68,61,07,41 <- mine
	 * 12,11,32,63,50,68,61,03,41 
	 * 12,04,32,63,50,68,29,03,41
	 * 04,01,32,63,3c,68,08,03,41
	 * - No idea?! ' cPha' is the ascii version of my middle 5 bytes - so probably not ascii!
	 * 4: Reminders, cleaning cycle length, etc.: 00,85,00,01,01,02,00,00,00,00,00,00,00,00,00,00,00,00
	 * - first 01 = temp scale (F or C)
	 * - next 01 = time format (12hour or 24hour)
	 * - 02 = cleaning cycle length in half hour increments
	 * 
	 * Mostly we don't choose to use any of the above information at present.
	 * 
	 * @param id 
	 * @param contents 
	 */
	interpretControlPanelReply(id: number, contents: Uint8Array) {
		this.log.info("Control Panel reply " + id + ":" + this.prettify(contents));
		if (id == 1) {
			const filter1start = this.timeToString(contents[0], contents[1]);
			const filter1duration = this.timeToString(contents[2], contents[3]);
			const filter2on = (contents[4] & 0x80) != 0;
			const filter2start = this.timeToString(contents[4] & 0x7f, contents[5]);
			const filter2duration = this.timeToString(contents[6], contents[7]);
			this.log.info("First filter time from", filter1start, "for", filter1duration);
			this.log.info("Second filter time", (filter2on ? 'on' : 'off'),
				"from", filter2start, "for", filter2duration);
		} else if (id == 2) {
			// bytes 0-3 tell us about the version of software running, which we format
			// in the same way as on the spa's screen.
			const softwareID = "M" + contents[0] + "_" + contents[1] + " V" + contents[2] + "." + contents[3];
			// Convert bytes 4-11 into ascii
			let motherboard: string = "";
			contents.slice(4, 12).forEach((byte: number) => {
				motherboard += String.fromCharCode(byte);
			});
			// No idea what these really mean, but they are shown on the spa screen
			const currentSetup = contents[12];
			const configurationSignature = Buffer.from(contents.slice(13, 17)).toString('hex').toUpperCase();
			// This is most of the information that shows up in the Spa display
			// when you go to the info screen.
			this.log.info("System Model", motherboard);
			this.log.info("SoftwareID (SSID)", softwareID);
			this.log.info("Current Setup", currentSetup);
			this.log.info("Configuration Signature", configurationSignature);
			// Not sure what the last 4 bytes 03-0a-44-00 mean
		}
		// None of the above currently indicate a "change" we need to tell homekit about,
		// so return false
		return false;
	}

	/**
	 * 	Get log of faults. Return true if there were faults of relevance which require a 
	 *  homekit state change
	 */
	readFaults(bytes: Uint8Array) {
		const daysAgo = bytes[3];
		const hour = bytes[4];
		const minute = bytes[5];

		const code = bytes[2];
		// This is just the most recent fault.  We could query for others too.
		// (I believe by replacing 0xff in the request with a number), but for our
		// purposes the most recent only is sufficient 

		// Set flow to good, but possibly over-ride right below
		this.flow = FLOW_GOOD;

		let message: string;
		let stateChanged = false;

		// Check if there are any new faults and report them.  I've chosen just to do 
		// that for codes 16 and 17.  But potentially any code except 19 (Priming) should
		// be alerted.  And priming is perhaps also useful since it indicates a restart.
		// Would be good to separate codes into ones which require immediate intervention
		// vs ones that might be ok for a few hours or days.

		if (daysAgo > 0) {
			message = "No recent faults. Last fault";
		} else if (code == 16 || code == 28) {
			// These indicate a problem, where the spa and/or heater will temporarily shut 
			// down for 1-15 minutes. These generally indicate
			// the filter needs cleaning/change very soon. Important to alert the user
			// of them.
			this.flow = FLOW_LOW;
			// This state change will also be used to switch the thermostat control accessory into 
			// a state of 'off' when water flow fails.
			message = "Recent, alerted fault found";
			stateChanged = true;
		} else if (code == 17 || code == 27 || code == 30) {
			// These are all serious problems. The spa has been shut down. 
			// Hot tub will stop heating and therefore cool down without a change. 
			// Important to alert the user of them.
			this.flow = FLOW_FAILED;
			// This state change will also be used to switch the thermostat control accessory into 
			// a state of 'off' when water flow fails.
			message = "Recent, alerted fault found";
			stateChanged = true;
		} else {
			message = "Recent, but not alerted fault found:";
		}

		// Store this for next time
		const oldBytes = this.lastFaultBytes;
		this.lastFaultBytes = new Uint8Array(bytes);

		// To avoid annoyance, only log each fault once.
		if (!this.equal(oldBytes, this.lastFaultBytes)) {
			this.log.info(message, daysAgo, "days ago of type",
				"M0" + code, "=", this.faultCodeToString(code), "with details from log:",
				"Fault Entries:", bytes[0], ", Num:", bytes[1] + 1,
				", Error code:", "M0" + code, ", Days ago:", daysAgo,
				", Time:", this.timeToString(hour, minute),
				", Heat mode:", bytes[6], ", Set temp:", this.internalTemperatureToString(bytes[7]),
				", Temp A:", this.internalTemperatureToString(bytes[8]),
				", Temp B:", this.internalTemperatureToString(bytes[9]));
		}

		return stateChanged;
	}

	equal(one: Uint8Array, two: Uint8Array) {
		if (one.length != two.length) return false;
		for (let i = 0; i < one.length; i++) {
			if (one[i] !== two[i]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * All fault codes I've found on the internet, e.g. in balboa spa manuals
	 * 
	 * @param code 
	 */
	faultCodeToString(code: number) {
		if (code == 15) return "sensors may be out of sync";
		if (code == 16) return "the water flow is low";
		if (code == 17) return "the water flow has failed";
		if (code == 19) return "priming (this is not actually a fault - your Spa was recently turned on)"
		if (code == 20) return "the clock has failed";
		if (code == 21) return "the settings have been reset (persistent memory error)";
		if (code == 22) return "program memory failure";
		if (code == 26) return "sensors are out of sync -- call for service";
		if (code == 27) return "the heater is dry";
		if (code == 28) return "the heater may be dry";
		if (code == 29) return "the water is too hot";
		if (code == 30) return "the heater is too hot";
		if (code == 31) return "sensor A fault";
		if (code == 32) return "sensor B fault";
		if (code == 33) return "safety trip - pump suction blockage";
		if (code == 34) return "a pump may be stuck on";
		if (code == 35) return "hot fault";
		if (code == 36) return "the GFCI test failed";
		if (code == 37) return "hold mode activated (this is not actually a fault)";
		return "unknown code - check Balboa spa manuals";
	}
}