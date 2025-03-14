import type Controller from "./Controller";
import type WsServerConnector from "./WsServerConnector";

import * as lib from "@clusterio/lib";
const { logger } = lib;

import BaseConnection from "./BaseConnection";
import InstanceInfo from "./InstanceInfo";
import HostInfo from "./HostInfo";


/**
 * Represents the connection to a host
 *
 * @extends module:controller/src/BaseConnection
 * @alias module:controller/src/HostConnection
 */
export default class HostConnection extends BaseConnection {
	private _agent: string;
	private _id: number;
	private _name: string;
	private _version: string;
	plugins: Map<string, string>;

	constructor(
		registerData: lib.RegisterHostData,
		connector: WsServerConnector,
		controller: Controller,
	) {
		super(connector, controller);

		this._agent = registerData.agent;
		this._id = registerData.id;
		this._name = registerData.name;
		this._version = registerData.version;
		this.plugins = new Map(Object.entries(registerData.plugins));
		this._checkPluginVersions();

		const previousHostInfo = this._controller.hosts.get(this._id);
		const currentHostInfo = new HostInfo(
			this._agent,
			this._id,
			this._name,
			this._version,
			this.plugins,
			true,
			registerData.publicAddress ?? "",
			previousHostInfo?.tokenValidAfter,
			Date.now(),
			false,
		);
		this._controller.hosts.set(this._id, currentHostInfo);
		this._controller.hostsUpdated([currentHostInfo]);

		for (let event of ["connect", "drop", "resume", "close"] as const) {
			// eslint-disable-next-line no-loop-func
			this.connector.on(event, () => {
				for (let plugin of this._controller.plugins.values()) {
					plugin.onHostConnectionEvent(this, event);
				}
			});
		}

		this.connector.on("close", () => {
			// Update status to unknown for instances on this host.
			const instances: InstanceInfo[] = [];
			for (let instance of this._controller.instances.values()) {
				if (instance.config.get("instance.assigned_host") !== this._id) {
					continue;
				}

				instances.push(instance);
				let prev = instance.status;
				instance.status = "unknown";
				lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", instance, prev);
			}
			this._controller.instanceDetailsUpdated(instances);

			currentHostInfo.connected = false;
			this._controller.hostsUpdated([currentHostInfo]);
		});

		this.handle(lib.InstanceStatusChangedEvent, this.handleInstanceStatusChangedEvent.bind(this));
		this.handle(lib.InstancesUpdateRequest, this.handleInstancesUpdateRequest.bind(this));
		this.handle(lib.InstanceSaveDetailsUpdatesEvent, this.handleInstanceSaveDetailsUpdatesEvent.bind(this));
		this.handle(lib.LogMessageEvent, this.handleLogMessageEvent.bind(this));
		this.handle(lib.InstancePlayerUpdateEvent, this.handleInstancePlayerUpdateEvent.bind(this));
	}

	validateIngress(message: lib.MessageRoutable) {
		let origin = this.connector.dst;
		switch (message.src.type) {
			case lib.Address.control:
			case lib.Address.controller:
				throw new lib.InvalidMessage(`Received message with invalid src ${message.src} from ${origin}`);

			case lib.Address.host:
				if (message.src.id !== origin.id) {
					throw new lib.InvalidMessage(
						`Received message with invalid src ${message.src} from ${origin}`
					);
				}
				break;

			case lib.Address.instance:
				let instance = this._controller.instances.get(message.src.id);
				if (!instance || instance.config.get("instance.assigned_host") !== this._id) {
					throw new lib.InvalidMessage(
						`Received message with invalid src ${message.src} from ${origin}`
					);
				}
				break;

			default:
				throw new Error("Should be unreachable");
		}
	}

	_checkPluginVersions() {
		let pluginInfos = new Map(this._controller.pluginInfos.map(i => [i.name, i]));
		for (let [name, version] of this.plugins) {
			let info = pluginInfos.get(name);
			if (!info) {
				logger.warn(`Host ${this._name} has plugin ${name} ${version} which the controller does not have`);
				continue;
			}

			if (info.version !== version) {
				logger.warn(
					`Host ${this._name} has plugin ${name} ${version} which does not match the version of this ` +
					`plugin on the controller (${info.version})`
				);
			}
		}

		for (let [name, info] of pluginInfos) {
			if (!this.plugins.has(name)) {
				logger.warn(`Host ${this._name} is missing plugin ${name} ${info.version}`);
			}
		}
	}

	async prepareDisconnect() {
		await lib.invokeHook(this._controller.plugins, "onPrepareHostDisconnect", this);
		return await super.prepareDisconnect();
	}

	/**
	 * ID of the host this connection is connected to
	 *
	 * @returns {number} host ID.
	 */
	get id() {
		return this._id;
	}

	async handleInstanceStatusChangedEvent(request: lib.InstanceStatusChangedEvent) {
		let instance = this._controller.instances.get(request.instanceId);

		// It's possible to get updates from an instance that does not exist
		// or is not assigned to the host it originated from if it was
		// reassigned or deleted while the connection to the host it was
		// originally on was down at the time.
		if (!instance || instance.config.get("instance.assigned_host") !== this._id) {
			logger.warn(`Got bogus update for instance id ${request.instanceId}`);
			return;
		}

		// We may receive status changed where the status hasn't changed
		// from our perspective if the connection was down at the time it
		// changed.  Hosts also send status updates on assignInstance which
		// for hacky reason is also used to push config changes and
		// restablish status after a connection loss.
		if (instance.status === request.status) {
			return;
		}

		let prev = instance.status;
		instance.status = request.status;
		instance.gamePort = request.gamePort;
		instance.updatedAt = Date.now();
		logger.verbose(`Instance ${instance.config.get("instance.name")} State: ${instance.status}`);
		this._controller.instanceDetailsUpdated([instance]);
		await lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", instance, prev);
	}

	async handleInstancesUpdateRequest(request: lib.InstancesUpdateRequest) {
		// Push updated instance configs
		for (let instance of this._controller.instances.values()) {
			if (instance.config.get("instance.assigned_host") === this._id) {
				await this.send(
					new lib.InstanceAssignInternalRequest(instance.id, instance.config.toRemote("host"))
				);
			}
		}

		// Assign instances the host has but controller does not
		const instanceUpdates: InstanceInfo[] = [];
		for (let instanceData of request.instances) {
			const instanceConfig = new lib.InstanceConfig("controller");
			instanceConfig.update(instanceData.config, false, "host");

			let controllerInstance = this._controller.instances.get(instanceConfig.get("instance.id"));
			if (controllerInstance) {
				// Check if this instance is assigned somewhere else.
				if (controllerInstance.config.get("instance.assigned_host") !== this._id) {
					await this.send(
						new lib.InstanceUnassignInternalRequest(instanceConfig.get("instance.id"))
					);
					continue;
				}

				// Already have this instance, update state instead
				if (controllerInstance.status !== instanceData.status) {
					let prev = controllerInstance.status;
					controllerInstance.status = instanceData.status;
					controllerInstance.gamePort = instanceData.gamePort;
					controllerInstance.updatedAt = Date.now();
					logger.verbose(`Instance ${instanceConfig.get("instance.name")} State: ${instanceData.status}`);
					instanceUpdates.push(controllerInstance);
					await lib.invokeHook(
						this._controller.plugins, "onInstanceStatusChanged", controllerInstance, prev
					);
				}
				continue;
			}

			instanceConfig.set("instance.assigned_host", this._id);
			let newInstance = new InstanceInfo(
				instanceConfig,
				instanceData.status,
				instanceData.gamePort,
				Date.now(),
			);
			this._controller.instances.set(instanceConfig.get("instance.id"), newInstance);
			this._controller.instancesDirty = true;
			this._controller.addInstanceHooks(newInstance);
			await this.send(
				new lib.InstanceAssignInternalRequest(
					instanceConfig.get("instance.id"), instanceConfig.toRemote("host")
				)
			);
			instanceUpdates.push(newInstance);
			await lib.invokeHook(this._controller.plugins, "onInstanceStatusChanged", newInstance);
		}

		if (instanceUpdates.length) {
			this._controller.instanceDetailsUpdated(instanceUpdates);
		}

		// Push lists to make sure they are in sync.
		let adminlist: Set<string> = new Set();
		let banlist: Map<string, string> = new Map();
		let whitelist: Set<string> = new Set();

		for (let user of this._controller.userManager.users.values()) {
			if (user.isAdmin) {
				adminlist.add(user.name);
			}
			if (user.isBanned) {
				banlist.set(user.name, user.banReason);
			}
			if (user.isWhitelisted) {
				whitelist.add(user.name);
			}
		}

		await this.send(new lib.SyncUserListsEvent(adminlist, banlist, whitelist));
	}

	async handleInstanceSaveDetailsUpdatesEvent(event: lib.InstanceSaveDetailsUpdatesEvent) {
		const now = Date.now();
		const updates: lib.SaveDetails[] = [];
		for (const save of event.updates) {
			const existingSave = this._controller.saves.get(save.id);
			if (existingSave && save.equals(existingSave)) {
				continue;
			}
			save.updatedAt = now;
			this._controller.saves.set(save.id, save);
			updates.push(save);
		}
		if (event.instanceId !== undefined) {
			const updatedSaves = new Set(event.updates.map(s => s.id));
			for (const [id, save] of this._controller.saves) {
				if (save.instanceId === event.instanceId && !updatedSaves.has(id)) {
					save.isDeleted = true;
					save.updatedAt = now;
					updates.push(save);
					this._controller.saves.delete(id);
				}
			}
		}
		// Hosts eagerly send updates, which means we may get an update
		// where nothing actualy changed.
		if (updates.length) {
			this._controller.savesUpdated(updates);
		}
	}

	async handleLogMessageEvent(event: lib.LogMessageEvent) {
		this._controller.clusterLogger.log({
			...event.info,
			host_id: this._id,
			host_name: this._name,
		});
	}

	async handleInstancePlayerUpdateEvent(event: lib.InstancePlayerUpdateEvent, src: lib.Address) {
		let instanceId = src.id;
		let user = this._controller.userManager.users.get(event.name);
		if (!user) {
			user = this._controller.userManager.createUser(event.name);
		}

		if (event.type === "join") {
			this._controller.userManager.notifyJoin(user, instanceId);
		} else if (event.type === "leave") {
			this._controller.userManager.notifyLeave(user, instanceId);
		}

		user.instanceStats.set(instanceId, event.stats);

		user.recalculatePlayerStats();
		this._controller.usersUpdated([user]);

		let instance = this._controller.instances.get(instanceId)!;
		await lib.invokeHook(this._controller.plugins, "onPlayerEvent", instance, {
			type: event.type,
			name: event.name,
			reason: event.reason,
			stats: event.stats,
		});
	}
}
