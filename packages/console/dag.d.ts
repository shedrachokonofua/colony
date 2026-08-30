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

export function layoutDag(nodes: DagNode[], edges: DagEdge[]): DagLayout;

export function graphModel(detail: DagDetail | null | undefined): {
  nodes: DagNode[];
  edges: DagEdge[];
};
