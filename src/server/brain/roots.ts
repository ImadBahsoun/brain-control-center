import "server-only";
import os from "node:os";
import path from "node:path";

/**
 * The only module that knows where the Brain keeps its files. Paths derive from the home directory,
 * exactly as brain-state does from HOME. There is no env var, query or config override.
 */
export interface BrainRoots {
  claudeDir: string;
  brainStateDir: string;
  tasksDir: string;
  governorDir: string;
  governorFile: "governor.json";
  gateDir: string;
  gateStateFile: "state.json";
  gateAuditFile: "audit.jsonl";
  projectsDir: string;
}

export function rootsFromHome(home: string): BrainRoots {
  const claudeDir = path.join(home, ".claude");
  const brainStateDir = path.join(claudeDir, "state", "brain");
  return {
    claudeDir,
    brainStateDir,
    tasksDir: path.join(brainStateDir, "tasks"),
    governorDir: path.join(claudeDir, "brain"),
    governorFile: "governor.json",
    gateDir: path.join(claudeDir, "state", "brain-gate"),
    gateStateFile: "state.json",
    gateAuditFile: "audit.jsonl",
    projectsDir: path.join(claudeDir, "projects"),
  };
}

export function brainRoots(): BrainRoots {
  return rootsFromHome(os.homedir());
}
