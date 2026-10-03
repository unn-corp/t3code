export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;

export const COMPOSER_INLINE_CHIP_CLASS_NAME =
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border border-border/70 bg-accent/40 px-[0.5em] text-[0.86em] font-medium leading-none text-foreground align-middle select-none";
export const COMPOSER_INLINE_CHIP_ICON_CLASS_NAME =
  "block size-[1.17em] shrink-0 self-center [&>svg]:block";
export const COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME =
  "block self-center truncate leading-tight select-none";
export const COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME =
  "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Keeps both the recognizable beginning and the extension/end of a long attachment name. */
export function middleTruncateAttachmentName(name: string, maxCharacters = 36): string {
  const characters = Array.from(name);
  if (characters.length <= maxCharacters) return name;
  if (maxCharacters <= 0) return "";
  if (maxCharacters === 1) return "…";
  const available = maxCharacters - 1;
  const suffixLength = Math.min(available - 1, available >= 18 ? 14 : Math.ceil(available / 2));
  const prefixLength = available - suffixLength;
  const suffix = suffixLength === 0 ? "" : characters.slice(-suffixLength).join("");
  return `${characters.slice(0, prefixLength).join("")}…${suffix}`;
}
