import { runNpmSkillInstall } from "./install-skill-mode.js";

runNpmSkillInstall().catch(() => {
  process.exitCode = 1;
});
