const btn = document.getElementById("hello-btn");
const status = document.getElementById("status");

btn?.addEventListener("click", () => {
  const now = new Date().toLocaleTimeString();
  status.textContent = `Hello from avyaan-clean · ${now}`;
});

console.log("avyaan-clean ready");
