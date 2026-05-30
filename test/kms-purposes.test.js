import test from "node:test";
import assert from "node:assert/strict";
import { KMS_PURPOSES, getKmsAlias, listKmsPurposeMappings } from "../src/kms-purposes.js";

test("builds purpose-specific KMS aliases", () => {
  assert.equal(getKmsAlias("stage", KMS_PURPOSES.SESSION_SECRETS), "alias/ai-assist-stage-session-secrets-key");
});

test("keeps optional persistent user secrets out when requested", () => {
  const purposes = listKmsPurposeMappings({ includeOptional: false }).map((item) => item.purpose);

  assert.equal(purposes.includes(KMS_PURPOSES.USER_SECRETS), false);
  assert.equal(purposes.includes(KMS_PURPOSES.OAUTH_TOKENS), true);
});

test("rejects unknown KMS purposes", () => {
  assert.throws(() => getKmsAlias("dev", "raw-content"), /unknown KMS purpose/);
});
