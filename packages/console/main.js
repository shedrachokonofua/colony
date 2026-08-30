import "./colony-app.js";

const mount = document.getElementById("app");
mount.textContent = "";

document.addEventListener("DOMContentLoaded", () => {
  mount.append(document.createElement("colony-app"));
});
