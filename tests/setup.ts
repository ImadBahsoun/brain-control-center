// Runs before every test file: HOME is redirected to a fresh temp dir, so `os.homedir()` (and with it
// every Brain root) can never point at the real ~/.claude store.
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bcc-home-")));
process.env.HOME = home;
if (os.homedir() !== home) {
  throw new Error("test setup: HOME override did not take effect");
}
