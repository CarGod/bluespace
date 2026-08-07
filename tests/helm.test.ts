/**
 * Helm's tool surface.
 *
 * Two claims are under test. The first is structural: `helmTools()` returns
 * plain `ToolDef`s — name, prescriptive description, JSON Schema, text handler —
 * with no vendor type anywhere in sight, because that is the whole reason the
 * adapter boundary exists. The second is behavioural: each tool is a thin
 * wrapper that hits the orchestrator (or the registry) and formats what comes
 * back. If a tool ever grows logic of its own, these tests are where it shows.
 *
 * The orchestrator and the registry are stubs at the seam the tools already
 * use: their public methods. Nothing here needs a Blackbox or a worktree.
 */

import { describe, expect, it } from 'vitest';

import type { ToolDef } from '../src/adapters/types.js';
import { HELM_TOOL_NAMES, helmTools } from '../src/agents/helm/index.js';
import type { Blackbox } from '../src/blackbox/index.js';
import type { ProjectRegistry } from '../src/config/index.js';
import type { Orchestrator } from '../src/orchestrator/index.js';
import { addTokenUsage, noTokenUsage } from '../src/types/domain.js';
import type { Decision, Project, Task } from '../src/types/domain.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'uploader',
    path: '/repos/uploader',
    description: 'the upload service',
    delivery: 'local',
    addedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'mission',
    projectId: 'proj-1',
    title: 'Add retry to the uploader',
    brief: 'Retry failed uploads three times with backoff.',
    state: 'working',
    dependsOn: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    tokens: addTokenUsage(noTokenUsage(), 'claude-opus-5', {
      input: 1000,
      output: 200,
      cacheRead: 12_000,
      cacheCreation: 800,
    }),
    metered: false,
    listPriceUsd: 0.123_456,
    reworkCount: 1,
    ...over,
  };
}

function makeDecision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    taskId: 'task-1',
    question: 'Retry on 5xx only, or on every failure?',
    options: [
      { id: 'a', label: '5xx only' },
      { id: 'b', label: 'every failure', detail: 'includes timeouts' },
    ],
    context: 'the uploader sees both',
    openedAt: 1_700_000_000_000,
    ...over,
  };
}

interface Calls {
  created: unknown[];
  resolved: Array<[string, string]>;
  steered: Array<[string, string]>;
  cancelled: string[];
  /** Project ids handed to registry.remove — pure metadata, and nothing else. */
  removed: string[];
}

function wire(
  opts: {
    projects?: Project[];
    tasks?: Task[];
    decisions?: Decision[];
    onCancel?: (id: string) => void;
    steerError?: Error;
  } = {},
): { tools: Map<string, ToolDef>; list: ToolDef[]; calls: Calls } {
  const projects = opts.projects ?? [makeProject()];
  const tasks = opts.tasks ?? [makeTask()];
  const decisions = opts.decisions ?? [makeDecision()];

  const calls: Calls = { created: [], resolved: [], steered: [], cancelled: [], removed: [] };

  const registry = {
    list: () => projects,
    get: (id: string) => projects.find((p) => p.id === id),
    remove: (id: string) => {
      calls.removed.push(id);
    },
    resolveScored: (hint: string) =>
      projects
        .filter((p) => p.name.includes(hint) || p.description.includes(hint))
        .map((project) => ({ project, score: 42 })),
  } as unknown as ProjectRegistry;

  // Delivery needs a log and a git manager. This suite is deliberately stub-only
  // — the tools that actually touch a repository are exercised against real git
  // in tests/land.test.ts — so an empty log means no delivery lookup ever runs,
  // and a manager that throws proves it.
  const blackbox = {
    read: () => [],
    append: (body: unknown) => body,
  } as unknown as Blackbox;

  const orch = {
    tasks: () => tasks,
    task: (id: string) => tasks.find((t) => t.id === id),
    openDecisions: () => decisions,
    createTask: (input: unknown) => {
      calls.created.push(input);
      const typed = input as { title: string; projectId: string };
      return makeTask({ id: 'task-new', state: 'queued', ...typed });
    },
    resolveDecision: async (id: string, answer: string) => {
      calls.resolved.push([id, answer]);
    },
    steer: async (id: string, message: string) => {
      if (opts.steerError) throw opts.steerError;
      calls.steered.push([id, message]);
    },
    cancelTask: async (id: string) => {
      calls.cancelled.push(id);
      opts.onCancel?.(id);
    },
  } as unknown as Orchestrator;

  const list = helmTools(orch, registry, {
    blackbox,
    worktreeFor: () => {
      throw new Error('this suite never reaches a repository');
    },
  });
  return { tools: new Map(list.map((t) => [t.name, t])), list, calls };
}

function tool(name: string): ToolDef {
  const found = wire().tools.get(name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

async function callJson(t: ToolDef, input: Record<string, unknown> = {}): Promise<any> {
  return JSON.parse(await t.handler(input));
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('helmTools — shape', () => {
  const { list } = wire();

  it('returns the levers Helm has on the fleet', () => {
    expect(list.map((t) => t.name)).toEqual([
      'list_projects',
      'resolve_project',
      'create_task',
      'list_tasks',
      'get_task',
      'open_decisions',
      'answer_decision',
      'steer_task',
      'cancel_task',
      'land_task',
      'delivery_status',
      'add_project',
      'add_projects',
      'describe_project',
      'remove_project',
    ]);
  });

  /**
   * The launcher pre-approves these tools by name so a first-run window opens on
   * a report rather than a permission dialog (`HELM_ALLOWED_TOOLS`). It has no
   * orchestrator, so it cannot build a tool surface and read the names off — it
   * reads `HELM_TOOL_NAMES`. A tool added here and forgotten there would prompt
   * on first use, months later, in front of whoever called it first.
   */
  it('agrees with the name list the launcher pre-approves', () => {
    expect(list.map((t) => t.name)).toEqual([...HELM_TOOL_NAMES]);
  });

  /**
   * `land_task` is the first tool in BlueSpace that writes to the captain's
   * repository, and the only thing standing between Helm and a wrong merge is
   * what this description says. It has to carry all three: what it does, what it
   * refuses, and that main is never written to.
   */
  it('says in land_task’s own description that it never touches the default branch', () => {
    const land = list.find((t) => t.name === 'land_task');
    expect(land?.description).toMatch(/never touches the default branch/i);
    expect(land?.description).toMatch(/main is reached only through a pull request/i);
    expect(land?.description).toMatch(/REFUSES/);
    expect(land?.description).toMatch(/recon/);
    expect(land?.description).toMatch(/conflict/i);
    // Only on the captain's word — the one trigger clause that matters here.
    expect(land?.description).toMatch(/ONLY when the captain has said to land it/);
  });

  /**
   * The captain's own framing: *"加入移除都是链接的形式，并不会真正删除这些本地的
   * 项目."* Helm can only tell him that truthfully if the tool says so.
   */
  it('says plainly that registering and unregistering never touch the repository', () => {
    const add = list.find((t) => t.name === 'add_project');
    const remove = list.find((t) => t.name === 'remove_project');
    expect(add?.description).toMatch(/does not copy, move, clone, modify or delete/i);
    expect(add?.description).toMatch(/in place/i);
    expect(remove?.description).toMatch(/DELETES NOTHING/);
    expect(remove?.description).toMatch(/left exactly as they are/i);
  });

  /**
   * Two tools that do the same thing differ only by their trigger clauses, and a
   * model picks by those. The measured failure is the loop: eight `add_project`
   * calls for one "add everything in this folder", ninety seconds of waiting.
   */
  it('points the single-repo tool at the bulk one, and the bulk one away from descriptions', () => {
    const one = list.find((t) => t.name === 'add_project');
    const many = list.find((t) => t.name === 'add_projects');

    expect(one?.description).toMatch(/add_projects/);
    expect(one?.description).toMatch(/never call this one in a loop/i);

    expect(many?.description).toMatch(/more than one repository/i);
    expect(many?.description).toMatch(/DESCRIPTIONS ARE NOT REQUIRED/);
    // The scan's one real limit, stated where the model reads it: a deep walk
    // would register vendored checkouts nobody asked to manage.
    expect(many?.description).toMatch(/does not recurse/i);
  });

  /**
   * A task marked cancelled while its Crew keeps working is the one failure the
   * captain cannot see from the outside, so the refusal has to be in the
   * description — a model that retries or reports success has already lost it.
   */
  it('warns that cancel_task refuses a Crew held by another process', () => {
    const cancel = list.find((t) => t.name === 'cancel_task');
    expect(cancel?.description).toMatch(/REFUSES/);
    expect(cancel?.description).toMatch(/different process/i);
    expect(cancel?.description).toMatch(/changing nothing/i);
  });

  it('describes every tool prescriptively — what it does AND when to call it', () => {
    for (const t of list) {
      expect(t.description.length).toBeGreaterThan(80);
      // "Call this …" is the trigger clause; a description without one is the
      // kind that gets a tool picked at the wrong moment.
      expect(t.description).toMatch(/Call (this|it)/);
    }
  });

  it('describes its input as a JSON Schema object the transport can serve verbatim', () => {
    for (const t of list) {
      expect(t.inputSchema['type']).toBe('object');
      expect(t.inputSchema['properties']).toBeTypeOf('object');
      // The MCP server puts this object on the wire untranslated, so the only
      // thing it has to survive is JSON.stringify — a cycle or a function here
      // would take the whole `tools/list` frame down rather than one tool.
      expect(() => JSON.stringify(t.inputSchema)).not.toThrow();
      for (const [field, raw] of Object.entries(
        t.inputSchema['properties'] as Record<string, Record<string, unknown>>,
      )) {
        expect(raw['description'], `${t.name}.${field}`).toBeTypeOf('string');
      }
    }
  });

  it('marks exactly the arguments a tool cannot work without as required', () => {
    const required = (name: string): string[] =>
      ((wire().tools.get(name)?.inputSchema['required'] as string[] | undefined) ?? []).sort();

    expect(required('list_projects')).toEqual([]);
    expect(required('open_decisions')).toEqual([]);
    expect(required('list_tasks')).toEqual([]); // the state filter is optional
    expect(required('resolve_project')).toEqual(['hint']);
    expect(required('create_task')).toEqual(['brief', 'kind', 'projectId', 'title']);
    expect(required('get_task')).toEqual(['taskId']);
    expect(required('answer_decision')).toEqual(['answer', 'decisionId']);
    expect(required('steer_task')).toEqual(['message', 'taskId']);
    expect(required('cancel_task')).toEqual(['taskId']);
    expect(required('land_task')).toEqual(['taskId']);
    expect(required('delivery_status')).toEqual([]); // every project by default
    expect(required('add_project')).toEqual(['path']);
    // Neither paths nor scan is required on its own — either will do, and the
    // handler refuses when both are absent with a message naming both.
    expect(required('add_projects')).toEqual([]);
    expect(required('describe_project')).toEqual(['description', 'projectId']);
    expect(required('remove_project')).toEqual(['projectId']);
  });

  it('offers the closed sets as enums so the model cannot invent a value', () => {
    const kind = (tool('create_task').inputSchema['properties'] as Record<string, Record<string, unknown>>)[
      'kind'
    ];
    expect(kind?.['enum']).toEqual(['mission', 'recon']);

    const state = (tool('list_tasks').inputSchema['properties'] as Record<string, Record<string, unknown>>)[
      'state'
    ];
    expect(state?.['enum']).toContain('awaiting_decision');
    expect(state?.['enum']).toContain('landed');
  });

  it('answers in text, not in a vendor content-block envelope', async () => {
    const answer = await tool('list_projects').handler({});
    expect(typeof answer).toBe('string');
    expect(JSON.parse(answer)).toMatchObject({ count: 1 });
  });
});

// ---------------------------------------------------------------------------
// Behaviour — every tool reaches the orchestrator
// ---------------------------------------------------------------------------

describe('helmTools — reads', () => {
  it('list_projects reports every registered project', async () => {
    const { tools } = wire({
      projects: [makeProject(), makeProject({ id: 'proj-2', name: 'starmap' })],
    });
    const result = await callJson(tools.get('list_projects')!);
    expect(result.count).toBe(2);
    expect(result.projects.map((p: Project) => p.name)).toEqual(['uploader', 'starmap']);
  });

  it('resolve_project ranks candidates against the hint', async () => {
    const { tools } = wire();
    const result = await callJson(tools.get('resolve_project')!, { hint: 'upload' });
    expect(result.hint).toBe('upload');
    expect(result.count).toBe(1);
    expect(result.candidates[0]).toMatchObject({ id: 'proj-1', score: 42 });
  });

  it('list_tasks summarizes the fleet and filters by state', async () => {
    const { tools } = wire({
      tasks: [makeTask(), makeTask({ id: 'task-2', state: 'landed', listPriceUsd: 1 })],
    });

    const all = await callJson(tools.get('list_tasks')!);
    expect(all.filter).toBe('all');
    expect(all.count).toBe(2);
    expect(all.byState).toEqual({ working: 1, landed: 1 });
    // Tokens are the fleet total Helm reports; both fixtures burned the same
    // 14,000 measured tokens on one model.
    expect(all.totalTokens).toBe(28_000);
    expect(all.tokensByModel).toEqual({ 'claude-opus-5': 28_000 });
    // Neither task was metered, so the dollars are offered as an equivalence
    // under a key that cannot be mistaken for spend — and `meteredCostUsd`,
    // which would be spend, is absent entirely.
    expect(all.subscriptionApiListPriceEquivalentUsd).toBeCloseTo(1.1235, 4);
    expect(all.meteredCostUsd).toBeUndefined();
    // The project name is resolved for the captain's benefit.
    expect(all.tasks[0].project).toBe('uploader');

    const landed = await callJson(tools.get('list_tasks')!, { state: 'landed' });
    expect(landed.count).toBe(1);
    expect(landed.tasks[0].id).toBe('task-2');
    // Counts stay fleet-wide even when the list is filtered.
    expect(landed.byState).toEqual({ working: 1, landed: 1 });
  });

  it('reports a subscription task in tokens, and never as a cost', async () => {
    // The defect this whole accounting exists to prevent: a Crew is the
    // captain's own Claude Code session on their own login, so its tokens draw
    // down a plan quota and are never billed. A `costUsd` field here is a
    // number Helm will repeat to the captain as money they spent.
    const { tools } = wire();
    const one = await callJson(tools.get('get_task')!, { taskId: 'task-1' });

    expect(one.metered).toBe(false);
    expect(one.costUsd).toBeUndefined();
    expect(one.tokens.total).toBe(14_000);
    expect(one.tokens.byModel['claude-opus-5']).toMatchObject({
      total: 14_000,
      input: 1000,
      output: 200,
      cacheRead: 12_000,
      cacheCreation: 800,
    });
    expect(one.apiListPriceEquivalentUsd).toBeCloseTo(0.1235, 4);
    expect(String(one.costNote)).toContain('NOT a cost');
  });

  it('reports a metered task as real spend, under a key that says so', async () => {
    const { tools } = wire({ tasks: [makeTask({ metered: true })] });
    const one = await callJson(tools.get('get_task')!, { taskId: 'task-1' });

    expect(one.metered).toBe(true);
    expect(one.costUsd).toBeCloseTo(0.1235, 4);
    expect(one.apiListPriceEquivalentUsd).toBeUndefined();
    expect(one.tokens.total).toBe(14_000);
  });

  it('get_task carries the brief that list_tasks omits', async () => {
    const { tools } = wire();
    const one = await callJson(tools.get('get_task')!, { taskId: 'task-1' });
    expect(one.brief).toBe('Retry failed uploads three times with backoff.');

    const many = await callJson(tools.get('list_tasks')!);
    expect(many.tasks[0].brief).toBeUndefined();
  });

  /**
   * `worktree` is a directory `blue gc` is allowed to delete; a recon's report
   * is archived out to `<dataDir>/reports/<taskId>.md` precisely so one copy
   * survives that. Helm reads a single task through this tool and nothing else,
   * so if the archived path does not come through here, the surviving copy is
   * one Helm cannot name.
   */
  it('get_task points at the archived artifact, not just the reclaimable worktree', async () => {
    const { tools } = wire({
      tasks: [
        makeTask({
          id: 'task-recon',
          kind: 'recon',
          state: 'landed',
          worktree: '/home/cap/.bluespace/worktrees/repo-task-recon',
          artifact: '/home/cap/.bluespace/reports/task-recon.md',
          summary: 'Recon complete. The report is archived at /home/cap/.bluespace/reports/task-recon.md.',
        }),
      ],
    });

    const one = await callJson(tools.get('get_task')!, { taskId: 'task-recon' });
    expect(one.artifact).toBe('/home/cap/.bluespace/reports/task-recon.md');
    expect(one.outcome).toContain('archived at');
    expect(one.worktree).toBe('/home/cap/.bluespace/worktrees/repo-task-recon');
  });

  it('open_decisions hands back the question, the options and the context', async () => {
    const { tools } = wire();
    const result = await callJson(tools.get('open_decisions')!);
    expect(result.count).toBe(1);
    expect(result.decisions[0]).toMatchObject({
      id: 'dec-1',
      taskId: 'task-1',
      question: 'Retry on 5xx only, or on every failure?',
      context: 'the uploader sees both',
    });
    expect(result.decisions[0].options).toHaveLength(2);
    expect(result.decisions[0].openedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('helmTools — writes', () => {
  it('create_task queues work through the orchestrator and nothing else', async () => {
    const { tools, calls } = wire();
    const result = await callJson(tools.get('create_task')!, {
      kind: 'recon',
      projectId: 'proj-1',
      title: 'Map the retry paths',
      brief: 'Find every place an upload is retried and report.',
      dependsOn: ['task-1'],
    });

    expect(calls.created).toEqual([
      {
        kind: 'recon',
        projectId: 'proj-1',
        title: 'Map the retry paths',
        brief: 'Find every place an upload is retried and report.',
        dependsOn: ['task-1'],
      },
    ]);
    expect(result.created.id).toBe('task-new');
    expect(result.note).toMatch(/orchestrator dispatches it/);
  });

  it('create_task leaves dependsOn unset when it was not given', async () => {
    const { tools, calls } = wire();
    await callJson(tools.get('create_task')!, {
      kind: 'mission',
      projectId: 'proj-1',
      title: 't',
      brief: 'b',
    });
    expect((calls.created[0] as { dependsOn?: unknown }).dependsOn).toBeUndefined();
  });

  it('answer_decision forwards the captain\'s answer verbatim', async () => {
    const { tools, calls } = wire();
    const result = await callJson(tools.get('answer_decision')!, {
      decisionId: 'dec-1',
      answer: 'b',
    });
    expect(calls.resolved).toEqual([['dec-1', 'b']]);
    expect(result).toMatchObject({ decisionId: 'dec-1', answer: 'b', resolved: true });
  });

  it('steer_task pushes the message into the running crew', async () => {
    const { tools, calls } = wire();
    const result = await callJson(tools.get('steer_task')!, {
      taskId: 'task-1',
      message: 'only retry idempotent requests',
    });
    expect(calls.steered).toEqual([['task-1', 'only retry idempotent requests']]);
    expect(result.steered).toBe(true);
  });

  it('remove_project unregisters through the registry and promises nothing was deleted', async () => {
    const { tools, calls } = wire();
    const result = await callJson(tools.get('remove_project')!, { projectId: 'proj-1' });

    expect(calls.removed).toEqual(['proj-1']);
    expect(result.unregistered.path).toBe('/repos/uploader');
    expect(String(result.note)).toMatch(/Nothing on disk was moved, modified or deleted/);
  });

  it('remove_project refuses an unknown id rather than silently doing nothing', async () => {
    const { tools, calls } = wire();
    await expect(tools.get('remove_project')!.handler({ projectId: 'ghost' })).rejects.toThrow(
      /No project with id ghost/,
    );
    expect(calls.removed).toEqual([]);
  });

  it('cancel_task cancels and reports the state it landed in', async () => {
    const tasks = [makeTask()];
    const { tools, calls } = wire({
      tasks,
      onCancel: () => {
        tasks[0]!.state = 'cancelled';
      },
    });
    const result = await callJson(tools.get('cancel_task')!, { taskId: 'task-1' });
    expect(calls.cancelled).toEqual(['task-1']);
    expect(result).toMatchObject({ taskId: 'task-1', cancelled: true, state: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// Failure — a tool error is a message to the model, not a crash
// ---------------------------------------------------------------------------

describe('helmTools — failure paths', () => {
  it('throws a readable error for an unknown task, naming the way out', async () => {
    const { tools } = wire();
    await expect(tools.get('get_task')!.handler({ taskId: 'nope' })).rejects.toThrow(
      /No task with id nope.*list_tasks/s,
    );
  });

  it('lets an orchestrator failure through as a tool error', async () => {
    const { tools } = wire({ steerError: new Error('task task-1 has no live crew to steer') });
    await expect(
      tools.get('steer_task')!.handler({ taskId: 'task-1', message: 'hurry' }),
    ).rejects.toThrow(/no live crew/);
  });

  it('refuses to queue a task against a project that does not exist', async () => {
    // Left to dispatch, this comes back as `unknown_project:ghost` minutes later
    // on a task create_task already reported as "Queued. The orchestrator
    // dispatches it once ...". Rejecting now is one corrected call instead.
    const { tools } = wire();
    await expect(
      tools.get('create_task')!.handler({
        kind: 'mission',
        projectId: 'ghost',
        title: 't',
        brief: 'b',
      }),
    ).rejects.toThrow(/No project with id ghost.*proj-1/s);
  });

  it('rejects a missing or malformed argument by name', async () => {
    const { tools } = wire();
    await expect(tools.get('resolve_project')!.handler({})).rejects.toThrow(/hint is required/);
    await expect(tools.get('get_task')!.handler({ taskId: 42 })).rejects.toThrow(/taskId/);
    await expect(
      tools.get('create_task')!.handler({
        kind: 'sortie',
        projectId: 'p',
        title: 't',
        brief: 'b',
      }),
    ).rejects.toThrow(/kind must be one of: mission, recon/);
    await expect(
      tools.get('create_task')!.handler({
        kind: 'mission',
        projectId: 'p',
        title: 't',
        brief: 'b',
        dependsOn: 'task-1',
      }),
    ).rejects.toThrow(/dependsOn must be an array of strings/);
    await expect(tools.get('list_tasks')!.handler({ state: 'melted' })).rejects.toThrow(
      /state must be one of/,
    );
  });
});
