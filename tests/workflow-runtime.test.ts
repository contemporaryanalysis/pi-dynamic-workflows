import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const fakeAgent = {
  async run(prompt: string): Promise<string> {
    return `result:${prompt}`;
  },
};

test("runWorkflow accepts metadata without phases and records runtime phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.deepEqual(result.phases, ["Scan"]);
  assert.equal(result.agentCount, 1);
  assert.equal((result.result as { scan: string }).scan, "result:scan");
});

test("runWorkflow records loop-created phases without skipped conditional phases", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'loop_demo',
  description: 'Create phases from work items',
  phases: [{ title: 'Review' }]
}

if (args.needsReview) {
  phase('Review')
  await agent('review', { label: 'review' })
}

for (const area of args.areas) {
  phase('Inspect ' + area)
  await agent('inspect ' + area, { label: 'inspect ' + area })
}

return { ok: true }
`,
    {
      args: { needsReview: false, areas: ["API", "UI"] },
      agent: fakeAgent,
    },
  );

  assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow rejects unawaited nested agent promises before returning details", async () => {
  let ended = 0;

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'promise_leak',
  description: 'Return an unawaited agent promise'
}

phase('Leak promise')
const scan = agent('scan', { label: 'scan' })
return { scan }
`,
        {
          agent: fakeAgent,
          onAgentEnd() {
            ended++;
          },
        },
      ),
    /workflow result must be structured-cloneable; did you forget to await agent\(\), parallel\(\), or pipeline\(\)\?.*Promise.*cloned/,
  );

  assert.equal(ended, 1);
});

test("runWorkflow rejects non-string runtime phase titles", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bad_phase',
  description: 'Use a non-string phase title'
}

phase(Promise.resolve('Scan'))
return { ok: true }
`,
        { agent: fakeAgent },
      ),
    /phase title must be a string/,
  );
});

test("runWorkflow allows prompts that mention nondeterministic API names", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'prompt_mentions',
  description: 'Ask about Date.now(), Math.random(), and new Date() usage'
}

phase('Catalog mentions')
const scan = await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })
return { scan }
`,
    { agent: fakeAgent },
  );

  assert.equal(
    (result.result as { scan: string }).scan,
    "result:Catalog Date.now(), Math.random(), and new Date() usage",
  );
});

test("runWorkflow enforces the lifetime agent limit", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = {
  name: 'bounded',
  description: 'Do not exceed the configured lifetime limit'
}
await agent('one')
await agent('two')
return { ok: true }
`,
        { agent: fakeAgent, maxAgents: 1 },
      ),
    /workflow agent limit exceeded \(1\)/,
  );
});

test("runWorkflow rejects pretend worktree isolation", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'isolation', description: 'Do not simulate isolation' }
return { value: await agent('edit safely', { isolation: 'worktree' }) }
`,
        { agent: fakeAgent },
      ),
    /agent isolation is not implemented/,
  );
});

test("runWorkflow records provider-reported nested usage", async () => {
  const usageAgent = {
    async run(_prompt: string, options: any): Promise<string> {
      options.onUsage?.({
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 20,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
      });
      return "done";
    },
  };
  const result = await runWorkflow(
    `export const meta = { name: 'usage', description: 'Track usage' }
return { value: await agent('measure') }
`,
    { agent: usageAgent },
  );

  assert.equal(result.usage.totalTokens, 20);
  assert.equal(result.usage.cost.total, 0.33);
});

test("runWorkflow aborts and drains outstanding agents when the script fails", async () => {
  let aborted = false;
  const blockingAgent = {
    run(_prompt: string, options: any): Promise<string> {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'cleanup', description: 'Abort pending work' }
agent('keep running')
throw new Error('script failed')
`,
        { agent: blockingAgent },
      ),
    /script failed/,
  );
  assert.equal(aborted, true);
});
