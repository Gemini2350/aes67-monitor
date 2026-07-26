const { app, BrowserWindow, ipcMain } = require("electron/main");
const path = require("node:path");
const crypto = require("crypto");
const os = require("os");
const { RtAudio, RtAudioApi } = require("audify");
const Store = require("electron-store");
const { fork } = require("child_process");

// Initialize persistent storage
const store = new Store();

// Global variables
let mainWindow; // Main application window
let networkInterfaces = []; // List of available network interfaces
let currentNetworkInterface = store.get("interface");
const defaultSettings = {
	bufferSize: 16,
	bufferEnabled: true,
	hideUnsupported: true,
	sdpDeleteTimeout: 300,
	sidebarCollapsed: false,
	nmosEnabled: false,
	nmosMode: "unicast",
	nmosRegistryHost: "",
	nmosRegistryPort: 80,
	nmosDnsServer: "",
	nmosDomain: "",
	nmosNodePort: 3212,
};
let persistentData = store.get("persistentData", { settings: {} });
persistentData.settings = Object.assign(
	{},
	defaultSettings,
	persistentData.settings
);

// Persistent NMOS resource IDs (node, device, receiver)
let nmosIds = store.get("nmosIds");
if (!nmosIds) {
	nmosIds = {
		node: crypto.randomUUID(),
		device: crypto.randomUUID(),
		receiver: crypto.randomUUID(),
	};
	store.set("nmosIds", nmosIds);
}
let currentAudioDevice = null;
let audioAPI = RtAudioApi.UNSPECIFIED;
let isSDPInitialized = false;
let streamsHash;

// Set audio API based on the operating system
switch (process.platform) {
	case "darwin":
		audioAPI = RtAudioApi.MACOSX_CORE;
		break;
	case "win32":
		audioAPI = RtAudioApi.WINDOWS_WASAPI;
		break;
	case "linux":
		audioAPI = RtAudioApi.LINUX_ALSA;
		break;
}

// Initialize RtAudio with the chosen API
const rtAudio = new RtAudio(audioAPI);

// Child processes for SDP, Audio and NMOS functionalities
let sdpProcess = null;
let audioProcess = null;
let nmosProcess = null;
let isQuitting = false;

/**
 * Sends a message to a child process, ignoring dead or disconnected children.
 * Prevents EPIPE crashes when a child process died.
 */
function safeSend(childProcess, message) {
	if (childProcess && childProcess.connected) {
		try {
			childProcess.send(message, () => {});
		} catch (error) {
			console.error("Error sending to child process:", error.message);
		}
	}
}

/**
 * Forks the SDP child process and restarts it if it dies.
 */
function forkSdpProcess() {
	sdpProcess = fork(path.join(__dirname, "./src/lib/sdp.js"));
	sdpProcess.on("message", handleSdpMessage);
	sdpProcess.on("error", (error) => {
		console.error("SDP process error:", error.message);
	});
	sdpProcess.on("exit", (code) => {
		sdpProcess = null;
		if (!isQuitting) {
			console.error("SDP process died (code " + code + "), restarting in 2s");
			setTimeout(() => {
				// Re-initialize (interface, timeouts, manual streams) via updateSystem
				isSDPInitialized = false;
				forkSdpProcess();
			}, 2000);
		}
	});
}

/**
 * Forks the audio child process and restarts it if it dies.
 */
function forkAudioProcess() {
	audioProcess = fork(path.join(__dirname, "./src/lib/audio.js"));
	audioProcess.on("error", (error) => {
		console.error("Audio process error:", error.message);
	});
	audioProcess.on("exit", (code) => {
		audioProcess = null;
		if (!isQuitting) {
			console.error("Audio process died (code " + code + "), restarting in 2s");
			setTimeout(forkAudioProcess, 2000);
		}
	});
}

/**
 * Forks the NMOS child process and restarts it if it dies.
 */
function forkNmosProcess() {
	nmosProcess = fork(path.join(__dirname, "./src/lib/nmos.js"));
	nmosProcess.on("message", handleNmosMessage);
	nmosProcess.on("error", (error) => {
		console.error("NMOS process error:", error.message);
	});
	nmosProcess.on("exit", (code) => {
		nmosProcess = null;
		if (!isQuitting) {
			console.error("NMOS process died (code " + code + "), restarting in 2s");
			setTimeout(() => {
				forkNmosProcess();
				sendNmosConfig();
			}, 2000);
		}
	});
}

forkSdpProcess();
forkAudioProcess();
forkNmosProcess();

/**
 * Creates and configures the main application window.
 */
function createMainWindow() {
	mainWindow = new BrowserWindow({
		width: 1920,
		height: 1080,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			/* devTools: !app.isPackaged, */
		},
	});

	// Load file or URL depending on whether the app is packaged
	if (app.isPackaged) {
		mainWindow.loadFile("./dist/index.html");
		// Disable refresh shortcuts in packaged mode
		mainWindow.webContents.on("before-input-event", (event, input) => {
			if (
				(input.key.toLowerCase() === "r" && (input.control || input.meta)) ||
				input.key === "F5"
			) {
				event.preventDefault();
			}
		});
	} else {
		mainWindow.loadURL("http://localhost:8888");
	}

	// Handle IPC messages from the renderer process
	ipcMain.on("recv-message", (event, message) => {
		handleIpcMessage(message);
	});
}

/**
 * Handles incoming IPC messages from the renderer.
 * @param {Object} message - The message object from the renderer.
 */
function handleIpcMessage(message) {
	switch (message.type) {
		case "update":
			sendMessage("updatePersistentData", persistentData);
			updateSystem();
			safeSend(sdpProcess, { type: "update" });
			safeSend(nmosProcess, { type: "update" });
			break;
		case "setAudioInterface":
			setAudioInterface(message.data);
			break;
		case "restart":
			refreshCurrentAudioInterface();
			safeSend(audioProcess, {
				type: "restart",
				data: {
					networkInterface: currentNetworkInterface.address,
					selected: currentAudioDevice,
				},
			});
			break;
		case "play":
			refreshCurrentAudioInterface();
			var playArgs = {
				...message.data,
				audioAPI: audioAPI,
				networkInterface: currentNetworkInterface.address,
				selected: currentAudioDevice,
			};
			safeSend(audioProcess, { type: "start", data: playArgs });

			// Reflect NMOS sender playback in the registered receiver
			if (message.data.nmos) {
				safeSend(nmosProcess, {
					type: "connected",
					data: { senderId: message.data.id, sdp: message.data.sdp },
				});
			} else {
				safeSend(nmosProcess, { type: "disconnected" });
			}
			break;
		case "stop":
			safeSend(audioProcess, { type: "stop" });
			safeSend(nmosProcess, { type: "disconnected" });
			break;
		case "addStream":
			safeSend(sdpProcess, { type: "add", data: message.data });
			break;
		case "delete":
			safeSend(sdpProcess, { type: "delete", data: message.data });
			break;
		case "setNetwork":
			if (currentNetworkInterface.address != message.data) {
				console.log("Got new network interface", message.data);
				currentNetworkInterface.address = message.data;
				updateNetworkInterfaces();
				store.set("interface", currentNetworkInterface);
				safeSend(audioProcess, { type: "stop" });
				safeSend(sdpProcess, {
					type: "interface",
					data: currentNetworkInterface.address,
				});
			}
			break;
		case "save":
			persistentData[message.key] = JSON.parse(message.data);
			store.set("persistentData", persistentData);

			if (message.key == "settings") {
				safeSend(sdpProcess, {
					type: "deleteTimeout",
					data: persistentData.settings.sdpDeleteTimeout,
				});
				sendNmosConfig();
			}

			break;
		default:
			console.log("Unknown IPC message type:", message.type, message.data);
	}
}

/**
 * Sends a message to the renderer process.
 * @param {string} type - The message type.
 * @param {*} data - The message payload.
 */
function sendMessage(type, data) {
	if (mainWindow) {
		try {
			mainWindow.webContents.send("send-message", { type, data });
		} catch (error) {
			console.error("Error sending message:", error);
		}
	}
}

/**
 * Sends a log message to the renderer process.
 * @param {string} logMessage - The log message.
 */
function sendLog(logMessage) {
	sendMessage("log", logMessage);
}

/**
 * Scans and updates the available network interfaces.
 */
function updateNetworkInterfaces() {
	const interfaces = os.networkInterfaces();
	const addresses = [];

	// Iterate over each interface and collect valid IPv4 addresses (exclude localhost)
	for (const interfaceName of Object.keys(interfaces)) {
		const iface = interfaces[interfaceName];
		for (const addr of iface) {
			if (addr.family === "IPv4" && addr.address !== "127.0.0.1") {
				addr.name = interfaceName;
				addresses.push(addr);
			}
		}
	}

	// Check if the stored network interface is still available
	if (currentNetworkInterface) {
		let found = false;
		for (const addr of addresses) {
			if (addr.address === currentNetworkInterface.address) {
				found = true;
				addr.isCurrent = true;
			} else {
				addr.isCurrent = false;
			}
		}
		if (!found && addresses.length > 0) {
			console.log("Network interface changed");
			currentNetworkInterface = addresses[0];
			addresses[0].isCurrent = true;
			store.set("interface", currentNetworkInterface);
			safeSend(audioProcess, { type: "stop" });

			if (isSDPInitialized) {
				safeSend(sdpProcess, {
					type: "interface",
					data: currentNetworkInterface.address,
				});
			}
		} else if (!found) {
			console.error("No Network interfaces found");
		}
	} else if (addresses.length > 0) {
		currentNetworkInterface = addresses[0];
	} else {
		console.error("No Network interfaces found");
	}

	networkInterfaces = addresses;
}

/**
 * Updates the list of audio devices and sends it to the renderer.
 */
function updateAudioInterfaces() {
	let devices = rtAudio.getDevices();

	// Mark the current audio device and filter out devices without channels
	for (let i = 0; i < devices.length; i++) {
		devices[i].isCurrent =
			currentAudioDevice && devices[i].id === currentAudioDevice.id;
		if (devices[i].inputChannels === 0 && devices[i].outputChannels === 0) {
			devices.splice(i, 1);
			i--;
		}
	}
	sendMessage("audioDevices", devices);
}

/**
 * Sets the current audio interface based on the provided device.
 * @param {Object} device - The audio device to set as current.
 */
function setAudioInterface(device) {
	const devices = rtAudio.getDevices();
	let defaultOutputDevice = null;
	let found = false;

	// Find a matching device or use the default output device
	for (const dev of devices) {
		if (
			device &&
			dev.name === device.name &&
			dev.inputChannels === device.inputChannels &&
			dev.outputChannels === device.outputChannels
		) {
			currentAudioDevice = dev;
			found = true;
			break;
		}
		if (dev.isDefaultOutput) {
			defaultOutputDevice = dev;
		}
	}

	if (!found) {
		console.log("Setting current device to default device");
		currentAudioDevice = defaultOutputDevice;
	}

	store.set("audioInterface", currentAudioDevice);
	updateAudioInterfaces();
}

/**
 * Refreshes the current audio interface.
 */
function refreshCurrentAudioInterface() {
	setAudioInterface(currentAudioDevice);
}

/**
 * Sends the current NMOS configuration to the NMOS child process.
 */
function sendNmosConfig() {
	if (!currentNetworkInterface) {
		return;
	}

	safeSend(nmosProcess, {
		type: "config",
		data: {
			config: {
				enabled: persistentData.settings.nmosEnabled,
				mode: persistentData.settings.nmosMode,
				host: persistentData.settings.nmosRegistryHost,
				port: persistentData.settings.nmosRegistryPort,
				dnsServer: persistentData.settings.nmosDnsServer,
				domain: persistentData.settings.nmosDomain,
				nodePort: persistentData.settings.nmosNodePort,
				label: "AES67 Stream Monitor",
				ids: nmosIds,
			},
			interface: {
				address: currentNetworkInterface.address,
				name: currentNetworkInterface.name,
				mac: currentNetworkInterface.mac,
			},
		},
	});
}

/**
 * Updates the system settings, network interfaces, and initializes SDP if necessary.
 */
function updateSystem() {
	updateNetworkInterfaces();
	refreshCurrentAudioInterface();

	if (!isSDPInitialized) {
		console.log("SDP is not yet initialized");
		sendLog("SDP is not yet initialized");

		isSDPInitialized = true;
		safeSend(sdpProcess, {
			type: "init",
			data: currentNetworkInterface.address,
		});
		safeSend(sdpProcess, {
			type: "deleteTimeout",
			data: persistentData.settings.sdpDeleteTimeout,
		});
		store.set("interface", currentNetworkInterface);
		console.log(
			"Init SDP",
			currentNetworkInterface.name,
			currentNetworkInterface.address
		);

		const storedStreams = store.get("streams");
		if (storedStreams) {
			for (const stream of storedStreams) {
				if (stream.manual) {
					console.log("Loading stream", stream.name);
					safeSend(sdpProcess, {
						type: "add",
						data: {
							sdp: stream.raw,
							announce: stream.announce,
						},
					});
				}
			}
		}
	}

	sendMessage("interfaces", networkInterfaces);
	sendNmosConfig();
}

// Handle messages from the SDP child process
function handleSdpMessage(data) {
	sendMessage("streams", data);

	// Combine raw stream data for hashing
	const combinedRaw = data
		.map((stream) => (stream.manual ? stream.raw : ""))
		.join("");
	const newHash = crypto.createHash("sha256").update(combinedRaw).digest("hex");

	if (newHash !== streamsHash) {
		console.log("Saving streams");
		streamsHash = newHash;
		store.set("streams", data);
	}
}

// Handle messages from the NMOS child process
function handleNmosMessage(message) {
	switch (message.type) {
		case "streams":
			sendMessage("nmosStreams", message.data);
			break;
		case "status":
			sendMessage("nmosStatus", message.data);
			break;
		case "connect":
			// Receiver was connected externally via IS-05: start playback
			playNmosStream(message.data);
			break;
		case "disconnect":
			// Receiver was disconnected externally via IS-05: stop playback
			safeSend(audioProcess, { type: "stop" });
			sendMessage("nmosPlaying", { id: "", stream: null });
			break;
	}
}

/**
 * Starts playback of a stream that was connected externally via IS-05.
 * Defaults to the first stereo pair (or mono channel).
 * @param {Object} stream - The parsed stream object from the NMOS process.
 */
function playNmosStream(stream) {
	if (!stream || !stream.isSupported || !stream.media[0]) {
		return;
	}

	refreshCurrentAudioInterface();

	let filter = false;
	let filterAddr = "";
	if (stream.media[0].sourceFilter) {
		filter = true;
		filterAddr = stream.media[0].sourceFilter.srcList;
	}

	safeSend(audioProcess, {
		type: "start",
		data: {
			id: stream.id,
			mcast: stream.mcast,
			port: stream.media[0].port,
			codec: stream.codec,
			ptime: stream.media[0].ptime,
			samplerate: stream.samplerate,
			channels: stream.channels,
			ch1Map: 0,
			ch2Map: stream.channels > 1 ? 1 : 0,
			jitterBufferEnabled: persistentData.settings.bufferEnabled,
			jitterBufferSize: persistentData.settings.bufferSize,
			filter: filter,
			filterAddr: filterAddr,
			audioAPI: audioAPI,
			networkInterface: currentNetworkInterface.address,
			selected: currentAudioDevice,
		},
	});

	sendMessage("nmosPlaying", { id: stream.id, stream: stream });
}

// Initialize the application when ready
app.whenReady().then(() => {
	createMainWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createMainWindow();
		}
	});
});

// Handle application shutdown: kill child processes and quit app
app.on("window-all-closed", () => {
	sdpProcess.kill();
	audioProcess.kill();
	nmosProcess.kill();
	app.quit();
});

// Initialize audio interface from stored configuration and start periodic updates
setAudioInterface(store.get("audioInterface"));
setInterval(updateSystem, 500);
