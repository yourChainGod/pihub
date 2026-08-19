"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const { createJiti } = require("jiti");

module.exports = createJiti(__filename, { interopDefault: true })("../lib/default-extensions.ts");
