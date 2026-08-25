import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createWorkflowTool } from "../src/index.js";
import { parseWorkflowScript, type WorkflowMeta } from "../src/workflow.js";
import { listSavedWorkflows, loadSavedWorkflow, saveWorkflow, type WorkflowScope } from "../src/workflow-store.js";

const WORKFLOW_TEMPLATE = `export const meta = {
  name: 'my_workflow',
  description: 'Describe what this workflow does'
}

phase('Work')
const result = await agent('Describe the delegated task.', {
  label: 'primary task'
})

return { ok: result !== null, result }
`;

export default function extension(pi: ExtensionAPI) {
  let lastScript: string | undefined;
  let knownWorkflowNames: string[] = [];

  pi.registerFlag("workflow-write-tools", {
    description: "Allow workflow subagents to edit files and run shell commands (default: read-only)",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("workflow-auto-approve", {
    description:
      "Run generated workflow scripts without interactive review (unsafe; required for non-interactive mode)",
    type: "boolean",
    default: false,
  });

  const workflowTool = createWorkflowTool({
    allowWrites: () => Boolean(pi.getFlag("workflow-write-tools")),
    autoApprove: () => Boolean(pi.getFlag("workflow-auto-approve")),
    maxAgents: 100,
    onScriptPrepared(script) {
      lastScript = script;
    },
  });
  pi.registerTool(workflowTool);

  pi.registerCommand("workflow-save", {
    description: "Save the latest or an edited workflow for reuse: /workflow-save [name] [--user|--project]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflow-save requires an interactive session", "error");
        return;
      }

      let parsedArgs: ReturnType<typeof parseSaveArgs>;
      try {
        parsedArgs = parseSaveArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const scope = parsedArgs.scope ?? "project";
      if (scope === "project" && !ctx.isProjectTrusted()) {
        ctx.ui.notify("Project workflows require a trusted project", "error");
        return;
      }

      const script = await ctx.ui.editor("Save workflow JavaScript", lastScript ?? WORKFLOW_TEMPLATE);
      if (script === undefined) return;

      let meta: WorkflowMeta;
      try {
        meta = parseWorkflowScript(script).meta;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const name = parsedArgs.name ?? meta.name;
      try {
        const saved = await saveWorkflow(ctx.cwd, name, script, scope);
        lastScript = saved.script;
        await refreshKnownNames(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(`Saved ${saved.scope} workflow: ${saved.name}\n${saved.path}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflow-run", {
    description: "Run a saved workflow: /workflow-run <name> [JSON args]",
    getArgumentCompletions: workflowCompletions,
    handler: async (args, ctx) => {
      let parsedArgs: ReturnType<typeof parseRunArgs>;
      try {
        parsedArgs = parseRunArgs(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!parsedArgs.name) {
        ctx.ui.notify("Usage: /workflow-run <name> [JSON args]", "error");
        return;
      }

      try {
        const workflow = await loadSavedWorkflow(ctx.cwd, parsedArgs.name, {
          includeProject: ctx.isProjectTrusted(),
        });
        lastScript = workflow.script;
        const argsInstruction =
          parsedArgs.args === undefined
            ? "Do not pass an args value."
            : `Pass this exact JSON value as the workflow tool args parameter: ${JSON.stringify(parsedArgs.args)}`;
        pi.sendUserMessage(
          [
            `Run the saved ${workflow.scope} workflow named ${workflow.name}.`,
            "Call the workflow tool with the exact JavaScript below. Do not rewrite, summarize, or repair it.",
            argsInstruction,
            "",
            workflow.script,
          ].join("\n"),
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("workflows", {
    description: "List saved user and project workflows",
    handler: async (_args, ctx) => {
      try {
        const workflows = await listSavedWorkflows(ctx.cwd, {
          includeProject: ctx.isProjectTrusted(),
        });
        if (workflows.length === 0) {
          ctx.ui.notify("No saved workflows", "info");
          return;
        }

        if (!ctx.hasUI) {
          ctx.ui.notify(workflows.map((item) => `${item.name} (${item.scope})`).join("\n"), "info");
          return;
        }

        const choices = workflows.map((item) => `${item.name} (${item.scope})`);
        const selected = await ctx.ui.select("Saved workflows — select to prepare a run", choices);
        if (!selected) return;
        const selectedIndex = choices.indexOf(selected);
        const workflow = workflows[selectedIndex];
        if (workflow) ctx.ui.setEditorText(`/workflow-run ${workflow.name}`);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    await refreshKnownNames(ctx.cwd, ctx.isProjectTrusted());
  });

  function workflowCompletions(prefix: string): AutocompleteItem[] | null {
    if (prefix.includes(" ")) return null;
    const matches = knownWorkflowNames
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ value: name, label: name }));
    return matches.length > 0 ? matches : null;
  }

  async function refreshKnownNames(cwd: string, includeProject: boolean): Promise<void> {
    try {
      knownWorkflowNames = (await listSavedWorkflows(cwd, { includeProject })).map((item) => item.name);
    } catch {
      knownWorkflowNames = [];
    }
  }
}

function parseSaveArgs(raw: string): { name?: string; scope?: WorkflowScope } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const hasUser = parts.includes("--user");
  const hasProject = parts.includes("--project");
  if (hasUser && hasProject) throw new Error("choose only one of --user or --project");
  const names = parts.filter((part) => part !== "--user" && part !== "--project");
  if (names.length > 1) throw new Error("workflow names cannot contain spaces");
  return {
    name: names[0],
    scope: hasUser ? "user" : hasProject ? "project" : undefined,
  };
}

function parseRunArgs(raw: string): { name?: string; args?: unknown } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const separator = trimmed.search(/\s/);
  if (separator === -1) return { name: trimmed };
  const name = trimmed.slice(0, separator);
  const json = trimmed.slice(separator).trim();
  try {
    return { name, args: JSON.parse(json) };
  } catch (error) {
    throw new Error(`workflow args must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
