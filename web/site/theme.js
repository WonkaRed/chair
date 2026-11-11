// Runs before first paint (an external file, because the page's CSP forbids inline script): applies a saved theme choice.
try {
  const saved = localStorage.getItem("chair-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // Storage can be blocked; the OS preference then decides.
}
