"use strict";
const lib = require("@clusterio/lib");
const { BaseControllerPlugin } = require("@clusterio/controller");

const {
	PluginExampleEvent, PluginExampleRequest,
//%if controller & web // Subscribing requires web content and the controller
	ExampleSubscribableUpdate, ExampleSubscribableValue,
//%endif
} = require("./messages");

class ControllerPlugin extends BaseControllerPlugin {
//%if controller & web // Subscribing requires web content and the controller
	exampleDatabase;
	storageDirty = false;

//%endif
	async init() {
		this.controller.handle(PluginExampleEvent, this.handlePluginExampleEvent.bind(this));
		this.controller.handle(PluginExampleRequest, this.handlePluginExampleRequest.bind(this));
//%if controller & web // Subscribing requires web content and the controller
		this.controller.subscriptions.handle(ExampleSubscribableUpdate, this.handleExampleSubscription.bind(this));
		this.exampleDatabase = new Map(); // If needed, replace with loading from database file
//%endif
	}

	async onControllerConfigFieldChanged(field, curr, prev) {
		this.logger.info(`controller::onControllerConfigFieldChanged ${field}`);
	}
//%if instance

	async onInstanceConfigFieldChanged(instance, field, curr, prev) {
		this.logger.info(`controller::onInstanceConfigFieldChanged ${instance.id} ${field}`);
	}
//%endif

	async onSaveData() {
		this.logger.info("controller::onSaveData");
	}

	async onShutdown() {
		this.logger.info("controller::onShutdown");
	}

	async onPlayerEvent(instance, event) {
		this.logger.info(`controller::onPlayerEvent ${instance.id} ${JSON.stringify(event)}`);
	}

	async handlePluginExampleEvent(event) {
		this.logger.info(JSON.stringify(event));
	}

	async handlePluginExampleRequest(request) {
		this.logger.info(JSON.stringify(request));
		return {
			myResponseString: request.myString,
			myResponseNumbers: request.myNumberArray,
		};
	}
//%if controller & web // Subscribing requires web content and the controller

	async handleExampleSubscription(request) {
		const values = [...this.exampleDatabase.values()].filter(
			value => value.updatedAtMs > request.lastRequestTimeMs,
		);
		return values.length ? new ExampleSubscribableUpdate(values) : null;
	}
//%endif
}

module.exports = {
	ControllerPlugin,
};
