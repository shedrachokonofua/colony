import { describe, expect, it } from "bun:test";
import { renderFrame, type TuiState } from "./frame.js";

describe("renderFrame", () => {
  it("renders 80x24 golden frame exactly and matches bounds", () => {
    const state: TuiState = {
      scopes: [
        { id: "col-11111111", title: "Add user dashboard", status: "planning" },
        { id: "col-22222222", title: "Fix merge gate auth", status: "active" },
      ],
      selectedScopeId: "col-22222222",
      tasks: [
        {
          id: "task-1",
          title: "Create schema",
          state: "done",
          attempt: 1,
          mrIid: 10,
          model: "sonnet",
        },
        {
          id: "task-2",
          title: "Write migrations",
          state: "running",
          attempt: 2,
          mrIid: null,
          model: "haiku",
        },
        {
          id: "task-3",
          title: "Add endpoints",
          state: "pending",
          attempt: 0,
          mrIid: null,
          model: null,
        },
      ],
      selectedTaskIndex: 1,
      feedLines: [
        "#1 run_started model=haiku",
        "#2 tool_call cmd=git status",
        "#3 tool_result exit=0",
        "#4 test_run pass=5 fail=0",
        "#5 run_finished status=success",
      ],
      statusLine: "",
      modal: null,
      lastAction: { ok: true, text: "Approved plan" },
    };

    const output = renderFrame(state, { cols: 80, rows: 24 });
    const lines = output.replace(/^\u001b\[2J\u001b\[H/, "").split("\n");

    expect(lines.length).toBe(24);
    for (const line of lines) {
      expect(line.length).toBe(80);
    }

    const expected =
      "\u001b[2J\u001b[H" +
      "[PLANNING]                  │TASKS                                              \n" +
      "  col-11111111  Add user da…│  task-1  done  #1  !10  sonnet  Create schema     \n" +
      "[ACTIVE]                    │> task-2  running  #2  -  haiku  Write migrations  \n" +
      "> col-22222222  Fix merge g…│  task-3  pending  #0  -  -  Add endpoints         \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │LIVE FEED                                          \n" +
      "                            │#1 run_started model=haiku                         \n" +
      "                            │#2 tool_call cmd=git status                        \n" +
      "                            │#3 tool_result exit=0                              \n" +
      "                            │#4 test_run pass=5 fail=0                          \n" +
      "                            │#5 run_finished status=success                     \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "                            │                                                   \n" +
      "q:quit  j/k:move  h/l:pane  a:approve  R:replan  A:abandon  r:retry  s:stop  u:…";

    expect(output).toBe(expected);
  });
});
