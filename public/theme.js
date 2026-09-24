// Applies the saved light/dark theme before first paint (a separate file so
// the Content-Security-Policy can forbid inline scripts).
(() => {
  let mode = "light";
  try {
    mode = localStorage.getItem("theme") || "light";
  } catch {
    // Storage blocked: use the default theme.
  }
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
})();
