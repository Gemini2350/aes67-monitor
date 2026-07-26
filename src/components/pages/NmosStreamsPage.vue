<template>
	<div
		class="alert alert-primary"
		role="alert"
		v-if="!persistentData.settings.nmosEnabled"
	>
		NMOS is disabled. Enable it in
		<a href="#" class="alert-link" @click.prevent="viewPage('settings')"
			>Settings</a
		>.
	</div>
	<div class="alert alert-warning" role="alert" v-else-if="nmosStatus.error">
		{{ nmosStatus.error }}
	</div>
	<div
		class="alert alert-primary"
		role="alert"
		v-else-if="searchNmosStreams.length == 0"
	>
		No NMOS streams found.
		<span v-if="nmosStatus.registered">
			Connected to registry, waiting for senders.
		</span>
		<span v-else> Searching for registry... </span>
	</div>

	<div v-if="nmosStatus.registered" class="form-text mb-3">
		<i class="bi bi-check-circle-fill text-success me-1"></i>
		Registered with registry at {{ nmosStatus.registry }}
	</div>

	<div
		class="card mb-3"
		v-for="device in searchNmosStreams"
		:key="device.id"
	>
		<div
			class="card-header d-flex align-items-center"
			style="cursor: pointer"
			@click="toggleNmosDevice(device.id)"
		>
			<i
				class="bi me-2"
				:class="{
					'bi-chevron-down': !isNmosDeviceCollapsed(device.id),
					'bi-chevron-right': isNmosDeviceCollapsed(device.id),
				}"
			></i>
			<strong>{{ device.label }}</strong>
			<span class="ms-2 text-body-secondary" v-if="device.nodeLabel">
				{{ device.nodeLabel
				}}<span v-if="device.hostname"> ({{ device.hostname }})</span>
			</span>
			<span class="badge bg-primary ms-auto">{{ device.streams.length }}</span>
		</div>
		<div class="card-body p-0" v-if="!isNmosDeviceCollapsed(device.id)">
			<table class="table table-sm table-borderless mb-0">
				<thead>
					<tr>
						<th>Name</th>
						<th>Info</th>
						<th>Format</th>
						<th>Multicast</th>
						<th>Channel</th>
						<th></th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="stream in device.streams" :key="stream.id">
						<td>{{ stream.name }}</td>
						<td>
							{{ stream.description != "-" ? stream.description : "" }}
						</td>
						<td>
							<span v-if="stream.isSupported" class="copy">
								{{ stream.codec }} / {{ stream.samplerate }}Hz /
								{{ stream.channels }}
							</span>
						</td>
						<td>
							<span v-if="stream.isSupported" class="copy"
								>{{ stream.mcast }}:{{ stream.media[0].port }}</span
							>
						</td>
						<td>
							<select
								class="form-select form-select-sm"
								v-model="selectedChannel[stream.id]"
								:disabled="stream.id === playing"
								v-if="stream.isSupported"
							>
								<template
									v-for="value in getChannelSelectValues(stream)"
									:key="value.value"
								>
									<option :value="value.value">
										{{ value.string }}
									</option>
								</template>
							</select>
							<small
								v-else
								class="d-inline-flex px-2 py-1 fw-semibold text-danger-emphasis bg-danger-subtle border border-danger-subtle rounded-2"
								>{{ stream.unsupportedReason }}</small
							>
						</td>
						<td>
							<button
								class="btn btn-sm"
								:class="{
									'btn-success': stream.id !== playing,
									'btn-danger': stream.id === playing,
								}"
								@click="playStream(stream)"
								v-if="stream.isSupported"
								:disabled="
									!getCurrentSupportedSampleRates().includes(stream.samplerate)
								"
								:title="
									stream.id === playing
										? 'Disconnect receiver'
										: 'Connect receiver to this sender'
								"
							>
								<i v-if="stream.id === playing" class="bi bi-stop-fill"></i>
								<i v-else class="bi bi-play-fill"></i>
							</button>
						</td>
						<td>
							<button
								class="btn btn-sm btn-primary"
								@click="viewStream(stream)"
								v-if="stream.raw"
							>
								<i class="bi bi-info-circle-fill"></i>
							</button>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>

<script>
import {
	searchNmosStreams,
	nmosStatus,
	persistentData,
	viewPage,
	viewStream,
	getChannelSelectValues,
	selectedChannel,
	playStream,
	playing,
	getCurrentSupportedSampleRates,
	toggleNmosDevice,
	isNmosDeviceCollapsed,
} from "../../app.js";

export default {
	name: "NmosStreamsPage",
	setup() {
		return {
			searchNmosStreams,
			nmosStatus,
			persistentData,
			viewPage,
			viewStream,
			getChannelSelectValues,
			selectedChannel,
			playStream,
			playing,
			getCurrentSupportedSampleRates,
			toggleNmosDevice,
			isNmosDeviceCollapsed,
		};
	},
};
</script>

<style></style>
