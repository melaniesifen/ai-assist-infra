import test from "node:test";
import assert from "node:assert/strict";
import { findServiceRoute, groupRoutesByService, listServiceRoutes, SERVICES } from "../src/service-routes.js";

test("includes MVP SSE route under the session events service", () => {
  const route = findServiceRoute("GET", "/resource-sessions/{sessionId}/events");

  assert.equal(route.service, SERVICES.SESSION_EVENTS);
  assert.equal(route.rateLimitTier, "STREAM");
  assert.equal(route.requiresAuthentication, true);
});

test("returns defensive route copies", () => {
  const routes = listServiceRoutes();
  routes[0].service = "changed";

  assert.notEqual(listServiceRoutes()[0].service, "changed");
});

test("groups routes by owning service", () => {
  const groups = groupRoutesByService();

  assert.ok(groups[SERVICES.ORCHESTRATION].some((route) => route.path.includes("/commands")));
  assert.ok(groups[SERVICES.AUTH].some((route) => route.path === "/auth/google/start"));
});
