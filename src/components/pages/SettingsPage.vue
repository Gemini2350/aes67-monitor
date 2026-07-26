<template>
	<div class="row">
		<div class="col-4">
			<h5 class="mb-3">Network</h5>
			<select
				class="form-select"
				aria-label="Default select example"
				id="networkSelect"
			>
				<option
					v-for="networkInterface in networkInterfaces"
					:key="networkInterface.name"
					:value="networkInterface.address"
					:selected="networkInterface.isCurrent"
				>
					{{ networkInterface.name }}: {{ networkInterface.address }}
				</option>
			</select>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Audio Buffering</h5>
			<div class="form-check">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-buffering"
					v-model="persistentData.settings.bufferEnabled"
				/>
				<label class="form-check-label" for="check-buffering">
					Enable Buffering
				</label>
			</div>
			<div class="input-group mb-3">
				<input
					type="number"
					v-model="persistentData.settings.bufferSize"
					class="form-control"
				/>
				<span class="input-group-text">packets</span>
			</div>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Other</h5>
			<div class="form-check mb-3">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-unsupported"
					v-model="persistentData.settings.hideUnsupported"
				/>
				<label class="form-check-label" for="check-unsupported">
					Hide unsupported Streams
				</label>
			</div>
			<label for="sdp-delete-timeout-input" class="form-label"
				>SDP Delete Timeout</label
			>
			<div class="input-group mb-3">
				<input
					type="number"
					id="sdp-delete-timeout-input"
					v-model="persistentData.settings.sdpDeleteTimeout"
					class="form-control"
				/>
				<span class="input-group-text">seconds</span>
			</div>
			<div id="sdp-delete-text" class="form-text mb-3">
				Streams will be removed if no new announcement is received within
				timeout
			</div>
			<div class="form-check mb-3">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-sidebar-collapsed"
					v-model="persistentData.settings.sidebarCollapsed"
				/>
				<label class="form-check-label" for="check-sidebar-collapsed">
					Collapse Sidebar
				</label>
			</div>
		</div>
	</div>
	<hr />
	<div class="row">
		<div class="col-4">
			<h5 class="mb-3">NMOS</h5>
			<div class="form-check mb-3">
				<input
					class="form-check-input"
					type="checkbox"
					id="check-nmos-enabled"
					v-model="persistentData.settings.nmosEnabled"
				/>
				<label class="form-check-label" for="check-nmos-enabled">
					Enable NMOS (IS-04 / IS-05)
				</label>
			</div>
			<div class="form-text mb-3">
				Registers a receiver in the NMOS registry which can be connected via
				IS-05 or from the NMOS Streams page.
			</div>
			<label for="nmos-node-port-input" class="form-label">Node API Port</label>
			<div class="input-group mb-3">
				<input
					type="number"
					id="nmos-node-port-input"
					v-model.number="persistentData.settings.nmosNodePort"
					class="form-control"
					:disabled="!persistentData.settings.nmosEnabled"
				/>
			</div>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Registry Discovery</h5>
			<select
				class="form-select mb-3"
				v-model="persistentData.settings.nmosMode"
				:disabled="!persistentData.settings.nmosEnabled"
			>
				<option value="unicast">DNS-SD Unicast</option>
				<option value="mdns">mDNS (multicast DNS-SD)</option>
				<option value="static">Static Registry Address</option>
			</select>
			<template v-if="persistentData.settings.nmosMode == 'static'">
				<label for="nmos-registry-host-input" class="form-label"
					>Registry IP / Host</label
				>
				<div class="input-group mb-3">
					<input
						type="text"
						id="nmos-registry-host-input"
						v-model="persistentData.settings.nmosRegistryHost"
						class="form-control"
						placeholder="192.168.1.10"
						:disabled="!persistentData.settings.nmosEnabled"
					/>
				</div>
				<label for="nmos-registry-port-input" class="form-label"
					>Registry Port</label
				>
				<div class="input-group mb-3">
					<input
						type="number"
						id="nmos-registry-port-input"
						v-model.number="persistentData.settings.nmosRegistryPort"
						class="form-control"
						:disabled="!persistentData.settings.nmosEnabled"
					/>
				</div>
			</template>
			<template v-if="persistentData.settings.nmosMode == 'unicast'">
				<label for="nmos-dns-server-input" class="form-label"
					>DNS Server (optional)</label
				>
				<div class="input-group mb-3">
					<input
						type="text"
						id="nmos-dns-server-input"
						v-model="persistentData.settings.nmosDnsServer"
						class="form-control"
						placeholder="Host DNS server"
						:disabled="!persistentData.settings.nmosEnabled"
					/>
				</div>
				<label for="nmos-domain-input" class="form-label"
					>Search Domain (optional)</label
				>
				<div class="input-group mb-3">
					<input
						type="text"
						id="nmos-domain-input"
						v-model="persistentData.settings.nmosDomain"
						class="form-control"
						placeholder="Host search domain"
						:disabled="!persistentData.settings.nmosEnabled"
					/>
				</div>
				<div class="form-text mb-3">
					Leave empty to use the DNS server and search domain configured on
					this host.
				</div>
			</template>
		</div>
		<div class="col-4">
			<h5 class="mb-3">Status</h5>
			<div class="form-text mb-3" v-if="!persistentData.settings.nmosEnabled">
				NMOS is disabled.
			</div>
			<div class="form-text mb-3" v-else-if="nmosStatus.registered">
				<i class="bi bi-check-circle-fill text-success me-1"></i>
				Registered with registry at {{ nmosStatus.registry }}
			</div>
			<div class="form-text mb-3" v-else-if="nmosStatus.error">
				<i class="bi bi-exclamation-triangle-fill text-warning me-1"></i>
				{{ nmosStatus.error }}
			</div>
			<div class="form-text mb-3" v-else>Searching for registry...</div>
		</div>
	</div>
</template>

<script>
import { persistentData, networkInterfaces, nmosStatus } from "../../app.js";

export default {
	name: "SettingsPage",
	setup() {
		return {
			persistentData,
			networkInterfaces,
			nmosStatus,
		};
	},
};
</script>

<style></style>
