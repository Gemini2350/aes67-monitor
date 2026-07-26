const http = require("http");
const os = require("os");
const dns = require("dns");
const sdpTransform = require("sdp-transform");
const { Bonjour } = require("bonjour-service");

const supportedSampleRates = [16000, 32000, 44100, 48000, 88200, 96000, 192000];

// Configuration and state
let config = null; // {enabled, mode, host, port, dnsServer, domain, nodePort, label, ids: {node, device, receiver}}
let networkInterface = null; // {address, name, mac}
let registrationBase = null; // http://host:port/x-nmos/registration/v1.3
let queryBase = null; // http://host:port/x-nmos/query/v1.3
let apiVersion = "v1.3";
let registered = false;
let heartbeatTimer = null;
let queryTimer = null;
let discoveryTimer = null;
let httpServer = null;
let bonjour = null;
let manifestCache = {};
let lastStreamsJSON = "";

// IS-05 receiver connection state
let receiverActive = {
	sender_id: null,
	master_enable: false,
	activation: { mode: null, requested_time: null, activation_time: null },
	transport_file: { data: null, type: null },
	transport_params: [
		{
			source_ip: null,
			multicast_ip: null,
			interface_ip: "auto",
			destination_port: "auto",
			rtp_enabled: true,
		},
	],
};
let receiverStaged = JSON.parse(JSON.stringify(receiverActive));

/**
 * Returns an IS-04 version timestamp (TAI-like) for resource updates.
 */
const versionNow = function () {
	const now = Date.now();
	return Math.floor(now / 1000) + ":" + (now % 1000) * 1000000;
};

let resourceVersion = versionNow();

const sendStatus = function (status, error) {
	process.send({
		type: "status",
		data: {
			enabled: !!(config && config.enabled),
			registered: registered,
			registry: registrationBase,
			error: error || null,
		},
	});
};

const log = function (...args) {
	console.log("[NMOS]", ...args);
};

/**
 * HTTP JSON helper (fetch with timeout).
 */
const fetchJSON = async function (url, options) {
	const response = await fetch(url, {
		...options,
		signal: AbortSignal.timeout(5000),
	});
	const text = await response.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch (e) {
		json = null;
	}
	return { status: response.status, json };
};

/**
 * Discovers the registry depending on the configured mode.
 * Sets registrationBase and queryBase.
 */
const discoverRegistry = async function () {
	if (config.mode == "static") {
		const base = "http://" + config.host + ":" + config.port;
		registrationBase = base + "/x-nmos/registration/" + apiVersion;
		queryBase = base + "/x-nmos/query/" + apiVersion;
		return true;
	}

	if (config.mode == "unicast") {
		try {
			const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
			resolver.setServers([config.dnsServer]);

			const lookupSrv = async function (service) {
				const records = await resolver.resolveSrv(
					service + "." + config.domain
				);
				if (records.length == 0) {
					return null;
				}
				records.sort((a, b) => a.priority - b.priority);
				const record = records[0];
				let address = record.name;
				try {
					const addresses = await resolver.resolve4(record.name);
					if (addresses.length > 0) {
						address = addresses[0];
					}
				} catch (e) {
					// use hostname as-is if no A record resolvable via this server
				}
				return "http://" + address + ":" + record.port;
			};

			const regBase = await lookupSrv("_nmos-register._tcp");
			if (!regBase) {
				return false;
			}
			const qryBase = await lookupSrv("_nmos-query._tcp");
			registrationBase = regBase + "/x-nmos/registration/" + apiVersion;
			queryBase = (qryBase || regBase) + "/x-nmos/query/" + apiVersion;
			return true;
		} catch (error) {
			log("Unicast DNS-SD discovery failed:", error.message);
			return false;
		}
	}

	// mDNS discovery
	return new Promise((resolve) => {
		if (!bonjour) {
			bonjour = new Bonjour();
		}

		let resolved = false;
		let regService = null;
		let qryService = null;

		const serviceUrl = function (service) {
			let address = service.host;
			if (service.addresses) {
				for (const addr of service.addresses) {
					if (addr.indexOf(":") === -1) {
						address = addr;
						break;
					}
				}
			}
			return "http://" + address + ":" + service.port;
		};

		const finish = function () {
			if (resolved) {
				return;
			}
			resolved = true;
			regBrowser.stop();
			qryBrowser.stop();

			if (regService) {
				registrationBase =
					serviceUrl(regService) + "/x-nmos/registration/" + apiVersion;
				queryBase =
					serviceUrl(qryService || regService) + "/x-nmos/query/" + apiVersion;
				resolve(true);
			} else {
				resolve(false);
			}
		};

		const regBrowser = bonjour.find(
			{ type: "nmos-register", protocol: "tcp" },
			function (service) {
				if (!regService) {
					regService = service;
				}
				if (qryService) {
					finish();
				} else {
					setTimeout(finish, 500);
				}
			}
		);
		const qryBrowser = bonjour.find(
			{ type: "nmos-query", protocol: "tcp" },
			function (service) {
				if (!qryService) {
					qryService = service;
				}
			}
		);

		setTimeout(finish, 3000);
	});
};

/**
 * Builds the IS-04 node resource.
 */
const buildNode = function () {
	const href = "http://" + networkInterface.address + ":" + config.nodePort + "/";
	const chassisId = networkInterface.mac
		? networkInterface.mac.replace(/:/g, "-").toLowerCase()
		: "00-00-00-00-00-00";

	return {
		id: config.ids.node,
		version: resourceVersion,
		label: config.label,
		description: "AES67 Stream Monitor",
		tags: {},
		href: href,
		hostname: os.hostname(),
		api: {
			versions: [apiVersion],
			endpoints: [
				{
					host: networkInterface.address,
					port: config.nodePort,
					protocol: "http",
				},
			],
		},
		caps: {},
		services: [],
		clocks: [{ name: "clk0", ref_type: "internal" }],
		interfaces: [
			{
				chassis_id: chassisId,
				port_id: chassisId,
				name: networkInterface.name,
			},
		],
	};
};

/**
 * Builds the IS-04 device resource.
 */
const buildDevice = function () {
	const base = "http://" + networkInterface.address + ":" + config.nodePort;
	return {
		id: config.ids.device,
		version: resourceVersion,
		label: config.label,
		description: "AES67 Stream Monitor",
		tags: {},
		type: "urn:x-nmos:device:generic",
		node_id: config.ids.node,
		senders: [],
		receivers: [config.ids.receiver],
		controls: [
			{
				type: "urn:x-nmos:control:sr-ctrl/v1.1",
				href: base + "/x-nmos/connection/v1.1/",
			},
			{
				type: "urn:x-nmos:control:sr-ctrl/v1.0",
				href: base + "/x-nmos/connection/v1.0/",
			},
		],
	};
};

/**
 * Builds the IS-04 receiver resource.
 */
const buildReceiver = function () {
	return {
		id: config.ids.receiver,
		version: resourceVersion,
		label: config.label + " Receiver",
		description: "Monitoring receiver of AES67 Stream Monitor",
		tags: {},
		device_id: config.ids.device,
		transport: "urn:x-nmos:transport:rtp.mcast",
		interface_bindings: [networkInterface.name],
		subscription: {
			sender_id: receiverActive.sender_id,
			active: receiverActive.master_enable,
		},
		format: "urn:x-nmos:format:audio",
		caps: {
			media_types: ["audio/L24", "audio/L16"],
		},
	};
};

/**
 * Registers a single resource with the registry.
 */
const registerResource = async function (type, data) {
	const result = await fetchJSON(registrationBase + "/resource", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: type, data: data }),
	});

	if (result.status != 200 && result.status != 201) {
		throw new Error(
			"Registration of " + type + " failed with status " + result.status
		);
	}
};

/**
 * Registers node, device and receiver with the registry.
 */
const registerAll = async function () {
	resourceVersion = versionNow();
	await registerResource("node", buildNode());
	await registerResource("device", buildDevice());
	await registerResource("receiver", buildReceiver());
	registered = true;
	log("Registered with registry", registrationBase);
	sendStatus();
};

/**
 * Updates the receiver resource in the registry (e.g. subscription changed).
 */
const updateReceiverInRegistry = async function () {
	if (!registered) {
		return;
	}
	try {
		resourceVersion = versionNow();
		await registerResource("receiver", buildReceiver());
	} catch (error) {
		log("Could not update receiver in registry:", error.message);
	}
};

/**
 * Sends a heartbeat; re-registers if the registry lost us.
 */
const heartbeat = async function () {
	if (!config || !config.enabled || !registrationBase) {
		return;
	}

	try {
		const result = await fetchJSON(
			registrationBase + "/health/nodes/" + config.ids.node,
			{ method: "POST" }
		);

		if (result.status == 404) {
			log("Registry does not know us, re-registering");
			registered = false;
			await registerAll();
		} else if (result.status != 200) {
			throw new Error("Heartbeat failed with status " + result.status);
		}
	} catch (error) {
		log("Heartbeat error:", error.message);
		registered = false;
		registrationBase = null;
		queryBase = null;
		sendStatus(null, "Registry unreachable: " + error.message);
	}
};

/**
 * Pre-parses an SDP (same logic as sdp.js) for playback support detection.
 */
const preParse = function (sdp) {
	sdp.isSupported = true;

	if (sdp.media.length <= 0) {
		sdp.isSupported = false;
		sdp.unsupportedReason = "Unsupported media type";
	} else {
		for (let i = 0; i < sdp.media.length; i++) {
			if (sdp.media[i].type != "audio" || sdp.media[i].protocol != "RTP/AVP") {
				sdp.isSupported = false;
				sdp.unsupportedReason = "Unsupported media type";
				break;
			}
			if (sdp.media[i].rtp.length != 1) {
				sdp.isSupported = false;
				sdp.unsupportedReason = "Unsupported rtpmap";
				break;
			}
			if (supportedSampleRates.indexOf(sdp.media[i].rtp[0].rate) === -1) {
				sdp.isSupported = false;
				sdp.unsupportedReason = "Unsupported samplerate";
				break;
			}
			if (
				sdp.media[i].rtp[0].codec != "L24" &&
				sdp.media[i].rtp[0].codec != "L16"
			) {
				sdp.isSupported = false;
				sdp.unsupportedReason = "Unsupported codec";
				break;
			}
			if (sdp.media[i].rtp[0].encoding < 1 || sdp.media[i].rtp[0].encoding > 64) {
				sdp.isSupported = false;
				sdp.unsupportedReason = "Unsupported channel number";
				break;
			}
		}
	}

	sdp.dante = sdp.keywords == "Dante";

	if (sdp.media[0] && sdp.media[0].connection && sdp.media[0].connection.ip) {
		sdp.mcast = sdp.media[0].connection.ip.split("/")[0];
	} else if (sdp.connection && sdp.connection.ip) {
		sdp.mcast = sdp.connection.ip.split("/")[0];
	} else {
		sdp.mcast = "-";
		sdp.isSupported = false;
		sdp.unsupportedReason = "No multicast address";
	}

	sdp.description = sdp.description ? sdp.description : "-";
	if (sdp.description == "-" && sdp.media[0] && sdp.media[0].description) {
		sdp.description = sdp.media[0].description;
	}

	if (sdp.isSupported) {
		sdp.codec = sdp.media[0].rtp[0].codec;
		sdp.samplerate = sdp.media[0].rtp[0].rate;
		sdp.channels = sdp.media[0].rtp[0].encoding;
		sdp.rtpMap = sdp.codec + "/" + sdp.samplerate + "/" + sdp.channels;
	} else {
		sdp.rtpMap = "-";
	}

	return sdp;
};

/**
 * Parses a raw SDP string into a stream object usable by the frontend.
 */
const parseManifest = function (rawSDP, sender) {
	let sdp;
	try {
		sdp = sdpTransform.parse(rawSDP);
	} catch (error) {
		return null;
	}

	if (!sdp.media || !sdp.origin) {
		return null;
	}

	sdp.raw = rawSDP;
	sdp.id = sender.id;
	sdp.name = sender.label || sdp.name;
	sdp.manual = false;
	sdp.nmos = true;
	sdp.lastSeen = Date.now();

	if (!sdp.origin.address) {
		sdp.origin.address = "-";
	}

	return preParse(sdp);
};

/**
 * Fetches the SDP manifest of a sender (cached by sender version).
 */
const fetchManifest = async function (sender) {
	const cacheKey = sender.id;
	const cached = manifestCache[cacheKey];
	if (cached && cached.version == sender.version) {
		return cached.stream;
	}

	let stream = null;
	if (sender.manifest_href) {
		try {
			const response = await fetch(sender.manifest_href, {
				signal: AbortSignal.timeout(5000),
			});
			if (response.ok) {
				const rawSDP = await response.text();
				stream = parseManifest(rawSDP, sender);
			}
		} catch (error) {
			stream = null;
		}
	}

	if (!stream) {
		stream = {
			id: sender.id,
			name: sender.label || sender.id,
			nmos: true,
			manual: false,
			isSupported: false,
			unsupportedReason: "Manifest unavailable",
			mcast: "-",
			rtpMap: "-",
			description: sender.description ? sender.description : "-",
			origin: { address: "-" },
			media: [{ port: 0 }],
			raw: "",
		};
	}

	manifestCache[cacheKey] = { version: sender.version, stream: stream };
	return stream;
};

/**
 * Polls the query API for senders and groups them by device.
 */
const pollQuery = async function () {
	if (!config || !config.enabled || !queryBase) {
		return;
	}

	try {
		const [senders, devices, nodes] = await Promise.all([
			fetchJSON(queryBase + "/senders"),
			fetchJSON(queryBase + "/devices"),
			fetchJSON(queryBase + "/nodes"),
		]);

		if (
			senders.status != 200 ||
			!Array.isArray(senders.json) ||
			devices.status != 200 ||
			!Array.isArray(devices.json) ||
			nodes.status != 200 ||
			!Array.isArray(nodes.json)
		) {
			throw new Error("Query API returned unexpected response");
		}

		const nodeMap = {};
		for (const node of nodes.json) {
			nodeMap[node.id] = node;
		}

		const deviceMap = {};
		for (const device of devices.json) {
			deviceMap[device.id] = device;
		}

		// Clean manifest cache of disappeared senders
		const senderIds = new Set(senders.json.map((sender) => sender.id));
		for (const key of Object.keys(manifestCache)) {
			if (!senderIds.has(key)) {
				delete manifestCache[key];
			}
		}

		const groups = {};
		for (const sender of senders.json) {
			const stream = await fetchManifest(sender);
			const device = deviceMap[sender.device_id];
			const node = device ? nodeMap[device.node_id] : null;
			const groupId = sender.device_id || "unknown";

			if (!groups[groupId]) {
				groups[groupId] = {
					id: groupId,
					label: device ? device.label : "Unknown Device",
					description: device && device.description ? device.description : "",
					nodeLabel: node ? node.label : "",
					hostname: node && node.hostname ? node.hostname : "",
					streams: [],
				};
			}

			groups[groupId].streams.push(stream);
		}

		const groupList = Object.values(groups);
		groupList.sort((a, b) => a.label.localeCompare(b.label));
		for (const group of groupList) {
			group.streams.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
		}

		// Only send if something changed
		const json = JSON.stringify(groupList);
		if (json != lastStreamsJSON) {
			lastStreamsJSON = json;
			process.send({ type: "streams", data: groupList });
		}
	} catch (error) {
		log("Query error:", error.message);
		queryBase = null;
		sendStatus(null, "Query API unreachable: " + error.message);
	}
};

/**
 * Handles an IS-05 PATCH on the receiver: stage + immediate activation.
 */
const patchReceiver = function (body) {
	if (body.sender_id !== undefined) {
		receiverStaged.sender_id = body.sender_id;
	}
	if (body.master_enable !== undefined) {
		receiverStaged.master_enable = body.master_enable;
	}
	if (body.transport_file !== undefined && body.transport_file !== null) {
		receiverStaged.transport_file = {
			data: body.transport_file.data !== undefined ? body.transport_file.data : null,
			type: body.transport_file.type !== undefined ? body.transport_file.type : null,
		};
	}
	if (Array.isArray(body.transport_params) && body.transport_params[0]) {
		receiverStaged.transport_params[0] = {
			...receiverStaged.transport_params[0],
			...body.transport_params[0],
		};
	}

	const activation = body.activation || {};
	const response = JSON.parse(JSON.stringify(receiverStaged));

	if (activation.mode === "activate_immediate") {
		receiverStaged.activation = {
			mode: null,
			requested_time: null,
			activation_time: null,
		};
		receiverActive = JSON.parse(JSON.stringify(receiverStaged));
		receiverActive.activation = {
			mode: "activate_immediate",
			requested_time: null,
			activation_time: versionNow(),
		};

		response.activation = {
			mode: "activate_immediate",
			requested_time: null,
			activation_time: receiverActive.activation.activation_time,
		};

		applyActivation();
	} else if (activation.mode !== undefined) {
		// Scheduled activations are not supported, treat as staged only
		receiverStaged.activation = {
			mode: activation.mode,
			requested_time: activation.requested_time || null,
			activation_time: null,
		};
		response.activation = receiverStaged.activation;
	} else {
		response.activation = receiverStaged.activation;
	}

	return response;
};

/**
 * Applies an activated connection: starts or stops playback via the main process.
 */
const applyActivation = function () {
	if (
		receiverActive.master_enable &&
		receiverActive.transport_file &&
		receiverActive.transport_file.data
	) {
		const stream = parseManifest(receiverActive.transport_file.data, {
			id: receiverActive.sender_id || "nmos-external",
			label: null,
		});

		if (stream && stream.isSupported) {
			process.send({ type: "connect", data: stream });
		} else {
			log("Received unsupported transport file via IS-05");
			process.send({ type: "disconnect" });
		}
	} else {
		process.send({ type: "disconnect" });
	}

	updateReceiverInRegistry();
};

/**
 * Resolves 'auto' transport params against the actual connection for /active.
 */
const resolveActiveParams = function () {
	const active = JSON.parse(JSON.stringify(receiverActive));
	const params = active.transport_params[0];

	if (active.transport_file && active.transport_file.data) {
		try {
			const sdp = sdpTransform.parse(active.transport_file.data);
			const mcast =
				sdp.media[0] && sdp.media[0].connection
					? sdp.media[0].connection.ip.split("/")[0]
					: sdp.connection
					? sdp.connection.ip.split("/")[0]
					: null;

			if (params.multicast_ip == null || params.multicast_ip == "auto") {
				params.multicast_ip = mcast;
			}
			if (params.destination_port == "auto" && sdp.media[0]) {
				params.destination_port = sdp.media[0].port;
			}
		} catch (e) {
			// keep params as-is
		}
	}

	if (params.interface_ip == "auto" && networkInterface) {
		params.interface_ip = networkInterface.address;
	}

	return active;
};

/**
 * Minimal Node API + Connection API HTTP server.
 */
const requestHandler = function (request, response) {
	const sendJSON = function (status, data) {
		const body = JSON.stringify(data);
		response.writeHead(status, {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		});
		response.end(body);
	};

	const notFound = function () {
		sendJSON(404, { code: 404, error: "Not Found", debug: null });
	};

	if (request.method == "OPTIONS") {
		response.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		});
		response.end();
		return;
	}

	const url = request.url.split("?")[0].replace(/\/+$/, "");
	const receiverId = config.ids.receiver;

	// Node API
	const nodeBase = "/x-nmos/node/" + apiVersion;
	if (url == "" || url == "/x-nmos") {
		sendJSON(200, url == "" ? ["x-nmos/"] : ["node/", "connection/"]);
		return;
	}
	if (url == "/x-nmos/node") {
		sendJSON(200, [apiVersion + "/"]);
		return;
	}
	if (url == nodeBase) {
		sendJSON(200, [
			"self/",
			"devices/",
			"sources/",
			"flows/",
			"senders/",
			"receivers/",
		]);
		return;
	}
	if (url == nodeBase + "/self") {
		sendJSON(200, buildNode());
		return;
	}
	if (url == nodeBase + "/devices") {
		sendJSON(200, [buildDevice()]);
		return;
	}
	if (url == nodeBase + "/devices/" + config.ids.device) {
		sendJSON(200, buildDevice());
		return;
	}
	if (url == nodeBase + "/receivers") {
		sendJSON(200, [buildReceiver()]);
		return;
	}
	if (url == nodeBase + "/receivers/" + receiverId) {
		sendJSON(200, buildReceiver());
		return;
	}
	if (
		url == nodeBase + "/sources" ||
		url == nodeBase + "/flows" ||
		url == nodeBase + "/senders"
	) {
		sendJSON(200, []);
		return;
	}

	// Connection API (v1.0 and v1.1 are handled identically)
	const connectionMatch = url.match(
		/^\/x-nmos\/connection\/(v1\.[01])(\/.*)?$/
	);
	if (url == "/x-nmos/connection") {
		sendJSON(200, ["v1.0/", "v1.1/"]);
		return;
	}
	if (connectionMatch) {
		const subPath = connectionMatch[2] || "";

		switch (subPath) {
			case "":
				sendJSON(200, ["bulk/", "single/"]);
				return;
			case "/single":
				sendJSON(200, ["receivers/", "senders/"]);
				return;
			case "/single/senders":
				sendJSON(200, []);
				return;
			case "/single/receivers":
				sendJSON(200, [receiverId + "/"]);
				return;
			case "/single/receivers/" + receiverId:
				sendJSON(200, ["constraints/", "staged/", "active/", "transporttype/"]);
				return;
			case "/single/receivers/" + receiverId + "/constraints":
				sendJSON(200, [{}]);
				return;
			case "/single/receivers/" + receiverId + "/transporttype":
				sendJSON(200, "urn:x-nmos:transport:rtp");
				return;
			case "/single/receivers/" + receiverId + "/active":
				sendJSON(200, resolveActiveParams());
				return;
			case "/single/receivers/" + receiverId + "/staged":
				if (request.method == "GET") {
					sendJSON(200, receiverStaged);
					return;
				}
				if (request.method == "PATCH") {
					let body = "";
					request.on("data", (chunk) => {
						body += chunk;
					});
					request.on("end", () => {
						try {
							const parsed = body ? JSON.parse(body) : {};
							sendJSON(200, patchReceiver(parsed));
						} catch (error) {
							sendJSON(400, {
								code: 400,
								error: "Invalid JSON body",
								debug: null,
							});
						}
					});
					return;
				}
				notFound();
				return;
			default:
				notFound();
				return;
		}
	}

	notFound();
};

/**
 * Starts the NMOS node: HTTP server, discovery, registration, polling.
 */
const start = async function () {
	if (!config || !config.enabled || !networkInterface) {
		return;
	}

	if (!httpServer) {
		httpServer = http.createServer(requestHandler);
		httpServer.on("error", function (error) {
			log("HTTP server error:", error.message);
			sendStatus(null, "Node API server error: " + error.message);
			httpServer = null;
		});
		httpServer.listen(config.nodePort);
		log("Node/Connection API listening on port", config.nodePort);
	}

	if (!heartbeatTimer) {
		heartbeatTimer = setInterval(heartbeat, 5000);
	}
	if (!queryTimer) {
		queryTimer = setInterval(pollQuery, 5000);
	}
	if (!discoveryTimer) {
		discoveryTimer = setInterval(async function () {
			if ((!registrationBase || !queryBase) && config && config.enabled) {
				await connectToRegistry();
			}
		}, 10000);
	}

	await connectToRegistry();
};

/**
 * Discovers and registers with the registry.
 */
const connectToRegistry = async function () {
	try {
		const found = await discoverRegistry();
		if (!found) {
			sendStatus(null, "No registry found");
			return;
		}

		await registerAll();
		await pollQuery();
	} catch (error) {
		log("Registry connection failed:", error.message);
		registered = false;
		sendStatus(null, "Registry connection failed: " + error.message);
	}
};

/**
 * Stops all NMOS activity and unregisters from the registry.
 */
const stop = async function () {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	if (queryTimer) {
		clearInterval(queryTimer);
		queryTimer = null;
	}
	if (discoveryTimer) {
		clearInterval(discoveryTimer);
		discoveryTimer = null;
	}
	if (httpServer) {
		httpServer.close();
		httpServer = null;
	}
	if (bonjour) {
		bonjour.destroy();
		bonjour = null;
	}

	if (registered && registrationBase) {
		try {
			await fetch(registrationBase + "/resource/nodes/" + config.ids.node, {
				method: "DELETE",
				signal: AbortSignal.timeout(2000),
			});
		} catch (error) {
			// registry will garbage-collect us
		}
	}

	registered = false;
	registrationBase = null;
	queryBase = null;
	manifestCache = {};
	lastStreamsJSON = "";
	process.send({ type: "streams", data: [] });
	sendStatus();
};

/**
 * Applies a new configuration (restart if needed).
 */
const applyConfig = async function (newConfig, newInterface) {
	const wasRunning = config && config.enabled;
	const restartNeeded =
		!config ||
		config.enabled != newConfig.enabled ||
		config.mode != newConfig.mode ||
		config.host != newConfig.host ||
		config.port != newConfig.port ||
		config.dnsServer != newConfig.dnsServer ||
		config.domain != newConfig.domain ||
		config.nodePort != newConfig.nodePort ||
		(newInterface &&
			networkInterface &&
			newInterface.address != networkInterface.address);

	config = newConfig;
	if (newInterface) {
		networkInterface = newInterface;
	}

	if (!restartNeeded) {
		return;
	}

	if (wasRunning) {
		await stop();
	}

	if (config.enabled) {
		await start();
	}
};

process.on("message", async (message) => {
	switch (message.type) {
		case "config":
			await applyConfig(message.data.config, message.data.interface);
			break;
		case "connected":
			// Local playback of an NMOS sender started via the UI
			receiverActive.sender_id = message.data.senderId;
			receiverActive.master_enable = true;
			receiverActive.transport_file = {
				data: message.data.sdp || null,
				type: "application/sdp",
			};
			receiverStaged = JSON.parse(JSON.stringify(receiverActive));
			updateReceiverInRegistry();
			break;
		case "disconnected":
			// Local playback stopped via the UI
			receiverActive.sender_id = null;
			receiverActive.master_enable = false;
			receiverActive.transport_file = { data: null, type: null };
			receiverStaged = JSON.parse(JSON.stringify(receiverActive));
			updateReceiverInRegistry();
			break;
		case "update":
			if (lastStreamsJSON) {
				process.send({ type: "streams", data: JSON.parse(lastStreamsJSON) });
			}
			sendStatus();
			break;
	}
});

process.on("disconnect", () => {
	process.exit(0);
});
