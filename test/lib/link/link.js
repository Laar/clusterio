"use strict";
const assert = require("assert").strict;
const events = require("events");

const libData = require("@clusterio/lib/data");
const libLink = require("@clusterio/lib/link");
const libErrors = require("@clusterio/lib/errors");
const mock = require("../../mock");

const addr = libData.Address.fromShorthand;

describe("lib/link/link", function() {
	function throwSimple(message) {
		let err = new Error(message);
		err.stack = message;
		throw err;
	}

	describe("class Link", function() {
		let testConnector;
		let testLink;
		let src = addr({ controlId: 1 });
		let dst = addr("controller");

		class SimpleRequest {
			static type = "request";
			static src = ["controller", "control"];
			static dst = ["controller", "control"];
		}
		libLink.Link.register(SimpleRequest);
		class NumberRequest {
			static type = "request";
			static src = ["controller", "control"];
			static dst = ["controller", "control"];
			constructor(value) { this.value = value; }
			static jsonSchema = { type: "number" };
			toJSON() { return this.value; }
			static fromJSON(json) { return new this(json); }
		}
		NumberRequest.Response = class {
			constructor(value) { this.value = value; }
			static jsonSchema = { type: "number" };
			toJSON() { return this.value; }
			static fromJSON(json) { return new this(json); }
		};
		libLink.Link.register(NumberRequest);
		class SimpleEvent {
			static type = "event";
			static src = ["controller", "control"];
			static dst = ["controller", "control"];
		}
		libLink.Link.register(SimpleEvent);
		class NumberEvent {
			static type = "event";
			static src = ["controller", "control"];
			static dst = ["controller", "control"];
			constructor(value) { this.value = value; }
			static jsonSchema = { type: "number" };
			toJSON() { return this.value; }
			static fromJSON(json) { return new this(json); }
		}
		libLink.Link.register(NumberEvent);

		beforeEach(function() {
			testConnector = new mock.MockConnector(src, dst);
			testLink = new libLink.Link(testConnector);
		});

		it("should handle unknown message", async function() {
			testConnector.emit("message", { type: "unknown" });
		});
		it("should give an error response back on unrecognized request", function() {
			testConnector.emit("message", new libData.MessageRequest(1, dst, src, "UnhandledRequest"));
			assert.deepEqual(testConnector.sentMessages, [
				new libData.MessageResponseError(
					testConnector._seq - 1,
					src,
					dst,
					new libData.ResponseError("Unrecognized request UnhandledRequest")
				),
			]);
		});
		it("should give an error response back on unhandled request", function() {
			class UnhandledRequest {
				static type = "request";
				static src = "controller";
				static dst = "control";
			}
			libLink.Link.register(UnhandledRequest);
			testConnector.emit("message", new libData.MessageRequest(1, dst, src, "UnhandledRequest"));
			assert.deepEqual(testConnector.sentMessages, [
				new libData.MessageResponseError(
					testConnector._seq - 1,
					src,
					dst,
					new libData.ResponseError("No handler for UnhandledRequest")
				),
			]);
		});

		it("should send ready on connector prepareDisconnect", async function() {
			let message = events.once(testConnector, "send");
			message.catch(() => {});
			testConnector.emit("disconnectPrepare");
			assert.deepEqual(await message, [new libData.MessageDisconnect("ready")]);
		});
		it("should send ready on connector prepareDisconnect if an error occurs", async function() {
			testLink.prepareDisconnect = async () => { throwSimple("Error occured"); };
			let message = events.once(testConnector, "send");
			message.catch(() => {});
			testConnector.emit("disconnectPrepare");
			assert.deepEqual(await message, [new libData.MessageDisconnect("ready")]);
		});

		it("should reject pending requests on close", async function() {
			let pending = testLink.send(new SimpleRequest());
			pending.catch(() => {});
			testConnector.emit("close");
			await assert.rejects(pending, { message: "Session Closed" });
		});
		it("should reject pending requests on invalidate", async function() {
			let pending = testLink.send(new SimpleRequest());
			pending.catch(() => {});
			testConnector.emit("invalidate");
			await assert.rejects(pending, { message: "Session Lost" });
		});

		describe(".send()", function() {
			it("should send request to the other side of the link", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.send(new SimpleRequest());
				let srcReq = new libData.Address(libData.Address.control, 1, 1);
				assert.deepEqual(
					await message,
					[new libData.MessageRequest(1, srcReq, dst, "SimpleRequest", undefined)]
				);
			});
			it("should send request with data to the other side of the link", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.send(new NumberRequest(22));
				let srcReq = new libData.Address(libData.Address.control, 1, 1);
				assert.deepEqual(
					await message,
					[new libData.MessageRequest(1, srcReq, dst, "NumberRequest", new NumberRequest(22))]
				);
			});
			it("should send request and resolve when response is received", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				let request = testLink.send(new SimpleRequest());
				let srcReq = new libData.Address(libData.Address.control, 1, 1);
				testConnector.emit("message", new libData.MessageResponse(1, dst, srcReq));
				await request;
			});
			it("should send request and reject with error when error response is received", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				let request = testLink.send(new SimpleRequest());
				let srcReq = new libData.Address(libData.Address.control, 1, 1);
				testConnector.emit(
					"message", new libData.MessageResponseError(1, dst, srcReq, new libData.ResponseError("Error"))
				);
				await assert.rejects(
					request,
					{ message: "Error" }
				);
			});
			it("should send request and resolve with data when response is received", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				let request = testLink.send(new NumberRequest(22));
				let srcReq = new libData.Address(libData.Address.control, 1, 1);
				testConnector.emit("message", new libData.MessageResponse(1, dst, srcReq, 44));
				assert.deepEqual(await request, new NumberRequest.Response(44));
			});
			it("should send event to the other side of the link", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.send(new SimpleEvent());
				assert.deepEqual(
					await message,
					[new libData.MessageEvent(1, src, dst, "SimpleEvent", undefined)]
				);
			});
			it("should send event with data to the other side of the link", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.send(new NumberEvent(22));
				assert.deepEqual(
					await message,
					[new libData.MessageEvent(1, src, dst, "NumberEvent", new NumberEvent(22))]
				);
			});
		});
		describe(".handle()", function() {
			it("should register a request handler", function() {
				let handled = false;
				testLink.handle(SimpleRequest, async () => { handled = true; });
				assert(testLink._requestHandlers.has(SimpleRequest), "request handler was not registered");
				testConnector.emit("message", new libData.MessageRequest(1, dst, src, "SimpleRequest"));
				assert(handled, "request was not handled");
			});
			it("should send response error from request handler throwing", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.handle(SimpleRequest, async () => { throwSimple("Error"); });
				testConnector.emit("message", new libData.MessageRequest(1, dst, src, "SimpleRequest"));
				assert.deepEqual(
					await message,
					[new libData.MessageResponseError(
						1, src, dst, new libData.ResponseError("Error", undefined, "Error")
					)]
				);
			});
			it("should send response error on request validation failing", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.handle(NumberRequest, async () => 1);
				testConnector.emit("message", new libData.MessageRequest(1, dst, src, "NumberRequest", "not a number"));
				let response = (await message)[0];
				assert.deepEqual(
					response,
					new libData.MessageResponseError(1, src, dst, new libData.ResponseError(
						"Request NumberRequest failed validation",
						response.data.code,
						response.data.stack,
					))
				);
			});
			it("should send response error on response validation failing", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.handle(NumberRequest, async () => "not a number");
				testConnector.emit("message", new libData.MessageRequest(1, dst, src, "NumberRequest", 1));
				let response = (await message)[0];
				assert.deepEqual(
					response,
					new libData.MessageResponseError(1, src, dst, new libData.ResponseError(
						"Response for request NumberRequest failed validation",
						response.data.code,
						response.data.stack,
					))
				);
			});
			it("should send value returned from request handler", async function() {
				let message = events.once(testConnector, "send");
				message.catch(() => {});
				testLink.handle(NumberRequest, async (request) => request.value + 4);
				testConnector.emit("message", new libData.MessageRequest(1, dst, src, "NumberRequest", 1));
				let response = (await message)[0];
				assert.deepEqual(
					response,
					new libData.MessageResponse(1, src, dst, 5)
				);
			});
			it("should register an event handler", function() {
				let handled = false;
				testLink.handle(SimpleEvent, async () => { handled = true; });
				assert(testLink._eventHandlers.has(SimpleEvent), "event handler was not registered");
				testConnector.emit("message", new libData.MessageEvent(1, dst, src, "SimpleEvent"));
				assert(handled, "event was not handled");
			});
			it("should pass value to event handler", async function() {
				let value;
				testLink.handle(NumberEvent, async (event) => { value = event.value; });
				testConnector.emit("message", new libData.MessageEvent(1, dst, src, "NumberEvent", 9));
				assert.deepEqual(value, 9);
			});
			it("should log errors from event handler", function() {
				testLink.handle(SimpleEvent, async () => { throwSimple("Error"); });
				testConnector.emit("message", new libData.MessageEvent(1, dst, src, "SimpleEvent"));
			});
			it("should throw on unknown type", function() {
				assert.throws(
					() => testLink.handle({ name: "Bad", type: "bad" }),
					{ message: "Class Bad has unrecognized type bad" }
				);
			});
			it("should throw on double registration", function() {
				testLink.handle(SimpleRequest);
				assert.throws(
					() => testLink.handle(SimpleRequest),
					new Error("Request SimpleRequest is already registered")
				);
				testLink.handle(SimpleEvent);
				assert.throws(
					() => testLink.handle(SimpleEvent),
					new Error("Event SimpleEvent is already registered")
				);
			});
		});
		describe("static .register()", function() {
			it("should throw if Request has only one of jsonSchema and fromJSON", function() {
				class BadRequest1 {
					static type = "request";
					static src = "controller";
					static dst = "control";
					static jsonSchema = {};
				}
				assert.throws(
					() => libLink.Link.register(BadRequest1),
					new Error("Request BadRequest1 has static jsonSchema but is missing static fromJSON")
				);
				class BadRequest2 {
					static type = "request";
					static src = "controller";
					static dst = "control";
					static fromJSON() {};
				}
				assert.throws(
					() => libLink.Link.register(BadRequest2),
					new Error("Request BadRequest2 has static fromJSON but is missing static jsonSchema")
				);
			});
			it("should throw if Event has only one of jsonSchema and fromJSON", function() {
				class BadEvent1 {
					static type = "event";
					static src = "controller";
					static dst = "control";
					static jsonSchema = {};
				}
				assert.throws(
					() => libLink.Link.register(BadEvent1),
					new Error("Event BadEvent1 has static jsonSchema but is missing static fromJSON")
				);
				class BadEvent2 {
					static type = "event";
					static src = "controller";
					static dst = "control";
					static fromJSON() {};
				}
				assert.throws(
					() => libLink.Link.register(BadEvent2),
					new Error("Event BadEvent2 has static fromJSON but is missing static jsonSchema")
				);
			});
		});

		describe("._processMessage()", function() {
			it("should throw on unhandled type", function() {
				assert.throws(
					() => testLink._processMessage({ type: "invalid" }),
					{ message: "Unhandled message type invalid" }
				);
			});
			it("should throw on Event failing validation", function() {
				class StringEvent {
					static type = "event";
					static src = "controller";
					static dst = "control";
					constructor(value) { this.value = value; }
					static jsonSchema = { type: "string" };
					static fromJSON(json) { return new this(json); };
				}
				libLink.Link.register(StringEvent);
				testLink.handle(StringEvent, () => {});
				assert.throws(
					() => testLink._processMessage(new libData.MessageEvent(1, dst, src, "StringEvent", 99)),
					{ message: "Event StringEvent failed validation" }
				);
			});
		});

		describe(".snoopEvent()", function() {
			it("should snoop an event", function() {
				let handled = false;
				testLink.snoopEvent(SimpleEvent, async () => { handled = true; });
				assert(testLink._eventSnoopers.has(SimpleEvent), "event was not snooped");
				testConnector.emit("message", new libData.MessageEvent(1, dst, src, "SimpleEvent"));
				assert(handled, "event was not handled");
			});
			it("should log errors from snoop handler", function() {
				testLink.snoopEvent(SimpleEvent, async () => { throwSimple("Error"); });
				testConnector.emit("message", new libData.MessageEvent(1, dst, src, "SimpleEvent"));
			});
			it("should throw on double registration", function() {
				testLink.snoopEvent(SimpleEvent);
				assert.throws(
					() => testLink.snoopEvent(SimpleEvent),
					new Error("Event SimpleEvent is already snooped")
				);
			});
		});
	});
});
