// Non-destructive, GET-only staged API evidence capture; does not log in for you.
// Needs explicit PDM_TEST_SCOPE=isolated-dev and PDM_UI_BASE_URL=http://127.0.0.1:<port>
// plus PDM_TEST_DEVICE_ID + PDM_BEARER. Never target production or unknown hosts.
import assert from "node:assert/strict";
const {PDM_UI_BASE_URL, PDM_TEST_DEVICE_ID, PDM_BEARER, PDM_TEST_SCOPE} = process.env;
assert.equal(PDM_TEST_SCOPE, "isolated-dev", "Only explicit isolated-dev is permitted");
const url = new URL(PDM_UI_BASE_URL || "");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Refusing remote/prod host");
assert.match(PDM_TEST_DEVICE_ID || "", /^[a-f0-9-]{36}$/i, "Missing isolated test device");
assert.ok((PDM_BEARER || "").length > 32, "Missing test JWT");
const headers = {Authorization: "Bearer " + PDM_BEARER};
const path = new URL("/api/pdm/p3/shadow?deviceId=" + PDM_TEST_DEVICE_ID, url);
const res = await fetch(path, {method: "GET", headers, signal: AbortSignal.timeout(8000)});
let outcome;
try { outcome = await res.json(); } catch { outcome = {}; }
const state = outcome?.data?.state;
assert.ok([200,401,403,404,503].includes(res.status), "Unexpected API status");
if(res.status===200) {
  assert.ok(["Unverified","StatisticsOnly","HistoricalStatisticsOnly"].includes(state),
      "No invented model prediction state accepted");
  assert.equal(outcome?.data?.isWorkOrderCreated ?? false,false);
  assert.equal(outcome?.data?.failureProbability ?? null,null);
}
console.log(JSON.stringify({scope:"isolated-dev",method:"GET",path:path.pathname,status:res.status,
  shadowState:state??null,productionValidated:false,realBrowserScreenshot:false},null,2));

