function isGitMetadataComponent(part: string): boolean {
  const p = part
    .normalize("NFC")
    .replace(/[.\s]+$/, "")
    .toLowerCase();
  return p === ".git" || /^git~[0-9]+$/.test(p);
}

export function carriesGitMetadata(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).some(isGitMetadataComponent);
}

export function normalizeRelPath(path: string): string {
  const p = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);
  if (
    !parts.length ||
    path.startsWith("/") ||
    parts.some((part) => part === "." || part === ".." || part.includes("\0")) ||
    parts.some(isGitMetadataComponent)
  ) {
    throw new Error(`invalid deploy path: ${path}`);
  }
  return parts.join("/");
}
