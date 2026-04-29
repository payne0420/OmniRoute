const fs = require("fs");
let file = fs.readFileSync("tests/unit/reasoning-cache.test.ts", "utf8");

// Insert import for updateSettings
if (!file.includes("updateSettings")) {
  file = file.replace(
    "import { getDbInstance }",
    'import { getDbInstance } from "../../src/lib/db/core.ts";\nimport { updateSettings, getSettings } from "../../src/lib/db/settings.ts";\n// import { getDbInstance }'
  );
}

// Add DB update logic
file = file.replace(
  'process.env.REQUIRE_LOGIN = "false";',
  'process.env.REQUIRE_LOGIN = "false";\n    await updateSettings({ requireLogin: false });'
);

// We need to make `before()` async
file = file.replace("  before(() => {", "  before(async () => {");

fs.writeFileSync("tests/unit/reasoning-cache.test.ts", file);
