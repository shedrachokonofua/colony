// Console entry: registers the shell, mounts it into #app. Loaded from
// index.html as /ui/main.js.
import "./colony-app.js";

function mountApp() {
  const mount = document.getElementById("app");
  if (!mount) return;
  mount.textContent = "";
  mount.append(document.createElement("colony-app"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountApp);
} else {
  mountApp();
}
