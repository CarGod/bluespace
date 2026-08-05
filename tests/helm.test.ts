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
import { helmTools } from '../src/agents/helm/index.js';
import type { ProjectRegistry } from '../src/config/index.js';
import type { Orchestrator } from '../src/orchestrator/index.js';
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
    costUsd: 0.123_456,
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

  const calls: Calls = { created: [], resolved: [], steered: [], cancelled: [] };

  const registry = {
    list: () => projects,
    get: (id: string) => projects.find((p) => p.id === id),
    resolveScored: (hint: string) =>
      projects
        .filter((p) => p.name.includes(hint) || p.description.includes(hint))
        .map((project) => ({ project, score: 42 })),
  } as unknown as ProjectRegistry;

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

  const list = helmTools(orch, registry);
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

  it('returns the nine levers Helm has on the fleet', () => {
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
    ]);
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
      tasks: [makeTask(), makeTask({ id: 'task-2', state: 'landed', costUsd: 1 })],
    });

    const all = await callJson(tools.get('list_tasks')!);
    expect(all.filter).toBe('all');
    expect(all.count).toBe(2);
    expect(all.byState).toEqual({ working: 1, landed: 1 });
    expect(all.totalCostUsd).toBeCloseTo(1.1235, 4);
    // The project name is resolved for the captain's benefit.
    expect(all.tasks[0].project).toBe('uploader');

    const landed = await callJson(tools.get('list_tasks')!, { state: 'landed' });
    expect(landed.count).toBe(1);
    expect(landed.tasks[0].id).toBe('task-2');
    // Counts stay fleet-wide even when the list is filtered.
    expect(landed.byState).toEqual({ working: 1, landed: 1 });
  });

  it('get_task carries the brief that list_tasks omits', async () => {
    const { tools } = wire();
    const one = await callJson(tools.get('get_task')!, { taskId: 'task-1' });
    expect(one.brief).toBe('Retry failed uploads three times with backoff.');

    const many = await callJson(tools.get('list_tasks')!);
    expect(many.tasks[0].brief).toBeUndefined();
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
