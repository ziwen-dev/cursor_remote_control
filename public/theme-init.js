(function applySavedTheme() {
  try {
    const preference = localStorage.getItem("bridge-theme");
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const theme = preference === "light" || preference === "dark"
      ? preference
      : (dark ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
}());
