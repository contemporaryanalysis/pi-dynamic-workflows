import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getWorkflowDirectories,
  listSavedWorkflows,
  loadSavedWorkflow,
  saveWorkflow,
  validateWorkflowName,
} from "../src/workflow-store.js";

const SCRIPT = `export const meta = {
  name: 'shared_review',
  description: 'Review a repository'
}
phase('Review')
return { result: await agent('Review the repository', { label: 'repo review' }) }
`;

test("validateWorkflowName rejects traversal and spaces", () => {
  assert.equal(validateWorkflowName("shared-review_2"), "shared-review_2");
  assert.throws(() => validateWorkflowName("../escape"), /only letters/);
  assert.throws(() => validateWorkflowName("two names"), /only letters/);
});

test("project workflows are saved at the git root and can be loaded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-store-"));
  const nested = path.join(root, "packages", "app");
  await mkdir(path.join(root, ".git"));
  await mkdir(nested, { recursive: true });

  try {
    const directories = await getWorkflowDirectories(nested);
    assert.equal(directories.project, path.join(root, ".pi", "workflows"));

    const saved = await saveWorkflow(nested, "shared-review", SCRIPT, "project");
    assert.equal(saved.path, path.join(root, ".pi", "workflows", "shared-review.js"));
    assert.equal(await readFile(saved.path, "utf8"), `${SCRIPT.trim()}\n`);

    const listed = await listSavedWorkflows(nested);
    assert.ok(listed.some((workflow) => workflow.name === "shared-review" && workflow.scope === "project"));

    const loaded = await loadSavedWorkflow(nested, "shared-review");
    assert.equal(loaded.script, `${SCRIPT.trim()}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveWorkflow rejects invalid workflow JavaScript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workflow-store-invalid-"));
  await mkdir(path.join(root, ".git"));
  try {
    await assert.rejects(() => saveWorkflow(root, "broken", "return { ok: true }", "project"), /export const meta/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
