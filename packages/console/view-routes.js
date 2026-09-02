// The shell's lazy view registry: route name -> the module defining that
// route's custom element. colony-app imports a module on first navigation
// (the view surfaces as shell state meanwhile); the shell dispatches by
// element name. This is the one place route names and elements meet — a new
// view registers here and nowhere else. Kept data-only so a route's module
// graph (and its failure) stays off the shell's critical path.
export const VIEW_ROUTES = {
  list: ["./views/project-list.js", "project-list"],
  project: ["./views/project-page.js", "project-page"],
  files: ["./views/project-files.js", "project-files"],
  newProject: ["./views/project-create.js", "project-create"],
  newScope: ["./views/scope-create.js", "scope-create"],
  scope: ["./views/scope-sheet.js", "scope-sheet"],
};
