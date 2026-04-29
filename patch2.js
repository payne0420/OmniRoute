const fs = require("fs");
let file = fs.readFileSync("tests/unit/reasoning-cache.test.ts", "utf8");

// Replace the before/after blocks
file = file.replace(
  /describe\("Reasoning Replay Cache — API Route", \(\) => {[\s\S]*?(?=  it\("should return stats)/m,
  `describe("Reasoning Replay Cache — API Route", () => {
  before(() => {
    clearReasoningCacheAll();
    try {
      getDbInstance().prepare(
        "INSERT OR IGNORE INTO api_keys (key, name, role, is_active) VALUES ('test-admin-key', 'test', 'admin', 1)"
      ).run();
    } catch (e) {}
  });

  after(() => {
    clearReasoningCacheAll();
    try {
      getDbInstance().prepare("DELETE FROM api_keys WHERE key = 'test-admin-key'").run();
    } catch (e) {}
  });\n\n`
);

// Add Headers
file = file.replace(
  /new Request\("http:\/\/localhost\/api\/cache\/reasoning\?provider=deepseek"\)/g,
  'new Request("http://localhost/api/cache/reasoning?provider=deepseek", { headers: { Authorization: "Bearer test-admin-key" } })'
);
file = file.replace(
  /new Request\("http:\/\/localhost\/api\/cache\/reasoning\?toolCallId=call_api_delete_1"\)/g,
  'new Request("http://localhost/api/cache/reasoning?toolCallId=call_api_delete_1", { headers: { Authorization: "Bearer test-admin-key" } })'
);

fs.writeFileSync("tests/unit/reasoning-cache.test.ts", file);
