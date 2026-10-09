import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedBridgeRequest } from "../lib/pool.js";

test("Issue #22 (Desktop support): requests with absent Origin header", async (t) => {
  await t.test("POST with undefined Origin on loopback peer and loopback Host is trusted", () => {
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:3000" },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), true);
  });

  await t.test("PUT with undefined Origin on IPv6 loopback is trusted", () => {
    const req = {
      method: "PUT",
      headers: { host: "[::1]:3000" },
      socket: { remoteAddress: "::1" }
    };
    assert.equal(isTrustedBridgeRequest(req), true);
  });

  await t.test("DELETE with undefined Origin on localhost Host is trusted", () => {
    const req = {
      method: "DELETE",
      headers: { host: "localhost:8080" },
      socket: { remoteAddress: "::ffff:127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), true);
  });

  await t.test("POST with undefined Origin from non-loopback remote address is rejected (403)", () => {
    const req = {
      method: "POST",
      headers: { host: "127.0.0.1:3000" },
      socket: { remoteAddress: "192.168.1.50" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });

  await t.test("POST with undefined Origin but missing Host header is rejected (403)", () => {
    const req = {
      method: "POST",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });

  await t.test("POST with undefined Origin but non-loopback Host (DNS rebinding) is rejected (403)", () => {
    const req = {
      method: "POST",
      headers: { host: "evil.attacker.com:3000" },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });

  await t.test("POST with sec-fetch-site: cross-site is rejected even if Origin is undefined", () => {
    const req = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        "sec-fetch-site": "cross-site"
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });
});

test("Issue #22 (Desktop support): requests with dsh-app://app Origin", async (t) => {
  await t.test("POST with origin dsh-app://app is trusted on loopback", () => {
    const req = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "dsh-app://app"
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), true);
  });

  await t.test("POST with origin dsh-app://evil is rejected", () => {
    const req = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "dsh-app://evil"
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });

  await t.test("POST with explicit empty string origin is rejected", () => {
    const req = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: ""
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });

  await t.test("POST with null origin (sandboxed iframe) is rejected", () => {
    const req = {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "null"
      },
      socket: { remoteAddress: "127.0.0.1" }
    };
    assert.equal(isTrustedBridgeRequest(req), false);
  });
});
