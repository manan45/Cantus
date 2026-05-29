const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
};

export function langFromPath(path: string): string {
  const ext = path.split(".").at(-1) ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}
