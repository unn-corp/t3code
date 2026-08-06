const MAX_DROPPED_TEXT_FILE_BYTES = 512 * 1024;
const MAX_DROPPED_TEXT_TOTAL_CHARS = 100_000;

export type DroppedTextFile = Pick<File, "name" | "size" | "text">;

export async function formatDroppedTextFiles(files: ReadonlyArray<DroppedTextFile>): Promise<{
  readonly text: string;
  readonly rejectedNames: ReadonlyArray<string>;
}> {
  const sections: string[] = [];
  const rejectedNames: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (file.size > MAX_DROPPED_TEXT_FILE_BYTES) {
      rejectedNames.push(file.name);
      continue;
    }
    try {
      const contents = await file.text();
      // Binary data either contains NUL bytes or cannot be decoded as UTF-8
      // without replacement characters. Do not leak a corrupted blob into an
      // agent prompt.
      if (contents.includes("\0") || contents.includes("\uFFFD")) {
        rejectedNames.push(file.name);
        continue;
      }
      const section = `\n\n<attached-file name=${JSON.stringify(file.name)}>\n${contents}\n</attached-file>`;
      if (totalChars + section.length > MAX_DROPPED_TEXT_TOTAL_CHARS) {
        rejectedNames.push(file.name);
        continue;
      }
      sections.push(section);
      totalChars += section.length;
    } catch {
      rejectedNames.push(file.name);
    }
  }

  return { text: sections.join(""), rejectedNames };
}
