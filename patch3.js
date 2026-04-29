const fs = require("fs");
let file = fs.readFileSync("tests/unit/reasoning-cache.test.ts", "utf8");

file = file.replace(
  /describe\("Reasoning Replay Cache — API Route", \(\) => \{[\s\S]*?(?=  it\("should return stats)/m,
  `describe("Reasoning Replay Cache — API Route", () => {
  let originalInitialPassword;
  let originalRequireLogin;

  before(async () => {
    clearReasoningCacheAll();
    originalInitialPassword = process.env.INITIAL_PASSWORD;
    originalRequireLogin = process.env.REQUIRE_LOGIN;
    process.env.INITIAL_PASSWORD = "";
    process.env.REQUIRE_LOGIN = "false";
    
    try {
      const { getDbInstance } = await import("../../src/lib/db/core.ts");
      getDbInstance().prepare(
        "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'requireLogin', 'false')"
      ).run();
      getDbInstance().prepare(
        "DELETE FROM key_value WHERE namespace = 'settings' AND key = 'password'"
      ).run();
    } catch (e) {}
  });

  after(async () => {
    clearReasoningCacheAll();
    process.env.INITIAL_PASSWORD = originalInitialPassword;
    process.env.REQUIRE_LOGIN = originalRequireLogin;
    try {
      const { getDbInstance } = await import("../../src/lib/db/core.ts");
      getDbInstance().prepare(
        "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'requireLogin', 'true')"
      ).run();
    } catch (e) {}
  });\n\n`
);

file = file.replace(/, \{ headers: \{ Authorization: "Bearer test-admin-key" \} \}/g, "");

fs.writeFileSync("tests/unit/reasoning-cache.test.ts", file);
