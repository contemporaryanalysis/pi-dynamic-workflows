import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parseWorkflowScript } from "./workflow.js";

export type WorkflowScope = "project" | "user";

export interface SavedWorkflow {
  name: string;
  path: string;
  scope: WorkflowScope;
  script: string;
}

const WORKFLOW_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateWorkflowName(name: string): string {
  const normalized = name.trim();
  if (!WORKFLOW_NAME.test(normalized)) {
    throw new Error("workflow name must contain only letters, numbers, underscores, and hyphens");
  }
  return normalized;
}

export async function getWorkflowDirectories(cwd: string): Promise<Record<WorkflowScope, string>> {
  const projectRoot = await findProjectRoot(cwd);
  return {
    project: path.join(projectRoot, CONFIG_DIR_NAME, "workflows"),
    user: path.join(getAgentDir(), "workflows"),
  };
}

export async function listSavedWorkflows(
  cwd: string,
  options: { includeProject?: boolean } = {},
): Promise<SavedWorkflow[]> {
  const directories = await getWorkflowDirectories(cwd);
  const workflows = new Map<string, SavedWorkflow>();
  const scopes: WorkflowScope[] = options.includeProject === false ? ["user"] : ["user", "project"];

  for (const scope of scopes) {
    for (const workflow of await loadDirectory(directories[scope], scope)) {
      workflows.set(workflow.name, workflow);
    }
  }

  return [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSavedWorkflow(
  cwd: string,
  name: string,
  options: { includeProject?: boolean } = {},
): Promise<SavedWorkflow> {
  const normalized = validateWorkflowName(name);
  const workflows = await listSavedWorkflows(cwd, options);
  const workflow = workflows.find((item) => item.name === normalized);
  if (!workflow) throw new Error(`saved workflow not found: ${normalized}`);
  return workflow;
}

export async function saveWorkflow(
  cwd: string,
  name: string,
  script: string,
  scope: WorkflowScope,
): Promise<SavedWorkflow> {
  const normalized = validateWorkflowName(name);
  parseWorkflowScript(script);
  const directories = await getWorkflowDirectories(cwd);
  const directory = directories[scope];
  const filePath = path.join(directory, `${normalized}.js`);

  await withFileMutationQueue(filePath, async () => {
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.${normalized}.${process.pid}.tmp`);
    await writeFile(temporaryPath, `${script.trim()}\n`, {
      encoding: "utf8",
      mode: scope === "user" ? 0o600 : 0o644,
    });
    await rename(temporaryPath, filePath);
  });

  return { name: normalized, path: filePath, scope, script: `${script.trim()}\n` };
}

async function loadDirectory(directory: string, scope: WorkflowScope): Promise<SavedWorkflow[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const workflows: SavedWorkflow[] = [];
  for (const entry of entries) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".js")) continue;
    const name = entry.name.slice(0, -3);
    if (!WORKFLOW_NAME.test(name)) continue;
    const filePath = path.join(directory, entry.name);
    const script = await readFile(filePath, "utf8");
    try {
      parseWorkflowScript(script);
    } catch {
      continue;
    }
    workflows.push({ name, path: filePath, scope, script });
  }
  return workflows;
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd);
  let gitRoot: string | undefined;

  while (true) {
    if (await exists(path.join(current, CONFIG_DIR_NAME))) return current;
    if (!gitRoot && (await exists(path.join(current, ".git")))) gitRoot = current;
    const parent = path.dirname(current);
    if (parent === current) return gitRoot ?? path.resolve(cwd);
    current = parent;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
