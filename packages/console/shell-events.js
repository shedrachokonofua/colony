// The shell's event bus: the catalog of colony-* events the views bubble up,
// and the single dispatch that maps each onto an action. Every view talks to
// the shell through these names only — adding a view capability is one catalog
// entry plus one case here, never a new wiring path.
import {
  saveActor,
  selectTask,
  closeDrawer,
  confirmAction,
  toggle,
  saveContext,
  confirmFile,
  toggleReplaceFile,
  deleteFile,
  replaceFile,
  uploadFile,
  createProject,
  createScope,
  taskAction,
  abandon,
  openReader,
  closeReader,
  feedback,
  mutate,
} from "./shell-actions.js";

/** Every colony-* event type the shell listens for on itself. */
export const LISTENED = [
  "colony-navigate",
  "colony-actor-change",
  "colony-signin",
  "colony-signout",
  "colony-open-scope",
  "colony-select-task",
  "colony-close-drawer",
  "colony-confirm",
  "colony-toggle",
  "colony-save-context",
  "colony-file-confirm",
  "colony-file-replace-toggle",
  "colony-file-replace",
  "colony-file-delete",
  "colony-file-upload",
  "colony-create-project",
  "colony-create-scope",
  "colony-task-action",
  "colony-abandon",
  "colony-open-reader",
  "colony-close-reader",
  "colony-page",
  "colony-feedback",
];

/**
 * @param {import("./shell-data.js").ShellState} app
 * @param {Event} event
 */
export function handleEvent(app, event) {
  const detail =
    /** @type {{ detail?: { [key: string]: any } }} */ (event).detail ?? {};
  switch (event.type) {
    case "colony-navigate":
      app.navigate(detail.href);
      break;
    case "colony-actor-change":
      saveActor(app, detail.actor);
      break;
    case "colony-signin":
      void app.beginLogin();
      break;
    case "colony-signout":
      app.signOut();
      break;
    case "colony-open-scope":
      if (detail.id) app.navigate(`#/${detail.id}`);
      break;
    case "colony-select-task":
      selectTask(app, detail.taskId);
      break;
    case "colony-close-drawer":
      closeDrawer(app);
      break;
    case "colony-confirm":
      confirmAction(app, detail.kind);
      break;
    case "colony-toggle":
      toggle(app, detail.key);
      break;
    case "colony-save-context":
      void saveContext(app, detail.project, detail.context_doc);
      break;
    case "colony-file-confirm":
      confirmFile(app, detail.fileId);
      break;
    case "colony-file-replace-toggle":
      toggleReplaceFile(app, detail.fileId);
      break;
    case "colony-file-replace":
      void replaceFile(
        app,
        /** @type {{ fileId: string, content: string, media_type: string }} */ (
          detail
        ),
      );
      break;
    case "colony-file-delete":
      void deleteFile(app, /** @type {{ fileId: string }} */ (detail));
      break;
    case "colony-file-upload":
      void uploadFile(
        app,
        /** @type {{ filename: string, media_type: string, content: string }} */ (
          detail
        ),
      );
      break;
    case "colony-create-project":
      void createProject(
        app,
        /** @type {{ name: string, context_doc?: string }} */ (detail),
      );
      break;
    case "colony-create-scope":
      void createScope(
        app,
        /** @type {{ goal: string, title?: string, project?: string | null, repo: { path: string }, approvals?: string }} */ (
          detail
        ),
      );
      break;
    case "colony-task-action":
      if (detail.path) {
        void mutate(app, detail.path, detail.body);
      } else {
        void taskAction(app, detail.taskId, detail.action);
      }
      break;
    case "colony-abandon":
      void abandon(app, detail.scopeId);
      break;
    case "colony-open-reader":
      openReader(app, detail.title, detail.markdown);
      break;
    case "colony-close-reader":
      closeReader(app);
      break;
    case "colony-page":
      app._page(detail.page, detail.surface);
      break;
    case "colony-feedback":
      void feedback(app, detail.path, detail.body ?? {});
      break;
    default:
      break;
  }
}
