export interface DagNode {
  id: string;
  title?: string;
  state?: string;
  proposed?: boolean;
}

export interface DagEdge {
  task_id: string;
  depends_on_task_id: string;
}

export interface DagDetail {
  tasks: Array<{ id: string; title: string; state: string }>;
  deps: DagEdge[];
  scope: { plan_json?: string | null };
  runs?: unknown[];
}

export interface DagBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DagLayout {
  pos: Map<string, DagBox>;
  width: number;
  height: number;
}

export interface PlanTask {
  title: string;
  spec?: string;
  depends_on?: number[];
  /** Files the task changes; the architect verified each exists or names its creation. */
  files?: string[];
  /** Commands that prove the task landed. */
  evidence?: string[];
}

export interface Plan {
  summary?: string;
  /** What the goal demands, each traced to the task indexes that deliver it. */
  requirements?: Array<{ id?: string; text?: string; tasks?: number[] }>;
  /** The working state after each task lands, in order. */
  journey?: Array<{ after_task?: number; working_state?: string }>;
  acceptance?: Array<{ description?: string; command?: string }>;
  tasks: PlanTask[];
}

export function parsePlan(raw: string | null | undefined): Plan | null;

export function layoutDag(nodes: DagNode[], edges: DagEdge[]): DagLayout;

export function graphModel(detail: DagDetail | null | undefined): {
  nodes: DagNode[];
  edges: DagEdge[];
};
