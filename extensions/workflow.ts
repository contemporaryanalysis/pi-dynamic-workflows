import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowTool } from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
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
  });
  pi.registerTool(workflowTool);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
  });
}
